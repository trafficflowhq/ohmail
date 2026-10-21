import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps, type ResolvedSession } from "@trafficflow/api";
import { devices, recordChange, sessions, type EntityType } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { DEVICE_SYNC_STAMP_MIN_GAP_MS, VALID_TYPE_LIST, syncRoutes } from "../src/routes/sync.js";
import { makeDeps, seedDevice, seedSession, seedSessionFor, req, FIXED_NOW } from "./helpers.js";

/**
 * AN UNCHANGED `/sync` POLL COSTS TWO STATEMENTS AND WRITES NOTHING. The web, the phone and the
 * desktop poll `/sync` on a timer; at the horizon the answer already comes from the bounds read
 * (`sync-at-the-horizon-costs-one-read.test.ts`). What was left on every such poll were the two
 * sync-stamp UPDATEs, which the five-minute predicate refuses on all but one poll in that window.
 * The session row `withSession` already read says whether the stamp is due, so a poll that is not
 * due sends neither. Counted on the store's own client, both stores.
 */

type World = Awaited<ReturnType<typeof makeDeps>>;
type Db = World["db"];

interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }
interface PgliteClient extends Doors { transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown> }

/** The statements `work` hands the store, by text: PGlite's two doors (a transaction's too), or SQLite's prepare. */
async function statementsOf<T>(db: Db, work: () => Promise<T>): Promise<{ value: T; seen: string[] }> {
  const seen: string[] = [];
  const note = (a: unknown[]): void => { seen.push(String(a[0]).replace(/\s+/g, " ").trim()); };
  if (dialect(db as never).name === "sqlite") {
    const proto = (createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: { prototype: { prepare: (...a: unknown[]) => unknown } };
    }).DatabaseSync.prototype;
    const prepare = proto.prepare;
    proto.prepare = function (this: unknown, ...a: unknown[]) { note(a); return prepare.apply(this, a); };
    try { return { value: await work(), seen }; } finally { proto.prepare = prepare; }
  }
  const client = (db as unknown as { $client: PgliteClient }).$client;
  const saved = { query: client.query, exec: client.exec, transaction: client.transaction };
  const wrap = <D extends Doors>(d: D): D => {
    for (const door of ["query", "exec"] as const) {
      const inner = d[door].bind(d);
      d[door] = (...a: unknown[]) => { note(a); return inner(...a); };
    }
    return d;
  };
  wrap(client);
  const tx = saved.transaction.bind(client);
  client.transaction = (cb) => tx((inner) => cb(wrap(inner)));
  try { return { value: await work(), seen }; } finally { Object.assign(client, saved); }
}

const isWrite = (statement: string): boolean => /^(update|insert|delete)\b/i.test(statement);

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const poll = (cursor: string): string => `/sync?since=${encodeURIComponent(cursor)}`;

interface SyncBody {
  changes: Record<"creates" | "updates" | "moves" | "deletes", Array<{ type: string; id: string }>>;
  cursor: string;
  hasMore: boolean;
}
const delivered = (b: SyncBody): string[][] =>
  [...b.changes.creates, ...b.changes.updates, ...b.changes.moves, ...b.changes.deletes].map((c) => [c.type, c.id]);

/** One change row, in its own transaction; the delta reader reads nothing else. */
async function change(db: Db, accountId: string, entityType: EntityType = "rule", entityId: string = randomUUID()): Promise<string> {
  await db.transaction((tx) => recordChange(tx as never, {
    accountId, entityType, entityId, op: entityType === "mailbox" ? "delete" : "update",
  }));
  return entityId;
}

/** Read from zero the way a window does; returns the horizon cursor. */
async function drain(deps: ApiDeps, token: string): Promise<string> {
  const body = await (await H(req("GET", "/sync?since=0", { bearer: token }), deps)).json() as SyncBody;
  expect(body.hasMore).toBe(false);
  return body.cursor;
}

const sessionStamp = async (db: Db, id: string): Promise<Date | null> =>
  (await db.select({ at: sessions.lastSyncedAt }).from(sessions).where(eq(sessions.id, id)))[0]!.at;
const deviceStamp = async (db: Db, id: string): Promise<Date | null> =>
  (await db.select({ at: devices.lastSyncedAt }).from(devices).where(eq(devices.id, id)))[0]!.at;

describe("an unchanged /sync poll writes nothing", () => {
  it("is the session read and the bounds read alone, with the same answer and the stamp left where it is", async () => {
    const { db, deps, clock } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await change(db, s.accountId);
    const horizon = await drain(deps, s.token);
    // The first empty tail is a committed drain: stamped.
    const first = await (await H(req("GET", poll(horizon), { bearer: s.token }), deps)).text();
    expect(await sessionStamp(db, s.sessionId)).toEqual(FIXED_NOW);

    clock.advance(20_000);
    const { value: res, seen } = await statementsOf(db, () => H(req("GET", poll(horizon), { bearer: s.token }), deps));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(seen.filter(isWrite), "an unchanged poll sent a write").toEqual([]);
    expect(seen, seen.join("\n")).toHaveLength(2);
    expect(text, "the unchanged answer's bytes moved")
      .toBe(first.replace(FIXED_NOW.toISOString(), clock.now().toISOString()));
    expect(await sessionStamp(db, s.sessionId)).toEqual(FIXED_NOW);
  });

  it("a due stamp still lands on the session and its device; exactly at the gap nothing is sent", async () => {
    const { db, deps, clock } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW });
    const deviceId = await seedDevice(db, { accountId: owner.accountId, userId: owner.userId });
    const s = await seedSessionFor(db, { accountId: owner.accountId, userId: owner.userId, now: FIXED_NOW, deviceId });
    await change(db, owner.accountId);
    const horizon = await drain(deps, s.token);
    await H(req("GET", poll(horizon), { bearer: s.token }), deps);
    expect(await sessionStamp(db, s.sessionId)).toEqual(FIXED_NOW);
    expect(await deviceStamp(db, deviceId)).toEqual(FIXED_NOW);

    clock.advance(DEVICE_SYNC_STAMP_MIN_GAP_MS);
    const atGap = await statementsOf(db, () => H(req("GET", poll(horizon), { bearer: s.token }), deps));
    expect(atGap.seen.filter(isWrite), "a stamp the predicate would refuse was sent").toEqual([]);
    expect(atGap.seen, atGap.seen.join("\n")).toHaveLength(2);
    expect(await sessionStamp(db, s.sessionId)).toEqual(FIXED_NOW);
    expect(await deviceStamp(db, deviceId)).toEqual(FIXED_NOW);

    clock.advance(1);
    const due = await statementsOf(db, () => H(req("GET", poll(horizon), { bearer: s.token }), deps));
    expect(due.seen.filter(isWrite), "a due stamp was skipped").toHaveLength(2);
    expect(await sessionStamp(db, s.sessionId)).toEqual(clock.now());
    expect(await deviceStamp(db, deviceId)).toEqual(clock.now());
  });

  it("a session never stamped is stamped on its first empty tail, and one whose stamp was not read is stamped as before", async () => {
    const { db, deps, clock } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await change(db, s.accountId);
    const horizon = await drain(deps, s.token);
    expect(await sessionStamp(db, s.sessionId)).toBeNull();
    const firstTail = await statementsOf(db, () => H(req("GET", poll(horizon), { bearer: s.token }), deps));
    expect(firstTail.seen.filter(isWrite)).toHaveLength(2);
    expect(await sessionStamp(db, s.sessionId)).toEqual(FIXED_NOW);

    // A session handed over without the field: the UPDATEs go out and their predicate decides.
    clock.advance(20_000);
    const route = syncRoutes.find((r) => r.method === "GET" && r.pattern === "/sync")!;
    const session: ResolvedSession = {
      accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, lastTwofaAt: null,
      scope: "full", via: "bearer", emailVerifiedAt: FIXED_NOW,
    };
    const unread = await statementsOf(db, () => route.handler(req("GET", poll(horizon)), { ...deps, session }, {}));
    expect(unread.seen.filter(isWrite), "a stamp nobody read was trusted").toHaveLength(2);
    expect(await sessionStamp(db, s.sessionId), "inside the window the predicate refuses").toEqual(FIXED_NOW);
  });

  it("every kind of change makes the next poll a full answer, and the poll after it cheap again", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await change(db, s.accountId);
    let cursor = await drain(deps, s.token);
    await H(req("GET", poll(cursor), { bearer: s.token }), deps);
    expect(await sessionStamp(db, s.sessionId)).toEqual(FIXED_NOW);

    for (const type of VALID_TYPE_LIST) {
      const id = await change(db, s.accountId, type, type === "settings" ? s.accountId : randomUUID());
      const full = await statementsOf(db, () => H(req("GET", poll(cursor), { bearer: s.token }), deps));
      const body = await full.value.json() as SyncBody;
      expect(delivered(body), `a ${type} change was answered as unchanged`).toEqual([[type, id]]);
      expect(body.cursor).not.toBe(cursor);
      expect(body.hasMore).toBe(false);
      expect(full.seen.length, full.seen.join("\n")).toBeGreaterThan(2);
      cursor = body.cursor;

      const again = await statementsOf(db, () => H(req("GET", poll(cursor), { bearer: s.token }), deps));
      expect(delivered(await again.value.json() as SyncBody)).toEqual([]);
      expect(again.seen, `after a ${type} change: ${again.seen.join("\n")}`).toHaveLength(2);
    }
  });

  it("another account's change never reads as this one's, and a cursor is judged on the presenting session's log", async () => {
    const { db, deps, clock } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW });
    for (let i = 0; i < 3; i++) await change(db, a.accountId);
    const bIds = [await change(db, b.accountId)];
    const aCursor = await drain(deps, a.token);
    await H(req("GET", poll(aCursor), { bearer: a.token }), deps);
    expect(await sessionStamp(db, a.sessionId)).toEqual(FIXED_NOW);

    // B moves; A's poll is still the unchanged answer, and A's row stays put.
    clock.advance(20_000);
    bIds.push(await change(db, b.accountId));
    const aPoll = await statementsOf(db, () => H(req("GET", poll(aCursor), { bearer: a.token }), deps));
    expect(delivered(await aPoll.value.json() as SyncBody)).toEqual([]);
    expect(aPoll.seen.filter(isWrite)).toEqual([]);
    expect(aPoll.seen, aPoll.seen.join("\n")).toHaveLength(2);
    expect(await sessionStamp(db, a.sessionId)).toEqual(FIXED_NOW);
    expect(await sessionStamp(db, b.sessionId)).toBeNull();

    // A's cursor (seq 3) on B's session, B's log at 2: ahead of B's log, refused.
    const ahead = await H(req("GET", poll(aCursor), { bearer: b.token }), deps);
    expect(ahead.status).toBe(410);

    // B's log at 4: behind, so B's own rows above seq 3 and nothing of A's; not a tail, so no stamp.
    bIds.push(await change(db, b.accountId), await change(db, b.accountId));
    const behind = await (await H(req("GET", poll(aCursor), { bearer: b.token }), deps)).json() as SyncBody;
    expect(delivered(behind)).toEqual([["rule", bIds[3]!]]);
    expect(await sessionStamp(db, b.sessionId)).toBeNull();

    // A's log at 4 too: A's horizon is B's, so B gets the unchanged answer and only B's row is stamped.
    await change(db, a.accountId);
    const aHorizon = (await (await H(req("GET", poll(aCursor), { bearer: a.token }), deps)).json() as SyncBody).cursor;
    const atB = await statementsOf(db, () => H(req("GET", poll(aHorizon), { bearer: b.token }), deps));
    expect(delivered(await atB.value.json() as SyncBody)).toEqual([]);
    expect(atB.seen.filter(isWrite)).toHaveLength(2);
    expect(await sessionStamp(db, b.sessionId)).toEqual(clock.now());
    expect(await sessionStamp(db, a.sessionId)).toEqual(FIXED_NOW);
  });
});

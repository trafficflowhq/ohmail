import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { changeLog, rules } from "@trafficflow/db/mail";
import { materializeRule } from "@trafficflow/services/mail";
import type {
  MailboxDTO, MessageDTO, RuleDTO, SnapshotResponse, SyncChange, SyncResponse,
} from "@trafficflow/services/mail";
import {
  consentIndex, consentPartition, decidedDestination, type EngineMessage, type EntityReader,
} from "@ohmail/client-engine";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror, CURSOR_VERSION } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * A MIRRORED RULE KEEPS THE INSTANT CLOUD CREATED IT.
 *
 * The mirror's `rule` arm wrote every hosted rule without its `createdAt`, so on a Cloud-paired
 * desktop all rules shared the insert instant. Then the client ranked a sender's twins
 * newest-created first, and the desktop's Ohbox held rows the web filed under News. The twins are
 * ranked by the router's order now, which reads no instant (FIX-024); the instant still orders the
 * Rules list, so the arm carries it and an upgraded mirror repairs the rows it wrote wrong once.
 */

const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED_MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")];
const OLDER = "2026-08-01T10:00:00.000Z";
const NEWER = "2026-09-07T23:28:43.095Z";
/** The instant a pre-fix mirror stamped on every rule — one bootstrap's insert time. */
const INSERT_INSTANT = "2026-09-24T06:45:31.571Z";

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ db: OpenLocalDb["db"]; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-rule-instants-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  return { db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

const iso = (): string => new Date().toISOString();
const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

function change(type: SyncChange["type"], id: string, op: SyncChange["op"], seq: number, entity: unknown): SyncChange {
  return { type, op, id, seq, updatedAt: iso(), entity };
}

function syncPage(changes: SyncChange[], cursor: string): SyncResponse {
  return {
    changes: {
      creates: changes.filter((c) => c.op === "create"),
      updates: changes.filter((c) => c.op === "update"),
      moves: [],
      deletes: [],
    },
    cursor,
    hasMore: false,
    serverTime: iso(),
  };
}

/** Snapshot page 1 — the live state; every row `op:"create"` at `seq = asOfSeq`, the contract. */
function snapshotPage(changes: SyncChange[], asOfSeq = 99): SnapshotResponse {
  return {
    asOfSeq,
    changes: changes.map((c) => ({ ...c, op: "create" as const, seq: asOfSeq })),
    nextCursor: null,
    window: { days: 90, minRows: 500 },
  };
}
const EMPTY_SNAPSHOT = snapshotPage([]);

function ruleDTO(id: string, over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id,
    kind: "sender",
    match: "alerts@notify.test",
    destination: "INBOX",
    priority: 0,
    provenance: "promoted",
    enabled: true,
    subjectContains: null,
    bodyContains: null,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    retro: { requestedAt: null, doneAt: null },
    byOhmail: false,
    createdAt: OLDER,
    updatedAt: OLDER,
    ...over,
  };
}

/**
 * A fake Cloud API: `/mailboxes` first (the mirror refuses to drain without it), `/sync/snapshot`
 * before `/sync` (a prefix away from eating a page), the bootstrap's `types=rule` pass derived
 * from the mixed pages, then the mixed pages by call order. `failSnapshotOnce` rejects the first
 * snapshot read — a dead network mid-repair — and answers every later one.
 */
function fakeAuth(
  sync: SyncResponse[],
  snapshot: SnapshotResponse = EMPTY_SNAPSHOT,
  opts: { asked?: string[]; failSnapshotOnce?: boolean } = {},
): CloudAuth {
  let s = 0;
  let r = 0;
  let fail = opts.failSnapshotOnce === true;
  const empty = syncPage([], "end");
  const ruleChanges = sync.flatMap((p) => [...p.changes.creates, ...p.changes.updates].filter((c) => c.type === "rule"));
  const rulePages = [syncPage(ruleChanges, "rules-end")];
  return {
    authedFetch: async (path: string) => {
      opts.asked?.push(path);
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED_MAILBOXES));
      if (path.startsWith("/sync/snapshot")) {
        if (fail) { fail = false; throw new Error("network died mid-repair"); }
        return json(snapshot);
      }
      if (path.startsWith("/sync") && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json(rulePages[r++] ?? empty);
      }
      if (path.startsWith("/sync")) return json(sync[s++] ?? empty);
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

const ruleRow = async (db: OpenLocalDb["db"], id: string) =>
  (await db.select().from(rules).where(eq(rules.id, id)))[0]!;

/** Age the cursor file to the pre-repair build's shape: the same cursor, no `ruleInstantRepair` key. */
function dropRepairKey(cursorPath: string): void {
  const cur = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
  delete cur.ruleInstantRepair;
  writeFileSync(cursorPath, JSON.stringify(cur));
}

describe("a mirrored rule keeps the instant Cloud created it", () => {
  it("the rule arm writes the hosted createdAt, not this process's insert time", async () => {
    const { db, world, cursorPath } = await standUp();
    const ruleId = randomUUID();
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("rule", ruleId, "create", 1, ruleDTO(ruleId, { updatedAt: NEWER }))], "c1")]),
    }).pullOnce();
    const row = await ruleRow(db, ruleId);
    expect(row.createdAt.toISOString(), "the local row took the insert instant instead of the hosted one").toBe(OLDER);
    expect(row.updatedAt.toISOString()).toBe(NEWER);
  });

  it("a re-delivered rule corrects a row that was written without it (the conflict set carries it)", async () => {
    const { db, world, cursorPath } = await standUp();
    const ruleId = randomUUID();
    // The pre-fix mirror's row: every column right but the instant, which is the insert time.
    await db.insert(rules).values({
      id: ruleId, accountId: world.accountId, kind: "sender", match: "alerts@notify.test",
      destination: "INBOX", priority: 0, provenance: "promoted", enabled: true,
      createdAt: new Date(INSERT_INSTANT), updatedAt: new Date(OLDER),
    });
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("rule", ruleId, "update", 1, ruleDTO(ruleId))], "c1")]),
    }).pullOnce();
    expect((await ruleRow(db, ruleId)).createdAt.toISOString(), "an update left the wrong instant standing").toBe(OLDER);
  });
});

/**
 * AND ITS BACKLOG PASS STAMPS. The sender sheet over this mirror reads `retro` from the local row;
 * the arm wrote neither stamp, so a pass the account had asked for read as never asked, and the
 * sheet could say every message was at the place while the account's pass still moved mail.
 */
describe("a mirrored rule keeps the account's backlog pass stamps", () => {
  it("carries both stamps, and a stamp the account cleared clears here too", async () => {
    const { db, world, cursorPath } = await standUp();
    const ruleId = randomUUID();
    const ASKED = "2026-09-27T08:00:00.000Z";
    const DONE = "2026-09-27T08:05:00.000Z";
    const AGAIN = "2026-09-27T09:00:00.000Z";
    const pull = (seq: number, retro: RuleDTO["retro"]) => createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("rule", ruleId, seq === 1 ? "create" : "update", seq, ruleDTO(ruleId, { retro }))], `c${seq}`)]),
    }).pullOnce();
    const stamps = async (): Promise<[string | null, string | null]> => {
      const r = await ruleRow(db, ruleId);
      return [r.retroRequestedAt?.toISOString() ?? null, r.retroDoneAt?.toISOString() ?? null];
    };
    await pull(1, { requestedAt: ASKED, doneAt: null });
    expect(await stamps(), "the pass the account asked for reads as never asked").toEqual([ASKED, null]);
    await pull(2, { requestedAt: ASKED, doneAt: DONE });
    expect(await stamps()).toEqual([ASKED, DONE]);
    await pull(3, { requestedAt: AGAIN, doneAt: null });
    expect(await stamps(), "a finished pass stayed finished after the account asked again").toEqual([AGAIN, null]);
  });
});

/**
 * AND WHETHER A PERSON DECIDED IT (`RuleDTO.personDecided`, `rules.person_decided_at`): a person's own
 * Screener press on a domain is consent to a hold for want of confirmation, so the paired desktop's door
 * says it as Cloud's does, and a rule Cloud no longer marks reads unmarked here too.
 */
describe("a mirrored rule keeps whether a person decided it", () => {
  it("the local door re-emits the mark, and a later copy without it clears it", async () => {
    const { db, world, cursorPath } = await standUp();
    const ruleId = randomUUID();
    const pressed = ruleDTO(ruleId, { kind: "domain", match: "paypal.com", personDecided: true });
    const pull = (seq: number, entity: RuleDTO) => createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("rule", ruleId, seq === 1 ? "create" : "update", seq, entity)], `c${seq}`)]),
    }).pullOnce();
    await pull(1, pressed);
    expect((await ruleRow(db, ruleId)).personDecidedAt, "the person's decision was dropped").not.toBeNull();
    expect((await materializeRule(db, world.accountId, ruleId))?.personDecided).toBe(true);
    const { personDecided: _gone, ...unmarked } = pressed;
    await pull(2, unmarked);
    expect((await ruleRow(db, ruleId)).personDecidedAt).toBeNull();
    expect((await materializeRule(db, world.accountId, ruleId))?.personDecided).toBeUndefined();
  });
});

describe("an upgraded mirror repairs the rule instants it wrote wrong", () => {
  async function staleMirror(): Promise<{ db: OpenLocalDb["db"]; world: LocalWorld; cursorPath: string; older: string; newer: string }> {
    const { db, world, cursorPath } = await standUp();
    const older = randomUUID();
    const newer = randomUUID();
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("rule", older, "create", 1, ruleDTO(older)),
        change("rule", newer, "create", 2, ruleDTO(newer, { destination: "ohmail/News", createdAt: NEWER, updatedAt: NEWER })),
      ], "c1")]),
    }).pullOnce();
    // What a pre-fix build left on disk: both rules stamped with one insert instant, and a
    // cursor file that has never heard of the repair.
    await db.update(rules).set({ createdAt: new Date(INSERT_INSTANT) }).where(eq(rules.accountId, world.accountId));
    dropRepairKey(cursorPath);
    return { db, world, cursorPath, older, newer };
  }
  const liveRules = (older: string, newer: string): SnapshotResponse => snapshotPage([
    change("rule", older, "create", 1, ruleDTO(older)),
    change("rule", newer, "create", 2, ruleDTO(newer, { destination: "ohmail/News", createdAt: NEWER, updatedAt: NEWER })),
  ]);

  it("one snapshot read rewrites them, announces each on the local log, marks the repair consumed and never re-asks", async () => {
    const { db, world, cursorPath, older, newer } = await staleMirror();
    const asked: string[] = [];
    const events: string[] = [];
    const mirror = createCloudMirror({
      db, world, cursorPath, now: () => new Date(), log: (e) => { events.push(e); },
      auth: fakeAuth([syncPage([], "c2"), syncPage([], "c3")], liveRules(older, newer), { asked }),
    });
    await mirror.pullOnce();
    expect((await ruleRow(db, older)).createdAt.toISOString(), "the older twin's instant was not restored").toBe(OLDER);
    expect((await ruleRow(db, newer)).createdAt.toISOString(), "the newer twin's instant was not restored").toBe(NEWER);
    // The window's own mirror drains this log; without a receipt the database is right and the
    // screen is not, which is the whole shape of the defect.
    const announced = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, world.accountId), eq(changeLog.entityType, "rule"), eq(changeLog.op, "update")));
    expect(announced.map((c) => c.entityId).sort()).toEqual([older, newer].sort());
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ ruleInstantRepair: true });
    expect(events).toContain("cloud_rule_instant_repair_applied");
    const snapshotAsks = asked.filter((p) => p.startsWith("/sync/snapshot")).length;
    await mirror.pullOnce();
    expect(asked.filter((p) => p.startsWith("/sync/snapshot")).length, "a consumed repair asked again").toBe(snapshotAsks);
  });

  it("a failed snapshot read leaves the repair unconsumed and the pull green; the next pull heals", async () => {
    const { db, world, cursorPath, older, newer } = await staleMirror();
    const mirror = createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([], "c2"), syncPage([], "c3")], liveRules(older, newer), { failSnapshotOnce: true }),
    });
    await mirror.pullOnce();   // the rejection is swallowed, the pull succeeds
    expect((await ruleRow(db, older)).createdAt.toISOString()).toBe(INSERT_INSTANT);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).not.toMatchObject({ ruleInstantRepair: true });
    await mirror.pullOnce();   // the retry heals
    expect((await ruleRow(db, older)).createdAt.toISOString()).toBe(OLDER);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ ruleInstantRepair: true });
  });

  it("a bootstrap replays every rule through the corrected arm and consumes the repair without a read", async () => {
    const { db, world, cursorPath } = await standUp();
    const ruleId = randomUUID();
    // An old build's cursor at the very start: no repair key, nothing drained yet.
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "0", bodies: null }));
    const events: string[] = [];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(), log: (e) => { events.push(e); },
      auth: fakeAuth([syncPage([change("rule", ruleId, "create", 1, ruleDTO(ruleId))], "c1")]),
    }).pullOnce();
    expect((await ruleRow(db, ruleId)).createdAt.toISOString()).toBe(OLDER);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ ruleInstantRepair: true });
    expect(events).not.toContain("cloud_rule_instant_repair_applied");
  });
});

describe("the Cloud-paired desktop presents a sender where the web does", () => {
  it("two same-sender rules mirrored through the local door present the sender where the hosted rules do", async () => {
    const { db, world, cursorPath } = await standUp();
    // Twins that tie on everything the router ranks, so its last clause (the id) decides: here the
    // News twin. The older twin is applied LAST, so an insert-time order would pick INBOX instead.
    const inboxTwin = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const newsTwin = "00000000-0000-4000-8000-000000000001";
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("rule", newsTwin, "create", 1, ruleDTO(newsTwin, { destination: "ohmail/News", createdAt: NEWER, updatedAt: NEWER })),
        change("rule", inboxTwin, "create", 2, ruleDTO(inboxTwin)),
      ], "c1")]),
    }).pullOnce();

    // The local door's RuleDTOs, as the window's engine receives them — read off the mirrored rows.
    const rows = await db.select().from(rules).where(eq(rules.accountId, world.accountId));
    const dtos: RuleDTO[] = rows.map((r) => ({
      id: r.id, kind: r.kind as RuleDTO["kind"], match: r.match, destination: r.destination as RuleDTO["destination"],
      priority: r.priority, provenance: r.provenance as RuleDTO["provenance"], enabled: r.enabled,
      subjectContains: r.subjectContains, bodyContains: r.bodyContains,
      stats: { hits: r.hits, lastHitAt: r.lastHitAt?.toISOString() ?? null, demotions: r.demotions },
      retro: { requestedAt: null, doneAt: null },
      byOhmail: false,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    }));
    expect(dtos).toHaveLength(2);
    // The sender's mail as both doors hold it — identical on the wire (measured), physically in the
    // INBOX because a decision rules the future and moves nothing already there.
    const msg: MessageDTO = {
      id: randomUUID(), accountId: CLOUD_ACCOUNT, mailboxId: CLOUD_MAILBOX, threadId: null,
      messageIdHeader: "<alert@notify.test>", subject: "Sign-in from a new device",
      from: { name: null, address: "alerts@notify.test" }, to: [{ name: null, address: "me@ohmail.test" }], cc: [],
      arrivedAt: "2026-09-22T08:00:00.000Z", date: "2026-09-22T08:00:00.000Z", folder: "INBOX",
      snippet: "", unread: true, lastReadAt: null, hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-22T08:00:00.000Z",
    };
    const held: Record<string, Array<{ id: string }>> = { rule: dtos, message: [msg] };
    const reader = {
      get: (type: string, id: string) => held[type]?.find((e) => e.id === id),
      list: (type: string) => held[type] ?? [],
      entries: (type: string) => (held[type] ?? []).map((e, i) => ({ id: e.id, entity: e, seq: i + 1 })),
      version: () => 1,
      stampOf: () => 1,
      stampExcept: () => 1,
    } as unknown as EntityReader;
    // INVERTED by ARCH-R902: a rule that moved nothing leaves the letter where the mailbox has it,
    // so the twin is read where it still decides — the sender's pile — on both doors.
    const part = consentPartition(reader, { now: new Date("2026-09-24T08:00:00.000Z"), ownAddresses: ["me@ohmail.test"] });
    expect(part.placeOf.get(msg.id), "the desktop moved a letter no rule moved").toBe("INBOX");
    expect(decidedDestination(consentIndex(dtos), msg.from.address), "the desktop decided the sender by the other twin")
      .toBe("ohmail/News");
    // And the control the web already passes: the same two rules with their hosted instants.
    const webRules = [ruleDTO(newsTwin, { destination: "ohmail/News", createdAt: NEWER, updatedAt: NEWER }), ruleDTO(inboxTwin)];
    const web: Record<string, Array<{ id: string }>> = { ...held, rule: webRules };
    const webReader = { ...reader, list: (type: string) => web[type] ?? [], get: (type: string, id: string) => web[type]?.find((e: { id: string }) => e.id === id) } as unknown as EntityReader;
    expect(consentPartition(webReader, { now: new Date("2026-09-24T08:00:00.000Z"), ownAddresses: ["me@ohmail.test"] }).placeOf.get(msg.id)).toBe("INBOX");
    expect(decidedDestination(consentIndex(webRules), msg.from.address)).toBe("ohmail/News");
    void (msg as unknown as EngineMessage);
  });
});

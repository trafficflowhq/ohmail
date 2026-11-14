import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, mailboxCredentials, mailboxes, type Tx } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core/mail";
import { formatClaim, isMalformed, parseClaim } from "@trafficflow/core/adapters/organizer-lease";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";
import { SYNC_KICK_EVERY_MS, startWorker } from "../src/index.js";
import { syncKickPass } from "../src/sync-kick.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * "HAND THE MAILBOX BACK" RINGS THE PASS (RULING-026 lane E). The release stamped only
 * `release_requested_at`, so the organizer honoured it at the next roster pass and cycle (60 s
 * measured). It now rings the doorbell, and the kick asks a roster first so the gate reads the
 * press. The release is the gate's FIRST arm, ahead of the renew: after the press no claim of ours
 * is appended and no permit is granted. A press over a foreign live claim still decides nothing.
 */

type Db = ReturnType<typeof makeDb>;
type Line = Record<string, unknown>;
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
const svc = makeMailboxService({ keyProvider: KP, allowance: async () => { /* unmetered here */ } });
const PRODUCTION = { pollIntervalMs: 60_000, rosterIntervalMs: 30_000 };
const INSTALL = "cloud-handback";
/* CLAIMS, NOT EVERY MESSAGE AN INSTALL WROTE: a consented organizer also publishes its settings
   document in `_meta`, which carries the same install header and outlives the claim by design. */
const claimsOf = (messages: readonly { raw: string }[], installId: string): number =>
  messages.filter((m) => {
    const c = parseClaim(m.raw);
    return c !== null && !isMalformed(c) && c.installId === installId;
  }).length;

/** The bound the brief sets for press -> no claim of ours in `_meta`. */
const RELEASED_WITHIN_MS = 10_000;

let DB = "";

/** A consented mailbox the person handed back once: a reader, the release marker standing. */
async function handedBack(db: Db): Promise<ServiceContext & { mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "hand-back" });
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    organizerRole: "reader", organizeConsentedAt: new Date(Date.now() - 3_600_000),
    organizerReleasedAt: new Date(Date.now() - 60_000),
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { db, accountId, userId: null, now: () => new Date(), requestId: randomUUID(), mailboxId: row!.id };
}

const rowOf = async (db: Db, id: string) =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

async function waitFor(pred: () => Promise<boolean> | boolean, ms: number, step = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const foreignClaim = (): string => formatClaim({
  authorizedAt: null, capabilities: [], installId: "a-desktop-install", kind: "local",
  displayName: "the laptop", heartbeat: new Date(), claimedAt: new Date(), nonce: randomUUID(),
});

describe("Hand the mailbox back rings the pass", () => {
  const closers: Array<() => Promise<void>> = [];
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_handback"); }, 120_000);
  afterEach(async () => {
    for (const c of closers.splice(0)) await c().catch(() => undefined);
    await truncateAll(DB);
  }, ISOLATED_DB_RESET_BUDGET_MS);
  afterAll(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });

  async function boot(fleet: FakeAdapterFleet, lines: Line[]) {
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, ...PRODUCTION, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: INSTALL, displayName: "Cloud", staleAfterMs: 60_000 },
      logger: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(JSON.parse(l) as Line) }),
    });
    closers.push(() => worker.stop());
    return worker;
  }

  it("the release rings the doorbell, and the kick asks for a roster before the cycle", async () => {
    const db = makeDb(DB);
    const ctx = await handedBack(db);
    await db.update(mailboxes).set({ organizerRole: "organizer", organizerReleasedAt: null })
      .where(eq(mailboxes.id, ctx.mailboxId));
    expect((await svc.release(ctx, ctx.mailboxId)).outcome).toBe("requested");
    const row = await rowOf(db, ctx.mailboxId);
    expect(row.syncRequestedAt, "the release rang no doorbell").not.toBeNull();
    expect(row.takeoverAuthorizedAt, "the premise: no Organize-here press stands").toBeNull();

    const order: string[] = [];
    const res = await syncKickPass({
      db: db as unknown as Tx, served: () => [ctx.mailboxId],
      kick: (id) => { order.push(`kick:${id}`); },
      leasePressed: (id) => { order.push(`roster:${id}`); },
    });
    expect(order, "the cycle would gate on the lease read before the release")
      .toEqual([`roster:${ctx.mailboxId}`, `kick:${ctx.mailboxId}`]);
    expect(res.cleared).toBe(1);

    // CONTROL: a doorbell with no lease press pending kicks and asks no roster.
    const other = await handedBack(db);
    await db.update(mailboxes).set({ syncRequestedAt: new Date() }).where(eq(mailboxes.id, other.mailboxId));
    const plain: string[] = [];
    await syncKickPass({
      db: db as unknown as Tx, served: () => [other.mailboxId],
      kick: (id) => { plain.push(`kick:${id}`); }, leasePressed: (id) => { plain.push(`roster:${id}`); },
    });
    expect(plain).toEqual([`kick:${other.mailboxId}`]);
  }, 60_000);

  /* THREE PRESSES at production intervals: one landing while the POLL's cycle is in flight (parked
     inside `changesSince`), two at different points of the idle poll interval. Each: no claim of
     ours in `_meta` within 10 s, the row released, and nothing renewed or permitted after the press. */
  it(`three hand-backs at production intervals: no claim of ours within ${RELEASED_WITHIN_MS / 1000} s, no renew after the press`, async () => {
    const db = makeDb(DB);
    const ctx = await handedBack(db);
    const fleet = new FakeAdapterFleet();
    const lines: Line[] = [];
    await boot(fleet, lines);
    expect(await waitFor(() => fleet.syncs > 0, 20_000), "the reader never synced").toBe(true);
    const meta = fleet.metaFor(ctx.mailboxId);
    const ours = () => claimsOf(meta.messages, INSTALL);

    const readings: string[] = [];
    for (const shape of ["mid-cycle", "idle 12 s", "idle 37 s"] as const) {
      expect((await svc.organizeHere(ctx, ctx.mailboxId, { intent: "takeover" })).outcome).toBe("authorized");
      expect(await waitFor(async () => ours() === 1
        // The poll's bound, not the kick's: this prelude is the Organize-here twin's subject, and a
        // mutation of the shared wiring must redden the RELEASE below rather than stop here.
        && (await rowOf(db, ctx.mailboxId)).organizerRole === "organizer", PRODUCTION.pollIntervalMs + 20_000), `${shape}: never organized`).toBe(true);

      let openGate: () => void = () => undefined;
      if (shape === "mid-cycle") {
        // The poll's own cycle, parked: no wake of ours, so the only thing that can visit is the kick.
        fleet.behave(ctx.mailboxId, { syncGate: new Promise<void>((r) => { openGate = r; }) });
        expect(await waitFor(() => fleet.syncInFlight > 0, PRODUCTION.pollIntervalMs + 10_000), "no cycle in flight").toBe(true);
      } else {
        await sleep(shape === "idle 12 s" ? 12_000 : 37_000);
      }

      const traceMark = fleet.trace.length;
      const lineMark = lines.length;
      const pressedAt = Date.now();
      expect((await svc.release(ctx, ctx.mailboxId)).outcome).toBe("requested");
      if (shape === "mid-cycle") {
        await sleep(1_500);
        fleet.behave(ctx.mailboxId, { syncGate: undefined });
        openGate();
      }
      const gone = await waitFor(() => ours() === 0, 40_000);
      const ms = Date.now() - pressedAt;
      const released = await waitFor(async () => {
        const r = await rowOf(db, ctx.mailboxId);
        return r.organizerRole === "reader" && r.releaseRequestedAt === null;
      }, Math.max(0, RELEASED_WITHIN_MS - (Date.now() - pressedAt)));
      readings.push(`${shape}: ${ms} ms`);
      expect(gone, `${shape}: the release was never honoured`).toBe(true);
      expect(ms, `${shape}: the release waited for the cycle, not the kick`).toBeLessThan(RELEASED_WITHIN_MS);
      expect(released, `${shape}: the row was not released within the bound`).toBe(true);

      const renewed = fleet.trace.slice(traceMark).filter((e) => e.mailboxId === ctx.mailboxId && e.event === "lease_organize");
      expect(renewed, `${shape}: a claim of ours was appended after the press`).toEqual([]);
      const permits = lines.slice(lineMark).filter((l) => l.event === "lease_permit_granted"
        && l.mailboxId === ctx.mailboxId && l.stamped === true);
      expect(permits, `${shape}: a permit was granted after the press`).toEqual([]);
      // Still none of ours, a few seconds on: the release is not undone by a later renew.
      await sleep(3_000);
      expect(ours(), `${shape}: a claim of ours came back`).toBe(0);
    }
    process.stdout.write(`[handback] press -> no claim of ours: ${readings.join(" · ")}\n`);
  }, 300_000);

  /* THE KICK'S WINDOW, MEASURED. The kick scan reads the press at most 3 s after it; a visit that
     starts inside that window (here two mail-arrival wakes, around the press) gates on the lease
     read before the press and renews. Every such renew lands inside that window, the release
     follows within the bound, and nothing of ours survives it. Before the doorbell the window was
     the roster interval and the next cycle. */
  it("a wake inside the kick's window renews only inside it, and the release still lands within the bound", async () => {
    const db = makeDb(DB);
    const ctx = await handedBack(db);
    const fleet = new FakeAdapterFleet();
    const fleetAt = Date.now();
    const lines: Line[] = [];
    await boot(fleet, lines);
    expect(await waitFor(() => fleet.syncs > 0, 20_000)).toBe(true);
    const meta = fleet.metaFor(ctx.mailboxId);
    const ours = () => claimsOf(meta.messages, INSTALL);
    expect((await svc.organizeHere(ctx, ctx.mailboxId, { intent: "takeover" })).outcome).toBe("authorized");
    expect(await waitFor(async () => ours() === 1
      && (await rowOf(db, ctx.mailboxId)).organizerRole === "organizer", 20_000)).toBe(true);
    let openGate: () => void = () => undefined;
    fleet.behave(ctx.mailboxId, { syncGate: new Promise<void>((r) => { openGate = r; }) });
    expect(await waitFor(() => fleet.signal.has(ctx.mailboxId), 10_000), "no watch to wake").toBe(true);
    fleet.signal.get(ctx.mailboxId)!();
    expect(await waitFor(() => fleet.syncInFlight > 0, 10_000), "no cycle in flight").toBe(true);
    const traceMark = fleet.trace.length;
    const pressedAt = Date.now();
    expect((await svc.release(ctx, ctx.mailboxId)).outcome).toBe("requested");
    fleet.signal.get(ctx.mailboxId)?.();
    await sleep(500);
    fleet.behave(ctx.mailboxId, { syncGate: undefined });
    openGate();
    const gone = await waitFor(() => ours() === 0, 40_000);
    const ms = Date.now() - pressedAt;
    const renews = fleet.trace.slice(traceMark)
      .filter((e) => e.mailboxId === ctx.mailboxId && e.event === "lease_organize")
      .map((e) => fleetAt + e.atMs - pressedAt);
    process.stdout.write(`[handback] woken in the kick's window: press -> no claim ${ms} ms, renews after the press at ${renews.join(", ") || "none"} ms\n`);
    expect(gone).toBe(true);
    expect(ms).toBeLessThan(RELEASED_WITHIN_MS);
    // One kick interval plus the scan's own read and the roster turn: past that, the gate has the press.
    expect(renews.filter((at) => at > SYNC_KICK_EVERY_MS + 1_000), "a renew landed after the kick had read the press").toEqual([]);
    await sleep(3_000);
    expect(ours(), "a claim of ours came back after the release").toBe(0);
  }, 120_000);

  it("a hand-back over a foreign live claim removes ours and certifies nothing", async () => {
    const db = makeDb(DB);
    const ctx = await handedBack(db);
    const fleet = new FakeAdapterFleet();
    const lines: Line[] = [];
    await boot(fleet, lines);
    expect(await waitFor(() => fleet.syncs > 0, 20_000)).toBe(true);
    const meta = fleet.metaFor(ctx.mailboxId);
    const ours = () => claimsOf(meta.messages, INSTALL);
    expect((await svc.organizeHere(ctx, ctx.mailboxId, { intent: "takeover" })).outcome).toBe("authorized");
    expect(await waitFor(() => ours() === 1, 20_000)).toBe(true);

    fleet.seedClaim(ctx.mailboxId, foreignClaim());
    const traceMark = fleet.trace.length;
    expect((await svc.release(ctx, ctx.mailboxId)).outcome).toBe("requested");
    expect(await waitFor(() => ours() === 0, RELEASED_WITHIN_MS), "our claim stayed").toBe(true);
    expect(await waitFor(() => lines.some((l) => l.event === "organizer_release_withheld"), 5_000),
      "the release was certified over a live holder").toBe(true);
    await sleep(3_000);
    const row = await rowOf(db, ctx.mailboxId);
    expect(row.releaseRequestedAt, "the request was spent while another install holds the mailbox").not.toBeNull();
    expect(claimsOf(meta.messages, "a-desktop-install")).toBe(1);
    // The mark is taken after the foreign claim was seeded, so any append since is ours.
    expect(fleet.trace.slice(traceMark).filter((e) => e.event === "lease_organize"), "a claim of ours was appended").toEqual([]);
    expect(ours()).toBe(0);
  }, 90_000);

  it("an Organize-here press during a foreign live claim still refuses", async () => {
    const db = makeDb(DB);
    const ctx = await handedBack(db);
    const fleet = new FakeAdapterFleet();
    fleet.seedClaim(ctx.mailboxId, foreignClaim());
    const lines: Line[] = [];
    await boot(fleet, lines);
    expect(await waitFor(() => fleet.syncs > 0, 20_000)).toBe(true);
    const meta = fleet.metaFor(ctx.mailboxId);
    const appendsBefore = meta.appends;
    // The reader's look has recorded the live holder, so the door itself refuses the join.
    const verdict = await svc.organizeHere(ctx, ctx.mailboxId, { intent: "join" })
      .then((r) => r.outcome as string, (err: unknown) => (err as Error).name);
    expect(verdict).toBe("OrganizedElsewhereError");
    expect((await rowOf(db, ctx.mailboxId)).takeoverAuthorizedAt, "a refused press left a stamp").toBeNull();
    // And nothing the doorbell can do claims it: the release bound and then some.
    await sleep(RELEASED_WITHIN_MS);
    expect(meta.appends, "a claim was appended over a live foreign holder").toBe(appendsBefore);
    expect((await rowOf(db, ctx.mailboxId)).organizerRole).toBe("reader");
  }, 90_000);
});

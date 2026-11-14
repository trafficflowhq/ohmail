import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts, mailboxes, mailboxCredentials, messageBodies, messageInstances, messages, messageSearch, routingDecisions,
  trackerEvents, workflows, workflowRuns, parkedResumeSet, parkedResumeWhere, type Tx,
} from "@trafficflow/db";
import { accountLifecycleNotices, makeDb, pushSubscriptions } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger, type DraftPort, type Logger } from "@trafficflow/core";
import { reindexMessageSearch } from "@trafficflow/core/mail";
import {
  formatClaim, isMalformed, parseClaim, type OrganizerClaim,
} from "@trafficflow/core/adapters/organizer-lease";
import { ImapBoundExceeded } from "@trafficflow/core/adapters/imap";
import { runWorkerSupervised } from "../src/supervisor.js";
import { DEFAULT_SYNC_BLOCK_GRACE_MS, type WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet, type FakeControl } from "./_fakeadapter.js";
// The door the first client read after a reopening goes through, driven against the rows this
// worker left: the catch-up is the two halves meeting, so it is measured where they meet.
import { reopenedCatchUp } from "../../../packages/api/src/account-reopen.js";

/**
 * THE WALL'S ROSTER HALF, DRIVEN THROUGH THE REAL WORKER (mail 0124).
 *
 * The parking seam existed, was tested at the loader, and ran NOWHERE: no production caller
 * supplied a `ParkedAccountsReader`, so a refused account kept syncing and organizing while its
 * owner met the refusal — the codebase's own built-tested-unreachable failure, on the roster. These
 * cases drive `startWorker` against a FAKE PLANE on a loopback socket (the real entitlements
 * client, the real composition, the real roster; what is faked is the provider and the plane),
 * and the fleet's `_meta` is a real in-memory `LeaseIo`, so the claim's removal is measured on
 * the folder, not on a mock.
 *
 * Each of the two call sites has a case that REDDENS if its reader is removed:
 *  · the ROSTER site — the park case (detach, release, reason, push rows);
 *  · the CYCLE-TAIL site — the snooze case (a parked account's due snooze must NOT resurface,
 *    while an open account's does, in the same run).
 */

type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9));
let DB = "";

/** The fake plane: the wire bodies `verdictOf` reads, flipped per account by the test. */
function fakePlane(): {
  server: Server; url: () => string; parked: Set<string>; close: () => Promise<void>;
  /** Every answer, in order: which account, whether it was refused, and when. */
  answered: Array<{ accountId: string; closed: boolean; at: number }>;
  /** Called right after an answer is written — where a case acts at the plane's own instant. */
  onAnswer: { fn: ((accountId: string, closed: boolean) => void) | null };
  /** While `on`, every call is answered 429 (the limiter of the edge in front of the plane, 2026-11-10),
   *  counted per account. The client asks a 429 once more, so one read is two of these. */
  limited: { on: boolean; count: Map<string, number> };
} {
  const parked = new Set<string>();
  const answered: Array<{ accountId: string; closed: boolean; at: number }> = [];
  const onAnswer: { fn: ((accountId: string, closed: boolean) => void) | null } = { fn: null };
  const limited = { on: false, count: new Map<string, number>() };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const accountId = (JSON.parse(raw || "{}") as { accountId?: string }).accountId ?? "";
      if (limited.on) {
        limited.count.set(accountId, (limited.count.get(accountId) ?? 0) + 1);
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "rate_limited" }));
        return;
      }
      const closed = parked.has(accountId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        entitlements: {
          mailboxLimit: closed ? 0 : null, canAddMailbox: !closed,
          aiEnabled: !closed, syncEnabled: !closed,
          storageBytesLimit: null, reason: closed ? "canceled" : "active",
        },
        balance: 0, setupCredits: { remaining: 0, expiresAt: null },
        storageUsedBytes: 0, invoiceGranted: false, manageUrl: null,
        lifecycle: closed
          ? {
              state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
              closedAt: "2026-09-01T00:00:00.000Z", erasureAt: "2026-10-01T00:00:00.000Z",
              erasedAt: null, formerlyPaid: false,
            }
          : {
              state: "active", closedReason: null, trialEndsAt: null, graceUntil: null,
              closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: false,
            },
      }));
      answered.push({ accountId, closed, at: Date.now() });
      onAnswer.fn?.(accountId, closed);
    });
  });
  return {
    server,
    parked,
    answered,
    onAnswer,
    limited,
    url: () => {
      const a = server.address();
      if (a === null || typeof a === "string") throw new Error("the fake plane has no port");
      return `http://127.0.0.1:${a.port}`;
    },
    close: () => new Promise((r) => { server.close(() => { r(); }); }),
  };
}

/** One consented organizer mailbox + credential + a push row — the product's own shape; `row` overrides it. */
async function seedAccount(
  db: Db, row: Partial<typeof mailboxes.$inferInsert> = {},
): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "wall" });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 3_600_000), ...row,
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  await db.insert(pushSubscriptions).values({
    accountId, transport: "webpush", endpoint: `https://push.example/${accountId}`,
  });
  return { accountId, mailboxId: mb!.id };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start >= ms) throw new Error(`timed out after ${ms}ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function quietLogger(): Logger {
  return createLogger({ service: "worker", level: "error", sink: () => { /* dropped */ } });
}

/** A logger that keeps every line, so a case can ask what the worker SAID it did, and in what order. */
function recordingLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    service: "worker", level: "info", sink: (l: string) => { lines.push(JSON.parse(l) as Record<string, unknown>); },
  });
  return { logger, lines };
}
const said = (lines: Array<Record<string, unknown>>, event: string, mailboxId: string) =>
  lines.filter((l) => l.event === event && l.mailboxId === mailboxId);

function cfgFor(fleet: FakeAdapterFleet, planeUrl: string, extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 250, sentDomain: "trafficflow.test",
    rosterIntervalMs: 400, lockHeartbeatMs: 60_000, mailboxRetryMs: 500,
    healthPort: 0, standbyRetryMs: 400, adapterFactory: fleet.factory, logger: quietLogger(),
    // Grace 0: the block's WRITE is under test here, not the anti-flap window in front of it.
    syncBlockGraceMs: 0,
    organizer: { installId: "cloud-wall", displayName: "Cloud", staleAfterMs: 60_000 },
    entitlements: { url: planeUrl, secret: "x".repeat(24), accessTtlMs: 150 },
    ...extra,
  };
}

/**
 * What `GET /account/access` writes when it reads open (`packages/api/src/account-reopen.ts`): the
 * `account_closed` clear and the resume stamp, one transaction, both ringing the worker's kick.
 */
async function doorReopens(db: Db, accountId: string, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(mailboxes)
      .set({ syncBlockedReason: null, syncBlockedSince: null, syncRequestedAt: now })
      .where(and(eq(mailboxes.accountId, accountId), eq(mailboxes.syncBlockedReason, "account_closed")));
    await tx.update(mailboxes).set(parkedResumeSet(now))
      .where(and(eq(mailboxes.accountId, accountId), parkedResumeWhere()));
  });
}

const rowOf = async (db: Db, mailboxId: string) => {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return row!;
};
const pushCount = async (db: Db, accountId: string): Promise<number> =>
  (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.accountId, accountId))).length;
const reopenedRows = async (db: Db, accountId: string) => db.select().from(accountLifecycleNotices)
  .where(and(eq(accountLifecycleNotices.accountId, accountId), eq(accountLifecycleNotices.kind, "reopened")));

const WHOLE = {
  from: ["Anna <anna@example.test>"], to: ["me@example.test"], subject: ["harbour ledger"], "message-id": ["<old@example.test>"],
  received: ["from mx.example.test by in.example.test"], references: ["<first@example.test>"],
};
const ALL = { snippet: "the ledger", documents: 1, rationale: "Order 4411 to the harbour", tracker: "https://t.example.test/o/4411", headers: WHOLE };
const NONE = { snippet: "", documents: 0, rationale: null, tracker: null, headers: { to: WHOLE.to, references: WHOLE.references } };

/** A stored letter with all its words. `gone`: deleted on the server and emptied, no copy on record. */
async function storedLetter(db: Db, at: { accountId: string; mailboxId: string }, gone: boolean): Promise<string> {
  const { accountId, mailboxId } = at;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, bodyHash: "h", dedupKey: `wall:${randomUUID()}`, subject: "harbour ledger", fromAddress: "anna@example.test",
    snippet: ALL.snippet, deletedAt: gone ? new Date() : null, nativeLocator: { folder: "INBOX", ref: "1:7" },
  }).returning();
  const messageId = m!.id;
  await db.insert(messageBodies).values({ messageId, accountId, text: gone ? "" : ALL.snippet, html: null, headers: WHOLE, withheldReason: gone ? "expunged" : null });
  if (!gone) await db.insert(messageInstances).values({ accountId, messageId, mailboxId, folder: "INBOX", uid: 7, uidvalidity: 1n, isPrimary: true });
  await reindexMessageSearch(db as unknown as Tx, accountId, messageId);
  await db.insert(routingDecisions).values({
    accountId, messageId, inputProvenance: "ai", destination: "ohmail/Receipts", status: "auto_applied", rationale: ALL.rationale,
  });
  await db.insert(trackerEvents).values({ accountId, messageId, kind: "pixel", trackerHost: "t.example.test", url: ALL.tracker });
  return messageId;
}
const wordsOf = async (db: Db, id: string) => ({
  snippet: (await db.select({ v: messages.snippet }).from(messages).where(eq(messages.id, id)))[0]!.v,
  documents: (await db.select({ v: messageSearch.messageId }).from(messageSearch).where(eq(messageSearch.messageId, id))).length,
  rationale: (await db.select({ v: routingDecisions.rationale }).from(routingDecisions).where(eq(routingDecisions.messageId, id)))[0]!.v,
  tracker: (await db.select({ v: trackerEvents.url }).from(trackerEvents).where(eq(trackerEvents.messageId, id)))[0]!.v,
  headers: (await db.select({ v: messageBodies.headers }).from(messageBodies).where(eq(messageBodies.messageId, id)))[0]!.v,
});

describe("a parked account leaves the roster and its organizer stands down (mail 0124)", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_wall"); }, 60_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("park: detached, claim gone from _meta, row released with consent KEPT, push rows gone — " +
     "ONCE per closure, with the open account untouched beside it", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);

    const A = await seedAccount(db);   // stays open — the positive control
    const B = await seedAccount(db);   // will be parked

    const fleet = new FakeAdapterFleet();
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url()));
    closers.push(() => w.stop());

    // Both attach and claim their folders — the state a mass park starts from.
    await waitFor(async () =>
      (await fleet.metaFor(A.mailboxId).listClaims()).length > 0
      && (await fleet.metaFor(B.mailboxId).listClaims()).length > 0,
    20_000, "both mailboxes to claim their _meta");

    plane.parked.add(B.accountId);

    // The roster's whole park, measured on the folder and the row.
    await waitFor(async () => (await fleet.metaFor(B.mailboxId).listClaims()).length === 0,
      20_000, "B's claim to leave ohmail/_meta");
    await waitFor(async () => (await rowOf(db, B.mailboxId)).syncBlockedReason === "account_closed",
      20_000, "B's row to say account_closed");
    const released = await rowOf(db, B.mailboxId);
    expect(released.organizerRole).toBe("reader");
    expect(released.organizedByKind).toBeNull();
    expect(released.organizedByInstallId).toBeNull();
    // CONSENT KEPT — the whole difference from a disable: reopening resumes by a press, not a re-ask.
    expect(released.organizeConsentedAt).not.toBeNull();
    expect(released.disabledReason, "NEVER disabled_reason — the CHECK refuses account_closed there")
      .toBeNull();
    await waitFor(async () => (await pushCount(db, B.accountId)) === 0,
      20_000, "B's push subscriptions to be deleted");

    // The OPEN account is untouched beside it — without this, a reader that parks everybody
    // passes every assertion above.
    const a = await rowOf(db, A.mailboxId);
    expect(a.organizerRole).toBe("organizer");
    expect(a.syncBlockedReason).toBeNull();
    expect((await fleet.metaFor(A.mailboxId).listClaims()).length).toBeGreaterThan(0);
    expect(await pushCount(db, A.accountId)).toBe(1);

    // ONCE PER CLOSURE: the release stamped its event; two more roster passes move nothing.
    const stampedAt = released.organizerEventAt?.getTime() ?? null;
    expect(stampedAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1_200));
    const again = await rowOf(db, B.mailboxId);
    expect(again.organizerEventAt?.getTime()).toBe(stampedAt);
    expect(again.organizerRole).toBe("reader");
  }, 60_000);

  it("un-park: the reason clears and the wall's release is ORGANIZED again within one roster pass, " +
     "while a local claim planted during the closure keeps its mailbox and is asked once", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);

    const B = await seedAccount(db);
    const C = await seedAccount(db);   // the planted-claim variant

    const fleet = new FakeAdapterFleet();
    const rec = recordingLogger();
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url(), { logger: rec.logger }));
    closers.push(() => w.stop());

    await waitFor(async () =>
      (await fleet.metaFor(B.mailboxId).listClaims()).length > 0
      && (await fleet.metaFor(C.mailboxId).listClaims()).length > 0,
    20_000, "both mailboxes to claim");
    plane.parked.add(B.accountId);
    plane.parked.add(C.accountId);
    await waitFor(async () => (await rowOf(db, B.mailboxId)).organizerRole === "reader"
      && (await rowOf(db, C.mailboxId)).organizerRole === "reader",
    20_000, "both rows to be released");
    await waitFor(async () => (await fleet.metaFor(C.mailboxId).listClaims()).length === 0,
      20_000, "C's own claim to be released");
    // THE MARKER, read off the ROW: the park wrote it, so the resume below reads a fact the loader
    // selected rather than one this test planted.
    expect((await rowOf(db, B.mailboxId)).organizerParkedAt, "the park records itself").not.toBeNull();

    // During the closure, a DESKTOP install takes C's mailbox — the leave-anytime story.
    fleet.seedClaim(C.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "a-desktop-install", kind: "local", displayName: "A MacBook",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "wall-c1",
    }));

    plane.parked.delete(B.accountId);
    plane.parked.delete(C.accountId);

    // B: the wall's release comes back as a JOIN and the gate organizes it.
    await waitFor(async () => (await rowOf(db, B.mailboxId)).organizerRole === "organizer"
      && (await rowOf(db, B.mailboxId)).syncBlockedReason === null,
    20_000, "B to be organized again, with its account_closed cleared");
    const b = await rowOf(db, B.mailboxId);
    expect(b.syncBlockedReason).toBeNull();
    expect(b.organizerParkedAt, "the promotion spends the resume").toBeNull();
    expect(b.takeoverAuthorizedAt, "and the stamp with it").toBeNull();
    const bClaims = await fleet.metaFor(B.mailboxId).listClaims();
    expect(bClaims.map((m) => parseClaim(m.raw)).map((c) => (c && !isMalformed(c) ? c.installId : null)))
      .toEqual(["cloud-wall"]);
    expect(said(rec.lines, "organizer_parked_resume", B.mailboxId)).toHaveLength(1);
    // WITHIN ONE ROSTER PASS: the stamp is mirrored into the pass that wrote it, so the attach runs
    // the gate with it. Without the mirror that attach peeks, and a later pass promotes.
    const resumedAt = rec.lines.indexOf(said(rec.lines, "organizer_parked_resume", B.mailboxId)[0]!);
    expect(rec.lines.slice(resumedAt).filter((l) =>
      l.event === "organizer_reader_peek_only" && l.mailboxId === B.mailboxId && l.phase === "attach"),
    "the attach after the resume must not peek").toHaveLength(0);

    // C: a LIVE local claim wins the join. The row names the holder, the marker is spent by the
    // stand-down, and the resume is asked once however many passes follow.
    await waitFor(async () => (await rowOf(db, C.mailboxId)).organizedByKind === "local",
      20_000, "C's row to name the desktop holder");
    const claims = await fleet.metaFor(C.mailboxId).listClaims();
    expect(claims).toHaveLength(1);
    // Three reader cycles after the stand-down, counted off the line each one logs.
    const stoodDownAt = rec.lines.length;
    await waitFor(() => said(rec.lines.slice(stoodDownAt), "organizer_reader_peek_only", C.mailboxId).length >= 3,
      20_000, "three of C's reader cycles after the stand-down");
    const c = await rowOf(db, C.mailboxId);
    expect(c.organizerRole).toBe("reader");
    expect(c.organizerParkedAt, "a lost join clears the marker").toBeNull();
    expect(c.takeoverAuthorizedAt).toBeNull();
    expect(said(rec.lines, "organizer_parked_resume", C.mailboxId), "one stamp, never a loop").toHaveLength(1);
  }, 60_000);

  it("a mailbox the PERSON released before the wall stays a reader after the account reopens", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);

    const P = await seedAccount(db);
    const fleet = new FakeAdapterFleet();
    const rec = recordingLogger();
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url(), { logger: rec.logger }));
    closers.push(() => w.stop());
    await waitFor(async () => (await fleet.metaFor(P.mailboxId).listClaims()).length > 0,
      20_000, "P to claim");

    // "Stop organizing here, keep the mail" — the person's own release, honoured by the worker.
    await db.update(mailboxes).set({ releaseRequestedAt: new Date() }).where(eq(mailboxes.id, P.mailboxId));
    await waitFor(async () => (await rowOf(db, P.mailboxId)).organizerReleasedAt !== null,
      20_000, "P's release to be recorded");
    expect((await rowOf(db, P.mailboxId)).organizerParkedAt, "the person's release writes no marker").toBeNull();

    plane.parked.add(P.accountId);
    await waitFor(async () => (await rowOf(db, P.mailboxId)).syncBlockedReason === "account_closed",
      20_000, "P's account to be parked");
    plane.parked.delete(P.accountId);
    const reopenedAt = rec.lines.length;
    await waitFor(async () => (await rowOf(db, P.mailboxId)).syncBlockedReason === null,
      20_000, "P's account_closed to clear");
    // Three reader cycles after the reopening, counted off the line each one logs.
    await waitFor(() => said(rec.lines.slice(reopenedAt), "organizer_reader_peek_only", P.mailboxId).length >= 3,
      20_000, "three of P's reader cycles after the reopening");
    const p = await rowOf(db, P.mailboxId);
    expect(p.organizerRole, "the person's stop outlives the closure").toBe("reader");
    expect(p.takeoverAuthorizedAt).toBeNull();
    expect((await fleet.metaFor(P.mailboxId).listClaims()).length).toBe(0);
    expect(said(rec.lines, "organizer_parked_resume", P.mailboxId)).toHaveLength(0);
  }, 60_000);

  it("Cloud's OWN stale claim, its nonce lost, is organized again by continuation after the reopening", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);

    const O = await seedAccount(db);
    const fleet = new FakeAdapterFleet();
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url()));
    closers.push(() => w.stop());
    await waitFor(async () => (await fleet.metaFor(O.mailboxId).listClaims()).length > 0,
      20_000, "O to claim");
    plane.parked.add(O.accountId);
    await waitFor(async () => (await rowOf(db, O.mailboxId)).organizerRole === "reader"
      && (await fleet.metaFor(O.mailboxId).listClaims()).length === 0,
    20_000, "O to be released");

    // What a restart mid-park leaves: a record under THIS deployment's own install id, a nonce no
    // runtime holds, and a heartbeat long past the staleness window.
    const old = new Date(Date.now() - 10 * 60_000);
    fleet.seedClaim(O.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "cloud-wall", kind: "cloud", displayName: "Cloud",
      heartbeat: old, claimedAt: old, nonce: "lost-across-a-restart",
    }));

    plane.parked.delete(O.accountId);
    await waitFor(async () => (await rowOf(db, O.mailboxId)).organizerRole === "organizer",
      20_000, "O to be organized again");
    const o = await rowOf(db, O.mailboxId);
    expect(o.organizerParkedAt).toBeNull();
    expect(o.organizedByInstallId).toBeNull();
    const live = (await fleet.metaFor(O.mailboxId).listClaims())
      .map((m) => parseClaim(m.raw))
      .filter((c): c is OrganizerClaim => c !== null && !isMalformed(c))
      .filter((c) => c.installId === "cloud-wall" && Date.now() - c.heartbeat.getTime() < 60_000);
    expect(live.length, "a fresh claim under Cloud's own id").toBeGreaterThan(0);
  }, 60_000);

  /**
   * THE the TIMING: the worker holds a refusal read moments
   * before the payment, the door clears `account_closed` and stamps the kick, and the kicked roster
   * pass arrives inside the refusal's five seconds. Production TTLs, and a roster interval long
   * enough that the kicked pass is the only one in the window. The door acts the instant the plane
   * has answered the worker's refusal, so the held refusal predates the clear by milliseconds.
   */
  const heldRefusalCase = async (planeAfterDoor: "open" | "refused") => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);
    const B = await seedAccount(db);
    plane.parked.add(B.accountId);
    const fleet = new FakeAdapterFleet();
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url(), {
      rosterIntervalMs: 20_000,
      entitlements: { url: plane.url(), secret: "x".repeat(24) },
    }));
    closers.push(() => w.stop());
    await waitFor(async () => (await rowOf(db, B.mailboxId)).syncBlockedReason === "account_closed"
      && (await pushCount(db, B.accountId)) === 0, 20_000, "the boot pass to park B and take its push row");
    expect((await rowOf(db, B.mailboxId)).organizerParkedAt).not.toBeNull();

    // The next refusal the worker is answered is the one it holds: the door acts right behind it.
    let doorAt = 0;
    await new Promise<void>((resolve) => {
      plane.onAnswer.fn = (accountId, closed) => {
        if (accountId !== B.accountId || !closed) return;
        plane.onAnswer.fn = null;
        if (planeAfterDoor === "open") plane.parked.delete(B.accountId);
        doorAt = Date.now();
        // The door, then the lift's push re-announce (the the POST 201 at +0.94 s).
        void doorReopens(db, B.accountId, new Date(doorAt))
          .then(() => db.insert(pushSubscriptions).values({
            accountId: B.accountId, transport: "webpush", endpoint: `https://push.example/${B.accountId}/lift`,
          }))
          .then(() => { resolve(); });
      };
    });
    return { db, plane, B, doorAt };
  };

  it("a refusal held from BEFORE the door's clear never re-blocks the row nor takes the push row " +
     "the lift re-announced: the kicked pass organizes it instead (the end-to-end test's own timing)", async () => {
    const { db, B } = await heldRefusalCase("open");
    // Every 25 ms until the row is organized, noting the first sight of either effect. Well inside
    // the 20 s roster tick, so the pass that organizes it is the KICKED one.
    const start = Date.now();
    const seen = { reblockedAfterMs: null as number | null, pushTakenAfterMs: null as number | null };
    const organized = await waitFor(async () => {
      const r = await rowOf(db, B.mailboxId);
      if (r.syncBlockedReason !== null) seen.reblockedAfterMs ??= Date.now() - start;
      if ((await pushCount(db, B.accountId)) !== 1) seen.pushTakenAfterMs ??= Date.now() - start;
      return r.organizerRole === "organizer";
    }, 12_000, "B to be organized by the kicked pass").then(() => true, () => false);
    expect(seen, "neither effect of a refusal held from before the clear").toEqual(
      { reblockedAfterMs: null, pushTakenAfterMs: null });
    expect(organized, "B organized by the kicked pass").toBe(true);
    expect(await pushCount(db, B.accountId)).toBe(1);
  }, 60_000);

  it("…and a refusal read AFTER the clear still blocks it and takes its push rows (the positive control)", async () => {
    const { db, plane, B, doorAt } = await heldRefusalCase("refused");
    await waitFor(async () => (await rowOf(db, B.mailboxId)).syncBlockedReason === "account_closed"
      && (await pushCount(db, B.accountId)) === 0, 12_000, "a refusal read after the clear to block B again");
    expect(plane.answered.some((a) => a.accountId === B.accountId && a.closed && a.at > doorAt),
      "the block rests on a refusal the plane gave after the clear").toBe(true);
    expect((await rowOf(db, B.mailboxId)).organizerRole).toBe("reader");
  }, 60_000);

  /* THE EDGE IN FRONT OF THE PLANE ANSWERING 429 (2026-11-10): a worker that started inside it held
     no answer, allowed, and unparked a closed account: its block cleared, its mailbox signed in to.
     The stored block is the plane's last answer, so it stands until the plane answers again. */
  const walledAt = (at: Date) => ({
    organizerRole: "reader", organizerParkedAt: at, syncBlockedReason: "account_closed", syncBlockedSince: at,
  }) as const;
  /** A row's closure facts, sampled on every poll, so a clear a later pass undid is still seen. */
  const watchRow = async (db: Db, mailboxId: string) => {
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    const facts = async () => {
      const r = await rowOf(db, mailboxId);
      return {
        block: r.syncBlockedReason, blockSince: iso(r.syncBlockedSince), role: r.organizerRole,
        parkedAt: iso(r.organizerParkedAt), takeover: iso(r.takeoverAuthorizedAt), kick: iso(r.syncRequestedAt),
      };
    };
    const seeded = await facts();
    const seen = new Map([[JSON.stringify(seeded), seeded]]);
    return {
      seeded, seen: () => [...seen.values()],
      sample: async () => { const f = await facts(); seen.set(JSON.stringify(f), f); },
    };
  };
  /** What the stored closure keeps through the fault, read once the worker drained its last pass. */
  const expectStillClosed = async (
    db: Db, fleet: FakeAdapterFleet, B: { accountId: string; mailboxId: string },
    watch: Awaited<ReturnType<typeof watchRow>>,
  ) => {
    await watch.sample();
    expect(watch.seen(), "B's row on every poll: never cleared, never resumed").toEqual([watch.seeded]);
    expect(fleet.indicesOf(B.mailboxId, "connect_start"), "no sign-in to the closed account's mailbox").toEqual([]);
    expect(await fleet.metaFor(B.mailboxId).listClaims()).toEqual([]);
    expect(await reopenedRows(db, B.accountId), "no reopening noted").toEqual([]);
  };

  it("a worker that STARTS while the plane answers 429 keeps a stored closure — no sign-in, the block kept — " +
     "while a paying account and one the door reopened sync", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);
    plane.limited.on = true;
    const parkedAt = new Date(Date.now() - 86_400_000);
    const doorAt = new Date(Date.now() - 60_000);
    const A = await seedAccount(db);   // paying, no block
    const B = await seedAccount(db, walledAt(parkedAt));   // closed, its block stored
    const C = await seedAccount(db, {   // what the door leaves: no block, a join stamp and the kick
      organizerRole: "reader", organizerParkedAt: parkedAt,
      takeoverAuthorizedAt: doorAt, takeoverIntent: "join", syncRequestedAt: doorAt,
    });
    const watch = await watchRow(db, B.mailboxId);
    const fleet = new FakeAdapterFleet();
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url()));
    closers.push(() => w.stop());
    // Counted work: A and C synced, and B read twice (a 429 and its retry each), the second read past
    // the client's 5 s fault hold.
    await waitFor(async () => {
      await watch.sample();
      return [A, C].every((m) => fleet.indicesOf(m.mailboxId, "sync_end").length > 0)
        && (plane.limited.count.get(B.accountId) ?? 0) >= 4;
    }, 20_000, "A and C to sync and the plane to answer two reads of B 429");
    await w.stop();
    await expectStillClosed(db, fleet, B, watch);
  }, 60_000);

  it("…and a running worker holding the refusal keeps it when the kicked row's recheck meets the 429", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);
    const B = await seedAccount(db, {   // closed, and kicked: every pass asks its refusal again
      ...walledAt(new Date(Date.now() - 86_400_000)), syncRequestedAt: new Date(Date.now() - 60_000),
    });
    plane.parked.add(B.accountId);
    const watch = await watchRow(db, B.mailboxId);
    const fleet = new FakeAdapterFleet();
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url()));
    closers.push(() => w.stop());
    await waitFor(async () => {
      await watch.sample();
      return plane.answered.filter((a) => a.accountId === B.accountId && a.closed).length >= 2;
    }, 20_000, "the plane to refuse B twice");
    plane.limited.on = true;
    // A paying account added now: only a roster pass begun inside the fault attaches it.
    const D = await seedAccount(db);
    await waitFor(async () => {
      await watch.sample();
      return (plane.limited.count.get(B.accountId) ?? 0) >= 4 && fleet.indicesOf(D.mailboxId, "sync_end").length > 0;
    }, 20_000, "two reads of B answered 429, and D to sync");
    await w.stop();
    await expectStillClosed(db, fleet, B, watch);
  }, 60_000);

  it("a mailbox held back by our ceiling or a throttled sign-in stores account_closed once parked, " +
     "so a worker that starts inside the 429 keeps it closed", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);
    const A = await seedAccount(db);   // paying: served under both workers
    const soft: Array<{
      reason: "read_limited" | "provider_unavailable"; at: { accountId: string; mailboxId: string }; fault: FakeControl;
    }> = [
      { reason: "read_limited", at: await seedAccount(db),
        fault: { syncError: new ImapBoundExceeded("enumerate_uids", 500_000, 500_001, "INBOX") } },
      { reason: "provider_unavailable", at: await seedAccount(db),
        fault: { connectError: Object.assign(new Error("throttled"), { code: "ETHROTTLE" }) } },
    ];
    const fleet = new FakeAdapterFleet();
    for (const s of soft) fleet.behave(s.at.mailboxId, s.fault);
    // A backoff longer than the case: neither is mid-attach or mid-cycle when the park lands.
    const w1 = await runWorkerSupervised(cfgFor(fleet, plane.url(), { maxSyncFailures: 1, mailboxRetryMs: 60_000 }));
    closers.push(() => w1.stop());
    const rows = () => Promise.all(soft.map((s) => rowOf(db, s.at.mailboxId)));
    await waitFor(async () => (await rows()).every((r, i) => r.syncBlockedReason === soft[i]!.reason),
      20_000, "each soft block on its row");
    for (const s of soft) plane.parked.add(s.at.accountId);
    await waitFor(async () => (await rows()).every((r) => r.organizerParkedAt !== null), 20_000, "both parks");
    const parkedFrom = plane.answered.length;
    await waitFor(() => soft.every((s) => plane.answered.slice(parkedFrom)
      .filter((a) => a.accountId === s.at.accountId && a.closed).length >= 2), 20_000, "two refusals each after the park");
    expect((await rows()).map((r) => r.syncBlockedReason), "the park outranks the soft block on the row")
      .toEqual(["account_closed", "account_closed"]);
    expect(await Promise.all(soft.map((s) => pushCount(db, s.at.accountId))), "and takes the push rows").toEqual([0, 0]);
    await w1.stop();

    // A new process (a deploy, a failover) once that backoff has run out, while the plane answers
    // 429: it holds no answer.
    for (const s of soft) {
      await db.update(mailboxes).set({ retryAfter: new Date(Date.now() - 1_000) }).where(eq(mailboxes.id, s.at.mailboxId));
    }
    plane.limited.on = true;
    const watches = await Promise.all(soft.map((s) => watchRow(db, s.at.mailboxId)));
    const fleet2 = new FakeAdapterFleet();
    const w2 = await runWorkerSupervised(cfgFor(fleet2, plane.url()));
    closers.push(() => w2.stop());
    await waitFor(async () => {
      for (const w of watches) await w.sample();
      return fleet2.indicesOf(A.mailboxId, "sync_end").length > 0
        && soft.every((s) => (plane.limited.count.get(s.at.accountId) ?? 0) >= 4);
    }, 20_000, "A to sync and the plane to answer two reads of each closed account 429");
    await w2.stop();
    for (const [i, s] of soft.entries()) await expectStillClosed(db, fleet2, s.at, watches[i]!);
  }, 60_000);

  it("the CYCLE-TAIL site: a parked account's pending workflow run is NOT drained while an " +
     "open account's is — the DB passes skip what the roster parked", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);

    const A = await seedAccount(db);   // open — its run drains (the positive control)
    const B = await seedAccount(db);   // parked from the start
    plane.parked.add(B.accountId);

    // A pending workflow run per account: the drain is ACCOUNT-scoped (not role-scoped like the
    // bubble-up), so the run's fate is a pure reading of which accounts the cycle-tail list
    // carries — exactly the second call site's contribution.
    const pendingRunFor = async (accountId: string): Promise<string> => {
      const [wf] = await db.insert(workflows).values({
        accountId, name: "wf", enabled: true, trigger: { kind: "manual" },
        steps: [{ tool: "draft_reply", args: { messageId: randomUUID() } }],
      }).returning();
      const [run] = await db.insert(workflowRuns).values({
        accountId, workflowId: wf!.id, status: "pending", trigger: { kind: "manual" },
      }).returning();
      return run!.id;
    };
    const aRun = await pendingRunFor(A.accountId);
    const bRun = await pendingRunFor(B.accountId);

    const fleet = new FakeAdapterFleet();
    // A drafter, so the drained run reaches a terminal state deterministically.
    const drafter: DraftPort = {
      async draft() { return { subject: "Re:", body: "b", rationale: "r" }; },
    };
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url(), { drafter }));
    closers.push(() => w.stop());

    const statusOf = async (id: string): Promise<string> => {
      const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
      return row!.status;
    };
    // The open account's run drains — the pass provably RAN this cycle…
    await waitFor(async () => (await statusOf(aRun)) !== "pending",
      20_000, "the open account's workflow run to drain");
    // …and the parked account's did not: the cycle-tail read carries the reader, so the DB
    // passes never see the account. Removing the reader from THAT call site turns this red.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await statusOf(bRun), "a parked account's automation must not fire").toBe("pending");
  }, 60_000);

  it("the CYCLE-TAIL site, store-only: the gone-letter tidy takes a parked account's and a disconnected account's " +
     "deleted letters' words in one tail walk, and a letter still on the server keeps them", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);

    const A = await seedAccount(db);   // open: its letter is still on the server (the control)
    const B = await seedAccount(db);   // parked from the start
    plane.parked.add(B.accountId);
    const C = await seedAccount(db);   // its only mailbox disconnected, its mail kept
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, C.mailboxId));
    const kept = await storedLetter(db, A, false);
    const gone = { parked: await storedLetter(db, B, true), disconnected: await storedLetter(db, C, true) };

    const { logger, lines } = recordingLogger();
    const w = await runWorkerSupervised(cfgFor(new FakeAdapterFleet(), plane.url(), { logger }));
    closers.push(() => w.stop());
    await waitFor(() => lines.some((l) => l.event === "cycle_phases"), 30_000, "one whole tail walk");

    for (const [whose, id] of Object.entries(gone)) {
      expect(await wordsOf(db, id), `the ${whose} account's deleted letter kept its words`).toEqual(NONE);
    }
    expect(await wordsOf(db, kept), "a letter still on the server lost its words").toEqual(ALL);
  }, 60_000);
});

/* THE CATCH-UP A ROSTER PASS WOULD SPEND (cloud 0040). The pass that sees an account open again
   clears the park (the promotion) and the `account_closed` block (the pass end), which is what the
   door dates its catch-up from; so the pass records the anchor untold FIRST, and a pass that could
   not record it leaves both facts standing for the next one. */
describe("the catch-up a reopening pass records before it spends it", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_wall"); }, 60_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  /** A consented mailbox a DESKTOP install organizes: Cloud reads it and parks nothing. */
  async function seedReaderAccount(db: Db, fleet: FakeAdapterFleet): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "reader" });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
      organizerRole: "reader", organizeConsentedAt: new Date(Date.now() - 3_600_000),
    }).returning();
    const enc = await KP.encrypt("pw");
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
    });
    fleet.seedClaim(mb!.id, formatClaim({
      authorizedAt: null, capabilities: [], installId: "a-desktop-install", kind: "local",
      displayName: "A MacBook", heartbeat: new Date(), claimedAt: new Date(), nonce: `desk-${mb!.id}`,
    }));
    return { accountId, mailboxId: mb!.id };
  }
  const firstClientRead = (db: Db, accountId: string) => {
    const now = (): Date => new Date();
    return reopenedCatchUp({ db, now } as never, { accountId, db, now } as never);
  };

  it("an organizer and a reader-only account each keep their own untold row, told once by the door", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);
    const fleet = new FakeAdapterFleet();
    const B = await seedAccount(db);
    const D = await seedReaderAccount(db, fleet);
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url()));
    closers.push(() => w.stop());
    await waitFor(async () => (await fleet.metaFor(B.mailboxId).listClaims()).length > 0, 20_000, "B to claim");

    plane.parked.add(B.accountId);
    plane.parked.add(D.accountId);
    await waitFor(async () => (await rowOf(db, B.mailboxId)).organizerParkedAt !== null
      && (await rowOf(db, B.mailboxId)).syncBlockedReason === "account_closed"
      && (await rowOf(db, D.mailboxId)).syncBlockedReason === "account_closed", 20_000, "both parked");
    const parkB = (await rowOf(db, B.mailboxId)).organizerParkedAt!;
    const blockD = (await rowOf(db, D.mailboxId)).syncBlockedSince!;
    expect((await rowOf(db, D.mailboxId)).organizerParkedAt, "a reader row parks nothing").toBeNull();

    // The reopening, seen by this worker with no client reading in between.
    plane.parked.delete(B.accountId);
    plane.parked.delete(D.accountId);
    await waitFor(async () => (await rowOf(db, B.mailboxId)).organizerRole === "organizer"
      && (await rowOf(db, B.mailboxId)).syncBlockedReason === null
      && (await rowOf(db, D.mailboxId)).syncBlockedReason === null, 20_000, "the reopening pass to spend both");
    expect((await rowOf(db, B.mailboxId)).organizerParkedAt, "the promotion spent the park").toBeNull();

    // Each account holds ONE untold row at its own anchor, and none of the other's.
    const rowsB = await reopenedRows(db, B.accountId);
    const rowsD = await reopenedRows(db, D.accountId);
    expect(rowsB.map((n) => [n.anchor.toISOString(), n.sentAt.toISOString()]))
      .toEqual([[parkB.toISOString(), parkB.toISOString()]]);
    expect(rowsD.map((n) => [n.anchor.toISOString(), n.sentAt.toISOString()]))
      .toEqual([[blockD.toISOString(), blockD.toISOString()]]);

    // The first client read tells each once.
    expect(await firstClientRead(db, B.accountId)).toEqual({ since: parkB.toISOString() });
    expect(await firstClientRead(db, B.accountId), "never twice").toBeNull();
    expect(await firstClientRead(db, D.accountId)).toEqual({ since: blockD.toISOString() });
    expect(await firstClientRead(db, D.accountId), "never twice").toBeNull();

    // The lease is the gate's, unchanged: Cloud organizes B, the desktop keeps D.
    const holder = async (id: string) => (await fleet.metaFor(id).listClaims())
      .map((m) => parseClaim(m.raw)).map((c) => (c && !isMalformed(c) ? c.installId : null));
    expect(await holder(B.mailboxId)).toEqual(["cloud-wall"]);
    expect(await holder(D.mailboxId)).toEqual(["a-desktop-install"]);
  }, 60_000);

  /* THE DROP'S OWN SHAPE (the 13:40Z ANSWER; REVIEW-026 L1): a reopening nobody read, a second
     closure the person pays within minutes, and a client that reads before this worker's next pass.
     At the production block grace too, because the drop must not wait for the block it delays. */
  for (const grace of [0, DEFAULT_SYNC_BLOCK_GRACE_MS]) {
    it(`a door-first read after a short second closure is dated from it (block grace ${grace} ms)`, async () => {
      const db = makeDb(DB);
      const plane = fakePlane();
      await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
      closers.push(plane.close);
      const fleet = new FakeAdapterFleet();
      const B = await seedAccount(db);
      const w = await runWorkerSupervised(cfgFor(fleet, plane.url(), { syncBlockGraceMs: grace }));
      closers.push(() => w.stop());
      await waitFor(async () => (await fleet.metaFor(B.mailboxId).listClaims()).length > 0, 20_000, "B to claim");

      plane.parked.add(B.accountId);
      await waitFor(async () => (await rowOf(db, B.mailboxId)).organizerParkedAt !== null, 20_000, "closure 1's park");
      const park1 = (await rowOf(db, B.mailboxId)).organizerParkedAt!;
      plane.parked.delete(B.accountId);
      await waitFor(async () => (await rowOf(db, B.mailboxId)).organizerRole === "organizer"
        && (await rowOf(db, B.mailboxId)).organizerParkedAt === null, 20_000, "reopening 1, which nobody reads");
      expect((await reopenedRows(db, B.accountId)).map((n) => [n.anchor.toISOString(), n.sentAt.toISOString()]))
        .toEqual([[park1.toISOString(), park1.toISOString()]]);

      plane.parked.add(B.accountId);
      await waitFor(async () => {
        const at = (await rowOf(db, B.mailboxId)).organizerParkedAt;
        return at !== null && at.getTime() > park1.getTime();
      }, 20_000, "closure 2's park");
      await waitFor(async () => (await reopenedRows(db, B.accountId)).length === 0, 20_000,
        "the first pass that reads the account closed to drop reopening 1's untold row");
      const park2 = (await rowOf(db, B.mailboxId)).organizerParkedAt!;
      await w.stop();
      plane.parked.delete(B.accountId);
      expect(await firstClientRead(db, B.accountId)).toEqual({ since: park2.toISOString() });
    }, 90_000);
  }

  it("two short closures, the second reopening read by the worker first: the third is dated from its own", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);
    const fleet = new FakeAdapterFleet();
    const B = await seedAccount(db);
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url(), { syncBlockGraceMs: DEFAULT_SYNC_BLOCK_GRACE_MS }));
    closers.push(() => w.stop());
    await waitFor(async () => (await fleet.metaFor(B.mailboxId).listClaims()).length > 0, 20_000, "B to claim");
    const closeThenReopen = async (label: string): Promise<Date> => {
      const before = (await rowOf(db, B.mailboxId)).organizerParkedAt;
      plane.parked.add(B.accountId);
      await waitFor(async () => {
        const at = (await rowOf(db, B.mailboxId)).organizerParkedAt;
        return at !== null && (before === null || at.getTime() !== before.getTime());
      }, 20_000, `${label}'s park`);
      const park = (await rowOf(db, B.mailboxId)).organizerParkedAt!;
      plane.parked.delete(B.accountId);
      await waitFor(async () => (await rowOf(db, B.mailboxId)).organizerRole === "organizer"
        && (await rowOf(db, B.mailboxId)).organizerParkedAt === null, 20_000, `${label}'s reopening`);
      return park;
    };
    await closeThenReopen("closure 1");
    const park2 = await closeThenReopen("closure 2");
    expect(await firstClientRead(db, B.accountId), "reopening 2 is told its own date").toEqual({ since: park2.toISOString() });

    plane.parked.add(B.accountId);
    await waitFor(async () => {
      const at = (await rowOf(db, B.mailboxId)).organizerParkedAt;
      return at !== null && at.getTime() > park2.getTime();
    }, 20_000, "closure 3's park");
    const park3 = (await rowOf(db, B.mailboxId)).organizerParkedAt!;
    await w.stop();
    plane.parked.delete(B.accountId);
    expect(await firstClientRead(db, B.accountId)).toEqual({ since: park3.toISOString() });
  }, 90_000);

  it("reader-only: a new leader's first pass over a short second closure drops the untold row", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);
    const fleet = new FakeAdapterFleet();
    const D = await seedReaderAccount(db, fleet);

    // Closure 1 under a leader with no grace, so its block is the anchor; nobody reads the reopening.
    const w1 = await runWorkerSupervised(cfgFor(fleet, plane.url()));
    closers.push(() => w1.stop());
    plane.parked.add(D.accountId);
    await waitFor(async () => (await rowOf(db, D.mailboxId)).syncBlockedReason === "account_closed",
      20_000, "closure 1's block");
    const block1 = (await rowOf(db, D.mailboxId)).syncBlockedSince!;
    plane.parked.delete(D.accountId);
    await waitFor(async () => (await rowOf(db, D.mailboxId)).syncBlockedReason === null, 20_000, "reopening 1");
    expect((await reopenedRows(db, D.accountId)).map((n) => n.anchor.toISOString())).toEqual([block1.toISOString()]);
    await w1.stop();

    // Closure 2, shorter than the production grace, read by a NEW leader: nothing to go on but the park set.
    const w2 = await runWorkerSupervised(cfgFor(fleet, plane.url(), { syncBlockGraceMs: DEFAULT_SYNC_BLOCK_GRACE_MS }));
    closers.push(() => w2.stop());
    plane.parked.add(D.accountId);
    await waitFor(async () => (await reopenedRows(db, D.accountId)).length === 0, 20_000,
      "the new leader's first pass that reads the account closed to drop the untold row");
    expect((await rowOf(db, D.mailboxId)).syncBlockedReason, "no block inside the grace").toBeNull();
    await w2.stop();
    plane.parked.delete(D.accountId);
    expect(await firstClientRead(db, D.accountId), "never the first closure's date").toBeNull();
  }, 90_000);

  it("a drop that fails is owed: a later pass drops it, and the reopening is dated from its own closure", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);
    const fleet = new FakeAdapterFleet();
    const B = await seedAccount(db);
    const rec = recordingLogger();
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url(), {
      logger: rec.logger, syncBlockGraceMs: DEFAULT_SYNC_BLOCK_GRACE_MS,
    }));
    closers.push(() => w.stop());
    await waitFor(async () => (await fleet.metaFor(B.mailboxId).listClaims()).length > 0, 20_000, "B to claim");
    plane.parked.add(B.accountId);
    await waitFor(async () => (await rowOf(db, B.mailboxId)).organizerParkedAt !== null, 20_000, "closure 1's park");
    const park1 = (await rowOf(db, B.mailboxId)).organizerParkedAt!;
    plane.parked.delete(B.accountId);
    await waitFor(async () => (await rowOf(db, B.mailboxId)).organizerRole === "organizer"
      && (await rowOf(db, B.mailboxId)).organizerParkedAt === null, 20_000, "reopening 1, which nobody reads");
    expect((await reopenedRows(db, B.accountId)).map((n) => n.anchor.toISOString())).toEqual([park1.toISOString()]);

    // The drop's table is out of reach while the account closes again.
    await db.execute(sql`alter table account_lifecycle_notices rename to account_lifecycle_notices_away`);
    try {
      plane.parked.add(B.accountId);
      await waitFor(() => rec.lines.filter((l) => l.event === "reopened_notice_drop_failed"
        && l.accountId === B.accountId).length >= 2, 20_000, "two passes to fail B's drop");
    } finally {
      await db.execute(sql`alter table account_lifecycle_notices_away rename to account_lifecycle_notices`);
    }
    await waitFor(async () => (await reopenedRows(db, B.accountId)).length === 0, 20_000, "the owed drop");
    const park2 = (await rowOf(db, B.mailboxId)).organizerParkedAt!;
    expect(park2.getTime()).toBeGreaterThan(park1.getTime());
    await w.stop();
    plane.parked.delete(B.accountId);
    expect(await firstClientRead(db, B.accountId)).toEqual({ since: park2.toISOString() });
  }, 90_000);

  it("a worker with no entitlements program writes no catch-up across its passes", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const A = await seedAccount(db);
    const rec = recordingLogger();
    const cfg = { ...cfgFor(fleet, "http://127.0.0.1:9", { logger: rec.logger }), entitlements: undefined };
    const w = await runWorkerSupervised(cfg);
    closers.push(() => w.stop());
    await waitFor(async () => (await fleet.metaFor(A.mailboxId).listClaims()).length > 0, 20_000, "A to claim");
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await db.select().from(accountLifecycleNotices)).toEqual([]);
  }, 60_000);

  it("a plant that fails defers the spend; the next pass plants, resumes and clears. Erased defers nothing", async () => {
    const db = makeDb(DB);
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);
    const fleet = new FakeAdapterFleet();
    const B = await seedAccount(db);
    const F = await seedAccount(db);   // erased with its rows still standing: the fence's refusal
    const rec = recordingLogger();
    const w = await runWorkerSupervised(cfgFor(fleet, plane.url(), { logger: rec.logger }));
    closers.push(() => w.stop());
    await waitFor(async () => (await fleet.metaFor(B.mailboxId).listClaims()).length > 0
      && (await fleet.metaFor(F.mailboxId).listClaims()).length > 0, 20_000, "B and F to claim");
    plane.parked.add(B.accountId);
    plane.parked.add(F.accountId);
    await waitFor(async () => (await rowOf(db, B.mailboxId)).organizerParkedAt !== null
      && (await rowOf(db, B.mailboxId)).syncBlockedReason === "account_closed"
      && (await rowOf(db, F.mailboxId)).syncBlockedReason === "account_closed", 20_000, "both parked");
    const parkB = (await rowOf(db, B.mailboxId)).organizerParkedAt!;

    // The plant's table is out of reach — the one real fault a plant can meet.
    await db.execute(sql`alter table account_lifecycle_notices rename to account_lifecycle_notices_away`);
    await db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, F.accountId));
    try {
      plane.parked.delete(B.accountId);
      plane.parked.delete(F.accountId);
      await waitFor(() => rec.lines.filter((l) => l.event === "reopened_notice_plant_failed"
        && l.accountId === B.accountId).length >= 3, 20_000, "three passes to fail B's plant");
      const b = await rowOf(db, B.mailboxId);
      expect([b.organizerParkedAt?.toISOString(), b.syncBlockedReason, b.takeoverAuthorizedAt],
        "both facts stand and no stamp was written").toEqual([parkB.toISOString(), "account_closed", null]);
      // F: the fence refused its plant, which is final, so its reopening went ahead.
      await waitFor(async () => (await rowOf(db, F.mailboxId)).syncBlockedReason === null,
        20_000, "F's block to clear");
      expect(rec.lines.filter((l) => l.event === "reopened_notice_plant_failed" && l.accountId === F.accountId))
        .toHaveLength(0);
    } finally {
      await db.execute(sql`alter table account_lifecycle_notices_away rename to account_lifecycle_notices`);
    }
    await waitFor(async () => (await rowOf(db, B.mailboxId)).organizerRole === "organizer"
      && (await rowOf(db, B.mailboxId)).syncBlockedReason === null, 20_000, "B to be resumed and cleared");
    expect((await reopenedRows(db, B.accountId)).map((n) => [n.anchor.toISOString(), n.sentAt.toISOString()]))
      .toEqual([[parkB.toISOString(), parkB.toISOString()]]);
    expect(await reopenedRows(db, F.accountId)).toEqual([]);
  }, 90_000);
});

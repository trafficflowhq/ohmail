import { UNMETERED_STORAGE_CAP, createLogger } from "@trafficflow/core/mail";
import { describe, it, expect } from "vitest";
import type { NativeLocator } from "@trafficflow/core";
import type { ChangeBatch, ImapCursor, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
// The SAME module `sync.ts` imports it from — an `instanceof` against a second copy of the class
// would answer false and this file would be testing nothing.
import { OrganizerStandDownError, type LeasePermit } from "../src/lease.js";
import { runSyncCycle } from "../src/sync.js";

/**
 * ═══ THE PERMIT IS THREADED INTO THE CYCLE, AND A HANDOVER MID-SCAN STOPS THE LOSER ══════════
 *
 * `apps/worker/src/index.ts` called `runSyncCycle` with NO `leasePermit`, and the reconcile
 * backstop asked `permit.check()` at the cycle EDGE only. So a person who moved organization to
 * their own install while Cloud was scanning had BOTH installs applying moves for the rest of that
 * cycle — the invariant CLAUDE.md calls load-bearing, broken for as long as one pass takes.
 *
 * Two halves, and each was enough on its own:
 *
 *  1. the cycle never RECEIVED an authority, so every boundary inside it read `not_supplied`,
 *     which `assertMayWriteToMailbox` admits;
 *  2. `fileOne` and `reconcileFlags` swallow everything but a fence, so even a refusing permit
 *     was recorded as the MESSAGE's refusal — a deferral, an audit row blaming the mail server,
 *     and the pass filing every row behind it on somebody else's mailbox.
 *
 * ── MUTATIONS WATCHED (each restored from a pristine copy, verified by `cmp`) ────────────────
 *
 *  `sync.ts#writeAuthorityOf` returns `lease: { noLease: "not_supplied" }` — the threading
 *      taken away, which is HEAD before this fix
 *      ⇒ "a permit that goes mid-scan stops the cycle within a page" RED: three moves applied
 *        after the flip, and no verdict line.
 *  `sync.ts#rethrowRefusal` without `OrganizerStandDownError`
 *      ⇒ same case RED: the refusal is recorded as the message's, the pass files the rest of the
 *        page, and the cycle returns normally.
 *  `SyncDeps.writeAuthority` made optional again
 *      ⇒ `lease-write-permit-census.test.ts` RED by name.
 *  `writeAuthority: rt.leasePermit` deleted from the worker's own call
 *      ⇒ the same census RED, naming `apps/worker/src/index.ts:visitMailbox`.
 *
 * What this file does NOT claim: that the permit REFUSES correctly. That is `lease-permit.test.ts`
 * and `lease-permit-takeover.imap.test.ts`, which drive a real claim against a real server — and
 * `permit-cycle-takeover.imap.test.ts` beside this one, which carries one real IMAP move through
 * the whole cycle with a real permit and a real rival.
 */

const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

interface Recorded {
  /** Every IMAP mutation the adapter was asked for, in order. */
  moves: string[];
  flags: string[];
  audits: Array<{ action: string }>;
  deferredMoves: string[];
  deferredFlags: string[];
}

/**
 * A permit that admits its first `n` boundaries and then stands down for ever — the shape a
 * takeover produces (`acquireLeasePermit` latches `revoked` and every later `check()` throws).
 *
 * `asks` is what makes the page assertions readable: the cycle's own page counter and this one
 * count the same events from opposite sides, so a drift between them is visible.
 */
function permitAdmitting(n: number): LeasePermit & { asks: number } {
  let asks = 0;
  let revoked = false;
  return {
    get asks(): number { return asks; },
    get names() {
      return {
        installId: "cloud", mailboxId: "mb", uidValidity: 42, nonce: "n-1",
        issuedAt: new Date(0),
      };
    },
    get verifiedAt(): Date { return new Date(0); },
    get reads(): number { return 1; },
    get probes(): number { return asks; },
    get writesSinceRead(): number { return asks; },
    get revoked(): boolean { return revoked; },
    check: async (): Promise<void> => {
      asks++;
      if (asks <= n) return;
      revoked = true;
      throw new OrganizerStandDownError({
        organize: false, reason: "organized_elsewhere:local", state: "held",
        by: {
          kind: "local", installId: "the-laptop", displayName: "a laptop",
          heartbeat: new Date(0), claimedAt: new Date(0), nonce: "n-2", protocol: 1,
        } as never,
      });
    },
  } as unknown as LeasePermit & { asks: number };
}

/**
 * Three pending moves in three DIFFERENT destinations and three pending `\Seen` writes.
 *
 * Different destinations on purpose: `reconcileFolders` groups by (source → physical destination)
 * and one group is ONE `moveMany` — one page. Three groups are three pages, which is the unit the
 * permit is re-asked at and therefore the unit this file measures.
 */
function repoOf(rec: Recorded): WorkerRepo {
  const stub = {
    mailboxStatusForWrite: async (): Promise<string> => "connected",
    getMailboxFolders: async () => [],
    listKnownLocators: async () => [],
    listMessageFailures: async () => [],
    claimMessageFailures: async () => [],
    upsertMailboxFolder: async () => {},
    upsertMailboxFolders: async () => {},
    listPendingFolderStates: async () => [
      { messageId: "m-1", desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "42:1") },
      { messageId: "m-2", desiredFolder: "ohmail/Deals", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "42:2") },
      { messageId: "m-3", desiredFolder: "ohmail/Screener", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "42:3") },
    ],
    listPendingFlagStates: async () => [
      { messageId: "f-1", desiredSeen: true, observedSeen: false, lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "42:7") },
      { messageId: "f-2", desiredSeen: true, observedSeen: false, lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "42:8") },
    ],
    updateLocator: async () => {},
    upsertFolderState: async () => {},
    completeFolderState: async () => true,
    upsertFlagState: async () => {},
    primaryInstanceVanished: async () => false,
    recordAudit: async (_a: string, action: string) => { rec.audits.push({ action }); },
    deferFolderReconcile: async (messageId: string) => { rec.deferredMoves.push(messageId); },
    deferFlagReconcile: async (messageId: string) => { rec.deferredFlags.push(messageId); },
  };
  return {
    ...stub,
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
  } as unknown as WorkerRepo;
}

/** No `moveMany`, so each group takes the per-message path — one page, one message, one ask. */
function adapterOf(rec: Recorded): MailboxAdapter {
  return {
    changesSince: async (_c: ImapCursor) => ({
      creates: [], moves: [], flagChanges: [], deletes: [],
      newCursor: { folders: {} }, hasBacklog: false,
    }) as ChangeBatch,
    move: async (locator: NativeLocator, toFolder: string) => {
      rec.moves.push(locator.ref);
      return LOC(toFolder, `42:${100 + rec.moves.length}`);
    },
    setFlags: async (locator: NativeLocator) => { rec.flags.push(locator.ref); },
  } as unknown as MailboxAdapter;
}

interface Run {
  rec: Recorded;
  lines: string[];
  err: unknown;
  asks: number;
}

/**
 * One cycle under a permit that admits `admits` boundaries.
 *
 * `knownSet` is deliberately absent, which is the RECONCILE BACKSTOP's own composition
 * (`reconcile-cron.ts` states why it carries no memo) — and it is the branch of `runSyncCycle`
 * that returns before the cache bracket, so a verdict logged only inside that bracket would be
 * missing on exactly the path the backstop runs.
 */
async function run(admits: number): Promise<Run> {
  const rec: Recorded = { moves: [], flags: [], audits: [], deferredMoves: [], deferredFlags: [] };
  const lines: string[] = [];
  const permit = permitAdmitting(admits);
  let err: unknown = null;
  try {
    await runSyncCycle({
      repo: repoOf(rec), adapter: adapterOf(rec), accountId: "acct", mailboxId: "mb",
      role: "organizer", trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: permit,
      log: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(l) }),
    });
  } catch (e) { err = e; }
  return { rec, lines, err, asks: permit.asks };
}

const verdicts = (lines: readonly string[]): Array<Record<string, unknown>> =>
  lines.filter((l) => l.includes("stood_down_mid_cycle")).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("a permit that goes mid-scan stops the cycle within a page", () => {
  it("the move after the flip is never issued, and the verdict names the page", async () => {
    // One page admitted: `m-1` files, and the second group's ask is refused.
    const { rec, lines, err, asks } = await run(1);

    expect(rec.moves, "only the page the permit admitted may reach the server").toEqual(["42:1"]);
    // The flag pass runs AFTER the folder pass, so a cycle that carried on would push `\Seen` on a
    // mailbox somebody else organizes — the second half of the same defect.
    expect(rec.flags).toEqual([]);
    // NOT recorded as this message's failure, and asserted BEFORE the class below: with the
    // refusal swallowed, `fileOne`'s catch classifies the stand-down, defers `m-2` on the backoff
    // ladder and writes a `reconcile.move.failed` audit row naming the mail server — evidence
    // about a refusal the mail server never made, and the person's own move put to sleep for it.
    expect(rec.deferredMoves).toEqual([]);
    expect(rec.audits.map((a) => a.action)).not.toContain("reconcile.move.failed");
    expect(err, "the refusal is the cycle's own verdict, not a swallowed per-message fault")
      .toBeInstanceOf(OrganizerStandDownError);
    // Exactly two asks: the page that was admitted, and the page that was refused.
    expect(asks).toBe(2);

    expect(verdicts(lines)).toHaveLength(1);
    const v = verdicts(lines)[0]!;
    expect({ phase: v.phase, page: v.page, state: v.state, disabledReason: v.disabledReason })
      .toEqual({ phase: "filing", page: 2, state: "held", disabledReason: "organized_elsewhere:local" });
    // The REAL logger, not a fake one: a field that is not on `ALLOWED_FIELDS` is dropped and its
    // name reported, so a verdict whose page never reached the sink would read `page: undefined`
    // here. `droppedFields` absent is the whole assertion.
    expect(v.droppedFields).toBeUndefined();
  });

  it("a permit that goes at the FLAG pass stops there, and names that pass", async () => {
    // Three filing pages, then the flag pass's first STORE is refused.
    const { rec, lines, err } = await run(3);
    expect(rec.moves).toEqual(["42:1", "42:2", "42:3"]);
    expect(rec.flags, "no `\\Seen` may be pushed past the refusal").toEqual([]);
    expect(err).toBeInstanceOf(OrganizerStandDownError);
    expect(rec.deferredFlags).toEqual([]);
    const v = verdicts(lines)[0]!;
    expect({ phase: v.phase, page: v.page }).toEqual({ phase: "flags", page: 1 });
  });

  it("POSITIVE CONTROL — a held permit applies everything the cycle owes", async () => {
    // A permit that refuses too eagerly is the same product defect from the other side: a person's
    // mailbox stops being organized while they hold it.
    const { rec, lines, err, asks } = await run(Number.MAX_SAFE_INTEGER);
    expect(err).toBeNull();
    expect(rec.moves).toEqual(["42:1", "42:2", "42:3"]);
    expect(rec.flags).toEqual(["42:7", "42:8"]);
    // Five write boundaries, five asks — the pages the cycle had.
    expect(asks).toBe(5);
    expect(verdicts(lines)).toEqual([]);
  });

  it("the boundaries ask the LEASE and not a receipt — every page, not just the first", async () => {
    // The bound this fix claims, stated as a count: a cycle with five pages of writes asks five
    // times. A permit consulted once per cycle would read 1 here, which is HEAD's behaviour with
    // the edge check the backstop had.
    const { asks } = await run(Number.MAX_SAFE_INTEGER);
    expect(asks).toBe(5);
  });
});

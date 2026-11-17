import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { DEFAULT_SYNC_BATCH_MAX_FLAGS, type ImapCursor } from "../../src/adapters/imap-types.js";

/**
 * THE FLAG BUDGET — the bound that was missing from the CONDSTORE fast path.
 *
 * `changesSince` capped creates by count and by bytes and capped flag changes not at all, so a
 * CONDSTORE `changedSince` after "mark all as read" across thousands of messages returned all of
 * them in one `ChangeBatch`. The worker consumes each as its own database transaction
 * (`packages/organizer/src/sync.ts`), on its ONE serial queue: minutes in which no other mailbox
 * syncs, no roster pass runs, and `stop()` cannot finish inside Railway's 30 s drain.
 *
 * ── WHY THE BOUND NEEDED A RESUME POINT, WHICH IS THE WHOLE DIFFICULTY ─────────────────────
 *
 * Creates resume for free: an ingested UID joins the known-set and stops being unknown. A flag
 * has no such marker. `changedSince` is a pure function of the cursor, so "take the first 500
 * and hold the cursor" returns the SAME 500 for ever and the drain never terminates. The fix is
 * a per-folder resume UID held on the adapter, and the properties it must have are asserted
 * here — a bound that loses read state is worse than no bound at all.
 */

interface Flagged { uid: number; seen: boolean; modseq: bigint }

/** The body every `unknown` UID serves. Small: the byte budget is not what these tests bound. */
const SRC = Buffer.from("Message-ID: <u@x>\r\nSubject: n\r\n\r\nbody");

/**
 * A CONDSTORE server with `count` known messages whose flags all changed at modseq 51.
 *
 * `unknown` are UIDs the cursor does NOT know, i.e. creates. They exist so a pass can be
 * `truncated` on CREATES while its flag pass is not truncated at all — the state the cursor fix is
 * about, and the one the flag budget alone cannot produce.
 */
function makeFakeClient(flagged: Flagged[], highestModseq = 60n, unknown: number[] = []) {
  const inbox = { path: "INBOX", uidValidity: 100n, uidNext: 9999, highestModseq, exists: flagged.length + unknown.length };
  const empty = (path: string) => ({ path, uidValidity: 100n, uidNext: 1, highestModseq: 0n, exists: 0 });
  /** Every `changedSince` fetch the adapter issued: the ranges prove resumption. */
  const ranges: Array<{ range: unknown; since: bigint }> = [];
  const client = {
    capabilities: new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true], ["IDLE", true]]),
    mailbox: inbox as { path: string; uidValidity: bigint; uidNext: number; highestModseq: bigint; exists: number },
    /**
     * INBOX itself, so a test can move the server on mid-drain.
     *
     * NOT `client.mailbox`: `changesSince` walks all six WATCHED_FOLDERS, so by the time a call
     * returns `mailbox` points at `ohmail/Quarantine`. Writing to it looked like it was moving
     * the server and was in fact mutating a throwaway — a mutation of the implementation caught
     * this file asserting nothing.
     */
    inbox,
    ranges,
    _path: "INBOX",
    async list() { return [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }]; },
    async getMailboxLock(path: string) {
      this._path = path;
      this.mailbox = path === "INBOX" ? inbox : empty(path);
      return { path, release() { /* no lock in the fake */ } };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, options: any) {
      if (this._path !== "INBOX") return;
      if (options?.changedSince) {
        ranges.push({ range, since: options.changedSince as bigint });
        // Honour the UID range the adapter asked for — the resume point is meaningless if the
        // fake ignores it, and the test would pass against an implementation that never moved.
        const from = Number(String(range).split(":")[0] ?? 1);
        for (const f of flagged) {
          if (f.uid < from) continue;
          yield { uid: f.uid, flags: new Set(f.seen ? ["\\Seen"] : []), modseq: f.modseq };
        }
        return;
      }
      // `fetchCapped`'s two fetches over an explicit UID list: the RFC822.SIZE pre-fetch that
      // enforces the byte budget, then the bodies. Reached only when `unknown` is non-empty.
      if (query?.size) {
        for (const uid of range as number[]) yield { uid, size: SRC.length };
        return;
      }
      if (query?.source) {
        for (const uid of range as number[]) {
          yield { uid, flags: new Set<string>(), envelope: { messageId: `<u${uid}@x>` }, source: SRC };
        }
        return;
      }
      // The uid-only enumeration. Without `unknown` every message is already known, so there
      // are no creates and the two branches above are never taken.
      for (const f of flagged) yield { uid: f.uid };
      for (const uid of unknown) yield { uid };
    },
  };
  return client;
}

function cursorFor(flagged: Flagged[], highestModseq = "50"): ImapCursor {
  const cursor: ImapCursor = { folders: {} };
  cursor.folders["INBOX"] = {
    uidValidity: "100", uidNext: 9999, highestModseq,
    known: flagged.map((f) => ({ uid: f.uid, messageId: `u${f.uid}@x` })),
  };
  for (const f of ["ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"]) {
    cursor.folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  }
  return cursor;
}

const flags = (n: number, from = 1): Flagged[] =>
  Array.from({ length: n }, (_, i) => ({ uid: from + i, seen: true, modseq: 51n }));

describe("ImapAdapter.changesSince — the flag budget", () => {
  it("caps one call and holds the folder cursor, so nothing is lost", async () => {
    const all = flags(25);
    const fake = makeFakeClient(all);
    const adapter = new ImapAdapter(
      { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
      { client: fake, maxBatchFlags: 10 },
    );
    await adapter.connect();

    const batch = await adapter.changesSince(cursorFor(all));

    expect(batch.flagChanges).toHaveLength(10);
    expect(batch.hasBacklog, "a truncated flag pass owes another cycle").toBe(true);
    // THE CURSOR IS HELD. Advancing `highestModseq` past 15 unreported flag changes is how a
    // "mark all read" silently half-applies and never converges.
    expect(batch.newCursor.folders["INBOX"]!.highestModseq).toBe("50");
  });

  it("RESUMES by UID: three bounded passes drain the backlog exactly once each", async () => {
    // The property the naive bound does not have. `changedSince` is a fixed query, so without
    // a resume point every pass would return uids 1..10 for ever.
    const all = flags(25);
    const fake = makeFakeClient(all);
    const adapter = new ImapAdapter(
      { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
      { client: fake, maxBatchFlags: 10 },
    );
    await adapter.connect();
    const cursor = cursorFor(all);

    const seen: number[] = [];
    let last = await adapter.changesSince(cursor);
    for (let pass = 0; pass < 3; pass++) {
      for (const c of last.flagChanges) seen.push(Number(c.locator.ref.split(":")[1]));
      if (!last.hasBacklog) break;
      last = await adapter.changesSince(cursor);
    }

    // Every UID exactly once, in order, across the passes.
    expect(seen).toEqual(all.map((f) => f.uid));
    expect(new Set(seen).size).toBe(all.length);
    // …and the adapter actually asked the server for a moving window rather than re-reading.
    expect(fake.ranges.map((r) => String(r.range))).toEqual(["1:*", "11:*", "21:*"]);
    // Every pass read against the modseq the drain STARTED on.
    expect(new Set(fake.ranges.map((r) => String(r.since)))).toEqual(new Set(["50"]));
  });

  it("advances only to where the drain BEGAN, so a mid-drain change is not skipped", async () => {
    // The trap in a UID-resumed drain: a flag changed on a LOW uid while the drain is above it
    // sits below the resume point and is never read. Advancing to the modseq observed on the
    // final pass would bury it below the cursor for ever. The cursor therefore advances to the
    // modseq captured when the drain started, and the next cycle re-reports the rest.
    const all = flags(15);
    const fake = makeFakeClient(all, 60n);
    const adapter = new ImapAdapter(
      { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
      { client: fake, maxBatchFlags: 10 },
    );
    await adapter.connect();
    const cursor = cursorFor(all);

    const first = await adapter.changesSince(cursor);
    expect(first.hasBacklog).toBe(true);

    // The server moves on mid-drain — someone reads another message in Apple Mail.
    fake.inbox.highestModseq = 90n;

    const second = await adapter.changesSince(cursor);
    expect(second.hasBacklog).toBe(false);
    expect(second.newCursor.folders["INBOX"]!.highestModseq)
      .toBe("60");                       // where the drain began, NOT the 90 it now reports
  });

  it("captures that point ONCE, not on every truncated pass of a long drain", async () => {
    // Three passes, and the server moves between the first and the second. `advanceTo` is
    // carried forward from the drain that already exists; re-reading it each time would walk
    // the safe point up behind the resume UID one pass at a time, which is the same silent
    // loss as advancing to the final modseq — only harder to see.
    const all = flags(25);
    const fake = makeFakeClient(all, 60n);
    const adapter = new ImapAdapter(
      { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
      { client: fake, maxBatchFlags: 10 },
    );
    await adapter.connect();
    const cursor = cursorFor(all);

    expect((await adapter.changesSince(cursor)).hasBacklog).toBe(true);   // uids 1-10
    fake.inbox.highestModseq = 90n;                                       // the server moves on
    expect((await adapter.changesSince(cursor)).hasBacklog).toBe(true);   // uids 11-20
    const last = await adapter.changesSince(cursor);                      // uids 21-25, done

    expect(last.hasBacklog ?? false).toBe(false);
    expect(last.newCursor.folders["INBOX"]!.highestModseq).toBe("60");
  });

  it("a drain that fits in one pass advances the cursor normally", async () => {
    // The bound must not cost the ordinary case a cycle. No resume state was ever created, so
    // the folder advances to the modseq it just observed.
    const all = flags(3);
    const fake = makeFakeClient(all, 60n);
    const adapter = new ImapAdapter(
      { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
      { client: fake, maxBatchFlags: 10 },
    );
    await adapter.connect();

    const batch = await adapter.changesSince(cursorFor(all));
    expect(batch.flagChanges).toHaveLength(3);
    expect(batch.hasBacklog ?? false).toBe(false);
    expect(batch.newCursor.folders["INBOX"]!.highestModseq).toBe("60");
  });

  /**
   * ── THE READ-STATE MIRROR MUST SURVIVE A BACKFILL ─────────────────────
   *
   * `canFastPath` requires `prev.highestModseq !== "0"`, so `"0"` is the ONE value at which no
   * flag pass runs at all — and it is where every mailbox big enough to truncate starts. While
   * the cursor was held on CREATES-truncation, a folder that truncates on every pass never
   * published a first baseline, so it never ran a flag pass, so it had no inbound read-state
   * mirror: the bug an earlier change fixed (mail read in Apple Mail stays bold in ohmail) reinstated per
   * folder, for as long as the backfill lasts — for ever on a mailbox whose backfill never ends.
   *
   * Mutation (`imap.ts`, the `newFolders[folder]` assignment): put `truncated ||` back on the
   * `highestModseq` field. Watched red twice, because vitest stops at the first failure: the
   * baseline assertion reads `expected '0' to be '60'`, and with that one relaxed the fast-path
   * assertion fails on its own with `expected 0 to be greater than 0` — no `changedSince` issued
   * on either pass, which is the defect itself.
   */
  it("publishes a CONDSTORE baseline on the FIRST truncated pass, so a folder that never fully drains still mirrors read-state", async () => {
    const known = flags(1);                              // uid 1, already in the known-set
    const fake = makeFakeClient(known, 60n, [2, 3, 4]);  // …and three CREATES to drain
    const adapter = new ImapAdapter(
      { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
      { client: fake, maxBatchFlags: 10, maxBatchMessages: 1 },   // one create per pass ⇒ truncated
    );
    await adapter.connect();

    const cursor = cursorFor(known, "0");
    // A `uidNext` that is NOT the server's, so "held" and "published" are distinguishable.
    cursor.folders["INBOX"]!.uidNext = 42;

    const first = await adapter.changesSince(cursor);

    expect(first.creates).toHaveLength(1);
    expect(first.hasBacklog, "three unknown UIDs at one per pass").toBe(true);
    // No flag pass happened on THIS pass — at `"0"` `canFastPath` is false. That is the defect,
    // and it is why the baseline has to be published from a truncated pass.
    expect(fake.ranges).toHaveLength(0);
    // THE ASSERTION THAT FAILS WITHOUT THAT CHANGE.
    expect(first.newCursor.folders["INBOX"]!.highestModseq).toBe("60");
    // …while the field that CAN skip mail is still held: `uidNext` is the Sent enumeration
    // watermark and `fetchCapped` slices newest-first, so publishing the server's 9999 here would
    // put the watermark above three UIDs this pass did not fetch. (`uidValidity` is held too, but
    // this fake's epoch equals the cursor's, so only the worker's Postgres guard can see that.)
    expect(first.newCursor.folders["INBOX"]!.uidNext).toBe(42);
    // Risk: `getMailboxLock` serves `empty(path)` for the five non-INBOX folders and `fetch`
    // returns immediately for them, so an assertion on one of those asserts nothing. One is
    // pinned here so a blanket rewrite of the assignment cannot pass on INBOX alone.
    expect(first.newCursor.folders["ohmail/Screener"])
      .toEqual({ uidValidity: "100", uidNext: 1, highestModseq: "0", serverExists: 0 });

    // ── and the folder is now ON THE FAST PATH WHILE STILL BACKFILLING ───────────────────────
    const next = cursorFor(known, first.newCursor.folders["INBOX"]!.highestModseq);
    next.folders["INBOX"]!.uidNext = 42;
    next.folders["INBOX"]!.known.push({ uid: 4, messageId: "u4@x" });   // the create from pass 1

    const second = await adapter.changesSince(next);

    expect(second.hasBacklog, "uids 2 and 3 are still owed").toBe(true);
    expect(fake.ranges.length).toBeGreaterThan(0);
    expect(String(fake.ranges.at(-1)!.since)).toBe("60");     // the baseline pass 1 published
    expect(second.flagChanges.map((c) => c.locator.ref)).toEqual(["100:1"]);
  });

  it("publishes NO baseline against a server without CONDSTORE, however many passes it takes", async () => {
    // The branch most mailboxes actually take, and the one a CONDSTORE-only guard would leave
    // unasserted: `mb.highestModseq` is reported by the server regardless of our override, so
    // without the `!caps.condstore` term the cursor would publish a baseline the fallback path
    // can never use.
    //
    // This is the ONLY place that term is guarded, measured by deleting it: the GreenMail files
    // (`imap.changes.backfill.test.ts`, `apps/worker/test/uidvalidity-reset.e2e.test.ts`) stay
    // green without it, because GreenMail reports no HIGHESTMODSEQ either and `advanceTo` is `"0"`
    // there anyway. Only a fake can serve the combination the term is FOR — a server that reports
    // a modseq while the fast path is unavailable.
    const known = flags(1);
    const fake = makeFakeClient(known, 60n, [2, 3, 4]);
    const adapter = new ImapAdapter(
      { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
      { client: fake, maxBatchMessages: 1, capabilityOverrides: { condstore: false } },
    );
    await adapter.connect();

    const first = await adapter.changesSince(cursorFor(known, "0"));
    expect(first.hasBacklog).toBe(true);
    expect(first.newCursor.folders["INBOX"]!.highestModseq).toBe("0");

    const next = cursorFor(known, first.newCursor.folders["INBOX"]!.highestModseq);
    next.folders["INBOX"]!.known.push({ uid: 4, messageId: "u4@x" });
    const second = await adapter.changesSince(next);

    expect(second.newCursor.folders["INBOX"]!.highestModseq).toBe("0");
    // …and no `changedSince` was ever issued, on either pass.
    expect(fake.ranges).toHaveLength(0);
    expect(second.flagChanges).toHaveLength(0);
  });

  it("the shipped budget is what the worker's serial queue can afford", () => {
    // ~15 ms per `applyExternalFlag` transaction against Neon ⇒ ~7 s of queue per cycle, inside
    // imapflow's 15 s auto-idle arming delay and far inside `WORKER_NET_TIMEOUTS.socketMs`.
    expect(DEFAULT_SYNC_BATCH_MAX_FLAGS).toBe(500);
  });
});

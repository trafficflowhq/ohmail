import { describe, it, expect } from "vitest";
import { UNMETERED_STORAGE_CAP, type StorageCap } from "@trafficflow/core/mail";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { JunkFiledHuskRow, JunkUnhuskOutcome, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { junkRestorePass, oweJunkWalk } from "../src/junk-restore.js";
import { runSyncCycle } from "../src/sync.js";

/**
 * ═══ THE `junk_filed` CONVERGENCE PASS — control flow, budgets, and what is remembered ═══════
 *
 * The verify/rewrite itself is `core/husk-restore.ts` and is pinned on real Postgres
 * (`junk-restore.pg.test.ts` — the FOR UPDATE recheck, the byte accounting, the identity
 * witness against real normalizeMime). What THIS file pins is the pass around it: which rows
 * are fetched, which outcomes are remembered across cycles versus merely deferred, and that
 * every bound actually bounds. Both matter separately: the shared seam being right does not
 * stop the pass from re-fetching a refused row every cycle for ever, and the fakes here can
 * watch exactly that.
 *
 * ── MUTATIONS WATCHED (each run red, then restored) ─────────────────────────────────────────
 *
 *  · drop the EPOCH GUARD (`found.uidValidity !== row.uidValidity` skip) ⇒ the stale-epoch test
 *    red: the pass hands bytes fetched under a renumbered epoch to the rewrite.
 *  · make the at-cap deferral PERMANENT (skip whatever the clock says) ⇒ the clock test red:
 *    an account that made room stays bodiless until a redeploy.
 *  · drop the fetch budget ⇒ the budget test red: every candidate is fetched in one cycle and
 *    `capped` never reports.
 *  · make a remembered refusal consume the fetch budget ⇒ the starvation test red: sixty
 *    refusals sorted first exhaust the cycle before the one fresh candidate behind them.
 *  · drop the per-FETCH chunk ⇒ the chunk test red: one adapter call carries the whole group's
 *    buffers at once.
 */

const RAW = [
  "From: stranger@example.test",
  "To: me@ohmail.test",
  "Subject: back from junk",
  "Message-ID: <back-1@example.test>",
  "Date: Tue, 25 Aug 2026 09:00:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "the body that left junk with the message",
  "",
].join("\r\n");

interface Recorded {
  lists: Array<{ limit: number; afterId?: string }>;
  fetches: Array<{ folder: string; uids: number[]; maxBytes: number | undefined }>;
  unhusks: Array<{ id: string; capBytes: number | null; text: string }>;
}
const fresh = (): Recorded => ({ lists: [], fetches: [], unhusks: [] });

const husk = (id: string, over: Partial<JunkFiledHuskRow> = {}): JunkFiledHuskRow => ({
  messageId: id, dedupKey: `dk-${id}`, messageIdHeader: null,
  folder: "INBOX", uidValidity: "1", uid: Number(id.slice(-2)), ...over,
});

function repoOf(rec: Recorded, opts: {
  husks: JunkFiledHuskRow[];
  outcome?: (id: string) => JunkUnhuskOutcome;
  withList?: boolean;
}): WorkerRepo {
  const stub: Record<string, unknown> = {
    transaction: async <T,>(fn: (r: WorkerRepo) => Promise<T>): Promise<T> => fn(stub as unknown as WorkerRepo),
    // The removal fence reads this inside every write transaction; the double answers what a live
    // mailbox answers (see `assertMailboxStillHere`), because absent it the fence is a TypeError.
    mailboxStatusForWrite: async (): Promise<string> => "connected",
  };
  if (opts.withList !== false) {
    stub.listJunkFiledHusks = async (
      _a: string, _m: string, page: { limit: number; afterId?: string },
    ): Promise<JunkFiledHuskRow[]> => {
      rec.lists.push({ limit: page.limit, ...(page.afterId !== undefined ? { afterId: page.afterId } : {}) });
      const sorted = [...opts.husks].sort((x, y) => (x.messageId < y.messageId ? -1 : 1));
      const from = page.afterId !== undefined ? sorted.filter((h) => h.messageId > page.afterId!) : sorted;
      return from.slice(0, page.limit);
    };
  }
  stub.unhuskJunkFiledBody = async (
    _a: string, h: { id: string }, freshMsg: { textBody: string }, capBytes: number | null,
  ): Promise<JunkUnhuskOutcome> => {
    rec.unhusks.push({ id: h.id, capBytes, text: freshMsg.textBody });
    return opts.outcome?.(h.id) ?? "restored";
  };
  return stub as unknown as WorkerRepo;
}

function adapterOf(rec: Recorded, opts: {
  uidValidity?: string; absent?: number[]; oversize?: number[];
  raws?: Map<number, string>; fail?: boolean; withFetch?: boolean;
} = {}): MailboxAdapter {
  const a: Record<string, unknown> = {
    move: async () => { throw new Error("this pass must never move mail"); },
    setFlags: async () => { throw new Error("this pass must never flag mail"); },
  };
  if (opts.withFetch !== false) {
    a.fetchByUid = async (folder: string, uids: readonly number[], o?: { maxBytes?: number }) => {
      if (opts.fail) throw new Error("connection died");
      rec.fetches.push({ folder, uids: [...uids], maxBytes: o?.maxBytes });
      const raws = opts.raws ?? new Map(uids.map((u) => [u, RAW]));
      return {
        uidValidity: opts.uidValidity ?? "1",
        creates: uids.filter((u) => raws.has(u) && !(opts.absent ?? []).includes(u) && !(opts.oversize ?? []).includes(u))
          .map((u) => ({ type: "create" as const, locator: { folder, ref: `${opts.uidValidity ?? "1"}:${u}` }, raw: Buffer.from(raws.get(u)!, "utf8") })),
        absent: opts.absent ?? [],
        oversize: opts.oversize ?? [],
      };
    };
  }
  return a as unknown as MailboxAdapter;
}

const run = (
  rec: Recorded,
  repo: WorkerRepo,
  adapter: MailboxAdapter,
  over: Partial<Parameters<typeof junkRestorePass>[0]> = {},
) => junkRestorePass({
  repo, adapter, accountId: "acct-1", mailboxId: "mb-1",
  storageCap: 100_000 as StorageCap,
  write: (fn) => fn(repo),
  refused: new Set<string>(),
  capDeferred: new Map<string, number>(),
  resume: new Map<string, string>(),
  walkedAt: new Map<string, number>(),
  ...over,
});

describe("junkRestorePass — what is fetched and what the outcome does", () => {
  it("restores through the shared rewrite, with the cycle's cap mapped to bytes", async () => {
    const rec = fresh();
    const r = await run(rec, repoOf(rec, { husks: [husk("m-10")] }), adapterOf(rec));
    expect(r.restored).toBe(1);
    expect(r.examined).toBe(1);
    expect(rec.fetches).toEqual([{ folder: "INBOX", uids: [10], maxBytes: 8 * 1024 * 1024 }]);
    expect(rec.unhusks).toHaveLength(1);
    expect(rec.unhusks[0]).toMatchObject({ id: "m-10", capBytes: 100_000 });
    // The bytes handed to the rewrite are the RE-READ message's, parsed — never the husk's.
    expect(rec.unhusks[0]!.text).toContain("the body that left junk");
  });

  it("UNMETERED_STORAGE_CAP is the declaration — the rewrite sees capBytes null", async () => {
    const rec = fresh();
    await run(rec, repoOf(rec, { husks: [husk("m-10")] }), adapterOf(rec), { storageCap: UNMETERED_STORAGE_CAP });
    expect(rec.unhusks[0]).toMatchObject({ capBytes: null });
  });

  it("a repo without the seam, or an adapter without the targeted fetch, is 'no candidates'", async () => {
    const rec1 = fresh();
    const r1 = await run(rec1, repoOf(rec1, { husks: [husk("m-10")], withList: false }), adapterOf(rec1));
    expect(r1).toMatchObject({ examined: 0, fetched: 0, restored: 0 });
    expect(rec1.fetches).toEqual([]);

    const rec2 = fresh();
    const r2 = await run(rec2, repoOf(rec2, { husks: [husk("m-10")] }), adapterOf(rec2, { withFetch: false }));
    expect(r2).toMatchObject({ examined: 0, fetched: 0, restored: 0 });
    expect(rec2.lists).toEqual([]);
  });

  it("THE EPOCH GUARD: bytes fetched under a renumbered epoch are never handed to the rewrite", async () => {
    const rec = fresh();
    const r = await run(rec, repoOf(rec, { husks: [husk("m-10", { uidValidity: "1" })] }),
      adapterOf(rec, { uidValidity: "2" }));
    expect(r.deferred).toBe(1);
    expect(r.restored).toBe(0);
    expect(rec.unhusks, "a UID means nothing outside the epoch that issued it").toEqual([]);
    // NOT remembered: the scan owns re-numbering, so the next cycle asks again.
    const again = fresh();
    await run(again, repoOf(again, { husks: [husk("m-10", { uidValidity: "1" })] }), adapterOf(again, { uidValidity: "2" }));
    expect(again.fetches).toHaveLength(1);
  });

  it("gone from the folder is deferred, not remembered — the scan's evidence heals the predicate", async () => {
    const rec = fresh();
    const r = await run(rec, repoOf(rec, { husks: [husk("m-10")] }), adapterOf(rec, { absent: [10] }));
    expect(r).toMatchObject({ deferred: 1, restored: 0, refused: 0 });
    expect(rec.unhusks).toEqual([]);
  });

  it("oversize is refused AND remembered: the second cycle spends no fetch on it", async () => {
    const rec = fresh();
    const refused = new Set<string>();
    const repo = repoOf(rec, { husks: [husk("m-10")] });
    const adapter = adapterOf(rec, { oversize: [10] });
    const r1 = await run(rec, repo, adapter, { refused });
    expect(r1).toMatchObject({ refused: 1, restored: 0 });
    const r2 = await run(rec, repo, adapter, { refused });
    expect(r2.skipped).toBe(1);
    expect(rec.fetches, "a refusal this process remembers must not be re-read").toHaveLength(1);
  });

  it("at_cap is deferred ON A CLOCK: skipped within the interval, retried after it", async () => {
    const rec = fresh();
    const capDeferred = new Map<string, number>();
    let t = 1_000_000;
    const now = () => new Date(t);
    const repo = repoOf(rec, { husks: [husk("m-10")], outcome: () => "at_cap" });
    const adapter = adapterOf(rec);
    const over = { capDeferred, now, capRetryMs: 60_000 };
    const r1 = await run(rec, repo, adapter, over);
    expect(r1).toMatchObject({ refused: 1, restored: 0 });
    expect(rec.unhusks).toHaveLength(1);
    // Within the interval: no fetch, no rewrite — an at-cap account must not pay one fetch per
    // cycle per husk.
    t += 30_000;
    const r2 = await run(rec, repo, adapter, over);
    expect(r2.skipped).toBe(1);
    expect(rec.fetches).toHaveLength(1);
    // Past it: the cap-aware rewrite runs again — the CAP side changes under a running worker
    // (mail deleted, a tier upgraded), so a permanent memo would leave the body empty until a
    // redeploy on an account that made room weeks ago.
    t += 60_001;
    const r3 = await run(rec, repo, adapter, over);
    expect(r3.refused, "the clock ran out and the rewrite was retried").toBe(1);
    expect(rec.fetches).toHaveLength(2);
    expect(rec.unhusks).toHaveLength(2);
  });

  it("identity_mismatch is refused and remembered; a lost race is neither", async () => {
    const rec = fresh();
    const refused = new Set<string>();
    const outcomes = new Map<string, JunkUnhuskOutcome>([["m-10", "identity_mismatch"], ["m-11", "not_husked"]]);
    const repo = repoOf(rec, { husks: [husk("m-10"), husk("m-11")], outcome: (id) => outcomes.get(id)! });
    const r = await run(rec, repo, adapterOf(rec), { refused });
    expect(r).toMatchObject({ refused: 1, raced: 1, restored: 0 });
    expect(refused.has("m-10")).toBe(true);
    expect(refused.has("m-11"), "a row somebody else restored simply drops out of the predicate").toBe(false);
  });

  it("THE FETCH BUDGET bounds a cycle and reports capped; the keyset resumes within the cycle", async () => {
    const rec = fresh();
    const husks = [husk("m-10"), husk("m-11"), husk("m-12")];
    const r = await run(rec, repoOf(rec, { husks }), adapterOf(rec), { fetchesPerCycle: 2 });
    expect(r.capped).toBe(true);
    expect(r.fetched).toBe(2);
    expect(r.restored).toBe(2);
  });

  it("THE PAGE BUDGET bounds the SQL walk itself", async () => {
    const rec = fresh();
    const husks = [husk("m-10"), husk("m-11"), husk("m-12")];
    const r = await run(rec, repoOf(rec, { husks }), adapterOf(rec), { maxPages: 2, page: 1 });
    expect(r.examined).toBe(2);
    expect(r.capped).toBe(true);
    // Keyset-paged: the second page asked strictly after the first page's last row.
    expect(rec.lists).toEqual([{ limit: 1 }, { limit: 1, afterId: "m-10" }]);
  });

  it("remembered refusals cost the walk NOTHING — the fresh candidate behind sixty of them restores in the same cycle", async () => {
    const rec = fresh();
    const refused = new Set<string>();
    const husks: JunkFiledHuskRow[] = [];
    for (let i = 10; i < 70; i++) { husks.push(husk(`m-${i}`)); refused.add(`m-${i}`); }
    husks.push(husk("m-70"));
    const r = await run(rec, repoOf(rec, { husks }), adapterOf(rec), { refused });
    // An examined-based per-cycle budget starved exactly this row for ever: the sixty refusals
    // sorted first, consumed the budget as "examined", and the walk restarted at the top every
    // cycle. Skips are free; only pages and fetches are spent.
    expect(r.restored).toBe(1);
    expect(r.skipped).toBe(60);
    expect(rec.fetches).toHaveLength(1);
    expect(rec.fetches[0]!.uids).toEqual([70]);
  });

  it("THE ROTATION: a capped cycle resumes where it stopped — refusals cannot fence off the tail", async () => {
    // Round 2's finding on round 1's fix: a page bound only RAISES the starvation threshold.
    // With maxPages×pageSize refusals sorted first, a walk that restarts at the top every cycle
    // never reaches the fresh candidate. The cursor therefore survives a capped exit.
    const rec = fresh();
    const refused = new Set<string>(["m-10"]);
    const resume = new Map<string, string>();
    const repo = repoOf(rec, { husks: [husk("m-10"), husk("m-11")] });
    const adapter = adapterOf(rec);
    const over = { refused, resume, maxPages: 1, page: 1 };

    const r1 = await run(rec, repo, adapter, over);
    expect(r1).toMatchObject({ capped: true, restored: 0, skipped: 1 });

    const r2 = await run(rec, repo, adapter, over);
    expect(r2.restored, "the second cycle must resume past the refused prefix").toBe(1);
    expect(rec.lists.at(-1)).toEqual({ limit: 1, afterId: "m-10" });

    const r3 = await run(rec, repo, adapter, over);   // resumes past m-11 → empty page → the walk completes
    expect(r3).toMatchObject({ examined: 0, capped: false });

    const r4 = await run(rec, repo, adapter, over);   // …and the rotation starts from the top again
    expect(rec.lists.at(-1)).toEqual({ limit: 1 });
    expect(r4.skipped).toBe(1);
  });

  it("one folder, one FETCH per CHUNK — grouped, never one per row", async () => {
    const rec = fresh();
    const husks = [husk("m-10"), husk("m-11")];
    await run(rec, repoOf(rec, { husks }), adapterOf(rec));
    expect(rec.fetches).toHaveLength(1);
    expect(rec.fetches[0]!.uids).toEqual([10, 11]);
  });

  it("one adapter FETCH carries at most JUNK_RESTORE_FETCH_CHUNK locators — the in-flight byte bound", async () => {
    // The adapter holds every source buffer of ONE call until it returns, so an unchunked
    // 50-wide ask at the 8 MiB ceiling would hold ~400 MiB. Four at a time is ingest's own
    // 32 MiB bound, and each chunk's buffers release before the next is read.
    const rec = fresh();
    const husks = Array.from({ length: 9 }, (_, i) => husk(`m-${10 + i}`));
    const r = await run(rec, repoOf(rec, { husks }), adapterOf(rec));
    expect(r.restored).toBe(9);
    expect(rec.fetches.map((f) => f.uids.length), "an unchunked group holds every buffer at once")
      .toEqual([4, 4, 1]);
  });

  it("a dead connection defers the rows, charges the budget, and touches nothing", async () => {
    const rec = fresh();
    const r = await run(rec, repoOf(rec, { husks: [husk("m-10"), husk("m-11")] }), adapterOf(rec, { fail: true }));
    expect(r).toMatchObject({ deferred: 2, fetched: 2, restored: 0, refused: 0 });
    expect(rec.unhusks).toEqual([]);
  });

  it("THE WALK'S CLOCK: within the interval an untargeted call reads nothing; after it the walk runs", async () => {
    const rec = fresh();
    let t = 1_000_000;
    const over = { walkedAt: new Map<string, number>(), now: () => new Date(t), walkEveryMs: 15 * 60_000 };
    const repo = repoOf(rec, { husks: [] });
    await run(rec, repo, adapterOf(rec), over);
    expect(rec.lists).toHaveLength(1);
    t += 14 * 60_000;
    await run(rec, repo, adapterOf(rec), over);
    expect(rec.lists, "a walk that found nothing walked again within the interval").toHaveLength(1);
    t += 60_000;
    await run(rec, repo, adapterOf(rec), over);
    expect(rec.lists).toHaveLength(2);
  });

  it("THE WALK'S CLOCK holds neither the targeted run at the move nor the walk after a refill", async () => {
    const rec = fresh();
    const now = () => new Date(1_000_000);
    const repo = repoOf(rec, { husks: [husk("m-10")] });
    const clocked = { walkedAt: new Map<string, number>(), now };
    await run(rec, repoOf(rec, { husks: [] }), adapterOf(rec), clocked);
    const targeted = await run(rec, repo, adapterOf(rec), { ...clocked, messageIds: ["m-10"] });
    expect(targeted.restored, "the targeted run waited for the walk's clock").toBe(1);
    const refilled = { walkedAt: new Map<string, number>(), now };
    expect((await run(rec, repo, adapterOf(rec), refilled)).restored).toBe(1);
    expect((await run(rec, repo, adapterOf(rec), refilled)).restored,
      "a walk that refilled a body did not look again next cycle").toBe(1);
  });

  it("THE WALK'S CLOCK is cleared by a targeted run that left letters behind", async () => {
    let t = 1_000_000;
    const now = () => new Date(t);
    const moved = [husk("m-10"), husk("m-11"), husk("m-12")];
    for (const arm of ["capped", "deferred"] as const) {
      const rec = fresh();
      const clocked = { walkedAt: new Map<string, number>(), now };
      await run(rec, repoOf(rec, { husks: [] }), adapterOf(rec), clocked);
      const targeted = await run(rec, repoOf(rec, { husks: moved }), adapterOf(rec, { fail: arm === "deferred" }), {
        ...clocked, messageIds: moved.map((h) => h.messageId),
        ...(arm === "capped" ? { fetchesPerCycle: 1, fetchChunk: 1 } : {}),
      });
      expect(targeted.capped || targeted.deferred > 0, arm).toBe(true);
      t += 60_000;
      const next = await run(rec, repoOf(rec, { husks: moved }), adapterOf(rec), clocked);
      expect(next.restored, `the walk after a ${arm} targeted run waited out the clock`).toBeGreaterThan(0);
    }
  });

  it("THE WALK'S CLOCK is cleared by oweJunkWalk, the refill at the move's failure arm", async () => {
    const rec = fresh();
    const now = () => new Date(1_000_000);
    const shared = { walkedAt: undefined, mailboxId: "mb-owe", now };
    await run(rec, repoOf(rec, { husks: [] }), adapterOf(rec), shared);
    await run(rec, repoOf(rec, { husks: [] }), adapterOf(rec), shared);
    expect(rec.lists).toHaveLength(1);
    oweJunkWalk("mb-owe");
    await run(rec, repoOf(rec, { husks: [] }), adapterOf(rec), shared);
    expect(rec.lists).toHaveLength(2);
  });

  it("THE WIRING: a plain sync cycle runs the pass — an unwired pass is a decorative module", async () => {
    // `ai-gate.ts`'s lesson, applied forward: a pass that exists, passes its own tests and is
    // never CALLED is indistinguishable from a shipped feature everywhere except production.
    // This drives the real `runSyncCycle` over an idle mailbox (empty batch, nothing pending)
    // with a repo that offers exactly one husk, and requires the shared rewrite to have run.
    const rec = fresh();
    const repo = repoOf(rec, { husks: [husk("m-10")] });
    Object.assign(repo as unknown as Record<string, unknown>, {
      listMessageFailures: async () => [],
      getMailboxFolders: async () => [],
      listKnownLocators: async () => [],
      claimMessageFailures: async () => [],
      listPendingFolderStates: async () => [],
      listPendingFlagStates: async () => [],
      deferFolderReconcile: async () => {},
      deferFlagReconcile: async () => {},
    });
    const adapter = adapterOf(rec);
    Object.assign(adapter as unknown as Record<string, unknown>, {
      changesSince: async () => ({
        creates: [], moves: [], deletes: [], flagChanges: [], unanswered: [],
        newCursor: { folders: {} }, hasBacklog: false,
      }),
    });
    await runSyncCycle({
      repo, adapter, accountId: "acct-1", mailboxId: "mb-1",
      trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
    } as unknown as Parameters<typeof runSyncCycle>[0]);
    expect(rec.unhusks, "the cycle never reached the junk restore pass").toHaveLength(1);
    expect(rec.unhusks[0]).toMatchObject({ id: "m-10", capBytes: null });
  });
});

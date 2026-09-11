import { UNMETERED_STORAGE_CAP, normalizeMime, type Logger, type NormalizedMessage, type StorageCap } from "@trafficflow/core/mail";
import { parseRef, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { JunkFiledHuskRow, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";

/**
 * THE `junk_filed` CONVERGENCE PASS — a body husked by a spam verdict (`message_bodies.withheld_reason =
 * 'junk_filed'`, mail 0065) is refilled once its message is demonstrably alive in watched space again,
 * whoever moved it. The "Not junk" RESCUE (`junk-window.ts#rescueJunk`) refills at move time; the adopt
 * path refills an arrival that CARRIES bytes (`pipeline.ts` → `restoreWithheldBody`); this pass owns the
 * rest (a drag back in another client, a provider un-junk). Candidate predicate IS the idempotency:
 * `listJunkFiledHusks` answers husks with a live primary instance and no tombstone, and the filing
 * completion `forgetInstanceAt`s the parked Junk locator (`junk-filing.ts`), so "has a primary instance" is
 * "alive outside Junk" (mail 0071's partial index; no `done_at`). One VERIFY/REWRITE, shared with the
 * rescue (`core/husk-restore.ts#unhuskJunkFiledBody`), never a second path. Three per-cycle bounds (`JUNK_RESTORE_MAX_PAGES`, `JUNK_RESTORE_FETCHES_PER_CYCLE`, `JUNK_RESTORE_FETCH_CHUNK`), keyset-paged; refusals shelved in `refusedFor` (new build) and `capDeferredFor` (clock `AT_CAP_RETRY_MS`). Reads with BODY.PEEK, moves/flags/deletes nothing. */

/** SQL pages one cycle may walk before giving up and saying so. A bound, not `while (true)`. */
export const JUNK_RESTORE_MAX_PAGES = 20;

/** Messages re-read from the mail server per cycle — `redacted-restore.ts`'s heartbeat bound. */
export const JUNK_RESTORE_FETCHES_PER_CYCLE = 50;

/** Rows per SQL page inside the walk. Held in memory across the per-folder network reads. */
export const JUNK_RESTORE_PAGE = 50;

/**
 * Locators per adapter FETCH. The adapter holds every source buffer of one call until it
 * returns, so this times {@link JUNK_RESTORE_MAX_BYTES} is the in-flight ceiling of one call:
 * 4 × 8 MiB = 32 MiB, ingest's own batch bound. Chunks release between calls.
 */
export const JUNK_RESTORE_FETCH_CHUNK = 4;

/** How long an at-cap decline is remembered before the cap-aware rewrite is retried. */
export const AT_CAP_RETRY_MS = 60 * 60 * 1000;

/**
 * Per-message byte ceiling for the re-read. Over it the husk stands (its bytes are the one thing
 * we could not read). `redacted-restore.ts`'s 8 MiB — a verdict-filed message can carry an
 * attachment too, and the ceiling is a bound on one FETCH, not a storage decision (the stored
 * html is capped separately by `html-storage.ts`).
 */
export const JUNK_RESTORE_MAX_BYTES = 8 * 1024 * 1024;

/* THE THREE SHELVES BELOW ARE PER-PROCESS, AND THE RULE THAT MAKES THAT CORRECT. Stated as a rule because
 * the sibling that broke it cost somebody's mail: `sensitive-backfill.ts` kept this kind of shelf AND was
 * gated by a DURABLE completion marker, so one dropped connection refused a message for the life of the
 * process, the walk finished, the marker landed, and the message stayed redacted for ever (fixed 2026-09-01
 * by splitting decided from undecided refusals). THE RULE: process-scoped progress state is safe exactly
 * while it cannot be LAUNDERED INTO A DURABLE CLAIM — losing it must cost work, never correctness. This
 * pass satisfies it structurally: THERE IS NO COMPLETION MARKER, so a restart clears all three shelves
 * (`refusedByMailbox`, `capDeferredByMailbox`, `resumeAfterByMailbox`) together and re-walks from the top,
 * every loss toward MORE looking. A future durable "done" marker must move these three to disk in the same
 * commit, or it re-creates the sibling's defect one file over. */

const refusedByMailbox = new Map<string, Set<string>>();
/** The per-process memory of rows a new BUILD might change — see the header's two shelves. */
export function refusedFor(mailboxId: string): Set<string> {
  const hit = refusedByMailbox.get(mailboxId);
  if (hit) return hit;
  const fresh = new Set<string>();
  refusedByMailbox.set(mailboxId, fresh);
  return fresh;
}

const capDeferredByMailbox = new Map<string, Map<string, number>>();
/** messageId → epoch ms after which an at-cap decline is retried — the CLOCK shelf. */
export function capDeferredFor(mailboxId: string): Map<string, number> {
  const hit = capDeferredByMailbox.get(mailboxId);
  if (hit) return hit;
  const fresh = new Map<string, number>();
  capDeferredByMailbox.set(mailboxId, fresh);
  return fresh;
}

/**
 * WHERE A CAPPED CYCLE LEFT OFF — mailboxId → the keyset cursor to resume from, making the walk
 * a ROTATION rather than a restart. Without this, `maxPages × pageSize` remembered refusals
 * sorting first would make every cycle walk and skip the same prefix and exit at the page cap,
 * so the fresh candidate behind them was never reached (the second defect found here — the first
 * fix had only RAISED the starvation threshold). A cycle that completes the walk (a short or
 * empty page) CLEARS the entry, so the next cycle starts from the top and newly un-junked
 * messages with low ids wait at most one rotation.
 */
const resumeAfterByMailbox = new Map<string, string>();

export interface JunkRestoreDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  /** The account's cap, as the cycle resolved it — `UNMETERED_STORAGE_CAP` is the declaration. */
  storageCap: StorageCap;
  /**
   * The rewrite rides THIS, not the bare repo: the sync cycle passes its fenced group so the
   * leadership verdict and the restore commit or vanish together. A caller without a fence
   * passes `(fn) => repo.transaction(fn)`. The read (`listJunkFiledHusks`) does not — a stale
   * candidate is refused by the rewrite's own recheck.
   */
  write: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  log?: Logger;
  now?: () => Date;
  maxPages?: number;
  fetchesPerCycle?: number;
  page?: number;
  fetchChunk?: number;
  maxBytes?: number;
  capRetryMs?: number;
  /** Test seam for the in-memory refusal set (the per-build shelf). */
  refused?: Set<string>;
  /** Test seam for the at-cap deferral map (the clock shelf). */
  capDeferred?: Map<string, number>;
  /** Test seam for the rotation cursor (mailboxId → resume-after keyset position). */
  resume?: Map<string, string>;
}

export interface JunkRestoreResult {
  /** Candidate rows the SQL walk looked at. */
  examined: number;
  /** Messages re-read from the mail server. */
  fetched: number;
  /** Bodies refilled: marker cleared, bytes reserved, snippet refreshed, one `update` delta. */
  restored: number;
  /** Already declined by this process (see {@link refusedFor}) — not re-read. */
  skipped: number;
  /** Left for a later cycle without being remembered: stale epoch, gone from the folder, fetch failed. */
  deferred: number;
  /** Refused and remembered: over the ceiling, unparseable, identity mismatch, at cap. */
  refused: number;
  /** Someone else restored it (or re-husked it under another policy) between the read and the lock. */
  raced: number;
  /** A per-cycle bound ran out; the rest resumes on the next cycle. */
  capped: boolean;
}

const EMPTY: JunkRestoreResult = {
  examined: 0, fetched: 0, restored: 0, skipped: 0, deferred: 0, refused: 0, raced: 0, capped: false,
};

/**
 * THE PASS. Once per sync cycle per mailbox: re-read the bodies of `junk_filed` husks whose
 * message is alive in a watched folder, and refill them through the shared verify/rewrite.
 *
 * Every optional seam is checked, so a fake repo or an adapter without a targeted fetch answers
 * "no candidates" and never a wrong restore. Policy outcomes are counted and logged; the only
 * throws that leave this function are the ones `write` raises (the caller's fence vocabulary),
 * which the cycle rethrows or swallows on its own rule.
 */
export async function junkRestorePass(deps: JunkRestoreDeps): Promise<JunkRestoreResult> {
  const { repo, adapter, accountId, mailboxId, log } = deps;
  if (typeof repo.listJunkFiledHusks !== "function" || !adapter.fetchByUid) return { ...EMPTY };
  const listHusks = repo.listJunkFiledHusks.bind(repo);
  const fetchByUid = adapter.fetchByUid.bind(adapter);

  const maxPages = deps.maxPages ?? JUNK_RESTORE_MAX_PAGES;
  const fetchBudget = deps.fetchesPerCycle ?? JUNK_RESTORE_FETCHES_PER_CYCLE;
  const pageSize = deps.page ?? JUNK_RESTORE_PAGE;
  const fetchChunk = deps.fetchChunk ?? JUNK_RESTORE_FETCH_CHUNK;
  const maxBytes = deps.maxBytes ?? JUNK_RESTORE_MAX_BYTES;
  const capRetryMs = deps.capRetryMs ?? AT_CAP_RETRY_MS;
  const now = deps.now ?? (() => new Date());
  const capBytes = deps.storageCap === UNMETERED_STORAGE_CAP ? null : deps.storageCap;
  const refused = deps.refused ?? refusedFor(mailboxId);
  const capDeferred = deps.capDeferred ?? capDeferredFor(mailboxId);
  const resume = deps.resume ?? resumeAfterByMailbox;

  const result: JunkRestoreResult = { ...EMPTY };
  // THE ROTATION — see {@link resumeAfterByMailbox}: a bounded exit left a cursor, resume there.
  let after: string | undefined = resume.get(mailboxId);

  outer: for (let pages = 0; ; pages++) {
    if (pages >= maxPages || result.fetched >= fetchBudget) { result.capped = true; break; }
    // Where this page started — a mid-page budget exit resumes HERE, so the page's unprocessed
    // remainder is re-offered next cycle rather than waiting out a whole rotation.
    const pageStart = after;
    const page = await listHusks(accountId, mailboxId, {
      limit: pageSize, ...(after !== undefined ? { afterId: after } : {}),
    });
    if (page.length === 0) break;
    result.examined += page.length;
    after = page[page.length - 1]!.messageId;

    // One targeted FETCH per folder per chunk, the retry pass's grouping — never one per row.
    // Both refusal shelves are skipped HERE, before any grouping, and deliberately cost the
    // walk nothing but the page read: an examined-based budget once let two hundred remembered
    // refusals starve the fresh candidate sorted behind them, for ever.
    const byFolder = new Map<string, JunkFiledHuskRow[]>();
    const nowMs = now().getTime();
    for (const row of page) {
      if (refused.has(row.messageId)) { result.skipped++; continue; }
      const retryAt = capDeferred.get(row.messageId);
      if (retryAt !== undefined) {
        if (nowMs < retryAt) { result.skipped++; continue; }
        capDeferred.delete(row.messageId);   // the clock ran out — retry the cap-aware rewrite
      }
      const arr = byFolder.get(row.folder) ?? [];
      arr.push(row);
      byFolder.set(row.folder, arr);
    }

    for (const [folder, all] of byFolder) {
      for (let i = 0; i < all.length;) {
      const budget = fetchBudget - result.fetched;
      if (budget <= 0) { result.capped = true; after = pageStart; break outer; }
      const rows = all.slice(i, i + Math.min(fetchChunk, budget));
      i += rows.length;

      let found: Awaited<ReturnType<typeof fetchByUid>>;
      try {
        found = await fetchByUid(folder, rows.map((r) => r.uid), { maxBytes });
      } catch (err) {
        // The folder is unselectable or the connection died — nothing about these rows. They
        // keep their husks and are re-offered next cycle; the fetches still count, or a dead
        // connection would spin the whole budget through this arm.
        result.fetched += rows.length;
        result.deferred += rows.length;
        log?.warn("junk_restore_fetch_failed", { mailboxId, accountId, folder, err });
        continue;
      }
      result.fetched += rows.length;

      for (const row of rows) {
        // THE EPOCH GUARD — the retry pass's, verbatim: a UID number means nothing outside the
        // epoch that issued it. The instance row is stale; the scan re-numbers, we wait.
        if (found.uidValidity !== "0" && found.uidValidity !== row.uidValidity) { result.deferred++; continue; }
        // Moved or expunged since the instance was written. The scan's next delete observation
        // forgets the instance and the predicate heals itself; nothing to remember here.
        if (found.absent.includes(row.uid)) { result.deferred++; continue; }
        if (found.oversize.includes(row.uid)) {
          refused.add(row.messageId);
          result.refused++;
          log?.warn("junk_restore_oversize", {
            mailboxId, accountId, messageId: row.messageId, folder, uid: row.uid,
            reason: "the message is over the re-read ceiling; the husk stands and its bytes stay in the mailbox",
          });
          continue;
        }
        const change = found.creates.find((c) => parseRef(c.locator.ref).uid === row.uid);
        const raw = change?.raw;
        if (raw === undefined) {
          // Named, not absent, not oversize, and still no bytes — a server that stopped honouring
          // the targeted fetch's shape. Deferred, and said so; the next cycle asks again.
          result.deferred++;
          log?.warn("junk_restore_no_answer", { mailboxId, accountId, messageId: row.messageId, folder, uid: row.uid });
          continue;
        }

        let fresh: NormalizedMessage;
        try {
          fresh = await normalizeMime(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        } catch (err) {
          refused.add(row.messageId);
          result.refused++;
          log?.warn("junk_restore_unparseable", { mailboxId, accountId, messageId: row.messageId, err });
          continue;
        }

        const husk = { id: row.messageId, dedupKey: row.dedupKey, messageIdHeader: row.messageIdHeader };
        const outcome = await deps.write((r) =>
          typeof r.unhuskJunkFiledBody === "function"
            ? r.unhuskJunkFiledBody(accountId, husk, fresh, capBytes)
            : Promise.resolve("not_husked" as const));
        switch (outcome) {
          case "restored":
            result.restored++;
            break;
          case "not_husked":
            // The rescue, the adopt-time refill, or a second driver got there first — or another
            // policy re-husked it. Either way the row is not ours to write; nothing remembered,
            // because the predicate no longer offers it.
            result.raced++;
            break;
          case "identity_mismatch":
            refused.add(row.messageId);
            result.refused++;
            log?.warn("junk_restore_identity_mismatch", {
              mailboxId, accountId, messageId: row.messageId, folder, uid: row.uid,
              reason: "the instance no longer resolves to this message — nothing written, because " +
                "storing these bytes would put one person's mail into another message's row",
            });
            break;
          case "at_cap":
            // The CLOCK shelf, not the per-build one: the cap side changes under a running
            // worker (mail deleted, a tier upgraded), so the decline is retried after the
            // interval rather than remembered until a redeploy.
            capDeferred.set(row.messageId, nowMs + capRetryMs);
            result.refused++;
            log?.warn("junk_restore_at_cap", {
              mailboxId, accountId, messageId: row.messageId,
              reason: "the account is at its storage cap; the husk stands with its marker true — " +
                "the bytes live on in the mailbox, and the rewrite is retried once the interval passes",
            });
            break;
        }
      }
      }
    }
    if (page.length < pageSize) break;
  }

  // THE ROTATION'S BOOKKEEPING: a bounded exit resumes at `after` next cycle; a completed walk
  // (an empty or short page — the only non-capped exits) clears the cursor so the next cycle
  // starts from the top and newly un-junked low-id messages wait at most one rotation.
  if (result.capped && after !== undefined) resume.set(mailboxId, after);
  else resume.delete(mailboxId);

  if (result.restored > 0 || result.fetched > 0) {
    log?.info("sync_junk_bodies_restored", {
      mailboxId, accountId,
      examined: result.examined, fetched: result.fetched, restored: result.restored,
      skipped: result.skipped, deferred: result.deferred, refused: result.refused, raced: result.raced,
      capped: result.capped,
      reason: "junk_filed husks whose message is alive in a watched folder again were refilled " +
        "from the mailbox through the same verify/rewrite the Not-junk rescue uses",
    });
  }
  return result;
}

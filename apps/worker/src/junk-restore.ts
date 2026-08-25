import { UNMETERED_STORAGE_CAP, normalizeMime, type Logger, type NormalizedMessage, type StorageCap } from "@trafficflow/core/mail";
import { parseRef, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { JunkFiledHuskRow, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE `junk_filed` CONVERGENCE PASS — a body husked by a verdict is refilled once its message
 *  is demonstrably alive in watched space again, whoever moved it there
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A spam verdict that filed a message to the provider's native `\Junk` husked its stored body
 * (`message_bodies.withheld_reason = 'junk_filed'`, mail 0065): the bytes live on in Junk, which
 * is the master. When that message LEAVES Junk again there are two doors, and only one of them
 * was closed:
 *
 *  · the "Not junk" RESCUE (`packages/api/src/junk-window.ts#rescueJunk`) — our own verb, which
 *    fetches the raw while the message is still in Junk and refills the husk right after the
 *    move; and
 *  · EVERYTHING ELSE — the user drags it back to the Imbox in another mail client, the provider
 *    un-junks it on its own — where nobody pressed anything here. The ordinary scan then records
 *    the message alive in a WATCHED folder while its body row is still the verdict's husk.
 *
 * The adopt path already refills a husk whose arrival CARRIES bytes (`pipeline.ts` →
 * `restoreWithheldBody`), so the population this pass owns is what that left behind: an arrival
 * that carried no body (a flag-only observation, an instance recorded as a second copy), a
 * refill declined at cap that the account has since made room for, or a husk that predates the
 * adopt-time refill. Without this pass, every such row renders as an empty message for ever —
 * on webmail, on the desktop, on mobile — for mail the user demonstrably wants back.
 *
 * ── THE CANDIDATE PREDICATE IS STRUCTURAL, AND IT IS THE IDEMPOTENCY ─────────────────────────
 *
 * `listJunkFiledHusks` answers `junk_filed` husks whose message has a LIVE PRIMARY INSTANCE and
 * no tombstone. Instances exist only for enumerated folders, and the filing completion
 * `forgetInstanceAt`s the parked Junk locator (`junk-filing.ts`), so "has a primary instance"
 * IS "alive outside Junk" — no junk-path comparison to drift. A restored row loses its marker
 * and drops out of the predicate; a finished mailbox selects nothing and costs one indexed read
 * per cycle (mail 0071's partial index). No `done_at` column, on `redacted-restore.ts`'s
 * argument: the shrinking set is the bookmark.
 *
 * ── ONE VERIFY/REWRITE, SHARED WITH THE RESCUE — NEVER A SECOND RESTORE PATH ────────────────
 *
 * The fetch here is the worker's (the adapter's `fetchByUid` against the instance's folder, on
 * the connection the lease already holds); VERIFY and REWRITE are `core/husk-restore.ts`'s
 * `unhuskJunkFiledBody`, the same function the rescue calls. That is where the two-witness
 * identity check (Message-ID or content fingerprint — bytes are never stored into a row they do
 * not belong to), the lock-and-recheck (`FOR UPDATE`, `withheld_reason = 'junk_filed'` must
 * still stand: the rescue and this pass are different processes and can race on one husk; the
 * loser writes nothing) and the at-cap posture (`reserveBodyBytes`; a decline keeps the husk,
 * marker still TRUE, the bytes live on in the mailbox) all live. Two copies of that policy is
 * how one door drifts, so this module owns none of it.
 *
 * ── BOUNDED PER CYCLE, RESUMABLE, AND IT NEVER THROWS FOR A POLICY OUTCOME ──────────────────
 *
 * Three bounds, all per cycle: SQL pages walked (`JUNK_RESTORE_MAX_PAGES` — a bound, not
 * `while (true)`, `redacted-restore.ts`'s shape), messages RE-READ from the server
 * (`JUNK_RESTORE_FETCHES_PER_CYCLE`, its 50 — every one is a full-body FETCH), and bytes in
 * flight per FETCH (`JUNK_RESTORE_FETCH_CHUNK` locators per adapter call — the adapter
 * accumulates every source buffer of one call before returning, so a 50-wide ask at the 8 MiB
 * ceiling could hold ~400 MiB; four at a time caps one call at ingest's own 32 MiB batch
 * bound, and each chunk's buffers release before the next is read — a review round caught the
 * unchunked version). The walk is keyset-paged on `messages.id` within a cycle, because a
 * refused row keeps its husk and stays a candidate: a cursorless page would re-offer the same
 * refusals for ever (`redacted-restore.ts#selectCandidates`, verbatim). Rows this process
 * already declined are SKIPPED WITHOUT A FETCH and — deliberately — without consuming the walk:
 * the page bound is the only thing they cost, so a mailbox whose first two hundred candidates
 * are all remembered refusals still reaches the fresh candidate behind them in the same cycle
 * (the same review round caught the examined-based bound starving exactly that row).
 *
 * The refusal memory has two shelves, because two different things can change a verdict:
 *  · {@link refusedFor} — per process, for outcomes only a NEW BUILD changes: over the
 *    ceiling, unparseable, identity mismatch. A restart retries them.
 *  · {@link capDeferredFor} — per process WITH A CLOCK (`AT_CAP_RETRY_MS`): an at-cap decline
 *    is retried after the interval, because the CAP side changes under a running worker (mail
 *    deleted, a tier upgraded) and a permanent memo would leave the body empty until a
 *    redeploy on an account that has long since made room.
 *
 * What is NOT remembered at all, only deferred to a later cycle: an epoch mismatch (the
 * instance row is stale — a UID means nothing outside the epoch that issued it, and the scan
 * owns re-numbering) and a UID the server no longer holds there (moved or expunged since the
 * instance was written; the scan's next delete observation forgets the instance and the
 * predicate self-heals). Both are the scan's evidence to record, not this pass's.
 *
 * It reads with the adapter's targeted fetch and NOTHING ELSE: no move, no flag, no delete. The
 * only writes are the shared rewrite's — body, snippet, marker, one `change_log` `update`.
 */

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
 * so the fresh candidate behind them was never reached (review round 2's finding — round 1's
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

import {
  isCalendarMime, isHuskSameMessage, isSentFolderOf, normalizeMime, type Logger, type NormalizedMessage,
} from "@trafficflow/core/mail";
import { epochOf, parseRef, sameEpoch, type MailboxAdapter, type TargetedFetch } from "@trafficflow/core/adapters/imap";
import type { InvitationBackfillSettled, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { InvitationCandidate, InvitationWrite } from "@trafficflow/db";

/**
 * THE INVITATION PASS (mail 0204): every letter a mailbox stored before ingest kept invitations gets
 * the row ingest gives one now. A letter with a calendar part and no row is read again from the mail
 * server (BODY.PEEK, the whole letter), parsed by ingest's own parse, checked to be the same letter
 * (its identity, and its calendar parts' bytes as stored at arrival), and written through the
 * table's one door with a message change, so every device learns it. Per mailbox, in message-id
 * order from a cursor in `pass_progress`, a bounded run per visit; the done mark is written last.
 * It moves and flags nothing on the server and writes nothing but ohmail's copy.
 *
 * A place is SETTLED when its letter got its row or was found to keep none: no invitation, over the
 * size, gone from the server, not the same letter, unreadable, or a row the store refused for its
 * value (said). A read that fails settles nothing and ends the visit's run, and so does a fault of
 * the store's own (thrown, the cursor where it was); a letter that could not be read in
 * {@link INVITATION_BACKFILL_TRIES} visits of this process is settled without a row, and said so.
 */

/** Letters a page reads, and pages a visit may read. */
export const INVITATION_BACKFILL_PAGE = 500;
export const INVITATION_BACKFILL_PAGES = 20;
/** Letters read again from the mail server in one visit, and in one FETCH. */
export const INVITATION_BACKFILL_READS = 25;
export const INVITATION_BACKFILL_CHUNK = 4;
/** Wall clock one visit's run may take; asked before each fetch. */
export const INVITATION_BACKFILL_BUDGET_MS = 15_000;
/** The most of one letter read again; over it the letter keeps no row. */
export const INVITATION_BACKFILL_MAX_BYTES = 8 * 1024 * 1024;
/** Visits a letter may fail to be read in before it is settled without a row. */
export const INVITATION_BACKFILL_TRIES = 3;

/** One mailbox's pass in this process. */
export interface InvitationBackfillState {
  /** The done mark was read or written: no visit asks again. */
  done: boolean;
  /** Letters a read failed for, and in how many visits. */
  tries: Map<string, number>;
}

export function newInvitationBackfillState(): InvitationBackfillState {
  return { done: false, tries: new Map() };
}

const stateByMailbox = new Map<string, InvitationBackfillState>();
function stateFor(mailboxId: string): InvitationBackfillState {
  let state = stateByMailbox.get(mailboxId);
  if (state === undefined) stateByMailbox.set(mailboxId, (state = newInvitationBackfillState()));
  return state;
}

export interface InvitationBackfillDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  /** The cycle's fenced group: each settle commits or vanishes with the fence. */
  write: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  log?: Logger;
  now?: () => Date;
  state?: InvitationBackfillState;
  page?: number;
  pages?: number;
  reads?: number;
  chunk?: number;
  budgetMs?: number;
  maxBytes?: number;
}

/** Why one place was settled without a row, or why it was not settled. */
type Settled = "row" | "no_invitation" | "too_large" | "gone" | "not_the_letter" | "unreadable";
type Unsettled = "epoch_changed" | "no_answer";

export interface InvitationBackfillResult {
  /** Set when the run did not walk: the pass is done, or this repo or adapter cannot run it. */
  waited: "done" | "unsupported" | null;
  scanned: number;
  read: number;
  /** Rows written. */
  written: number;
  /** Places settled without a row. */
  without: number;
  /** A bound of the run ran out; the next visit goes on from the cursor. */
  capped: boolean;
  /** The run ended on a read that failed. */
  stopped: "fetch_failed" | "epoch_unknown" | "unsettled" | null;
  /** The done mark was written by this run. */
  finished: boolean;
}

/** The calendar parts' digests a re-read letter carries, as ingest stores them, sorted. */
const calendarDigests = (m: NormalizedMessage): string[] =>
  m.attachments.filter((a) => isCalendarMime(a.contentType)).map((a) => a.contentSha256 ?? "").sort();

export async function invitationBackfillPass(deps: InvitationBackfillDeps): Promise<InvitationBackfillResult> {
  const { repo, adapter, accountId, mailboxId, log } = deps;
  const result: InvitationBackfillResult = {
    waited: null, scanned: 0, read: 0, written: 0, without: 0, capped: false, stopped: null, finished: false,
  };
  if (typeof repo.invitationBackfillPage !== "function" || typeof repo.invitationBackfillSettle !== "function" || !adapter.fetchByUid) {
    return { ...result, waited: "unsupported" };
  }
  const state = deps.state ?? stateFor(mailboxId);
  if (state.done) return { ...result, waited: "done" };
  const fetchByUid = adapter.fetchByUid.bind(adapter);
  const now = deps.now ?? (() => new Date());
  const deadline = now().getTime() + (deps.budgetMs ?? INVITATION_BACKFILL_BUDGET_MS);
  const pageRows = deps.page ?? INVITATION_BACKFILL_PAGE;
  const reads = deps.reads ?? INVITATION_BACKFILL_READS;
  const chunkSize = deps.chunk ?? INVITATION_BACKFILL_CHUNK;
  const sentFolder = (await repo.getMailboxSpecialFolders?.(mailboxId))?.sentFolder ?? null;
  const settle = (cursor: string | null, invitation?: InvitationWrite, finished?: true): Promise<InvitationBackfillSettled> =>
    deps.write((w) => w.invitationBackfillSettle!({
      accountId, mailboxId, cursor, at: now(), ...(invitation !== undefined ? { invitation } : {}), ...(finished ? { finished } : {}),
    }));

  let after: string | null | undefined;
  walk: for (let p = 0; p < (deps.pages ?? INVITATION_BACKFILL_PAGES); p++) {
    const page = await repo.invitationBackfillPage(accountId, mailboxId, { ...(after !== undefined ? { after } : {}), limit: pageRows });
    if (page.done) {
      state.done = true;
      return { ...result, waited: result.scanned === 0 ? "done" : null };
    }
    result.scanned += page.scanned.length;
    const candidates = new Map(page.candidates.map((c) => [c.messageId, c]));
    let i = 0;
    while (i < page.scanned.length) {
      const first = candidates.get(page.scanned[i]!);
      if (first === undefined) { i++; continue; }
      if (result.read >= reads || now().getTime() >= deadline) {
        result.capped = true;
        // The places before this candidate are settled: none of them carries a calendar part.
        if (i > 0) await settle(page.scanned[i - 1]!);
        break walk;
      }
      // This candidate and the next ones of its folder, as far as the chunk and the run's reads allow.
      const chunk = [first];
      for (let j = i + 1; j < page.scanned.length && chunk.length < Math.min(chunkSize, reads - result.read); j++) {
        const next = candidates.get(page.scanned[j]!);
        if (next === undefined) continue;
        if (next.folder !== first.folder) break;
        chunk.push(next);
      }
      let found: TargetedFetch;
      try {
        found = await fetchByUid(first.folder, chunk.map((c) => c.uid), { maxBytes: deps.maxBytes ?? INVITATION_BACKFILL_MAX_BYTES });
      } catch (err) {
        result.stopped = "fetch_failed";
        log?.warn("invitation_backfill_fetch_failed", { mailboxId, accountId, count: chunk.length, err });
        if (i > 0) await settle(page.scanned[i - 1]!);
        break walk;
      }
      result.read += chunk.length;
      if (!epochOf(found.uidValidity).known) {
        result.stopped = "epoch_unknown";
        if (i > 0) await settle(page.scanned[i - 1]!);
        break walk;
      }
      for (const c of chunk) {
        const verdict = await judge(c, found);
        if ("unsettled" in verdict) {
          const tries = (state.tries.get(c.messageId) ?? 0) + 1;
          if (tries < INVITATION_BACKFILL_TRIES) {
            state.tries.set(c.messageId, tries);
            result.stopped = "unsettled";
            if (page.scanned.indexOf(c.messageId) > 0) await settle(page.scanned[page.scanned.indexOf(c.messageId) - 1]!);
            break walk;
          }
          state.tries.delete(c.messageId);
          log?.warn("invitation_backfill_settled_unread", { mailboxId, accountId, messageId: c.messageId, reason: verdict.unsettled, tries });
          await settle(c.messageId);
          result.without += 1;
          continue;
        }
        const settled = await settle(c.messageId, verdict.invitation);
        // The store refused the row for its value: the letter is settled without it, and said.
        if (settled.refused !== undefined) {
          log?.warn("invitation_row_refused", { accountId, mailboxId, messageId: c.messageId, reason: settled.refused });
        }
        if (verdict.invitation !== undefined && settled.changed.includes(c.messageId)) result.written += 1;
        else result.without += 1;
      }
      i = page.scanned.indexOf(chunk[chunk.length - 1]!.messageId) + 1;
    }
    const last = page.scanned[page.scanned.length - 1];
    if (page.scanned.length < pageRows) {
      await settle(null, undefined, true);
      state.done = true;
      result.finished = true;
      break;
    }
    await settle(last!);
    after = last!;
  }
  if (result.read > 0 || result.finished) {
    log?.info("invitation_backfill_pass", {
      mailboxId, accountId, scanned: result.scanned, read: result.read, written: result.written, skipped: result.without,
      capped: result.capped, stopped: result.stopped, finished: result.finished,
    });
  }
  return result;

  /** One candidate's verdict on what the server answered for it. */
  async function judge(c: InvitationCandidate, found: TargetedFetch): Promise<{ settled: Settled; invitation?: InvitationWrite } | { unsettled: Unsettled }> {
    if (!sameEpoch(epochOf(found.uidValidity), epochOf(c.uidValidity))) return { unsettled: "epoch_changed" };
    if (found.absent.includes(c.uid)) return { settled: "gone" };
    if (found.oversize.includes(c.uid)) return { settled: "too_large" };
    const raw = found.creates.find((x) => parseRef(x.locator.ref).uid === c.uid)?.raw;
    if (raw === undefined) return { unsettled: "no_answer" };
    let fresh: NormalizedMessage;
    try {
      fresh = await normalizeMime(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    } catch {
      return { settled: "unreadable" };
    }
    const husk = { id: c.messageId, dedupKey: c.dedupKey, messageIdHeader: c.messageIdHeader };
    if (!isHuskSameMessage(husk, fresh) || calendarDigests(fresh).join(",") !== [...c.calendarSha256].sort().join(",")) {
      return { settled: "not_the_letter" };
    }
    const invitation = fresh.calendar?.invitation;
    if (invitation === undefined) return { settled: "no_invitation" };
    return {
      settled: "row",
      invitation: { ...invitation, accountId, messageId: c.messageId, own: isSentFolderOf(c.folder, sentFolder) },
    };
  }
}

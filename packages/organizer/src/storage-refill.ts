import { UNMETERED_STORAGE_CAP, normalizeMime, type Logger, type NormalizedMessage, type StorageCap } from "@trafficflow/core/mail";
import { epochOf, parseRef, sameEpoch, type MailboxAdapter, type TargetedFetch } from "@trafficflow/core/adapters/imap";
import type { StorageCapHuskKey, StorageCapHuskRow, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { EVICT_LOW_WATER_RATIO, type AccountRecount } from "@trafficflow/db";
import { STORAGE_RECOUNT_EVERY_MS } from "./storage-evict.js";

/**
 * THE STORAGE REFILL: once the account has room again, this mailbox's letters whose text the trim
 * emptied get it back from the mail server, newest first and a bounded run at a time, while the
 * counter stays at or under the trim's mark (inside a trial's storage floor, the mark of the plan's
 * own limit, which the trim keeps once the floor ends). The room is decided under the counter lock in
 * `core/husk-restore.ts#refillStorageCapBody`. A numeric cap only: an unmetered answer, or a cap
 * read that failed, refills nothing. Reads with BODY.PEEK; writes only ohmail's copy. Its state is
 * per process and has no completion marker, so a restart costs a re-walk, never a wrong write.
 */

/** A mailbox's runs are at least this far apart. */
export const REFILL_EVERY_MS = 10 * 60 * 1000;
/** Letters re-read from the mail server in one run. */
export const REFILL_FETCHES_PER_RUN = 200;
/** Wall clock one run may take; checked before each fetch. */
export const REFILL_RUN_BUDGET_MS = 30_000;
/** Raw bytes one mailbox may re-read in a rolling day, checked before each fetch. */
export const REFILL_BYTES_PER_DAY = 1024 * 1024 * 1024;
/** Per-letter ceiling of the re-read; over it the letter stays empty. */
export const REFILL_MAX_BYTES = 8 * 1024 * 1024;
/** Letters per FETCH: with {@link REFILL_MAX_BYTES}, the 32 MiB in-flight bound ingest keeps. */
export const REFILL_FETCH_CHUNK = 4;
/** How long a letter gone from the mail server is not asked about again. */
export const REFILL_ABSENT_RETRY_MS = 6 * 60 * 60 * 1000;
/** Rows per page of the walk, and pages one run may read. */
export const REFILL_PAGE = 50;
export const REFILL_MAX_PAGES = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One mailbox's refill state in this process. */
export interface RefillState {
  /** When the last run started, epoch ms. */
  lastRunAt: number | null;
  /** Where the walk resumes: the letters older than this one. `null` starts at the newest. */
  after: StorageCapHuskKey | null;
  /** The counter's latest trim and its emptied count when the walk's place was last checked. */
  lastHuskedAt: number | null;
  husked: number;
  /** How far the letter that did not fit would have moved the counter; no run while the room is smaller. */
  blocked: number | null;
  /** The raw bytes each fetch read, for the rolling day. */
  day: Array<{ at: number; bytes: number }>;
  /** Letters gone from the mail server: messageId → epoch ms they may be asked about again. */
  absent: Map<string, number>;
  /** Letters over the size limit, unparseable or not matching: not asked again by this process. */
  refused: Set<string>;
}

export function newRefillState(): RefillState {
  return {
    lastRunAt: null, after: null, lastHuskedAt: null, husked: 0, blocked: null,
    day: [], absent: new Map(), refused: new Set(),
  };
}

const stateByMailbox = new Map<string, RefillState>();
export function refillStateFor(mailboxId: string): RefillState {
  let state = stateByMailbox.get(mailboxId);
  if (state === undefined) {
    state = newRefillState();
    stateByMailbox.set(mailboxId, state);
  }
  return state;
}

export interface StorageRefillDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  /** The account's cap as the cycle resolved it; only a number refills anything. */
  storageCap: StorageCap;
  /**
   * Inside a trial's storage floor the plan's own limit: the text comes back only up to its mark, the
   * one the trim keeps once the floor ends, never past the cap's. Absent or null: the cap.
   */
  planLimitBytes?: number | null;
  /** The cycle's fenced group: every rewrite and recount commits or vanishes with the fence. */
  write: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  log?: Logger;
  now?: () => Date;
  state?: RefillState;
  everyMs?: number;
  fetchesPerRun?: number;
  runBudgetMs?: number;
  bytesPerDay?: number;
  maxBytes?: number;
  fetchChunk?: number;
  absentRetryMs?: number;
  page?: number;
  maxPages?: number;
}

/** Why a run did not walk at all. */
export type RefillWait =
  | "unmetered" | "unsupported" | "interval" | "day_budget" | "nothing_emptied" | "no_room"
  | "account_erased" | "erasing" | "importing";

/** Why a walk ended before its bounds: a letter did not fit, the day's bytes, or the server. */
export type RefillStop = "no_room" | "day_budget" | "fetch_failed" | "epoch_unknown";

export interface StorageRefillResult {
  /** Set when the run did not walk. */
  waited: RefillWait | null;
  examined: number;
  fetched: number;
  /** Letters whose text came back. */
  restored: number;
  /** Shelved by this process and not asked about. */
  skipped: number;
  /** Left for a later walk without being remembered: renumbered folder, no answer, failed fetch. */
  deferred: number;
  /** Shelved: gone from the server (for a while), over the size limit, unparseable, not matching. */
  refused: number;
  /** The letter stopped being emptied, or left the mailbox, between the read and the lock. */
  raced: number;
  /** A per-run bound ran out; the next run resumes. */
  capped: boolean;
  stopped: RefillStop | null;
  /** Bytes the counter grew by. */
  bytes: number;
}

const result0 = (): StorageRefillResult => ({
  waited: null, examined: 0, fetched: 0, restored: 0, skipped: 0, deferred: 0, refused: 0, raced: 0,
  capped: false, stopped: null, bytes: 0,
});

export async function storageRefillPass(deps: StorageRefillDeps): Promise<StorageRefillResult> {
  const { repo, adapter, accountId, mailboxId, log } = deps;
  const result = result0();
  const wait = (why: RefillWait): StorageRefillResult => ({ ...result, waited: why });
  if (deps.storageCap === UNMETERED_STORAGE_CAP || !Number.isFinite(deps.storageCap) || deps.storageCap <= 0) return wait("unmetered");
  // Inside a trial's floor the plan's own limit, never above the cap: what the refill may fill.
  const plan = deps.planLimitBytes ?? null;
  const cap = plan !== null && Number.isFinite(plan) && plan >= 0 && plan < deps.storageCap ? plan : deps.storageCap;
  if (typeof repo.listStorageCapHusks !== "function" || typeof repo.refillStorageCapBody !== "function"
    || typeof repo.storageRefillCounter !== "function" || typeof repo.storageRefillHold !== "function"
    || typeof repo.recountAccountStorage !== "function" || !adapter.fetchByUid) return wait("unsupported");
  const fetchByUid = adapter.fetchByUid.bind(adapter);
  const now = deps.now ?? (() => new Date());
  const state = deps.state ?? refillStateFor(mailboxId);
  const bytesPerDay = deps.bytesPerDay ?? REFILL_BYTES_PER_DAY;
  const startedMs = now().getTime();

  if (state.lastRunAt !== null && startedMs - state.lastRunAt < (deps.everyMs ?? REFILL_EVERY_MS)) return wait("interval");
  state.day = state.day.filter((d) => startedMs - d.at < DAY_MS);
  const dayBytes = (): number => state.day.reduce((n, d) => n + d.bytes, 0);
  if (dayBytes() >= bytesPerDay) return wait("day_budget");
  state.lastRunAt = startedMs;

  const mark = Math.floor(cap * EVICT_LOW_WATER_RATIO);
  /** Room above 0, and at least what the letter that did not fit needed. */
  const roomFor = (used: number): boolean => {
    const room = mark - used;
    if (room <= 0 || (state.blocked !== null && room < state.blocked)) return false;
    state.blocked = null;
    return true;
  };
  const counter = await repo.storageRefillCounter(accountId);
  if (counter === null || counter.huskedForSpace <= 0) return wait("nothing_emptied");
  // The walk goes back to the newest letter when the trim ran or the count rose since its place was taken.
  const trimmedAt = counter.lastHuskedAt?.getTime() ?? null;
  if (trimmedAt !== state.lastHuskedAt || counter.huskedForSpace > state.husked) {
    state.after = null;
    state.blocked = null;
  }
  state.lastHuskedAt = trimmedAt;
  state.husked = counter.huskedForSpace;
  if (!roomFor(counter.bytes)) return wait("no_room");
  const hold = await repo.storageRefillHold(accountId);
  if (hold !== null) return wait(hold);
  const recount = async (): Promise<AccountRecount> => {
    const r = await deps.write((w) => w.recountAccountStorage!(accountId, now()));
    if (r.drift !== 0) log?.warn("storage_counter_drift", { accountId, drift: r.drift, bytes: r.bytes });
    state.husked = r.huskedForSpace;
    return r;
  };
  // A counter not checked against the stored letters for a day is checked first.
  if (counter.recountedAt === null || startedMs - counter.recountedAt.getTime() >= STORAGE_RECOUNT_EVERY_MS) {
    const r = await recount();
    if (r.huskedForSpace <= 0) return wait("nothing_emptied");
    if (!roomFor(r.bytes)) return wait("no_room");
  }

  const fetchesPerRun = deps.fetchesPerRun ?? REFILL_FETCHES_PER_RUN;
  const deadline = startedMs + (deps.runBudgetMs ?? REFILL_RUN_BUDGET_MS);
  const chunkSize = deps.fetchChunk ?? REFILL_FETCH_CHUNK;
  const pageSize = deps.page ?? REFILL_PAGE;
  const maxPages = deps.maxPages ?? REFILL_MAX_PAGES;
  const absentRetryMs = deps.absentRetryMs ?? REFILL_ABSENT_RETRY_MS;
  const shelved = (row: StorageCapHuskRow): boolean =>
    state.refused.has(row.messageId) || (state.absent.get(row.messageId) ?? 0) > startedMs;
  const shelve = (row: StorageCapHuskRow, event: string, reason: string): void => {
    state.refused.add(row.messageId);
    result.refused += 1;
    log?.warn(event, { mailboxId, accountId, messageId: row.messageId, reason });
  };

  /** One letter of a fetched chunk: `false` ends the run with the walk's place above it. */
  const one = async (row: StorageCapHuskRow, found: TargetedFetch): Promise<boolean> => {
    if (!sameEpoch(epochOf(found.uidValidity), epochOf(row.uidValidity))) { result.deferred += 1; return true; }
    if (found.absent.includes(row.uid)) {
      state.absent.set(row.messageId, startedMs + absentRetryMs);
      result.refused += 1;
      return true;
    }
    if (found.oversize.includes(row.uid)) {
      shelve(row, "storage_refill_oversize", "the letter is over the re-read limit, so its text stays empty here");
      return true;
    }
    const raw = found.creates.find((c) => parseRef(c.locator.ref).uid === row.uid)?.raw;
    if (raw === undefined) { result.deferred += 1; return true; }
    let fresh: NormalizedMessage;
    try {
      fresh = await normalizeMime(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    } catch {
      shelve(row, "storage_refill_unparseable", "the letter could not be read, so its text stays empty here");
      return true;
    }
    const husk = { id: row.messageId, dedupKey: row.dedupKey, messageIdHeader: row.messageIdHeader };
    const out = await deps.write((w) => w.refillStorageCapBody!(accountId, mailboxId, husk, fresh, cap));
    switch (out.outcome) {
      case "refilled":
        result.restored += 1;
        result.bytes += out.grew;
        return true;
      case "not_capped":
      case "gone":
        result.raced += 1;
        return true;
      case "identity_mismatch":
        shelve(row, "storage_refill_identity_mismatch",
          "the letter at that place on the server is not this one, so nothing was written");
        return true;
      case "no_room":
        state.blocked = out.grew;
        result.stopped = "no_room";
        return false;
    }
  };

  walk: for (let pages = 0; ; pages++) {
    if (pages >= maxPages) { result.capped = true; break; }
    const page = await repo.listStorageCapHusks(accountId, mailboxId, {
      limit: pageSize, ...(state.after !== null ? { before: state.after } : {}),
    });
    result.examined += page.length;
    for (let i = 0; i < page.length;) {
      const row = page[i]!;
      if (shelved(row)) {
        result.skipped += 1;
        state.after = { at: row.at, id: row.messageId };
        i += 1;
        continue;
      }
      if (result.fetched >= fetchesPerRun || now().getTime() >= deadline) { result.capped = true; break walk; }
      if (dayBytes() >= bytesPerDay) { result.stopped = "day_budget"; break walk; }
      // Consecutive letters of one folder, newest first, so the walk's place stays exact.
      const chunk = [row];
      const most = Math.min(chunkSize, fetchesPerRun - result.fetched);
      while (chunk.length < most && i + chunk.length < page.length) {
        const next = page[i + chunk.length]!;
        if (next.folder !== row.folder || shelved(next)) break;
        chunk.push(next);
      }
      let found: TargetedFetch;
      try {
        found = await fetchByUid(row.folder, chunk.map((r) => r.uid), { maxBytes: deps.maxBytes ?? REFILL_MAX_BYTES });
      } catch (err) {
        result.deferred += chunk.length;
        result.stopped = "fetch_failed";
        log?.warn("storage_refill_fetch_failed", { mailboxId, accountId, err });
        break walk;
      }
      result.fetched += chunk.length;
      state.day.push({
        at: startedMs,
        bytes: found.creates.reduce((n, c) => n + (c.raw === undefined ? 0 : c.raw.length), 0),
      });
      if (!epochOf(found.uidValidity).known) {
        result.deferred += chunk.length;
        result.stopped = "epoch_unknown";
        log?.warn("storage_refill_epoch_unknown", {
          mailboxId, accountId, reason: "the server named no UIDVALIDITY for this folder; the letters stay as they are",
        });
        break walk;
      }
      for (const r of chunk) {
        if (!(await one(r, found))) break walk;
        state.after = { at: r.at, id: r.messageId };
      }
      i += chunk.length;
    }
    // A short page is the oldest letter: the next run starts at the newest again.
    if (page.length < pageSize) { state.after = null; break; }
  }

  // The text that came back moves the month text is kept from back; the recount is fenced, so it
  // never recreates the counter row of an account erased meanwhile.
  if (result.restored > 0) await recount();
  if (result.fetched > 0 || result.restored > 0) {
    log?.info("storage_refill_pass", {
      mailboxId, accountId, examined: result.examined, fetched: result.fetched, restored: result.restored,
      skipped: result.skipped, deferred: result.deferred, refused: result.refused, raced: result.raced,
      capped: result.capped, stopped: result.stopped, bytes: result.bytes,
    });
  }
  return result;
}

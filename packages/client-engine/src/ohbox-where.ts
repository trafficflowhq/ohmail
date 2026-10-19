/**
 * WHERE THE OHBOX'S MAIL WENT — the facts behind the line under the Ohbox title (row
 * OHBOX-QUIET-READS-AS-STALLED). A quiet Ohbox over mail that the sender rules filed elsewhere read
 * as a stopped sync; the line says when the mailboxes were last checked and how many letters went
 * to which pile since the person last left the Ohbox. One implementation for web, desktop and phone.
 */
import type { EntityReader } from "./store.js";
import { isOwnSent, messagesByDateDesc } from "./selectors.js";
import { storeInstantOf } from "./store-pages.js";
import { VIEW_OF_FOLDER, type EngineMessage, type ISODateTime, type OhmailView } from "./types.js";

/**
 * `view_meta` id of the Ohbox visit mark. Device-local (`putLocal`, seq 0): never on `/sync`, never
 * a mutation, wiped by a 410 re-sync, gone with the mirror on sign-out.
 */
export const OHBOX_VISIT_ID = "ohbox_visit";
export interface OhboxVisitMeta {
  at: ISODateTime;
}

/** The piles counted, in display order. The Screener is left out: the doorbell reports it. */
export const FILED_PILES = ["reads", "receipts", "screened", "spam"] as const satisfies readonly OhmailView[];
export type FiledPile = (typeof FILED_PILES)[number];

/**
 * The most letters newer than the mark a count may walk. At or below every shipped mirror window's
 * `minRows` (asserted by the web and phone suites), so a count never runs past what the mirror is
 * sure to hold; past it the line states nothing rather than a partial count.
 */
export const FILED_SINCE_SCAN_MAX = 5_000;

/** Mailbox facts older than this cannot say "Checked": a tab back from hidden has not re-read them. */
export const CHECKED_FACTS_MAX_AGE_MS = 90_000;

/** A letter dated further ahead than this is a broken Date header, not mail that arrived. */
const FUTURE_SLACK_MS = 48 * 60 * 60 * 1000;

/**
 * How far a sort instant may sit from its arrival: the server keeps the sender's Date as the sort
 * instant only within 48 h of the arrival (`materialize.ts#SORT_TOLERANCE_MS`). The walks below go
 * this far under the mark in date order, so a letter whose header is behind its arrival is reached.
 * A letter recorded long after it arrived (a first import) sits below the walk and is not counted.
 */
const SORT_TOLERANCE_MS = 48 * 60 * 60 * 1000;

const PILE_SET: ReadonlySet<string> = new Set(FILED_PILES);

/**
 * WHEN THE SERVER RECORDED A LETTER (`arrivedAt`, `messages.created_at`), the one stamp the sender
 * does not write and a later visit cannot see again. A row without it falls back to its sort
 * instant, `capAt` when given.
 */
function arrivalKeyOf(m: EngineMessage, capAt?: number): number {
  const arrived = m.arrivedAt == null ? Number.NaN : Date.parse(m.arrivedAt);
  if (Number.isFinite(arrived)) return arrived;
  const at = storeInstantOf(m);
  return capAt === undefined ? at : Math.min(capAt, at);
}

/**
 * THE MARK A LEAVE WRITES: the newest recorded arrival held. Anchored on held mail rather than the
 * clock so a letter reaching the mirror minutes after the person left still counts, without
 * trusting this device's clock against the server's. A row without a recorded arrival is capped at
 * the clock, so a future-dated letter cannot silence the line. An empty mirror answers the clock.
 */
export function ohboxVisitMark(reader: EntityReader, nowMs: number): ISODateTime {
  let mark = Number.NEGATIVE_INFINITY;
  let walked = 0;
  for (const m of messagesByDateDesc(reader)) {
    if (storeInstantOf(m) <= mark - SORT_TOLERANCE_MS || ++walked > FILED_SINCE_SCAN_MAX) break;
    mark = Math.max(mark, arrivalKeyOf(m, nowMs));
  }
  return new Date(Number.isFinite(mark) ? mark : nowMs).toISOString();
}

export interface FiledSince {
  /** The mark counted from. */
  at: ISODateTime;
  /** Non-zero piles only, in {@link FILED_PILES} order. */
  counts: Array<{ pile: FiledPile; count: number }>;
}

/**
 * Letters filed to each pile since the mark: those recorded after it, walked in date order down to
 * the tolerance under it. Pass the PRESENTED reader so each count is what the linked view lists.
 * Leaves out own sent mail, away replies, letters a person placed (`placeDecided`), ids in
 * `exclude` (held routing presses) and far-future dates. `null` without a usable mark, or past
 * {@link FILED_SINCE_SCAN_MAX} rows walked.
 */
export function filedSinceVisit(
  reader: EntityReader,
  visit: OhboxVisitMeta | null | undefined,
  opts: { nowMs: number; exclude?: { has(id: string): boolean } },
): FiledSince | null {
  if (!visit || typeof visit.at !== "string") return null;
  const mark = Date.parse(visit.at);
  if (!Number.isFinite(mark)) return null;
  const tally = new Map<FiledPile, number>();
  let walked = 0;
  for (const m of messagesByDateDesc(reader)) {
    const at = storeInstantOf(m);
    if (at <= mark - SORT_TOLERANCE_MS) break;
    if (++walked > FILED_SINCE_SCAN_MAX) return null;
    if (arrivalKeyOf(m) <= mark || at > opts.nowMs + FUTURE_SLACK_MS) continue;
    if (isOwnSent(m) || m.autoReplyByUs === true || m.placeDecided === true) continue;
    if (opts.exclude?.has(m.id)) continue;
    const pile = (VIEW_OF_FOLDER as Record<string, OhmailView | undefined>)[m.folder];
    if (pile === undefined || !PILE_SET.has(pile)) continue;
    tally.set(pile as FiledPile, (tally.get(pile as FiledPile) ?? 0) + 1);
  }
  return {
    at: visit.at,
    counts: FILED_PILES.filter((p) => (tally.get(p) ?? 0) > 0).map((pile) => ({ pile, count: tally.get(pile)! })),
  };
}

/** The mailbox facts {@link lastCheckedAt} reads (`GET /mailboxes`, narrowed). */
export interface CheckedRow {
  status: string | null;
  syncBlockedSince?: string | null;
  lastSyncAt?: string | null;
  /** Cloud-paired desktop only: Cloud's own scan. Present-but-null is "not known yet". */
  hostedLastSyncAt?: string | null;
}

/**
 * WHEN EVERY MAILBOX WAS LAST CHECKED — the oldest scan stamp, so "Checked" holds for each one.
 * `null` unless the facts were read within {@link CHECKED_FACTS_MAX_AGE_MS} and every mailbox that
 * is not disabled is connected, unblocked and stamped. A row carrying `hostedLastSyncAt` is read by
 * it alone, so a Cloud-paired desktop never shows its own pull as a check.
 */
export function lastCheckedAt(
  rows: readonly CheckedRow[] | null | undefined,
  factsReadAtMs: number | null,
  nowMs: number,
): string | null {
  if (!rows || factsReadAtMs === null || nowMs - factsReadAtMs > CHECKED_FACTS_MAX_AGE_MS) return null;
  let oldest: { at: number; iso: string } | null = null;
  for (const r of rows) {
    if (r.status === "disabled") continue;
    if (r.status !== "connected" || r.syncBlockedSince) return null;
    const checked = "hostedLastSyncAt" in r ? r.hostedLastSyncAt ?? null : r.lastSyncAt ?? null;
    if (!checked) return null;
    const at = Date.parse(checked);
    if (!Number.isFinite(at)) return null;
    if (oldest === null || at < oldest.at) oldest = { at, iso: checked };
  }
  return oldest?.iso ?? null;
}

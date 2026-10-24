/**
 * THE FILINGS THAT WAIT ON THE MAIL SERVER, WORDED FOR THE PHONE — the strip over the Ohbox and in
 * Settings, the Settings block per mailbox and what its two presses answer. Pure, over the
 * mailbox facts (`readMailboxes`' `filing`) and the block's read (`readFilings`), in the web's words
 * (`sync.filing*`, `mailboxFilings.*`). Only mailboxes the answering server organizes, and by the
 * server's own stuck/deferred split: this phone keeps no stuck threshold of its own.
 */
import { VIEW_OF_FOLDER, clock, filingRefusalReason } from "@ohmail/client-engine";
import { Copy } from "../copy";
import { folderName } from "../state/live";
import { DESTINATIONS, destDone, type Destination } from "../state/model";
import type { FilingsPress, PhoneFilingsGroup, PhoneMailbox } from "../net/mailboxes";

/** A mailbox whose waiting filings this phone may speak for: organized by the answering server, live. */
export function filingsWait(m: PhoneMailbox): boolean {
  return m.organizerRole === "organizer" && m.status !== "disabled" && m.filing !== undefined
    && (m.filing.stuck > 0 || m.filing.deferred > 0);
}

/** How many filings of this mailbox wait on the mail server — the self-check's count. */
export function filingsWaiting(m: PhoneMailbox | undefined): number {
  if (m === undefined || m.organizerRole !== "organizer" || m.filing === undefined) return 0;
  return m.filing.due + m.filing.deferred;
}

/** The reason's words; `null` (nothing refused) has its own, and a class this build cannot name is `unknown`. */
export function filingReasonWords(cls: string | null): string {
  switch (filingRefusalReason(cls)) {
    case null: return Copy.filingReasonNone;
    case "refused": return Copy.filingReasonRefused;
    case "no_such_folder": return Copy.filingReasonNoSuchFolder;
    case "read_only": return Copy.filingReasonReadOnly;
    case "over_quota": return Copy.filingReasonOverQuota;
    case "stale_locator": return Copy.filingReasonStaleLocator;
    case "unconfirmed": return Copy.filingReasonUnconfirmed;
    case "unknown": return Copy.filingReasonUnknown;
  }
}

/** A pile by its noun ("Screened out", as the web names it), any other folder by its own name. */
function pileName(folder: string): string {
  const view = (VIEW_OF_FOLDER as Record<string, string>)[folder];
  return view !== undefined && (DESTINATIONS as readonly string[]).includes(view) ? destDone(view as Destination) : folderName(folder);
}

/** "HH:MM" in the phone's zone, or the em dash for an instant that cannot be read. */
function timeAt(iso: string | null, zone: string): string {
  if (iso === null) return "—";
  try {
    return clock(new Date(iso), zone);
  } catch {
    return "—";
  }
}

const earliest = (xs: Array<string | null>): string | null =>
  xs.reduce<string | null>((a, x) => (x === null ? a : a === null || x < a ? x : a), null);

export interface FilingStripSaid {
  title: string;
  detail: string;
  /** Stuck warns; waiting for a scheduled retry does not. */
  warn: boolean;
  /** The first mailbox the line is about — the Settings block it opens. */
  mailboxId: string;
}

/** The strip: stuck first, then waiting for the next try, else nothing. */
export function filingStripSaid(rows: readonly PhoneMailbox[], now: number, zone: string): FilingStripSaid | null {
  const live = rows.filter(filingsWait);
  const where = (covered: PhoneMailbox[]): string => covered.length > 1
    ? Copy.mailboxCountWaiting(covered.length) : covered[0]!.displayName?.trim() || covered[0]!.address;
  const why = (covered: PhoneMailbox[], cls: (m: PhoneMailbox) => string | null): string => {
    const reasons = covered.map((m) => filingRefusalReason(cls(m)));
    return reasons.some((r) => r !== reasons[0]) ? Copy.filingReasonsDiffer : filingReasonWords(cls(covered[0]!));
  };
  const stuck = live.filter((m) => m.filing!.stuck > 0);
  if (stuck.length > 0) {
    const count = stuck.reduce((n, m) => n + m.filing!.stuck, 0);
    const since = earliest(stuck.map((m) => m.filing!.stuckSince));
    const at = since === null ? Number.NaN : Date.parse(since);
    const minutes = Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / 60_000));
    return {
      title: minutes >= 60 ? Copy.filingStuckHours(count, Math.floor(minutes / 60)) : Copy.filingStuck(count, minutes),
      detail: Copy.filingStuckWhy(where(stuck), why(stuck, (m) => m.filing!.stuckRefusalClass)),
      warn: true,
      mailboxId: stuck[0]!.id,
    };
  }
  const waiting = live.filter((m) => m.filing!.deferred > 0);
  if (waiting.length === 0) return null;
  return {
    title: Copy.filingWaiting(waiting.reduce((n, m) => n + m.filing!.deferred, 0)),
    detail: Copy.filingWaitingWhy(
      where(waiting), why(waiting, (m) => m.filing!.lastRefusalClass),
      timeAt(earliest(waiting.map((m) => m.filing!.nextAttemptAt)), zone),
    ),
    warn: false,
    mailboxId: waiting[0]!.id,
  };
}

export interface FilingsGroupSaid {
  label: string;
  lines: string[];
  /** Leave is offered for rows that are not deletes, once the read named the bound it repeats. */
  leave: boolean;
}

/** One folder's waiting filings in the Settings block. */
export function filingsGroupSaid(g: PhoneFilingsGroup, zone: string): FilingsGroupSaid {
  const reasons = g.reasons.length === 1
    ? filingReasonWords(g.reasons[0]!.reason)
    : g.reasons.map((r) => Copy.filingsReasonCounted(filingReasonWords(r.reason), r.count)).join(", ");
  const lines = [
    Copy.filingsWhy(reasons),
    g.nextAttemptAt === null ? null : Copy.filingsNext(timeAt(g.nextAttemptAt, zone)),
    g.at === null ? null : Copy.filingsAt(g.count, pileName(g.at)),
    g.deletes === 0 ? null : g.deletes >= g.count ? Copy.filingsDeletesAll(g.deletes) : Copy.filingsDeletesSome(g.deletes),
  ].filter((x): x is string => x !== null);
  return {
    label: Copy.filingsGroup(g.count, pileName(g.folder), timeAt(g.since, zone)),
    lines,
    leave: g.count > g.deletes && g.through !== null,
  };
}

/** What a press on the block answered. */
export function filingsPressSaid(p: FilingsPress): string {
  switch (p.k) {
    case "retried": return Copy.filingsRetried(p.count);
    case "left": return Copy.filingsLeft(p.count);
    case "elsewhere": return Copy.filingsElsewhere;
    case "failed": return Copy.filingsFailed;
  }
}

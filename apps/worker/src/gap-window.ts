import { sql, type SQL } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import type { Dialect } from "@trafficflow/db/dialect";

/* WHERE A READER'S LOOK OPENS THE GAP WINDOW (RULING-026 lane A). The start is a fact about the
   mailbox: the releasing organizer leaves it in its settings document (`gap: { since, by, at }`),
   and the next install's look opens its own row's window from it. Both stores, so only `d.ts()` and
   `d.now()` inside the fragments, and `least` spelled as a CASE. Every column read is the row as it
   stood before the UPDATE this fragment rides. */

/** The gap a hand-back left in the settings document, as instants. */
export interface TravelledGap {
  since: Date;
  /** The releasing install's lease id. */
  by: string;
  at: Date;
}

/** `least(a, b)` on both stores; neither may be NULL. */
function earliest(a: SQL, b: SQL): SQL {
  return sql`case when ${a} <= ${b} then ${a} else ${b} end`;
}

/**
 * THE START A LOOK THAT FOUND NO LIVE HOLDER WRITES. `stopped`: never before the stopped claim's last
 * server stamp (nor after now), and never earlier than the window already starts. `none`: with a key,
 * the arbitration below, so a key never reaches back over a tenure this row saw after the release,
 * and this install's own key never moves an open window; without one, today's rule, unless another
 * install wrote the settings after the window opened.
 */
export function gapOpenStart(d: Dialect, o: {
  occupancy: "none" | "stopped";
  /** The newest heartbeat among the stopped claims, or null when the peek named none. */
  stoppedAt: Date | null;
  travelled: TravelledGap | null;
  /** Who wrote the newest settings document, and when; null when none was read. */
  written: { by: string | null; at: Date } | null;
  /** This install's lease id. */
  self: string;
}): SQL {
  const G = sql`${mailboxes.gapSince}`;
  const now = d.now();
  if (o.occupancy === "stopped") {
    if (o.stoppedAt === null) return sql`coalesce(${G}, ${now})`;
    const at = earliest(now, d.ts(o.stoppedAt));
    /* A STOPPED CLAIM ORGANIZED UNTIL ITS LAST STAMP, so nothing before that stamp arrived while
       nothing organized: a window that starts earlier reached over that tenure, or over the part of
       it this row never saw (taken after the row last looked, or renewed after a stop the row
       recorded), and moves to the stamp. A window that already starts later stays: a stale claim
       an earlier tenure left in the folder never moves it back over this row's own turn. */
    return sql`case when ${G} is null or ${G} < ${at} then ${at} else ${G} end`;
  }
  const k = o.travelled;
  if (k === null) {
    const w = o.written;
    if (w === null || w.by === o.self) return sql`coalesce(${G}, ${now})`;
    // Another install organized after the window opened and left no key: count from this look.
    return sql`case when ${G} is not null and ${G} >= ${d.ts(w.at)} then ${G} else ${now} end`;
  }
  const since = earliest(now, d.ts(k.since));
  if (k.by === o.self) return sql`coalesce(${G}, ${since})`;
  const remembered = sql`(${mailboxes.organizedByKind} is not null or ${mailboxes.organizedByName} is not null
    or ${mailboxes.organizedByInstallId} is not null or ${mailboxes.organizedSince} is not null
    or ${mailboxes.organizerState} is not null)`;
  return sql`case
    when ${mailboxes.organizerEventAt} is null or ${d.ts(k.at)} > ${mailboxes.organizerEventAt} then
      case when ${mailboxes.organizedByInstallId} = ${k.by} then ${earliest(sql`coalesce(${G}, ${now})`, d.ts(k.since))}
      else ${since} end
    when ${remembered} then coalesce(${G}, ${now})
    else coalesce(${G}, ${since}) end`;
}

/**
 * THE `since` A RELEASING ORGANIZER LEAVES, and `at`, from its own row before the release clears it:
 * its own uncounted window; else the press when the row recorded no holder since (and, on the
 * device, no sibling refusal); else now. Never a counted window: that one is this tenure's own.
 */
export function travellingGapColumns(d: Dialect, o: { sibling: boolean }): { since: SQL<unknown>; at: SQL<unknown> } {
  const noHolder = sql`${mailboxes.organizedByKind} is null and ${mailboxes.organizedByName} is null
    and ${mailboxes.organizedByInstallId} is null`;
  const press = o.sibling ? sql`${mailboxes.releaseRefusal} is null and ${noHolder}` : noHolder;
  return {
    since: sql`case when ${mailboxes.gapSince} is not null and ${mailboxes.gapLetters} is null then ${mailboxes.gapSince}
      when ${press} then coalesce(${mailboxes.releaseRequestedAt}, ${d.now()}) else ${d.now()} end`,
    at: sql`${d.now()}`,
  };
}

/** A raw fragment's instant as either store answers it (an ISO string, a Date, epoch ms). */
export function instantOf(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const at = v instanceof Date ? v : new Date(typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v as string | number);
  return Number.isFinite(at.getTime()) ? at : null;
}

/** The key a releasing organizer leaves: `since` never after `at`. */
export function gapKeyFrom(row: { since: unknown; at: unknown }, by: string): { since: string; by: string; at: string } | null {
  const since = instantOf(row.since);
  const at = instantOf(row.at);
  if (since === null || at === null) return null;
  return { since: new Date(Math.min(since.getTime(), at.getTime())).toISOString(), by, at: at.toISOString() };
}

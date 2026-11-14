/**
 * NEW MAIL IS LATE, WORDED FOR THE PHONE — the strip over the Ohbox and the mailbox's note in
 * Settings. Pure, over the mailbox facts (`readMailboxes`' `fetching`): the server this phone is
 * paired with says on each row whether new mail is being fetched, and null or an absent field says
 * nothing. In the web's words (`sync.behind*`, `mailboxes.notCheckedNote*`), from this phone's deck.
 */
import { Copy } from "../copy";
import type { PhoneMailbox } from "../net/mailboxes";
import { setTimeLabel } from "../state/live";

/** Who checks the mailboxes behind a session: ohmail Cloud, or a server somebody runs. */
export type LateWho = "cloud" | "server";

/**
 * Whom the sentences name. ohmail Cloud only behind the managed service; any other paired server is
 * "your ohmail server". A phone that organizes on its own has no one to name: its engine answers
 * null for every row, and nothing is said.
 */
export function lateWho(session: { standalone: boolean; profile: { flavor?: string } } | null): LateWho | null {
  if (session === null || session.standalone) return null;
  return session.profile.flavor === "managed" ? "cloud" : "server";
}

const DAY_MS = 86_400_000;

/** The newest time the behind rows carry: the last instant anything was checked. */
function newestSince(rows: readonly PhoneMailbox[]): string | null {
  let newest: { iso: string; at: number } | null = null;
  for (const m of rows) {
    const iso = m.fetching?.since ?? null;
    const at = iso === null ? Number.NaN : Date.parse(iso);
    if (!Number.isNaN(at) && (newest === null || at > newest.at)) newest = { iso: iso!, at };
  }
  return newest?.iso ?? null;
}

/** The strip's line: a whole sentence per who checks and whether a time is on record. */
function lineSaid(who: LateWho, said: string | null, days: number): string {
  if (who === "cloud") {
    if (said === null) return Copy.lateLineCloudNoTime;
    // "On us" is said of our own service alone, so a server somebody runs has no day line.
    return days >= 1 ? Copy.lateLineCloudDay(said) : Copy.lateLineCloud(said);
  }
  return said === null ? Copy.lateLineServerNoTime : Copy.lateLineServer(said);
}

/** One mailbox's note, on the same rule. */
function noteSaid(who: LateWho, said: string | null): string {
  if (who === "cloud") return said === null ? Copy.notCheckedNoteCloudNoTime : Copy.notCheckedNoteCloud(said);
  return said === null ? Copy.notCheckedNoteServerNoTime : Copy.notCheckedNoteServer(said);
}

export interface LateStripSaid {
  title: string;
  line: string;
}

/** The strip: said while any row's fetching is behind, with the day form from 24 hours on. */
export function lateStripSaid(
  rows: readonly PhoneMailbox[], now: number, zone: string, locale: string, who: LateWho | null,
): LateStripSaid | null {
  if (who === null) return null;
  const behind = rows.filter((m) => m.fetching?.behind === true);
  if (behind.length === 0) return null;
  const since = newestSince(behind);
  const said = since === null ? null : setTimeLabel(since, new Date(now), zone, locale);
  // Whole days, rounded down.
  const days = since === null ? 0 : Math.max(0, Math.floor((now - Date.parse(since)) / DAY_MS));
  return { title: days >= 1 ? Copy.lateTitleDays(days) : Copy.lateTitle, line: lineSaid(who, said, days) };
}

/** One mailbox's note in Settings, or `null` where its row says nothing. */
export function notCheckedNoteSaid(
  row: PhoneMailbox, now: number, zone: string, locale: string, who: LateWho | null,
): string | null {
  if (who === null || row.fetching?.behind !== true) return null;
  const since = row.fetching.since !== null && !Number.isNaN(Date.parse(row.fetching.since)) ? row.fetching.since : null;
  return noteSaid(who, since === null ? null : setTimeLabel(since, new Date(now), zone, locale));
}

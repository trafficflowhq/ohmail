/**
 * NEW MAIL IS LATE, WORDED FOR THE PHONE — the strip over the Ohbox and the mailbox's note in
 * Settings. Pure, over the mailbox facts (`readMailboxes`' `fetching`): the server this phone is
 * paired with says on each row whether new mail is being fetched, and null or an absent field says
 * nothing. In the web's words (`sync.behind*`, `mailboxes.notCheckedNote*`), from this phone's deck.
 */
import { fetchingLate, mailboxErrorNeedsAction, noticeDelayPassed } from "@ohmail/app-logic/mail-state/mail-state";
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

/** One mailbox's note, on the same rule. */
function noteSaid(who: LateWho, said: string | null): string {
  if (who === "cloud") return said === null ? Copy.notCheckedNoteCloudNoTime : Copy.notCheckedNoteCloud(said);
  return said === null ? Copy.notCheckedNoteServerNoTime : Copy.notCheckedNoteServer(said);
}

export interface LateStripSaid {
  title: string;
  mailboxId: string;
  since: string;
  hot?: boolean;
}

/** The strip identifies the last check and opens the row that supplied it. */
export function lateStripSaid(
  rows: readonly PhoneMailbox[], now: number, zone: string, locale: string, who: LateWho | null, _compact = false,
): LateStripSaid | null {
  const issue = rows.map((row) => ({ row, error: mailboxIssue(row) })).find(
    ({ error }) => error && (error.urgent || noticeDelayPassed(error.since, now)),
  );
  if (issue?.error) {
    const { row, error } = issue;
    return {
      title: Copy.mailboxIssueTitle(row.address, error.words),
      mailboxId: row.id,
      since: error.since ?? `error:${row.errorCode}`,
      hot: true,
    };
  }
  if (who === null) return null;
  const late = fetchingLate(rows);
  const since = late?.since;
  if (!since || !noticeDelayPassed(since, now)) return null;
  const mailbox = rows.find((m) => m.fetching?.behind && m.fetching.since === since);
  if (!mailbox) return null;
  const time = setTimeLabel(since, new Date(now), zone, locale);
  const title = who === "cloud" ? Copy.lateCloudSince(time) : Copy.lateServerSince(time);
  return { title, mailboxId: mailbox.id, since };
}

/** One mailbox's note in Settings, or `null` where its row says nothing. */
export function notCheckedNoteSaid(
  row: PhoneMailbox, now: number, zone: string, locale: string, who: LateWho | null,
): string | null {
  if (who === null || row.fetching?.behind !== true) return null;
  const since = row.fetching.since !== null && !Number.isNaN(Date.parse(row.fetching.since)) ? row.fetching.since : null;
  return noteSaid(who, since === null ? null : setTimeLabel(since, new Date(now), zone, locale));
}

/** The phone's Settings row and the notice read the same provider failure. */
export function mailboxIssue(row: PhoneMailbox) {
  if (row.status !== "error" && !row.unreachableSince) return null;
  const code = row.errorCode ?? null;
  const urgent = mailboxErrorNeedsAction({ errorCode: code });
  const words = code === "auth" ? Copy.lateMailboxAuth
    : code === "storage" ? Copy.lateMailboxStorage
    : code === "tls" ? Copy.lateMailboxTls
    : code === "timeout" ? Copy.lateMailboxTimeout
    : row.unreachableSince || code === "connect" ? Copy.lateMailboxDown
    : Copy.lateMailboxOther;
  return { urgent, words, since: row.failedAt ?? row.unreachableSince ?? null };
}

/**
 * THE PROVIDER'S NOTICES: for each calendar read by token, a channel at the provider that rings
 * this deployment when the calendar changes, opened before the last one ends; polling stays the
 * floor under it. Worker-only: the channel table is the Cloud's.
 *
 * A channel needs a public address for the provider to call (`OHCAL_NOTICE_ORIGIN`). Without one
 * this pass is not composed, and where it is called all the same it makes no request and writes no
 * row. A provider that has no notices (CalDAV, a subscription) is left to its poll.
 *
 * One turn of it, after a turn of the sync that ended well: the connection's ended rows are
 * removed; a calendar with no channel, or with one in its last day, gets a new one (a new id and a
 * new word, never an extension), and only then is the old one ended; a channel whose calendar is
 * no longer read is ended. At most {@link NOTICE_REQUESTS_PER_TURN} requests a turn; what is left
 * waits for the next. Nothing here changes what the sync does: a failure of this pass is a line
 * in the log and a calendar that is polled.
 */
import type { Logger } from "@trafficflow/core";
import type { CalendarNoticeInput } from "@ohmail/organizer/calendar/types";
import {
  endChannel, noticeAddress, openChannel, standingChannels, type ChannelTurn, type StandingChannel,
} from "./calendar/notice-channels.js";

/** Requests to a provider one turn of this pass may make, opens and ends together. */
export const NOTICE_REQUESTS_PER_TURN = 8;
/** A channel with less than this left gets its successor. */
export const NOTICE_RENEW_BEFORE_MS = 24 * 3_600_000;
/** A calendar whose channel the provider refused is not asked for again before this, or before the wait the provider named. */
export const NOTICE_REFUSED_WAIT_MS = 3_600_000;
export const NOTICE_REFUSED_WAIT_CEILING_MS = 24 * 3_600_000;
/** Calendars remembered as refused. Past it the memory is dropped whole: a lost entry costs one request. */
const REFUSED_MEMORY_MAX = 4_096;

export interface CalendarNoticeDeps {
  /** The public origin a provider's notices are sent to, or `null`. */
  readonly origin: string | null;
  readonly log: Logger;
  readonly clock: { now(): number };
  /** By calendar row id: when a calendar the provider refused a channel for is asked for again. This process's only. */
  readonly refused: Map<string, number>;
}

/** After a turn that ended well: is a channel alive for every calendar of the connection? */
export async function calendarNoticesPass(deps: CalendarNoticeDeps, input: CalendarNoticeInput): Promise<{ readonly live: boolean }> {
  const notices = input.provider.notices ?? null;
  if (deps.origin === null || notices === null || input.calendars.length === 0 || input.signal.aborted) return { live: false };
  const address = noticeAddress(deps.origin, notices.provider);
  if (address === null) return { live: false };
  const facts = { accountId: input.key.accountId, kind: notices.provider };
  try {
    const now = deps.clock.now();
    const standing = await standingChannels(input.db, input.key, notices.provider);
    if (standing === "gone") return { live: false };
    const turn: ChannelTurn = { db: input.db, key: input.key, notices, connection: input.connection, address, now, signal: input.signal };
    const read = new Set(input.calendars.map((c) => c.id));
    let requests = NOTICE_REQUESTS_PER_TURN;
    let applied = 0;
    let closed = 0;
    let refused = 0;
    /**
     * One channel ended, at its provider and then its row. Where the provider can be told and no
     * request is left for it, the channel stands until a turn that has one: it still rings, and is
     * still answered. A row whose provider never answered has nothing to be told.
     */
    const end = async (channel: StandingChannel): Promise<void> => {
      const tell = notices.names === "provider" || channel.resourceId !== null;
      if (tell && requests === 0) return;
      if (tell) requests -= 1;
      await endChannel(turn, channel, tell);
      closed += 1;
    };

    // A channel of a calendar that is no longer read rings for nothing.
    for (const channel of standing) {
      if (input.signal.aborted) return { live: false };
      if (channel.calendarId === null || !read.has(channel.calendarId)) await end(channel);
    }

    // Where the provider names a channel's id, one that cannot be kept is ended again: an open is
    // begun there only while the request for that is left too.
    const needs = notices.names === "provider" ? 2 : 1;
    let live = 0;
    for (const calendar of input.calendars) {
      if (input.signal.aborted) return { live: false };
      const mine = standing.filter((c) => c.calendarId === calendar.id).sort((a, b) => b.expiresAtMs - a.expiresAtMs);
      const newest = mine[0];
      let stands = newest !== undefined && newest.expiresAtMs > now;
      let old = mine;
      if (newest !== undefined && newest.expiresAtMs - now > NOTICE_RENEW_BEFORE_MS) {
        // Its channel has more than a day left. One beside it is what an interrupted turn left behind.
        old = mine.slice(1);
      } else if (requests >= needs && (deps.refused.get(calendar.id) ?? 0) <= now) {
        requests -= 1;
        const opened = await openChannel(turn, calendar);
        if (opened === "gone") return { live: false };
        if (opened.ok) {
          deps.refused.delete(calendar.id);
          applied += 1;
          stands = true;
        } else {
          if (opened.ended) requests -= 1;
          if (deps.refused.size >= REFUSED_MEMORY_MAX) deps.refused.clear();
          const wait = Math.min(Math.max(opened.retryAfterMs ?? 0, NOTICE_REFUSED_WAIT_MS), NOTICE_REFUSED_WAIT_CEILING_MS);
          deps.refused.set(calendar.id, now + wait);
          refused += 1;
          old = [];
        }
      } else {
        old = [];
      }
      // The old one only once its successor stands.
      for (const channel of old) await end(channel);
      if (stands) live += 1;
    }

    const all = live === input.calendars.length;
    if (applied + closed + refused > 0) {
      deps.log.info("calendar_notices", { ...facts, count: input.calendars.length, applied, closed, refused, state: all ? "live" : "polling" });
    }
    return { live: all };
  } catch (err) {
    // The sync's turn ended well before this ran, and stays so: the calendars are polled.
    deps.log.warn("calendar_notices_failed", { ...facts, err });
    return { live: false };
  }
}

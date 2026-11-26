/**
 * THE PROVIDER'S NOTICES: for each calendar read by token, a channel at the provider that rings
 * this deployment when the calendar changes, opened before the last one ends; polling stays the
 * floor under it. Worker-only: the channel table is the Cloud's.
 *
 * A channel needs a public address for the provider to call (`OHCAL_NOTICE_ORIGIN`). Without one
 * this pass is not composed, and where it is called all the same it makes no request and writes no
 * row. A provider that has no notices (CalDAV, a subscription) is left to its poll.
 *
 * After a successful sync turn, remove expired and unused channels. Google opens a successor
 * before ending a channel in its last day. Outlook renews its mailbox subscription in place.
 * At most {@link NOTICE_REQUESTS_PER_TURN} provider requests run per turn. Calendars without
 * verified coverage fall back to polling.
 */
import type { Logger } from "@trafficflow/core";
import { MICROSOFT_MAILBOX_NOTICE_RESOURCE } from "@trafficflow/db/cloud";
import type { CalendarNoticeInput } from "@ohmail/organizer/calendar/types";
import {
  endChannel, noticeAddress, openChannel, renewChannel, standingChannels, type ChannelTurn, type StandingChannel,
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

/** Read confirmed coverage without making a provider request. A refused renewal restores frequent polling. */
export async function calendarNoticeCoverage(deps: CalendarNoticeDeps, input: CalendarNoticeInput): Promise<ReadonlyMap<string, number>> {
  const coverage = new Map<string, number>();
  const provider = input.provider.notices?.provider;
  if (deps.origin === null || (provider !== "microsoft" && provider !== "google")) return coverage;
  try {
    const now = deps.clock.now();
    const channels = await standingChannels(input.db, input.key, provider, false);
    if (channels === "gone") return coverage;
    for (const cal of input.calendars) {
      const id = provider === "microsoft" ? null : cal.id;
      if ((id === null && cal.access !== "owner") || (deps.refused.get(id ?? input.key.id) ?? 0) > now) continue;
      let renewAt = now;
      for (const row of channels) {
        if (row.calendarId === id && row.resourceId !== null &&
          (id !== null || row.resourceId === MICROSOFT_MAILBOX_NOTICE_RESOURCE)) {
          renewAt = Math.max(renewAt, row.expiresAtMs - NOTICE_RENEW_BEFORE_MS);
        }
      }
      if (renewAt > now) coverage.set(cal.id, renewAt);
    }
  } catch (err) {
    deps.log.warn("calendar_notices_failed", { accountId: input.key.accountId, kind: provider, err });
  }
  return coverage;
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
    const microsoft = notices.provider === "microsoft";
    const targets = microsoft
      ? input.calendars.some((c) => c.access === "owner") ? [{ id: null, providerId: MICROSOFT_MAILBOX_NOTICE_RESOURCE }] : []
      : input.calendars;
    const read = new Set(targets.map((c) => c.id));
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
      if (!read.has(channel.calendarId) || (channel.calendarId === null && channel.resourceId !== MICROSOFT_MAILBOX_NOTICE_RESOURCE)) await end(channel);
    }

    // Where the provider names a channel's id, one that cannot be kept is ended again: an open is
    // begun there only while the request for that is left too.
    const needs = notices.names === "provider" ? 2 : 1;
    let live = 0;
    for (const calendar of targets) {
      if (input.signal.aborted) return { live: false };
      const mine = standing.filter((c) => c.calendarId === calendar.id &&
        (calendar.id !== null || c.resourceId === MICROSOFT_MAILBOX_NOTICE_RESOURCE)).sort((a, b) => b.expiresAtMs - a.expiresAtMs);
      const newest = mine[0];
      const renew = newest !== undefined && notices.renew !== undefined;
      const refusalKey = calendar.id ?? input.key.id;
      let stands = newest !== undefined && newest.expiresAtMs > now;
      let old = mine;
      if (newest !== undefined && newest.expiresAtMs - now > NOTICE_RENEW_BEFORE_MS) {
        // Its channel has more than a day left. One beside it is what an interrupted turn left behind.
        old = mine.slice(1);
      } else if (requests >= (renew ? 1 : needs) && (deps.refused.get(refusalKey) ?? 0) <= now) {
        requests -= 1;
        const opened = renew ? await renewChannel(turn, newest) : await openChannel(turn, calendar);
        if (opened === "gone") return { live: false };
        if (opened.ok) {
          deps.refused.delete(refusalKey);
          applied += 1;
          stands = true;
          if (renew) old = mine.slice(1);
        } else {
          if (opened.ended) requests -= 1;
          if (deps.refused.size >= REFUSED_MEMORY_MAX) deps.refused.clear();
          const wait = Math.min(Math.max(opened.retryAfterMs ?? 0, NOTICE_REFUSED_WAIT_MS), NOTICE_REFUSED_WAIT_CEILING_MS);
          deps.refused.set(refusalKey, now + wait);
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

    const all = targets.length > 0 && live === targets.length;
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

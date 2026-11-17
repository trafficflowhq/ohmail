/**
 * A PROVIDER'S NOTICE CHANNEL, ONE AT A TIME: opened for one calendar, and ended. The rows are the
 * Cloud's (`cal_push_channels`); every statement here runs inside the turn's own binding, through
 * `inConnection`, and no provider is called inside a transaction.
 *
 * THE WORD a notice must carry is 32 random bytes as base64url, made here for each channel. It is
 * handed to the provider once and only its SHA-256 is stored: it is in no column, no log line and
 * no address. THE ADDRESS a provider is given is the deployment's own origin and this file's
 * literal path, never anything a row or a provider's answer names.
 *
 * A channel is never extended. Its successor is a new channel with a new id and a new word.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { CalendarNotices, Connection, ProviderRefusal } from "@ohmail/cal-providers";
import type { Tx } from "@trafficflow/db";
import { NOTICE_WORD_BYTES, calPushChannels, isNoticeChannelId, noticeWordDigest } from "@trafficflow/db/cloud";
import { inConnection, type ConnectionDb, type ConnectionKey } from "@ohmail/organizer/calendar-sync";

/** A channel lives a week at the most; a provider's own maximum cuts it shorter. */
export const NOTICE_LIFE_MS = 7 * 24 * 3_600_000;
/**
 * How long a row stands before its provider has answered: long enough for the provider's first
 * notice, which can arrive before its answer does, and short enough that a row whose opening was
 * cut off ends by itself.
 */
export const NOTICE_PROVISIONAL_MS = 10 * 60_000;

/** Where each provider's notices go, under the deployment's origin: the API's two routes, letter for letter. */
const NOTICE_PATHS: Readonly<Record<string, string>> = {
  google: "/calendar/notices/google",
  microsoft: "/calendar/notices/microsoft",
};

/** The address a provider is given, or `null` for a provider that has no route. */
export function noticeAddress(origin: string, provider: string): string | null {
  return Object.hasOwn(NOTICE_PATHS, provider) ? `${origin}${NOTICE_PATHS[provider]}` : null;
}

/** A channel as its row holds it. Never its word, which no row holds. */
export interface StandingChannel {
  readonly channelId: string;
  readonly calendarId: string | null;
  readonly resourceId: string | null;
  readonly expiresAtMs: number;
}

/** What opening or ending a channel is handed: the turn's own handle, key and sign-in. */
export interface ChannelTurn {
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
  readonly notices: CalendarNotices;
  readonly connection: Connection;
  readonly address: string;
  readonly now: number;
  readonly signal: AbortSignal;
}

/** What opening a channel came to. `ended`: the provider was asked a second time, to end what it had just opened. */
export type ChannelOpened =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ProviderRefusal; readonly retryAfterMs: number | null; readonly ended: boolean }
  | "gone";

const ofConnection = (key: ConnectionKey) =>
  and(eq(calPushChannels.accountId, key.accountId), eq(calPushChannels.connectionId, key.id));

/**
 * The connection's channels of this provider that still stand, once the ended ones of the
 * connection are removed: the tidy every turn runs.
 */
export async function standingChannels(db: ConnectionDb, key: ConnectionKey, provider: string): Promise<StandingChannel[] | "gone"> {
  return inConnection(db, key, async ({ tx }) => {
    await tx.delete(calPushChannels).where(and(ofConnection(key), sql`${calPushChannels.expiresAt} <= now()`));
    const rows = await tx.select({
      channelId: calPushChannels.channelId, calendarId: calPushChannels.calendarId,
      resourceId: calPushChannels.resourceId, expiresAt: calPushChannels.expiresAt,
    }).from(calPushChannels).where(and(ofConnection(key), eq(calPushChannels.provider, provider)));
    return rows.map((r) => ({ channelId: r.channelId, calendarId: r.calendarId, resourceId: r.resourceId, expiresAtMs: r.expiresAt.getTime() }));
  });
}

const removeRow = (tx: Tx, key: ConnectionKey, provider: string, channelId: string) =>
  tx.delete(calPushChannels).where(and(ofConnection(key), eq(calPushChannels.provider, provider), eq(calPushChannels.channelId, channelId)));

/** The row gone. A connection that is no longer there took its channels with it. */
async function forget(t: ChannelTurn, channelId: string): Promise<void> {
  await inConnection(t.db, t.key, async ({ tx }) => { await removeRow(tx, t.key, t.notices.provider, channelId); });
}

/**
 * ONE NEW CHANNEL for one calendar, with an id and a word of its own.
 *
 * Where the caller names the id (Google): the row first, standing only {@link NOTICE_PROVISIONAL_MS},
 * then the provider's open, then the provider's name for what is watched and the channel's real
 * end; a refusal removes the row. Where the provider names the id (Microsoft): the subscription
 * first, then the row; a row that could not be written ends the subscription again.
 */
export async function openChannel(t: ChannelTurn, calendar: { readonly id: string; readonly providerId: string }): Promise<ChannelOpened> {
  const provider = t.notices.provider;
  const word = randomBytes(NOTICE_WORD_BYTES).toString("base64url");
  const ask = { id: randomUUID(), address: t.address, word: () => word, untilMs: t.now + NOTICE_LIFE_MS };
  const row = { accountId: t.key.accountId, connectionId: t.key.id, calendarId: calendar.id, provider, tokenHash: noticeWordDigest(word) };

  if (t.notices.names === "caller") {
    const stood = await inConnection(t.db, t.key, async ({ tx }) => {
      await tx.insert(calPushChannels).values({ ...row, channelId: ask.id, resourceId: null, expiresAt: new Date(t.now + NOTICE_PROVISIONAL_MS) });
    });
    if (stood === "gone") return "gone";
    let answer: Awaited<ReturnType<CalendarNotices["open"]>>;
    try {
      answer = await t.notices.open(t.connection, { id: calendar.providerId }, ask, t.signal);
    } catch (err) {
      await forget(t, ask.id);
      throw err;
    }
    if (!answer.ok) {
      await forget(t, ask.id);
      return { ok: false, reason: answer.reason, retryAfterMs: answer.retryAfterMs, ended: false };
    }
    const { resourceId, expiresAtMs } = answer.value;
    const kept = await inConnection(t.db, t.key, async ({ tx }) => {
      await tx.update(calPushChannels).set({ resourceId, expiresAt: new Date(expiresAtMs) })
        .where(and(ofConnection(t.key), eq(calPushChannels.provider, provider), eq(calPushChannels.channelId, ask.id)));
    });
    return kept === "gone" ? "gone" : { ok: true };
  }

  const answer = await t.notices.open(t.connection, { id: calendar.providerId }, ask, t.signal);
  if (!answer.ok) return { ok: false, reason: answer.reason, retryAfterMs: answer.retryAfterMs, ended: false };
  const opened = answer.value;
  const end = (): Promise<unknown> => t.notices.close(t.connection, { id: opened.id, resourceId: opened.resourceId }, t.signal);
  // The id is the provider's: one the door could never be asked by is no channel, and is ended again.
  if (!isNoticeChannelId(opened.id)) {
    await end();
    return { ok: false, reason: "unreadable", retryAfterMs: null, ended: true };
  }
  let stood: unknown;
  try {
    stood = await inConnection(t.db, t.key, async ({ tx }) => {
      await tx.insert(calPushChannels).values({ ...row, channelId: opened.id, resourceId: opened.resourceId, expiresAt: new Date(opened.expiresAtMs) });
    });
  } catch (err) {
    await end();
    throw err;
  }
  if (stood === "gone") {
    await end();
    return "gone";
  }
  return { ok: true };
}

/**
 * A channel ended: at its provider where `ask` says a request may be spent on it and the provider
 * can be told (best effort: a channel nobody ended rings into nothing until its own end), then its row.
 */
export async function endChannel(t: ChannelTurn, channel: StandingChannel, ask: boolean): Promise<void> {
  if (ask) await t.notices.close(t.connection, { id: channel.channelId, resourceId: channel.resourceId }, t.signal);
  await forget(t, channel.channelId);
}

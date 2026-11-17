/**
 * THE DOOR A CALENDAR'S PROVIDER RINGS: `POST /calendar/notices/google` and
 * `POST /calendar/notices/microsoft`. Anyone can call it. Only whoever holds a live channel's id
 * and its word causes anything, and those are the provider and this service. What is caused is one
 * thing: that channel's own calendar is read sooner (`pullForNotice`, the services' one statement
 * for it). The account, the connection and the calendar are the channel row's. Nothing a call says
 * names one: Google's address of what changed and Microsoft's `resource`, `resourceData` and
 * `tenantId` are never read.
 *
 * EVERY CALL IS ANSWERED ALIKE, to the byte ({@link noticeAnswer}): a known channel, an unknown
 * one, a wrong word, an ended channel, a notice sent twice, a call that is no notice, one that came
 * while too many were in flight, and one whose handling threw. One exception, which names no
 * channel: Microsoft's validation call, and only where the composition switched it on.
 *
 * Mounted by a server that keeps a calendar, beside the calendar's routes, and never by a device's
 * own door: a device has no channel table. No route table re-exports this file.
 */
import { timingSafeEqual, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { bindDb } from "@trafficflow/db";
import { calPushChannels, isNoticeChannelId, isNoticeWord, noticeWordDigest } from "@trafficflow/db/cloud";
import type { Logger } from "@trafficflow/core/mail";
import { pullForNotice } from "@trafficflow/services/calendar";
import type { Db } from "@trafficflow/services/mail";
import { BodyOverCeilingError, readBodyWithin } from "../body-ceiling.js";
import type { ApiDeps, CalendarNoticeDoor } from "../deps.js";
import type { Route } from "../router.js";

type Provider = "google" | "microsoft";
const PROVIDERS: readonly Provider[] = ["google", "microsoft"];

/**
 * Calls at the store at once in one process, counted from when a call's pairs are read: a body on its
 * way holds no place. One more is answered without a statement; the poll remains. Two: a call holds
 * one connection at a time, so a stranger's calls leave the API's own pool room.
 */
export const NOTICE_IN_FLIGHT_MAX = 2;
/**
 * What is read of a Microsoft notice's body at the most: a batch of notices without resource data
 * is a few hundred bytes an entry, and twenty entries are looked at. Google's notice has no body,
 * and none is read.
 */
export const MICROSOFT_NOTICE_BODY_MAX_BYTES = 64 * 1024;
/** Entries of one Microsoft batch that are looked at. A longer batch's rest is left to the poll. */
export const MICROSOFT_NOTICE_ENTRIES_MAX = 20;
/** Microsoft's validation token as it is echoed: printable ASCII, at most this long. */
export const VALIDATION_TOKEN_MAX_CHARS = 1024;
/** The door says its counts at most this often, and never a line for a call. */
export const DOOR_LINE_EVERY_MS = 60_000;

const PRINTABLE = /^[\x20-\x7e]+$/;
/** What a word is compared with where no channel stands: random bytes no word's digest equals. */
const NO_DIGEST = randomBytes(32);

/** The one answer: accepted, no body, never stored. The same bytes whatever was asked and whatever was found. */
export const noticeAnswer = (): Response => new Response(null, { status: 202, headers: { "cache-control": "no-store" } });

/** Microsoft's validation call, echoed as text nothing renders as a page. */
const validationAnswer = (token: string): Response => new Response(token, {
  status: 200,
  headers: {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "no-store",
  },
});

export interface CalendarNoticeDoorOptions {
  /**
   * Answer Microsoft's validation call. Yes only where this server serves Microsoft's calendars and
   * has a public address for notices. No default: an absent word must not open the echo.
   */
  readonly microsoftValidation: boolean;
  /** The program's own logger, never a request's: the door's line carries no request's id. */
  readonly log: Logger;
  /** Now, in epoch milliseconds: the clock of the door's line. */
  readonly now: () => number;
}

/** What a call hands over for one channel, as it came: nothing is trusted before its shape is. */
interface Pair {
  readonly id: unknown;
  readonly word: unknown;
  /** Google's name for what the channel watches, as the call repeats it. */
  readonly resource: string | null;
}

type Verdict = "applied" | "expired" | "refused";
interface Tally { count: number; applied: number; expired: number; refused: number; dropped: number }
const nothing = (): Tally => ({ count: 0, applied: 0, expired: 0, refused: 0, dropped: 0 });
const counted = (t: Tally): boolean => t.count + t.applied + t.expired + t.refused + t.dropped > 0;

/** A stored digest as its 32 bytes, or `null` for a text that is no SHA-256 in hex. */
function digestOf(hex: string): Buffer | null {
  if (hex.length !== 64) return null;
  const bytes = Buffer.from(hex, "hex");
  return bytes.length === 32 ? bytes : null;
}

/** Google names the channel in three headers. These three are read and no other, and the body never. */
function googlePair(req: Request): Pair {
  return {
    id: req.headers.get("x-goog-channel-id"),
    word: req.headers.get("x-goog-channel-token"),
    resource: req.headers.get("x-goog-resource-id"),
  };
}

/**
 * Microsoft names its channels in the body: of at most {@link MICROSOFT_NOTICE_BODY_MAX_BYTES}, the
 * first {@link MICROSOFT_NOTICE_ENTRIES_MAX} entries of `value`, and of each only `subscriptionId`
 * and `clientState`. A channel named twice in one batch is one notice.
 */
async function microsoftPairs(req: Request): Promise<Pair[]> {
  let raw: ArrayBuffer | undefined;
  try {
    raw = await readBodyWithin(req, MICROSOFT_NOTICE_BODY_MAX_BYTES);
  } catch (err) {
    if (!(err instanceof BodyOverCeilingError)) throw err;
    return [];
  }
  if (raw === undefined) return [];
  let read: unknown;
  try {
    read = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    // No JSON, or no UTF-8: no notice.
    return [];
  }
  const value = read !== null && typeof read === "object" && !Array.isArray(read) ? (read as { value?: unknown }).value : undefined;
  if (!Array.isArray(value)) return [];
  const pairs: Pair[] = [];
  const seen = new Set<unknown>();
  for (const entry of value.slice(0, MICROSOFT_NOTICE_ENTRIES_MAX)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { subscriptionId, clientState } = entry as { subscriptionId?: unknown; clientState?: unknown };
    if (seen.has(subscriptionId)) continue;
    seen.add(subscriptionId);
    pairs.push({ id: subscriptionId, word: clientState, resource: null });
  }
  return pairs;
}

/**
 * One channel's notice, judged and, where it is live, applied. In order: the shape of the id and
 * the word, before any statement; the channel's row, found under its own id as the transaction's
 * key; the word's digest compared in constant time, against random bytes where no row stands; the
 * end of the channel's life by the database's clock; Google's own name for what is watched; and
 * only then the pull, on a handle bound to the row's account.
 */
async function judge(db: Db, provider: Provider, pair: Pair): Promise<Verdict> {
  if (!isNoticeChannelId(pair.id) || !isNoticeWord(pair.word)) return "refused";
  const keyed = bindDb(db, { account: null, key: pair.id });
  const [row] = await keyed.select({
    accountId: calPushChannels.accountId, connectionId: calPushChannels.connectionId, calendarId: calPushChannels.calendarId,
    tokenHash: calPushChannels.tokenHash, resourceId: calPushChannels.resourceId,
    alive: sql<boolean>`${calPushChannels.expiresAt} > now()`,
  }).from(calPushChannels).where(and(eq(calPushChannels.provider, provider), eq(calPushChannels.channelId, pair.id))).limit(1);
  const held = row === undefined ? null : digestOf(row.tokenHash);
  const same = timingSafeEqual(Buffer.from(noticeWordDigest(pair.word), "hex"), held ?? NO_DIGEST);
  if (row === undefined || held === null || !same) return "refused";
  if (row.alive !== true) return "expired";
  if (provider === "google" && row.resourceId !== null && row.resourceId !== pair.resource) return "refused";
  await pullForNotice(bindDb(db, { account: row.accountId }), {
    accountId: row.accountId, connectionId: row.connectionId, calendarId: row.calendarId,
  });
  return "applied";
}

/**
 * The door, made once for a program: what is in flight and the minute's counts live as long as it
 * does. Its line (`cal_notice_door`) is said when a call arrives and a minute has passed since the
 * last, one for each provider that was called: the provider's word and five counts, and never an
 * id, a header, a body, an address or a word. `count` is calls, counted as they arrive; the other
 * four count what was judged, a channel each, and a call that named none counts as one refusal. A
 * call still in flight when a line is said is judged into the next one: the counts are emptied in
 * place, so nothing a call comes to is lost with the minute it began in.
 */
export function makeCalendarNoticeDoor(opts: CalendarNoticeDoorOptions): CalendarNoticeDoor {
  let inFlight = 0;
  let saidAt = opts.now();
  const tallies: Readonly<Record<Provider, Tally>> = { google: nothing(), microsoft: nothing() };

  const say = (): void => {
    const at = opts.now();
    if (at - saidAt < DOOR_LINE_EVERY_MS) return;
    saidAt = at;
    for (const kind of PROVIDERS) {
      const t = tallies[kind];
      if (!counted(t)) continue;
      opts.log.info("cal_notice_door", { kind, count: t.count, applied: t.applied, expired: t.expired, refused: t.refused, dropped: t.dropped });
      Object.assign(t, nothing());
    }
  };

  /** Microsoft's validation token, where this door echoes one and the call carries one that may be echoed. */
  const validationOf = (req: Request): string | null => {
    if (!opts.microsoftValidation) return null;
    const token = new URL(req.url).searchParams.get("validationToken");
    return token !== null && token.length <= VALIDATION_TOKEN_MAX_CHARS && PRINTABLE.test(token) ? token : null;
  };

  return {
    async ring(provider, req, db) {
      const tally = tallies[provider];
      tally.count += 1;
      try {
        const token = provider === "microsoft" ? validationOf(req) : null;
        if (token !== null) return validationAnswer(token);
        const pairs = provider === "google" ? [googlePair(req)] : await microsoftPairs(req);
        // A place is taken once the pairs are read: a body on its way runs no statement.
        if (inFlight >= NOTICE_IN_FLIGHT_MAX) {
          tally.dropped += 1;
          return noticeAnswer();
        }
        inFlight += 1;
        try {
          if (pairs.length === 0) tally.refused += 1;
          for (const pair of pairs) tally[await judge(db, provider, pair)] += 1;
        } finally {
          inFlight -= 1;
        }
      } catch {
        // A store that did not answer, a row held past the pull's wait, a call cut off mid-body:
        // the notice is dropped, the answer is the one every call gets, and the poll remains.
        tally.dropped += 1;
      } finally {
        say();
      }
      return noticeAnswer();
    },
  };
}

const OPTIONS = { public: true, anonymous: true, raw: true, provider: true } as const;

const ring = (provider: Provider) => async (req: Request, deps: ApiDeps): Promise<Response> =>
  (await deps.services?.calendarNotices?.ring(provider, req, deps.db)) ?? noticeAnswer();

/**
 * The two routes, as literals. `unauthenticated`: no account is served, and what a call may cost is
 * bounded here (one keyed read a channel named, at most twenty a call, two calls in flight).
 * Never relayed: a provider calls the account's own server and no door in between.
 */
export const calendarNoticeRoutes: Route[] = [
  {
    method: "POST", pattern: "/calendar/notices/google", relay: false, cost: "unauthenticated",
    options: { ...OPTIONS, bodyMaxBytes: 0 }, handler: ring("google"),
  },
  {
    method: "POST", pattern: "/calendar/notices/microsoft", relay: false, cost: "unauthenticated",
    options: { ...OPTIONS, bodyMaxBytes: MICROSOFT_NOTICE_BODY_MAX_BYTES }, handler: ring("microsoft"),
  },
];

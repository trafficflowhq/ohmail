/**
 * Google's notice channels: one on a calendar's events, opened by Google's `watch` and ended by its
 * `stop`. A channel rings an address when the calendar changes and says nothing of what changed;
 * the reading stays `readChanges`'. Every request names a fixed address of Google's, with the
 * calendar's id as one escaped segment of its path, and leaves through the request port handed in.
 *
 * What is sent: the id the caller chose, the caller's address, the word a notice must carry, and
 * the moment the channel ends. Nothing of an answer becomes an address: Google's own address of
 * what is watched is not read.
 */
import {
  bearerOf,
  isRecord,
  jsonOf,
  MAX_PROVIDER_ID_CHARS,
  pathSegment,
  refuse,
  type Refused,
} from "../json-answers.js";
import { GOOGLE_NOTICE_MAX_MS, MAX_NOTICE_ID_CHARS, NOTICE_MIN_LIFE_MS } from "../limits.js";
import type { Answer, CalendarNotices, NoticeChannel } from "../port.js";
import { retryAfterMs, type AdapterDeps, type HttpResponse } from "../request/index.js";
import { GOOGLE_CALENDAR_BASE } from "./hosts.js";
import { googleAuthorization } from "./reader.js";

const STOP = `${GOOGLE_CALENDAR_BASE}/channels/stop`;
const QUOTA_REASONS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);

function quotaSpent(body: Uint8Array): boolean {
  const error = jsonOf(body)?.error;
  const listed = isRecord(error) && Array.isArray(error.errors) ? error.errors : [];
  return listed.some((e) => isRecord(e) && typeof e.reason === "string" && QUOTA_REASONS.has(e.reason));
}

/** A whole number of milliseconds as Google writes one: digits, as a text or a number. */
function millisOf(v: unknown): number | null {
  const text = typeof v === "number" ? String(v) : v;
  return typeof text === "string" && /^\d{1,15}$/.test(text) ? Number(text) : null;
}

export function makeNotices(deps: AdapterDeps): CalendarNotices {
  /** A status that is no channel, as a word. A calendar Google watches for nobody answers 400. */
  function refusalOf(res: HttpResponse): Refused {
    const wait = retryAfterMs(res, deps.clock);
    if (res.status >= 300 && res.status < 400) return refuse("redirect_invalid");
    if (res.status === 401) return refuse("sign_in_refused");
    if (res.status === 403) return quotaSpent(res.body) ? refuse("throttled", wait) : refuse("forbidden");
    if (res.status === 404 || res.status === 410) return refuse("not_found");
    if (res.status === 400) return refuse("unsupported");
    if (res.status === 429) return refuse("throttled", wait);
    if (res.status >= 500) return refuse("unavailable", wait);
    return refuse("unknown");
  }

  async function post(
    token: string,
    url: string,
    body: Record<string, string>,
    signal: AbortSignal,
  ): Promise<HttpResponse | Refused> {
    const answer = await deps.http.request(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      auth: googleAuthorization(token),
      validators: null,
      signal,
    });
    return answer.arrived ? answer : refuse(answer.reason);
  }

  return {
    provider: "google",
    names: "caller",

    async open(c, cal, ask, signal): Promise<Answer<NoticeChannel>> {
      const calendar = cal.id === "" || cal.id.length > MAX_PROVIDER_ID_CHARS ? null : pathSegment(cal.id);
      if (calendar === null) return refuse("not_found");
      const now = deps.clock.now();
      const until = Math.min(ask.untilMs, now + GOOGLE_NOTICE_MAX_MS);
      if (!Number.isFinite(until) || until < now + NOTICE_MIN_LIFE_MS) return refuse("unsupported");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const sent = await post(
        signedIn.token,
        `${GOOGLE_CALENDAR_BASE}/calendars/${calendar}/events/watch`,
        {
          id: ask.id,
          type: "web_hook",
          address: ask.address,
          token: ask.word(),
          expiration: String(Math.floor(until)),
        },
        signal,
      );
      if ("ok" in sent) return sent;
      if (sent.status !== 200) return refusalOf(sent);
      const json = jsonOf(sent.body);
      const resourceId = json === null ? undefined : json.resourceId;
      const ends = json === null ? null : millisOf(json.expiration);
      // The channel is the one asked for, or it is none: an answer that names another id is not followed.
      if (json === null || json.id !== ask.id) return refuse("unreadable");
      if (typeof resourceId !== "string" || resourceId === "" || resourceId.length > MAX_NOTICE_ID_CHARS)
        return refuse("unreadable");
      if (ends === null || ends <= now) return refuse("unreadable");
      return { ok: true, value: { id: ask.id, resourceId, expiresAtMs: Math.min(ends, until) } };
    },

    async close(c, channel, signal): Promise<Answer<null>> {
      // Google ends a channel by its id and its own name for what it watches: without the second there is nothing to say.
      if (channel.resourceId === null) return refuse("unsupported");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const sent = await post(
        signedIn.token,
        STOP,
        { id: channel.id, resourceId: channel.resourceId },
        signal,
      );
      if ("ok" in sent) return sent;
      // A channel Google no longer knows is ended.
      if (sent.status === 204 || sent.status === 200 || sent.status === 404) return { ok: true, value: null };
      return refusalOf(sent);
    },
  };
}

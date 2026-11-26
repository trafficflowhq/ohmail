/**
 * Microsoft's notice channels by Graph: a subscription to the signed-in mailbox's events, made and removed
 * under the base this program was composed with. Built from Microsoft's own pages and tried against
 * a double; not tried against Microsoft itself, and behind Microsoft's own switch.
 *
 * What is sent: the caller's address, the word a notice must carry, the mailbox event resource,
 * and the moment the subscription ends. No resource data is asked
 * for, so a notice carries nothing of an event, and no second address is named: Graph gets one
 * address and no other. Graph names the subscription itself; its id is the channel's.
 */
import { bearerOf, instantOfRfc3339, jsonOf, pathSegment, refuse, type Refused } from "../json-answers.js";
import { MAX_NOTICE_ID_CHARS, MICROSOFT_NOTICE_MAX_MS, NOTICE_MIN_LIFE_MS } from "../limits.js";
import type { Answer, CalendarNotices, NoticeChannel } from "../port.js";
import { retryAfterMs, type HttpResponse } from "../request/index.js";
import { graphBaseOf } from "./graph.js";
import { graphAuthorization, stamp, type MicrosoftDeps } from "./reader.js";

/** What a subscription rings for: every change of an event. */
const CHANGES = "created,updated,deleted";

export function makeNotices(deps: MicrosoftDeps): CalendarNotices {
  // A base that is no address is a fault of the composing program: loud, and before any request.
  const base = graphBaseOf(deps.graphBase);
  const subscriptions = `${base.href}/subscriptions`;

  function refusalOf(res: HttpResponse): Refused {
    const wait = retryAfterMs(res, deps.clock);
    if (res.status >= 300 && res.status < 400) return refuse("redirect_invalid");
    if (res.status === 401) return refuse("sign_in_refused");
    if (res.status === 403) return refuse("forbidden");
    if (res.status === 404 || res.status === 410) return refuse("not_found");
    // Graph answers 400 where the address did not answer its validation call, and where the resource takes no subscription.
    if (res.status === 400) return refuse("unsupported");
    if (res.status === 429 || res.status === 509 || (res.status === 503 && wait !== null))
      return refuse("throttled", wait);
    if (res.status >= 500) return refuse("unavailable", wait);
    return refuse("unknown");
  }

  return {
    provider: "microsoft",
    names: "provider",

    async open(c, _cal, ask, signal): Promise<Answer<NoticeChannel>> {
      const now = deps.clock.now();
      const until = Math.min(ask.untilMs, now + MICROSOFT_NOTICE_MAX_MS);
      if (!Number.isFinite(until) || until < now + NOTICE_MIN_LIFE_MS) return refuse("unsupported");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const sent = await deps.http.request(subscriptions, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          changeType: CHANGES,
          notificationUrl: ask.address,
          resource: "me/events",
          expirationDateTime: stamp(until),
          clientState: ask.word(),
        }),
        auth: graphAuthorization(signedIn.token, base),
        validators: null,
        signal,
      });
      if (!sent.arrived) return refuse(sent.reason);
      if (sent.status !== 201 && sent.status !== 200) return refusalOf(sent);
      const json = jsonOf(sent.body);
      const id = json === null ? undefined : json.id;
      const ends =
        json === null || typeof json.expirationDateTime !== "string"
          ? null
          : instantOfRfc3339(json.expirationDateTime);
      if (typeof id !== "string" || id === "" || id.length > MAX_NOTICE_ID_CHARS) return refuse("unreadable");
      if (ends === null || ends <= now) return refuse("unreadable");
      return { ok: true, value: { id, resourceId: null, expiresAtMs: Math.min(ends, until) } };
    },

    async renew(c, id, untilMs, signal): Promise<Answer<number>> {
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return refuse("not_found");
      const now = deps.clock.now();
      const until = Math.min(untilMs, now + MICROSOFT_NOTICE_MAX_MS);
      if (!Number.isFinite(until) || until < now + NOTICE_MIN_LIFE_MS) return refuse("unsupported");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const sent = await deps.http.request(`${subscriptions}/${id}`, {
        method: "PATCH",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ expirationDateTime: stamp(until) }),
        auth: graphAuthorization(signedIn.token, base),
        validators: null,
        precondition: { kind: "own-channel-renewal" },
        signal,
      });
      if (!sent.arrived) return refuse(sent.reason);
      if (sent.status !== 200) return refusalOf(sent);
      const json = jsonOf(sent.body);
      const ends =
        typeof json?.expirationDateTime === "string" ? instantOfRfc3339(json.expirationDateTime) : null;
      return json?.id === id && ends !== null && ends > now
        ? { ok: true, value: Math.min(ends, until) }
        : refuse("unreadable");
    },

    async close(c, channel, signal): Promise<Answer<null>> {
      const id =
        channel.id === "" ||
        channel.id === "." ||
        channel.id === ".." ||
        channel.id.length > MAX_NOTICE_ID_CHARS
          ? null
          : pathSegment(channel.id);
      if (id === null) return refuse("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const sent = await deps.http.request(`${subscriptions}/${id}`, {
        method: "DELETE",
        headers: { accept: "application/json" },
        body: null,
        auth: graphAuthorization(signedIn.token, base),
        validators: null,
        // A subscription has no version to remove it under, and nothing a person wrote is in it.
        precondition: { kind: "own-channel" },
        signal,
      });
      if (!sent.arrived) return refuse(sent.reason);
      // A subscription Graph no longer knows is ended.
      if (sent.status === 204 || sent.status === 200 || sent.status === 404) return { ok: true, value: null };
      return refusalOf(sent);
    },
  };
}

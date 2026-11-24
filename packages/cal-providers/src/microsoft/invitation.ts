/**
 * A meeting invitation that reached the person as an Outlook Web App link, looked up in their own
 * Microsoft calendar. Exchange sends some invitations over IMAP as a link that names the calendar
 * item by its Exchange id and carries no event; the person's Microsoft calendar connection holds
 * that event. Two fixed requests and no other: `POST /me/translateExchangeIds` turns the link's id
 * into Graph's own, and `GET /me/events/{id}` reads the event. Nothing of the letter's link but its
 * id travels, and the id travels only once it has the shape of one.
 *
 * Translating an id needs a user permission besides the calendar's, which a connection that was
 * granted the calendar alone does not hold. Where Graph refuses the translation for that (or for an
 * id of the older form it will not translate), the id is put in Graph's form here as Microsoft's own
 * add-in library does it: Graph's id is the same id with `/` written `-` and `+` written `_`.
 */
import type { CalEvent } from "@ohmail/cal-core";
import {
  bearerOf,
  isRecord,
  jsonOf,
  MAX_PROVIDER_ID_CHARS,
  pathSegment,
  refuse,
  type Refused,
} from "../json-answers.js";
import type { Answer, Connection } from "../port.js";
import { retryAfterMs, type HttpResponse } from "../request/index.js";
import { recordOf } from "./convert.js";
import { graphBaseOf } from "./graph.js";
import { graphAuthorization, type MicrosoftDeps } from "./reader.js";

/** The person's own answer to the event, as Graph's `responseStatus` says it; `null` for none yet. */
export type ExchangeAnswer = "accepted" | "tentative" | "declined";

export interface ExchangeInvitationEvent {
  /** The event as the calendar keeps it: a single event, or a series as its rule. */
  readonly event: CalEvent;
  /** Graph's own id of it, the id the calendar's copy is stored under. */
  readonly id: string;
  readonly answer: ExchangeAnswer | null;
}

export interface ExchangeInvitations {
  /**
   * The event an Outlook Web App link's item id names in the connection's own calendar. `null`: the
   * id names something that is no event of a kind the card shows (one day of a series, a record
   * that cannot be read). An id that is not of an Exchange id's shape is refused as `not_found`
   * before anything is asked.
   */
  eventOfItem(
    c: Connection,
    itemId: string,
    signal: AbortSignal,
  ): Promise<Answer<ExchangeInvitationEvent | null>>;
}

/** An Exchange id as a link carries it (base64) or as Graph writes it (its URL-safe form), with its padding. */
const ITEM_ID = /^[A-Za-z0-9+/_-]{16,512}={0,2}$/;
const ANSWERS: Readonly<Record<string, ExchangeAnswer>> = {
  accepted: "accepted",
  tentativelyAccepted: "tentative",
  declined: "declined",
};

/** Graph's form of an Exchange id, as Microsoft's add-in library writes it. */
export const restIdOf = (ewsId: string): string => ewsId.replaceAll("/", "-").replaceAll("+", "_");

export function makeExchangeInvitations(deps: MicrosoftDeps): ExchangeInvitations {
  const base = graphBaseOf(deps.graphBase);

  function refusalOf(answer: HttpResponse): Refused {
    const { status } = answer;
    if (status === 401) return refuse("sign_in_refused");
    if (status === 403) return refuse("forbidden");
    if (status === 400 || status === 404 || status === 410) return refuse("not_found");
    if (status === 429 || status === 509 || status === 503)
      return refuse("throttled", retryAfterMs(answer, deps.clock));
    if (status >= 500) return refuse("unavailable");
    return refuse("unknown");
  }

  async function asked(
    token: string,
    url: string,
    body: string | null,
    signal: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly json: Record<string, unknown> }
    | (Refused & { readonly status: number | null })
  > {
    const answer = await deps.http.request(url, {
      method: body === null ? "GET" : "POST",
      headers:
        body === null
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body,
      auth: graphAuthorization(token, base),
      validators: null,
      signal,
    });
    if (!answer.arrived) return { ...refuse(answer.reason), status: null };
    if (answer.status !== 200) return { ...refusalOf(answer), status: answer.status };
    const json = jsonOf(answer.body);
    return json === null ? { ...refuse("unreadable"), status: 200 } : { ok: true, json };
  }

  /** Graph's id of the item: its translation, or Graph's form written here where the translation is refused for the permission or the id's form. */
  async function restId(
    token: string,
    ewsId: string,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true; readonly id: string } | Refused> {
    const body = JSON.stringify({ inputIds: [ewsId], sourceIdType: "ewsId", targetIdType: "restId" });
    const answer = await asked(token, `${base.href}/me/translateExchangeIds`, body, signal);
    if (!answer.ok) {
      if (answer.status === 400 || answer.status === 403 || answer.status === 404)
        return { ok: true, id: restIdOf(ewsId) };
      return refuse(answer.reason, answer.retryAfterMs);
    }
    const [first] = Array.isArray(answer.json.value) ? answer.json.value : [];
    const target = isRecord(first) && first.sourceId === ewsId ? first.targetId : undefined;
    // Graph answers each id it could not translate with an error in its place: the id names nothing here.
    if (typeof target !== "string") return refuse("not_found");
    return ITEM_ID.test(target) ? { ok: true, id: target } : refuse("unreadable");
  }

  return {
    async eventOfItem(c, itemId, signal): Promise<Answer<ExchangeInvitationEvent | null>> {
      if (!ITEM_ID.test(itemId)) return refuse("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const id = await restId(signedIn.token, itemId, signal);
      if (!id.ok) return id;
      const segment = id.id.length > MAX_PROVIDER_ID_CHARS ? null : pathSegment(id.id);
      if (segment === null) return refuse("not_found");
      const answer = await asked(signedIn.token, `${base.href}/me/events/${segment}`, null, signal);
      if (!answer.ok) return refuse(answer.reason, answer.retryAfterMs);
      const one = recordOf(answer.json, deps.zones, deps.clock.now());
      if (one.kind !== "item" || one.item.kind !== "upsert") return { ok: true, value: null };
      const status = isRecord(answer.json.responseStatus) ? answer.json.responseStatus.response : undefined;
      const said = typeof status === "string" && Object.hasOwn(ANSWERS, status) ? ANSWERS[status]! : null;
      return { ok: true, value: { event: one.item.event, id: one.item.id, answer: said } };
    },
  };
}

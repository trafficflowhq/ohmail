/**
 * Google's sign-in, as far as this package goes: the address a person is sent to, the trade of what
 * comes back for a lasting sign-in, and the trade of the lasting sign-in for a short one.
 *
 * Until the product has a public name Google can return to, the sign-in is the one Google allows a
 * program on a person's own machine: it returns to a port on 127.0.0.1. Opening the browser,
 * listening on that port, and making the state and the proof are the connect step's; nothing here
 * listens, draws a random number or keeps anything between two calls. The registration's secret and
 * the lasting sign-in are revealed in one place, where the form for Google's token address is written.
 */
import { jsonOf, refuse, type Json, type Refused } from "../json-answers.js";
import type { Answer, Clock, Credential } from "../port.js";
import { retryAfterMs, type HttpPort } from "../request/index.js";
import { Secret } from "../secret.js";
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from "./hosts.js";

/**
 * The two permissions every act of the calendar needs, and no other: events, and the calendar list
 * read-only (names and colours; the account's own address is its primary calendar's id, so no
 * permission is asked for a name).
 */
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"] as const;

/** A short sign-in with less than this left is not handed out: one request may take half a minute, and a page may need several. */
const RENEW_BEFORE_MS = 120_000;
/** Google's short sign-ins last an hour; no life longer than a day is believed. */
const MAX_LIFE_SECONDS = 86_400;
/** A sign-in's text, short or lasting. Google's are a few hundred characters. */
const MAX_SIGN_IN_CHARS = 4096;
/** What a short sign-in may be made of to stand in a header: visible ASCII, no space, no line break. */
const HEADER_SAFE = /^[\x21-\x7e]+$/;
/** The proof's method (RFC 7636): the challenge is the SHA-256 of the verifier. The plain method is never asked for. */
const PROOF_METHOD = "S" + "256";

/** The registration at Google the program signs in as. */
export interface GoogleClient {
  readonly id: string;
  readonly secret: Secret;
}
export interface GoogleSignIn {
  readonly client: GoogleClient;
  readonly refreshToken: Secret;
}
/** A short sign-in and the moment it ends, in epoch milliseconds. */
export interface GoogleAccess {
  readonly token: string;
  readonly expiresAtMs: number;
}
/** What a completed sign-in gives: the lasting sign-in to seal, and a first short one. */
export interface GoogleGrant extends GoogleAccess {
  readonly refreshToken: Secret;
}
interface SignInDeps {
  readonly http: HttpPort;
  readonly clock: Clock;
}

/** Google returns a sign-in to an https address, or to a port on this machine by its number (never by a name, which can be made to mean another machine). */
function returnsHere(redirectUri: string): boolean {
  if (!URL.canParse(redirectUri)) return false;
  const url = new URL(redirectUri);
  if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
  return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "");
}

/**
 * The address a person signs in at. `state` and `codeChallenge` (the SHA-256 one) are the caller's: the answer
 * belongs to the request when its state is the one made here and the proof's other half opens the
 * trade. A lasting sign-in is asked for every time (`prompt=consent`), or Google hands none out the
 * second time. A return address Google would not take is a fault of the composing program, and thrown.
 */
export function googleAuthorizeUrl(o: { readonly clientId: string; readonly redirectUri: string; readonly state: string; readonly codeChallenge: string }): string {
  if (!returnsHere(o.redirectUri)) throw new Error("Google's sign-in returns to an https address or to a port on 127.0.0.1");
  const query = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: o.state,
    code_challenge: o.codeChallenge,
    code_challenge_method: PROOF_METHOD,
  });
  return `${GOOGLE_AUTHORIZE_URL}?${query.toString()}`;
}

/** One form sent to Google's token address. `lasting`: the form carries a lasting sign-in, so a refused grant means the consent has ended. */
async function trade(deps: SignInDeps, form: Readonly<Record<string, string>>, lasting: boolean, signal: AbortSignal): Promise<{ readonly ok: true; readonly json: Json } | Refused> {
  const answer = await deps.http.request(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    auth: null,
    validators: null,
    signal,
  });
  if (!answer.arrived) return refuse(answer.reason);
  const json = jsonOf(answer.body);
  if (answer.status === 200) return json === null ? refuse("unreadable") : { ok: true, json };
  const error = json?.error;
  const wait = retryAfterMs(answer, deps.clock);
  if (error === "invalid_grant") return refuse(lasting ? "consent_needed" : "sign_in_refused");
  if (error === "invalid_client" || error === "unauthorized_client" || answer.status === 401) return refuse("sign_in_refused");
  if (answer.status === 429 || error === "rate_limit_exceeded") return refuse("throttled", wait);
  if (answer.status >= 500) return refuse("unavailable", wait);
  return refuse("unknown");
}

function accessOf(json: Json, nowMs: number): GoogleAccess | null {
  const token = json.access_token;
  if (typeof token !== "string" || token.length > MAX_SIGN_IN_CHARS || !HEADER_SAFE.test(token)) return null;
  const life = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? Math.min(Math.max(json.expires_in, 0), MAX_LIFE_SECONDS) : 0;
  return { token, expiresAtMs: nowMs + life * 1000 };
}

/** Does the answer say it grants both permissions? A person may untick one on Google's page. */
function grantsAll(scope: unknown): boolean {
  if (typeof scope !== "string" || scope.length > MAX_SIGN_IN_CHARS) return false;
  const granted = new Set(scope.split(" "));
  return GOOGLE_SCOPES.every((needed) => granted.has(needed));
}

/**
 * What came back from a sign-in, traded for the lasting sign-in. An answer without one, or without
 * both permissions, is no sign-in: nothing of it is handed on.
 */
export async function exchangeGoogleCode(
  deps: SignInDeps,
  o: { readonly client: GoogleClient; readonly code: string; readonly codeVerifier: string; readonly redirectUri: string },
  signal: AbortSignal,
): Promise<Answer<GoogleGrant>> {
  const form = { grant_type: "authorization_code", code: o.code, code_verifier: o.codeVerifier, redirect_uri: o.redirectUri, client_id: o.client.id, client_secret: o.client.secret.reveal() };
  const answer = await trade(deps, form, false, signal);
  if (!answer.ok) return answer;
  const access = accessOf(answer.json, deps.clock.now());
  if (access === null) return refuse("unreadable");
  const lasting = answer.json.refresh_token;
  if (typeof lasting !== "string" || lasting === "" || lasting.length > MAX_SIGN_IN_CHARS || !grantsAll(answer.json.scope)) return refuse("sign_in_incomplete");
  return { ok: true, value: { ...access, refreshToken: new Secret(lasting) } };
}

/**
 * The lasting sign-in traded for a short one. A consent that has ended (Google's test consent ends
 * after seven days; a person can take it back any day) is `consent_needed`, an answer and never a fault.
 */
export async function renewGoogleAccess(deps: SignInDeps, signIn: GoogleSignIn, signal: AbortSignal): Promise<Answer<GoogleAccess>> {
  const form = { grant_type: "refresh_token", refresh_token: signIn.refreshToken.reveal(), client_id: signIn.client.id, client_secret: signIn.client.secret.reveal() };
  const answer = await trade(deps, form, true, signal);
  if (!answer.ok) return answer;
  const access = accessOf(answer.json, deps.clock.now());
  if (access === null) return refuse("unreadable");
  // Where the answer lists what it grants, both permissions are among them; one taken back is no sign-in for a calendar.
  if (answer.json.scope !== undefined && !grantsAll(answer.json.scope)) return refuse("sign_in_incomplete");
  return { ok: true, value: access };
}

/**
 * The port's sign-in for one pass: it trades on its first use and keeps the short sign-in until
 * shortly before it ends. It lives as long as the object does, which is the caller's pass; a refusal
 * is not kept, so the next ask trades again.
 */
export function googleBearer(deps: SignInDeps, signIn: GoogleSignIn): Credential {
  let held: GoogleAccess | null = null;
  return {
    kind: "bearer",
    async accessToken(signal) {
      if (held !== null && deps.clock.now() < held.expiresAtMs - RENEW_BEFORE_MS) return { ok: true, token: held.token };
      held = null;
      const answer = await renewGoogleAccess(deps, signIn, signal);
      if (!answer.ok) return refuse(answer.reason, answer.retryAfterMs);
      held = answer.value;
      return { ok: true, token: held.token };
    },
  };
}

/**
 * Google's sign-in: the address a person is sent to, the trade of the answer for a lasting sign-in,
 * and the trade of the lasting sign-in for a short one. No request leaves the process: the port
 * handed in answers from a table. The two permissions are written here as the calendar's groundwork
 * names them (events, and the read-only calendar list), not taken from the code.
 */
import { intlZones } from "@ohmail/cal-core";
import { describe, expect, it } from "vitest";
import { exchangeGoogleCode, googleAuthorizeUrl, googleBearer, GOOGLE_SCOPES, makeReader, renewGoogleAccess, type GoogleSignIn } from "../src/google/index.js";
import type { ProviderRefusal } from "../src/refusals.js";
import type { HttpPort } from "../src/request/index.js";
import { Secret } from "../src/secret.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
// Invented, and put together here so that no line of this file is shaped like a real value.
const LASTING = ["kiln", "glaze", "wheel"].join("-");
const CLIENT_SECRET = ["slip", "cone", "six"].join("-");
const signIn: GoogleSignIn = { client: { id: "client-1", secret: new Secret(CLIENT_SECRET) }, refreshToken: new Secret(LASTING) };

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | { refused: ProviderRefusal };
function serving(replies: Record<string, Reply[]>) {
  const sent: { url: string; method: string; type: string | undefined; form: Record<string, string>; auth: boolean }[] = [];
  const http: HttpPort = {
    async request(url, o) {
      sent.push({ url, method: o.method, type: o.headers["content-type"], form: Object.fromEntries(new URLSearchParams(o.body ?? "")), auth: o.auth !== null });
      const reply = replies[url]?.shift();
      if (reply === undefined) throw new Error(`the test serves nothing more at ${url}`);
      if ("refused" in reply) return { arrived: false, reason: reply.refused };
      const body = new TextEncoder().encode(reply.text ?? JSON.stringify(reply.json ?? {}));
      return { arrived: true, status: reply.status ?? 200, header: (name) => reply.headers?.[name.toLowerCase()] ?? null, body, location: null, url, hops: 0 };
    },
  };
  return { http, sent };
}
const never = new AbortController().signal;
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const refusal = (reason: ProviderRefusal, retryAfterMs: number | null = null) => ({ ok: false, reason, retryAfterMs });
const short = (token: string, seconds = 3599) => ({ json: { access_token: token, expires_in: seconds, scope: `${LIST_SCOPE} ${EVENTS_SCOPE}`, token_type: "Bearer" } });

describe("Google's sign-in: where a person is sent", () => {
  it("asks for the two permissions the calendar needs and no other, for a lasting sign-in, with the proof of who asked", () => {
    expect([...GOOGLE_SCOPES]).toEqual([EVENTS_SCOPE, LIST_SCOPE]);
    const url = new URL(googleAuthorizeUrl({ clientId: "client-1", redirectUri: "http://127.0.0.1:53124/", state: "state-1", codeChallenge: "challenge-1" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-1",
      redirect_uri: "http://127.0.0.1:53124/",
      response_type: "code",
      scope: `${EVENTS_SCOPE} ${LIST_SCOPE}`,
      access_type: "offline",
      prompt: "consent",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S" + "256",
    });
  });

  it("returns to a port on this machine or to an https address, and to nothing else", () => {
    const to = (redirectUri: string) => () => googleAuthorizeUrl({ clientId: "client-1", redirectUri, state: "s", codeChallenge: "c" });
    expect(to("https://api.ohmail.example/calendar/google/return")).not.toThrow();
    for (const other of ["http://api.ohmail.example/return", "http://localhost:53124/", "http://127.0.0.1/", "http://10.0.0.5:53124/", "ftp://127.0.0.1:53124/", "https://user:pw@api.ohmail.example/", "not an address"]) {
      expect(to(other), other).toThrow();
    }
  });
});

describe("Google's sign-in: the answer traded for a lasting sign-in", () => {
  const code = { client: signIn.client, code: "code-1", codeVerifier: "verifier-1", redirectUri: "http://127.0.0.1:53124/" };

  it("sends the code with its proof to Google's token address, and keeps the lasting sign-in where nothing prints it", async () => {
    const { http, sent } = serving({ [TOKEN_URL]: [{ json: { ...short("s1").json, refresh_token: LASTING } }] });
    const answer = await exchangeGoogleCode({ http, clock: { now: () => NOW } }, code, never);
    expect(sent).toEqual([
      { url: TOKEN_URL, method: "POST", type: "application/x-www-form-urlencoded", auth: false, form: { grant_type: "authorization_code", code: "code-1", code_verifier: "verifier-1", redirect_uri: "http://127.0.0.1:53124/", client_id: "client-1", client_secret: CLIENT_SECRET } },
    ]);
    if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
    expect({ token: answer.value.token, expiresAtMs: answer.value.expiresAtMs, lasting: answer.value.refreshToken.reveal() }).toEqual({ token: "s1", expiresAtMs: NOW + 3_599_000, lasting: LASTING });
    expect(JSON.stringify(answer)).not.toContain(LASTING);
  });

  it.each<[string, Reply, ProviderRefusal]>([
    ["no lasting sign-in", short("s1"), "sign_in_incomplete"],
    ["only one of the two permissions", { json: { access_token: "s1", expires_in: 3599, scope: EVENTS_SCOPE, refresh_token: LASTING } }, "sign_in_incomplete"],
    ["no word on the permissions", { json: { access_token: "s1", expires_in: 3599, refresh_token: LASTING } }, "sign_in_incomplete"],
    ["a code Google does not take", { status: 400, json: { error: "invalid_grant", error_description: "Bad Request" } }, "sign_in_refused"],
    ["a registration Google does not know", { status: 401, json: { error: "invalid_client" } }, "sign_in_refused"],
    ["no JSON", { text: "<html></html>" }, "unreadable"],
  ])("keeps nothing of an answer with %s", async (_what, reply, reason) => {
    const { http } = serving({ [TOKEN_URL]: [reply] });
    const answer = await exchangeGoogleCode({ http, clock: { now: () => NOW } }, code, never);
    expect(answer).toEqual(refusal(reason));
  });
});

describe("Google's sign-in: the lasting sign-in traded for a short one", () => {
  it("sends the lasting sign-in to Google's token address and answers with the short one and when it ends", async () => {
    const { http, sent } = serving({ [TOKEN_URL]: [short("s1")] });
    const answer = await renewGoogleAccess({ http, clock: { now: () => NOW } }, signIn, never);
    expect(answer).toEqual({ ok: true, value: { token: "s1", expiresAtMs: NOW + 3_599_000 } });
    expect(sent).toEqual([{ url: TOKEN_URL, method: "POST", type: "application/x-www-form-urlencoded", auth: false, form: { grant_type: "refresh_token", refresh_token: LASTING, client_id: "client-1", client_secret: CLIENT_SECRET } }]);
  });

  it.each<[string, Reply, ReturnType<typeof refusal>]>([
    ["a consent that has ended", { status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }, refusal("consent_needed")],
    ["a registration Google refuses", { status: 401, json: { error: "invalid_client" } }, refusal("sign_in_refused")],
    ["a permission taken back", { json: { access_token: "s1", expires_in: 3599, scope: EVENTS_SCOPE } }, refusal("sign_in_incomplete")],
    ["too many requests", { status: 429, headers: { "retry-after": "12" }, json: {} }, refusal("throttled", 12_000)],
    ["a busy token address", { status: 503, headers: { "retry-after": "5" }, text: "" }, refusal("unavailable", 5000)],
    ["a fault of Google's", { status: 500, text: "" }, refusal("unavailable")],
    ["a request that never arrived", { refused: "connection_failed" }, refusal("connection_failed")],
    ["a page that is no JSON", { text: "<html>Sign in</html>" }, refusal("unreadable")],
    ["a short sign-in no header may hold", { json: { access_token: "s1\r\nx-injected: 1", expires_in: 3599 } }, refusal("unreadable")],
    ["a status nothing has a word for", { status: 418, json: {} }, refusal("unknown")],
  ])("answers %s with its word, and shows nothing of what it sent", async (_what, reply, expected) => {
    const { http } = serving({ [TOKEN_URL]: [reply] });
    const answer = await renewGoogleAccess({ http, clock: { now: () => NOW } }, signIn, never);
    expect(answer).toEqual(expected);
    expect(JSON.stringify(answer)).not.toContain(LASTING);
    expect(JSON.stringify(answer)).not.toContain(CLIENT_SECRET);
  });
});

describe("Google's sign-in: the port a reader is handed", () => {
  it("trades once and keeps the short sign-in until two minutes before it ends, then trades again", async () => {
    let now = NOW;
    const { http, sent } = serving({ [TOKEN_URL]: [short("s1", 3600), short("s2", 3600)] });
    const credential = googleBearer({ http, clock: { now: () => now } }, signIn);
    if (credential.kind !== "bearer") throw new Error("no bearer");
    expect(await credential.accessToken(never)).toEqual({ ok: true, token: "s1" });
    now = NOW + 3_479_000;
    expect(await credential.accessToken(never)).toEqual({ ok: true, token: "s1" });
    expect(sent.length).toBe(1);
    now = NOW + 3_481_000;
    expect(await credential.accessToken(never)).toEqual({ ok: true, token: "s2" });
    expect(sent.length).toBe(2);
  });

  it("does not keep a refusal: the next ask trades again", async () => {
    const { http, sent } = serving({ [TOKEN_URL]: [{ status: 503, headers: { "retry-after": "5" }, text: "" }, short("s1")] });
    const credential = googleBearer({ http, clock: { now: () => NOW } }, signIn);
    if (credential.kind !== "bearer") throw new Error("no bearer");
    expect(await credential.accessToken(never)).toEqual(refusal("unavailable", 5000));
    expect(await credential.accessToken(never)).toEqual({ ok: true, token: "s1" });
    expect(sent.length).toBe(2);
  });

  it("gives the reader its short sign-in, and a consent that has ended reaches the reader's answer as that word", async () => {
    const list = "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250";
    const asked: (string | null)[] = [];
    const answers: Record<string, Reply[]> = { [TOKEN_URL]: [short("s1"), { status: 400, json: { error: "invalid_grant" } }], [list]: [{ json: { items: [] } }] };
    const { http } = serving(answers);
    const seeing: HttpPort = { request: (url, o) => (asked.push(o.auth !== null && o.auth.credential.kind === "bearer" ? o.auth.credential.token : null), http.request(url, o)) };
    const reader = makeReader({ http: seeing, clock: { now: () => NOW }, zones: intlZones() });
    const open = { provider: "google", credential: googleBearer({ http: seeing, clock: { now: () => NOW } }, signIn), start: null } as const;
    expect(await reader.listCalendars(open, never)).toEqual({ ok: true, value: [] });
    expect(asked).toEqual([null, "s1"]);
    const ended = { provider: "google", credential: googleBearer({ http: seeing, clock: { now: () => NOW } }, signIn), start: null } as const;
    expect(await reader.listCalendars(ended, never)).toEqual(refusal("consent_needed"));
    expect(asked).toEqual([null, "s1", null]);
  });
});

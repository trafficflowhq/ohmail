/**
 * THE SHELL'S HTTP DOOR: the one way a request the page names reaches a server, and every check
 * on the way, in this order. Nothing is sent unless every check passed, and nothing the page sends
 * can name a host: native composes the base, stamps the bearer last, and reads the answer back
 * through an allow-list.
 *
 *  1. Scope. The request's scope must be the live session's; a request queued under another
 *     profile is refused, so a send queued under A is never stamped with B's bearer.
 *  2. Not ready, no dial: the launch and the session's account binding must stand.
 *  3. The path in its one spelling (no `//`, no trailing `/`, no `/api` the base already names),
 *     through the relay's own allow-list (`relay-routes.ts`, held equal to it), minus the routes
 *     only native may call. Deny by default.
 *  4. Headers in by allow-list; `authorization`, `cookie` and every other credential are dropped.
 *  5. Bounds: a body and a number in flight, refused past them.
 *  6. The same live session must still hold an account binding. Reject foreign account answers.
 *     Headers out by allow-list.
 */
import { pairLink, type ShellSession } from "../net/pairing";
import type { Body, Headers, PairGrant, PhoneAccountRequest, Refused, Requests } from "./bridge-kinds";
import { RELAY_ROUTES } from "./relay-routes";

type HttpAsk = Requests["http"]["ask"];
type HttpAnswer = Requests["http"]["answer"];

/**
 * The routes only the native side calls: the session's end, the pairing ceremony, the wake registration, and the two
 * second-factor steps that answer session tokens in their body to a session that is still enrolling. The page's
 * session is a pairing's full one and never enrolling, but a route that hands out session tokens has no place at the
 * page's door in any state.
 */
export const NATIVE_ONLY = [
  "POST /auth/logout", "GET /pair", "POST /pair", "DELETE /pair/:id",
  "GET /push/vapid-key", "POST /push/subscriptions", "DELETE /push/subscriptions/:id",
  "POST /auth/2fa/totp/activate", "POST /auth/2fa/webauthn/register/verify",
] as const;

/** Keep the engine's existing retry code for the two feed reads. */
const DRAIN_PATHS = new Set(["/sync", "/sync/snapshot"]);

/** Header names the page may set. `x-ohmail-*` too, but never the two native stamps. */
const HEADERS_IN = new Set(["content-type", "accept", "idempotency-key", "if-none-match"]);
const NATIVE_STAMPS = new Set(["x-ohmail-client", "x-ohmail-accepts"]);
const HEADERS_OUT = new Set(["content-type", "retry-after", "x-sync-seq", "x-ohmail-account", "content-disposition"]);

/** The largest body either way, and the most requests in flight at once. */
export const BODY_MAX = 32 * 1024 * 1024;
export const IN_FLIGHT_MAX = 16;

export interface HttpDoorDeps {
  /** The live shell session and its scope, or null while none is entered. */
  readonly live: () => { readonly session: ShellSession; readonly scope: string } | null;
  /** The launch order (pins, install generation, owed wipes) has finished. */
  readonly ready: () => boolean;
  /** Counts, by what was refused: numbers only. */
  readonly count?: (what: string) => void;
}

function matches(spec: string, method: string, path: string): boolean {
  const [m, pattern] = spec.split(" ") as [string, string];
  if (m !== method) return false;
  const want = pattern.split("/");
  const got = path.split("/");
  return want.length === got.length && want.every((seg, i) => (seg.startsWith(":") ? got[i] !== "" : seg === got[i]));
}

const answerOf = (status: number, code: string): HttpAnswer => ({
  status,
  headers: [["content-type", "application/json"]],
  body: { as: "text", text: JSON.stringify({ error: { code } }) },
});

const ACCOUNT_NATIVE_ROUTES = [
  "GET /pair", "POST /pair", "DELETE /pair/:id", "POST /auth/2fa/totp/activate",
] as const;
const ACCOUNT_REFUSALS = new Set(["step_up_required", "account_locked", "sign_in_slowed", "credential_refused"]);

type AccountResult = Requests["phone.account"]["answer"] | { refused: Refused };
type PairListRow = { id: string; grant: PairGrant; label: string; createdAt: string; expiresAt: string; status: string };

function pairRow(value: unknown): value is PairListRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<PairListRow>;
  return typeof row.id === "string" && (row.grant === "device-pair" || row.grant === "invite") &&
    typeof row.label === "string" && typeof row.createdAt === "string" && typeof row.expiresAt === "string" &&
    typeof row.status === "string";
}

function jsonResult(value: object): AccountResult {
  return { result: { status: 200, headers: [["content-type", "application/json"]], body: { as: "text", text: JSON.stringify(value) } } };
}

function jsonOf(answer: HttpAnswer): Record<string, unknown> | null {
  if (answer.body?.as !== "text") return null;
  try {
    const data: unknown = JSON.parse(answer.body.text);
    return typeof data === "object" && data !== null ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function bodyOf(b: Body | null): string | Uint8Array | undefined {
  if (b === null) return undefined;
  if (b.as === "text") return b.text;
  return Uint8Array.from(atob(b.b64), (c) => c.charCodeAt(0));
}

const TEXTUAL = /^(text\/|application\/(json|problem\+json|x-www-form-urlencoded|javascript)|message\/)/i;
const JSON_TYPE = /^application\/(?:json|[^;\s]+\+json)(?:\s*;|$)/i;

async function answerBody(res: Response): Promise<Body | null> {
  const type = res.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) return null;
  if (bytes.length > BODY_MAX) throw new RangeError("answer too large");
  if (TEXTUAL.test(type) || JSON_TYPE.test(type)) return { as: "text", text: new TextDecoder().decode(bytes) };
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { as: "b64", b64: btoa(bin) };
}

function namesAnotherAccount(text: string, account: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return false; }
  const pending = [parsed];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === null || typeof entry !== "object") continue;
    for (const [key, value] of Object.entries(entry)) {
      if (key === "accountId" && typeof value === "string" && value !== account) return true;
      if (value !== null && typeof value === "object") pending.push(value);
    }
  }
  return false;
}

export class HttpDoor {
  private inFlight = 0;

  constructor(private readonly deps: HttpDoorDeps) {}

  /** Account management exposes only pairing metadata, a new one-use link, or a status. */
  async account(ask: Exclude<PhoneAccountRequest, { do: "deletePage" | "settingsPage" }>, signal: AbortSignal): Promise<AccountResult> {
    const live = this.deps.live();
    if (signal.aborted || live === null || live.scope !== ask.scope) return { refused: "foreignScope" };
    const { session } = live;
    const { profile } = session;
    if (session.standalone || (profile.flavor !== "managed" && profile.flavor !== "selfhost")) {
      return { result: answerOf(403, "not_relayed") };
    }
    if ("grant" in ask && ask.grant === "invite" && profile.flavor !== "selfhost") {
      return { result: answerOf(403, "not_relayed") };
    }
    const call = (path: string, method: HttpAsk["method"], body?: object) =>
      this.relay({ scope: ask.scope, path, method, headers: body ? [["content-type", "application/json"]] : [],
        body: body ? { as: "text", text: JSON.stringify(body) } : null }, signal, session);
    const failure = (result: HttpAnswer): AccountResult => {
      const data = jsonOf(result)?.error as { code?: unknown } | undefined;
      return { result: answerOf(result.status, typeof data?.code === "string" && ACCOUNT_REFUSALS.has(data.code) ? data.code : "refused") };
    };
    const done: AccountResult = { result: { status: 204, headers: [], body: null } };

    if (ask.do === "activate") {
      if (!/^\d{6}$/.test(ask.code)) return { result: answerOf(400, "malformed") };
      const result = await call("/auth/2fa/totp/activate", "POST", { code: ask.code });
      if ("refused" in result) return result;
      return result.status >= 200 && result.status < 300 ? done : failure(result);
    }
    if (ask.do === "mint") {
      const result = await call("/pair", "POST", { grant: ask.grant, ...(ask.name ? { label: ask.name } : {}) });
      if ("refused" in result) return result;
      if (result.status >= 300) return failure(result);
      const data = jsonOf(result);
      if (!data || typeof data.id !== "string" || typeof data.label !== "string" ||
        typeof data.expiresAt !== "string" || data.grant !== ask.grant ||
        typeof data.token !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(data.token)) {
        return { result: answerOf(502, "unreadable") };
      }
      const link = ask.grant === "invite"
        ? new URL(`/join/invite#${data.token}`, profile.origin).href
        : pairLink(profile.origin, data.token, profile.pin ?? null);
      return jsonResult({ id: data.id, label: data.label, expiresAt: data.expiresAt, link });
    }

    const result = await call("/pair", "GET");
    if ("refused" in result) return result;
    if (result.status >= 300) return failure(result);
    const data = jsonOf(result);
    if (!Array.isArray(data?.items)) return { result: answerOf(502, "unreadable") };
    const items = data.items.filter(pairRow).filter((row) => row.grant === "device-pair" || profile.flavor === "selfhost");
    if (ask.do === "revoke") {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(ask.pairId)) return { result: answerOf(400, "malformed") };
      if (!items.some((row) => row.grant === ask.grant && row.id === ask.pairId && row.status === "live")) return done;
      const removed = await call(`/pair/${ask.pairId}`, "DELETE");
      if ("refused" in removed) return removed;
      return removed.status < 300 || removed.status === 404 ? done : failure(removed);
    }
    return jsonResult({ items: items.map(({ id, grant, label, status, createdAt, expiresAt }) =>
      ({ id, grant, label, status, createdAt, expiresAt })) });
  }

  /** One request the page asked for. `signal` is the page's cancel. Resolves with what the page reads. */
  async request(ask: HttpAsk, signal: AbortSignal): Promise<HttpAnswer | { refused: "foreignScope" | "tooMany" | "tooLarge" }> {
    return this.relay(ask, signal);
  }

  private async relay(ask: HttpAsk, signal: AbortSignal, accountSession?: ShellSession): ReturnType<HttpDoor["request"]> {
    const count = this.deps.count ?? (() => {});
    const live = this.deps.live();
    if (live === null || ask.scope !== live.scope || (accountSession && live.session !== accountSession)) {
      count("foreignScope");
      return { refused: "foreignScope" };
    }
    if (!this.deps.ready()) return answerOf(503, "not_ready");
    const [path, query = ""] = splitQuery(ask.path);
    const method = ask.method;
    if (!oneSpelling(path) || !RELAY_ROUTES.some((spec) => matches(spec, method, path))
      || (NATIVE_ONLY.some((spec) => matches(spec, method, path)) &&
        (!accountSession || !ACCOUNT_NATIVE_ROUTES.some((spec) => matches(spec, method, path))))) {
      count("notRelayed");
      return answerOf(403, "not_relayed");
    }
    const account = live.session.boundAccount();
    if (account === null || account !== live.session.profile.accountId) {
      return answerOf(503, DRAIN_PATHS.has(path) ? "sync_held_pre_identity" : "account_held_pre_identity");
    }
    const stillHere = () => {
      const now = this.deps.live();
      return !signal.aborted && now?.session === live.session && now.scope === live.scope &&
        live.session.boundAccount() === account;
    };
    if (!stillHere()) return { refused: "foreignScope" };
    const sent = bodyOf(ask.body);
    if (sent !== undefined && (typeof sent === "string" ? sent.length : sent.byteLength) > BODY_MAX) {
      return { refused: "tooLarge" };
    }
    if (this.inFlight >= IN_FLIGHT_MAX) return { refused: "tooMany" };
    const headers: Record<string, string> = {};
    for (const [name, value] of ask.headers) {
      const n = name.toLowerCase();
      if (HEADERS_IN.has(n) || (n.startsWith("x-ohmail-") && !NATIVE_STAMPS.has(n))) headers[n] = value;
    }
    this.inFlight += 1;
    try {
      const res = await live.session.send(`${path}${query}`, {
        method, headers, body: sent as BodyInit | undefined, signal, credentials: "omit",
      } as RequestInit);
      if (!stillHere()) return { refused: "foreignScope" };
      const named = res.headers.get("x-ohmail-account");
      if (named !== null && named !== account) {
        live.session.leave();
        return answerOf(403, "account_mismatch");
      }
      const body = await answerBody(res);
      if (!stillHere()) return { refused: "foreignScope" };
      if (body?.as === "text" && JSON_TYPE.test(res.headers.get("content-type") ?? "") &&
          namesAnotherAccount(body.text, account)) {
        live.session.leave();
        return answerOf(403, "account_mismatch");
      }
      const out: [string, string][] = [];
      res.headers.forEach((value, name) => {
        if (HEADERS_OUT.has(name.toLowerCase())) out.push([name.toLowerCase(), value]);
      });
      return { status: res.status, headers: out as Headers, body };
    } catch (fault) {
      if (!stillHere()) return { refused: "foreignScope" };
      throw fault;
    } finally {
      this.inFlight -= 1;
    }
  }
}

/** The path as the routes spell it: no empty segment, no trailing slash, no `/api` the base names. */
function oneSpelling(path: string): boolean {
  if (path === "/") return true;
  if (path.includes("//") || path.endsWith("/")) return false;
  return path !== "/api" && !path.startsWith("/api/");
}

function splitQuery(path: string): [string, string] {
  const at = path.search(/[?#]/);
  if (at < 0) return [path, ""];
  const q = path.slice(at).split("#", 1)[0]!;
  return [path.slice(0, at), q];
}

/**
 * THE SHELL'S HTTP DOOR: the one way a request the page names reaches a server, and every check
 * on the way, in this order. Nothing is sent unless every check passed, and nothing the page sends
 * can name a host: native composes the base, stamps the bearer last, and reads the answer back
 * through an allow-list.
 *
 *  1. Scope. The request's scope must be the live session's; a request queued under another
 *     profile is refused, so a send queued under A is never stamped with B's bearer.
 *  2. Not ready, no dial: until the launch order has finished, and while the identity verdict has
 *     not settled for the drain routes.
 *  3. The path in its one spelling (no `//`, no trailing `/`, no `/api` the base already names),
 *     through the relay's own allow-list (`relay-routes.ts`, held equal to it), minus the routes
 *     only native may call. Deny by default.
 *  4. Headers in by allow-list; `authorization`, `cookie` and every other credential are dropped.
 *  5. Bounds: a body and a number in flight, refused past them.
 *  6. Headers out by allow-list; never `set-cookie`.
 */
import type { ShellSession } from "../net/pairing";
import type { Body, Headers, Requests } from "./bridge-kinds";
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

/** The drain routes, by path (both are reads), held shut until the identity verdict settles without a mismatch. */
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

function bodyOf(b: Body | null): string | Uint8Array | undefined {
  if (b === null) return undefined;
  if (b.as === "text") return b.text;
  return Uint8Array.from(atob(b.b64), (c) => c.charCodeAt(0));
}

const TEXTUAL = /^(text\/|application\/(json|problem\+json|x-www-form-urlencoded|javascript)|message\/)/i;

async function answerBody(res: Response): Promise<Body | null> {
  const type = res.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) return null;
  if (bytes.length > BODY_MAX) throw new RangeError("answer too large");
  if (TEXTUAL.test(type)) return { as: "text", text: new TextDecoder().decode(bytes) };
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { as: "b64", b64: btoa(bin) };
}

export class HttpDoor {
  private inFlight = 0;

  constructor(private readonly deps: HttpDoorDeps) {}

  /** One request the page asked for. `signal` is the page's cancel. Resolves with what the page reads. */
  async request(ask: HttpAsk, signal: AbortSignal): Promise<HttpAnswer | { refused: "foreignScope" | "tooMany" | "tooLarge" }> {
    const count = this.deps.count ?? (() => {});
    const live = this.deps.live();
    if (live === null || ask.scope !== live.scope) {
      count("foreignScope");
      return { refused: "foreignScope" };
    }
    if (!this.deps.ready()) return answerOf(503, "not_ready");
    const [path, query = ""] = splitQuery(ask.path);
    const method = ask.method;
    if (!oneSpelling(path) || !RELAY_ROUTES.some((spec) => matches(spec, method, path))
      || NATIVE_ONLY.some((spec) => matches(spec, method, path))) {
      count("notRelayed");
      return answerOf(403, "not_relayed");
    }
    if (method === "GET" && DRAIN_PATHS.has(path) && !live.session.identityCleared()) {
      return answerOf(503, "sync_held_pre_identity");
    }
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
      const out: [string, string][] = [];
      res.headers.forEach((value, name) => {
        if (HEADERS_OUT.has(name.toLowerCase())) out.push([name.toLowerCase(), value]);
      });
      return { status: res.status, headers: out as Headers, body: await answerBody(res) };
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

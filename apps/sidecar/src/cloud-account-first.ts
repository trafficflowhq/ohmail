import { ServiceError, type ServiceContext } from "@trafficflow/services/mail";
import { offlineResponse } from "./cloud-auth.js";
import { runsStorePass } from "./composition-passes.js";
import type { ReadRoute } from "./cloud-read.js";
import { MAX_BODY_BYTES, readBodyBounded } from "./frame.js";
import type { Diagnostic } from "./log.js";

/**
 * A READ THE ACCOUNT ANSWERS WHENEVER IT CAN BE REACHED — `/search`, whose whole-mailbox verdict
 * and count are the account's and whose mirror holds a window of it. The request relays; the
 * mirror answers only when the relay says the account is unreachable (a 502/503/504, the relay's
 * own offline refusal among them) or does not answer within the bound, and that answer carries
 * `answeredFrom: "mirror"` so the window can say so. A walk stays on the store that began it: a
 * mirror page's cursor is tagged, and an account cursor or an address count is refused offline.
 */

/** How long the account may take before the mirror answers instead: twice the slowest relayed page
    measured on a paired desktop (3.9 s), so a slow account is never called unreachable. */
export const ACCOUNT_FIRST_BOUND_MS = 8_000;

/** The tag on a mirror page's cursor. The service writes base64url, which never holds a `.`. */
export const MIRROR_CURSOR_TAG = "m.";

const UNREACHABLE = new Set([502, 503, 504]);

/** Whether this composition fills the mirror's search index. It does not, so the mirror holds no
    documents, is searched the older way (complete) and would answer "0 % done" for ever: its
    answer carries no index progress. */
const MIRROR_INDEX_FILLS = runsStorePass("cloud", "search-index-backfill");

type Hit = { route: ReadRoute; params: Record<string, string> };

export interface AccountFirstDeps {
  ctx: ServiceContext;
  forward: (req: Request) => Promise<Response>;
  boundMs?: number;
  log?: Diagnostic;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The forward's answer, or null past the bound; a late answer is read and dropped. */
async function withinBound(answer: Promise<Response>, ms: number): Promise<Response | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const won = await Promise.race([answer, new Promise<null>((resolve) => { timer = setTimeout(resolve, ms, null); })]);
    if (won === null) void answer.then((late) => late.body?.cancel().catch(() => undefined), () => undefined);
    return won;
  } finally {
    clearTimeout(timer);
  }
}

/** The mirror's answer to the same question, stamped as the mirror's and its cursor tagged. */
async function fromMirror(req: Request, hit: Hit, ctx: ServiceContext): Promise<Response> {
  let res: Response;
  try {
    res = await hit.route.handler(req, ctx, hit.params);
  } catch (err) {
    if (err instanceof ServiceError) return json({ error: { code: err.code, message: err.message } }, err.httpStatus);
    throw err;
  }
  if (!res.ok) return res;
  const { indexed, ...rest } = (await res.json()) as Record<string, unknown>;
  const body = MIRROR_INDEX_FILLS && indexed !== undefined ? { ...rest, indexed } : rest;
  const next = typeof body.nextCursor === "string" ? { nextCursor: `${MIRROR_CURSOR_TAG}${body.nextCursor}` } : {};
  return json({ ...body, ...next, answeredFrom: "mirror" });
}

/** Which part of a search this request asks for: the timed line's `kind`, never the query. */
function partOf(url: URL): string {
  if (url.searchParams.has("address")) return "address";
  if (url.searchParams.has("cursor")) return "next";
  const p = url.searchParams.get("parts");
  return p === "page" || p === "estimate" || p === "summary" ? p : "both";
}

/** The account's own `ms` on a JSON answer, or null. */
function serverMsOf(bytes: Uint8Array): number | null {
  try {
    const ms = (JSON.parse(new TextDecoder().decode(bytes)) as { ms?: unknown }).ms;
    return typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms) : null;
  } catch {
    return null;
  }
}

export async function answerAccountFirst(req: Request, hit: Hit, deps: AccountFirstDeps): Promise<Response> {
  const receivedAtMs = Date.now();
  const t0 = performance.now();
  const url = new URL(req.url);
  const kind = partOf(url);
  /* ONE TIMED LINE PER RELAYED SEARCH (`search_relayed`): who answered, the account's round trip
     with its body read, the account's own `ms`, this door's total, and the instant it arrived. */
  const said = (verdict: string, status: number | null, accountMs: number | null, serverMs: number | null): void => {
    deps.log?.("search_relayed", {
      kind, verdict, status, accountMs, serverMs, totalMs: Math.round(performance.now() - t0), receivedAtMs,
    });
  };
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && cursor.startsWith(MIRROR_CURSOR_TAG)) {
    url.searchParams.set("cursor", cursor.slice(MIRROR_CURSOR_TAG.length));
    const res = await fromMirror(new Request(url, req), hit, deps.ctx);
    said("mirror", res.status, null, null);
    return res;
  }
  const answer = await withinBound(deps.forward(req), deps.boundMs ?? ACCOUNT_FIRST_BOUND_MS);
  if (answer !== null && !UNREACHABLE.has(answer.status)) {
    // Read here rather than by the frame writer, with its cap, so the line times the whole answer.
    const bytes = await readBodyBounded(answer, MAX_BODY_BYTES);
    said("account", answer.status, Math.round(performance.now() - t0), serverMsOf(bytes));
    return new Response(bytes.byteLength === 0 ? null : (bytes as unknown as BodyInit), {
      status: answer.status, statusText: answer.statusText, headers: answer.headers,
    });
  }
  void answer?.body?.cancel().catch(() => undefined);
  const refused = cursor !== null || url.searchParams.has("address");
  deps.log?.("cloud_search_from_mirror", {
    status: answer === null ? null : answer.status,
    reason: refused
      ? "the account could not be reached; an account page or an address count is refused rather than answered by the mirror"
      : answer === null
        ? "the account did not answer within the bound; the mirror answered and said so"
        : "the account could not be reached; the mirror answered and said so",
  });
  const res = refused ? offlineResponse() : await fromMirror(req, hit, deps.ctx);
  said(refused ? "refused" : "mirror", answer === null ? null : answer.status, null, null);
  return res;
}

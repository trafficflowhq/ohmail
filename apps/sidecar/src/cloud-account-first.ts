import { ServiceError, type ServiceContext } from "@trafficflow/services/mail";
import { offlineResponse } from "./cloud-auth.js";
import type { ReadRoute } from "./cloud-read.js";
import type { Diagnostic } from "./log.js";

/**
 * A READ THE ACCOUNT ANSWERS WHENEVER IT CAN BE REACHED — `/search`, whose whole-mailbox verdict
 * and count are the account's and whose mirror holds a window of it. The request relays; the
 * mirror answers only when the relay says the account is unreachable (a 502/503/504, the relay's
 * own offline refusal among them) or does not answer within the bound, and that answer carries
 * `answeredFrom: "mirror"` so the window can say so. A walk stays on the store that began it: a
 * mirror page's cursor is tagged, and an account cursor or an address count is refused offline.
 */

/** How long the account may take before the mirror answers instead: forty times the page's p95. */
export const ACCOUNT_FIRST_BOUND_MS = 4_000;

/** The tag on a mirror page's cursor. The service writes base64url, which never holds a `.`. */
export const MIRROR_CURSOR_TAG = "m.";

const UNREACHABLE = new Set([502, 503, 504]);

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
  const body = (await res.json()) as Record<string, unknown>;
  const next = typeof body.nextCursor === "string" ? { nextCursor: `${MIRROR_CURSOR_TAG}${body.nextCursor}` } : {};
  return json({ ...body, ...next, answeredFrom: "mirror" });
}

export async function answerAccountFirst(req: Request, hit: Hit, deps: AccountFirstDeps): Promise<Response> {
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && cursor.startsWith(MIRROR_CURSOR_TAG)) {
    url.searchParams.set("cursor", cursor.slice(MIRROR_CURSOR_TAG.length));
    return fromMirror(new Request(url, req), hit, deps.ctx);
  }
  const answer = await withinBound(deps.forward(req), deps.boundMs ?? ACCOUNT_FIRST_BOUND_MS);
  if (answer !== null && !UNREACHABLE.has(answer.status)) return answer;
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
  return refused ? offlineResponse() : fromMirror(req, hit, deps.ctx);
}

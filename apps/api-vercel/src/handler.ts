import { randomUUID } from "node:crypto";
import { refusalBeforeRouter, json } from "@ohmail/server/program";
import { hostState } from "./config.js";
import { programFor } from "./deps.js";
import { normalizeRequest } from "./normalize.js";
import { withQuietHold } from "./quiet-hold.js";

export { QUIET_HOLD_MS } from "./quiet-hold.js";

/**
 * The dispatch point. `app/[[...path]]/route.ts` is a thin shim over this so behaviour is
 * testable without a Next runtime. Two things are this door's own: the quiet hold around every
 * answer, and the answer of a host whose configuration did not load (once per cold instance — a
 * config fault becomes a clean 503). Everything else is the one program's pipeline
 * (`@ohmail/server/program`): the request id, normalizing the URL exactly once, the deps, the
 * router, HEAD as GET, `Cache-Control: no-store`.
 */

/** `res`, with `end` called when its body is read to its end, cancelled or fails; at once with no body. */
function heldUntilSent(res: Response, end: () => void): Response {
  if (res.body === null) {
    end();
    return res;
  }
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          end();
          controller.close();
        } else controller.enqueue(value);
      } catch (err) {
        end();
        controller.error(err);
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Every answer, and every exit, goes through the quiet hold. */
export function handleApiRequest(req: Request): Promise<Response> {
  return withQuietHold(req.url, async (end) => {
    try {
      return heldUntilSent(await answer(req), end);
    } catch (err) {
      end();
      throw err;
    }
  });
}

function answer(req: Request): Promise<Response> {
  const state = hostState();
  return state.ok ? programFor(state.cfg).dispatch(req) : unconfigured(req, state.error, state.version);
}

/**
 * The answer of a host whose configuration did not load. The path is canonicalized exactly as the
 * program would (`normalize.ts`), so a malformed path is still a 400 and `/api/health` is still
 * `/health`; then {@link misconfigured}.
 */
async function unconfigured(req: Request, error: string, version: string): Promise<Response> {
  const requestId = randomUUID();
  let pathname: string;
  try {
    pathname = new URL((await normalizeRequest(req)).url).pathname;
  } catch (err) {
    const refused = refusalBeforeRouter(err, requestId);
    if (refused) return refused;
    console.error(JSON.stringify({ level: "error", event: "unhandled", requestId, method: req.method }));
    return json(500, { error: { code: "internal", message: "internal error" } }, requestId);
  }
  return misconfigured(pathname, error, version, requestId);
}

/**
 * A host whose configuration did not load answers 503 everywhere — but `/health` answers
 * 503 *with the reason*, because an operator staring at a broken deployment needs to know
 * WHICH variable is wrong, and the messages this carries name variables, never values.
 *
 * It takes the ALREADY-CANONICAL pathname. Re-normalizing here was a real contract break:
 * `normalizePathname` strips exactly ONE `/api` by design, so applying it twice turned
 * `/api/api/health` — which must 404 — into `/health` and handed it the diagnostic detail.
 */
function misconfigured(pathname: string, error: string, version: string, requestId: string): Response {
  if (pathname === "/health") {
    return json(503, { ok: false, version, error: "config_invalid", detail: error }, requestId);
  }
  return json(503, { error: { code: "service_misconfigured", message: "service is misconfigured" } }, requestId);
}

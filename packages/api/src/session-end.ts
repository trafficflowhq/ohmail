import type { Middleware } from "./middleware.js";
import { cookieSurface } from "./routes/shared.js";

/**
 * NO ANSWER THAT ENDS OR REFUSES A BROWSER SESSION CARRIES `Clear-Site-Data`. Chrome holds such an
 * answer, cookie clears included, until it has walked its whole disk cache (seconds to minutes on a
 * long-used profile): the resume splash waited on the refresh door's refusal, the sign-out press on
 * its door's 204 until its deadline named a confirmed sign-out unconfirmed, the erase on its receipt
 * with the cookie lock held. The cache still goes, where a proxied picture is kept a day
 * (`routes/privacy.ts`): the browser asks for the clear once it holds the answer
 * ({@link withCachePurge}), and nothing waits for that. `"cache"` only: the web client wipes its
 * own storage and reads back what survived (`apps/webapp/app/sign-out.ts`).
 */
export const SESSION_END_CLEARS = '"cache"';

/** The sign-out, the web's sign-out door and the erase: the refusal's rule, one helper each for the census. */
export function sessionEnded(res: Response): Response {
  return sessionRefused(res);
}

/**
 * AN ANSWER THAT FOUND THE SESSION ALREADY ENDED — the refresh door's refusal. Its cookies, status
 * and body ride through and the clear goes. A NEW Response, because a Response's header guard may
 * forbid mutation.
 */
export function sessionRefused(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.delete("Clear-Site-Data");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** The request header, and its one value, that asks the refresh door for the cache clear alone. */
const CACHE_PURGE_HEADER = "x-ohmail-clear";
const CACHE_PURGE_VALUE = "cache";

/**
 * THE CACHE CLEAR, ASKED FOR ON ITS OWN, carried by `POST /auth/refresh` ahead of everything that
 * reads the jar. On a cookie surface a request naming it is answered 202 with `Clear-Site-Data`
 * and nothing else: no cookie, session or database is read, nothing is rotated or ended, and no
 * `Set-Cookie` goes out, so a late answer can never clear a newer session. A bearer-only host has
 * no browser cache to clear and hands the request on unchanged.
 */
export const withCachePurge: Middleware = (next) => async (req, deps, params) => {
  if (!cookieSurface(deps) || req.headers.get(CACHE_PURGE_HEADER)?.trim().toLowerCase() !== CACHE_PURGE_VALUE) {
    return next(req, deps, params);
  }
  return new Response(null, {
    status: 202,
    headers: { "Clear-Site-Data": SESSION_END_CLEARS, "Cache-Control": "no-store" },
  });
};

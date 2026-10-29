import type { Middleware } from "./middleware.js";
import { cookieSurface } from "./routes/shared.js";

/**
 * A RESPONSE THAT ENDS THE BROWSER SESSION EMPTIES THE BROWSER'S HTTP CACHE TOO. A proxied picture
 * is kept a day there (`routes/privacy.ts`), out of reach of the web client's own wipe
 * (`apps/webapp/app/sign-out.ts`), which removes the storage and reads back what survived — so
 * `"cache"` only. Decided by the response's own cookies: it expires `tf_session`, so a refusal
 * that keeps the jar keeps the cache and a host that sets no cookie sends nothing. A NEW Response,
 * because a Response's header guard may forbid mutation.
 */
export const SESSION_END_CLEARS = '"cache"';

export function sessionEnded(res: Response): Response {
  if (!res.headers.getSetCookie().some(expiresSessionCookie)) return res;
  const headers = new Headers(res.headers);
  headers.set("Clear-Site-Data", SESSION_END_CLEARS);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * AN ANSWER THAT FOUND THE SESSION ALREADY ENDED — the refresh door's refusal. Its cookies ride
 * through and it never carries `Clear-Site-Data`: Chrome holds such an answer, cookie clears
 * included, until it has walked its whole disk cache (seconds to minutes on a long-used profile),
 * and the resume splash waits on this one. The browser asks for the clear on its own
 * ({@link withCachePurge}), and nothing waits for that.
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

/** A `tf_session` line whose `Max-Age` is zero or less — the browser deletes the cookie. */
function expiresSessionCookie(line: string): boolean {
  const [pair = "", ...attributes] = line.split(";");
  if (pair.slice(0, pair.indexOf("=")).trim() !== "tf_session") return false;
  return attributes.some((a) => {
    const [name = "", value = ""] = a.split("=");
    return name.trim().toLowerCase() === "max-age" && /^-?\d+$/.test(value.trim()) && Number(value) <= 0;
  });
}

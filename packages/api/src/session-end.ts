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

/** A `tf_session` line whose `Max-Age` is zero or less — the browser deletes the cookie. */
function expiresSessionCookie(line: string): boolean {
  const [pair = "", ...attributes] = line.split(";");
  if (pair.slice(0, pair.indexOf("=")).trim() !== "tf_session") return false;
  return attributes.some((a) => {
    const [name = "", value = ""] = a.split("=");
    return name.trim().toLowerCase() === "max-age" && /^-?\d+$/.test(value.trim()) && Number(value) <= 0;
  });
}

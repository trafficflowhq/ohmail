/**
 * `GET /img?mid=…&u=…` for one image, as an absolute same-origin url. Exported and pure so the
 * property that matters is asserted directly: the sender's host never appears in the request's
 * ORIGIN, only in its query — a test that only read the `src` string would pass on
 * `https://evil.example/x.png` too. `origin` is a parameter for the reason `createEngine` takes its
 * env: a test drives the real function instead of a copy.
 */
export function imageProxyUrl(base: string, origin: string, messageId: string, url: string): string {
  const u = new URL(`${base}/img`, origin);
  u.searchParams.set("mid", messageId);
  u.searchParams.set("u", url);
  return u.toString();
}

/**
 * Where the marketing waitlist handler is allowed to forward a signup — kept OUT of
 * `route.ts` on purpose.
 *
 * Next's App Router validates the export surface of a `route.ts` at build time: the only
 * things a route module may export are the HTTP verbs and the known segment-config fields
 * (`runtime`, `dynamic`, `revalidate`, …). Exporting a helper from it — `apiOrigin`, which
 * this module used to declare inline so a test could reach it — fails `next build` with
 * `"apiOrigin" is not a valid Route export field`, and fails it on Vercel exactly as it
 * fails locally. `tsc --noEmit` never sees that rule, which is how a green `pnpm typecheck`
 * certified a tree that could not deploy.
 *
 * So the allow-list lives here: `route.ts` imports it, the origin suite imports it, and the
 * route module keeps an export surface Next accepts.
 */

/**
 * The only hosts the waitlist handler will forward a signup to — a COMPILED allow-list,
 * exactly like `apps/webapp/next.config.mjs`'s. `TF_API_ORIGIN` selects from it; it does
 * not define it. An environment variable must not be able to redirect the waitlist (and
 * therefore every address typed into the landing page) to a host of the setter's choosing.
 */
export const ALLOWED_API_ORIGINS = ["https://api.ohmail.app"] as const;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Resolve `TF_API_ORIGIN` to an origin this handler may call, or `null`.
 *
 * `null` is not an error state to paper over: with no usable origin the route answers 503
 * and the dialog shows the honest "we could not record that" step. A waitlist that silently
 * discards signups is worse than one that says it is temporarily unavailable.
 */
export function apiOrigin(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (LOOPBACK.has(url.hostname.toLowerCase())) return url.origin;
  if (url.protocol !== "https:") return null;
  return (ALLOWED_API_ORIGINS as readonly string[]).includes(url.origin) ? url.origin : null;
}

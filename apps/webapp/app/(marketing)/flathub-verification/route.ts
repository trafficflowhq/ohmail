/**
 * Flathub's domain verification for `app.ohmail.desktop`.
 *
 * Flathub proves an app id belongs to the domain it is named for by reading a token from
 * `/.well-known/org.flathub.VerifiedApps.txt` on that domain — `next.config.mjs` rewrites that
 * path here, because a Next route segment cannot be named `.well-known`.
 *
 * The token is read from the environment and NOT committed: a placeholder served at this path
 * would be a verification that fails while looking configured. Unset, the route is 404 — the
 * same answer the path gave before it existed — so the two states are distinguishable from the
 * outside and neither one pretends.
 */
export const dynamic = "force-dynamic";

/** Flathub's own format: one app id and its token per line. Ours is one line. */
export function verificationBody(token: string | undefined): string | null {
  const trimmed = token?.trim();
  return trimmed ? `${trimmed}\n` : null;
}

export function GET(): Response {
  const body = verificationBody(process.env.FLATHUB_VERIFICATION_TOKEN);
  if (body === null) return new Response("Not found", { status: 404 });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

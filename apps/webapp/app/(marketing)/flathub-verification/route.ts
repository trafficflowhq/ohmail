import { verificationBody } from "./token";

/**
 * Flathub's domain verification for the `app.ohmail.Desktop` app id.
 *
 * Flathub proves an app id belongs to the domain it is named for by reading a token from
 * `/.well-known/org.flathub.VerifiedApps.txt` on that domain. `next.config.mjs` rewrites that path
 * here, because a Next route segment cannot be named `.well-known`. The token comes from the
 * environment and is not committed; unset, this answers 404.
 */
export const dynamic = "force-dynamic";

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

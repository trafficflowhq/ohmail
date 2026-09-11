import { notFound } from "next/navigation";

/**
 * The marketing site is not part of a self-host install. On `ohmail.app` this origin is a shop front and a mail
 * client; on an operator's own box there is no stranger to pitch. Measured against a live self-hosted stack: an
 * anonymous `GET /` answered 200 with 302 KB of our landing, pricing included, and the imprint named TrafficFlow GmbH
 * as "Operator of this website" — on that origin simply false; the legal pages are worse than the pitch, asserting a
 * controller the install does not have.
 */

/**
 * Every marketing document calls {@link refuseOnSelfHost} as its first act, so on the self-host build the whole group
 * prerenders as a 404 at BUILD time — the honest status: there is no policy for an install we do not run, so nothing
 * has a correct address to redirect to; the branded boundary still renders a way back to `/`. `/` itself is handled a
 * layer earlier ({@link DOOR_ROUTE} in middleware); the refusal stands behind it so a middleware that did not run
 * fails to a 404, not a pricing table. The flavor is re-derived here because `app/hello.ts` imports `api-client.ts`
 * and these are static server pages; the value cannot drift — a build refuses a `NEXT_PUBLIC_OHMAIL_FLAVOR` it did
 * not derive itself.
 */
export const SELF_HOST_BUILD = process.env.NEXT_PUBLIC_OHMAIL_FLAVOR === "selfhost";

/**
 * Refuse to render this document on a self-host build. Call it FIRST in the page component,
 * before any content is composed — `notFound()` throws, so anything above it is work done for
 * a response nobody receives.
 *
 * A no-op on the managed build, where `SELF_HOST_BUILD` is a compiled `false` and this whole
 * branch is dead code in the emitted bundle.
 */
export function refuseOnSelfHost(): void {
  if (SELF_HOST_BUILD) notFound();
}

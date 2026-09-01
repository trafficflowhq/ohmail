import { notFound } from "next/navigation";

/**
 * THE MARKETING SITE IS NOT PART OF A SELF-HOST INSTALL.
 *
 * One bundle serves two very different deployments. On `ohmail.app` this origin is a shop
 * front and a mail client at the same address — `session-gate.ts` decides which, and the shop
 * front is the right answer for a stranger. On an operator's own box it is neither: the origin
 * belongs to THEM, everyone who reaches it is their user, and there is no stranger to pitch.
 *
 * MEASURED, not argued. Against a live self-hosted stack at `https://ohmail.test` whose first
 * account already existed, an anonymous `GET /` answered 200 with 302 KB of our landing —
 * pricing section included ("Or ours to run, monthly"), on the operator's domain. `/privacy`,
 * `/imprint` and `/subprocessors` answered 200 as well, and the imprint names TrafficFlow GmbH
 * as "Operator of this website" — which on that origin is simply false. `/de` served the whole
 * German landing. Every one of those is our copy squatting somebody else's address, and the
 * legal pages are worse than the pitch: they assert a controller the install does not have.
 *
 * ── WHAT THIS MODULE DOES, AND WHY IT IS A 404 RATHER THAN A REDIRECT ──────────────────────
 *
 * Every marketing document calls {@link refuseOnSelfHost} as its first act, so on the
 * self-host build the whole group is unreachable and Next prerenders it as a 404 at BUILD
 * time — the page never exists on that deployment rather than existing and being hidden.
 * 404 is the honest status: there is no ohmail privacy policy for an install we do not run and
 * no imprint we can sign, so nothing here has a correct address to redirect to. The branded
 * boundary (`(marketing)/not-found.tsx`) still renders — wordmark, and a way back to `/` — so
 * an operator's user who follows a stale link is returned to their own front door.
 *
 * `/` is the ONE exception and it is handled a layer earlier: `middleware.ts` sends a
 * self-host visitor the gate answered "marketing" for to {@link DOOR_ROUTE} before this page is
 * ever reached. The refusal below still stands behind it, deliberately, so the failure mode of
 * a middleware that did not run is a 404 and not a pricing table.
 *
 * ── WHY THE FLAVOR IS RE-DERIVED HERE ───────────────────────────────────────────────────────
 *
 * `app/hello.ts` exports the same constant and is the natural home for it, but it also imports
 * `api-client.ts` — a browser-facing module — and these are static SERVER pages whose whole
 * value is that they prerender without touching a runtime. `(product)/join/invite/page.tsx`
 * re-derives it for the same reason and in the same words. The value cannot drift: a build
 * refuses `NEXT_PUBLIC_OHMAIL_FLAVOR` that it did not derive itself (`next.config.mjs`), so
 * every reader of this variable in a given bundle reads the same literal.
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

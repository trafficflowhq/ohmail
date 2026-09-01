import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { Landing } from "../../(marketing)/components/Landing";
import { marketingAlternates } from "../../(marketing)/marketing-root";
import { refuseOnSelfHost } from "../../self-host-marketing";
import type { AppLocale } from "../../shell/locale";
import { publicSignupEnabled } from "../../signup-mode";

/**
 * THE GERMAN LANDING — `/de`.
 *
 * The same composition `/` renders, mounted under the root layout that pins `lang="de"` and
 * provides the German catalogue. There is no German copy in this file and there is not meant
 * to be: every sentence comes from `messages/de.json`, which was already complete. This slice
 * routes it; it does not write it.
 *
 * A REAL PATH rather than a negotiated body on `/`. `Accept-Language` on the apex would give
 * one URL two bodies, which needs `Vary: Accept-Language` to be cacheable at all — and
 * `middleware.ts` records that Next owns `Vary` on an App Router response and overwrites
 * whatever middleware sets. So the negotiation is the visible one: a link in the nav and the
 * footer, `hreflang` in the head, and an address a German reader can bookmark, send, and find
 * in a search result.
 */

const LOCALE = "de" satisfies AppLocale;

export const metadata: Metadata = { alternates: marketingAlternates(LOCALE) };

export default function GermanLandingPage() {
  /* The German landing is the same composition `/` renders, so it carries the same pricing and
     the same pitch and is refused on a self-host build for the same reason — and it needs its
     OWN call: `/` is diverted by middleware, `/de` is a plain path nothing diverts. */
  refuseOnSelfHost();
  setRequestLocale(LOCALE);
  return <Landing publicSignup={publicSignupEnabled()} />;
}

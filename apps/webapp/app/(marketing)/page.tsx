import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { Landing } from "./components/Landing";
import { marketingAlternates } from "./marketing-root";
import { DEFAULT_LOCALE } from "../shell/locale";
import { publicSignupEnabled } from "../signup-mode";

/**
 * THE ENGLISH LANDING — `/`, and the front door of the whole origin.
 *
 * The composition lives in `components/Landing.tsx` because `/de` renders the same one; this
 * file is the English MOUNT of it. Two things belong here and nothing else:
 *
 *  · the signup posture, read ONCE. This is a server component and `/` is prerendered, so the
 *    read happens at build time and the page stays a CDN-cacheable static route.
 *  · the `hreflang` cluster, which is a property of this URL rather than of the layout — see
 *    `marketing-root.tsx` for why an `alternates` block on the layout would wrongly claim
 *    `/privacy` and `/imprint` as duplicates of the landing.
 */

export const metadata: Metadata = { alternates: marketingAlternates(DEFAULT_LOCALE) };

export default function Page() {
  /* Belt to the layout's braces. next-intl's own guidance is to pin the locale in every layout
     AND page that renders through the request config; the layout above is what actually runs
     first, and this makes the page independent of that ordering. */
  setRequestLocale(DEFAULT_LOCALE);
  return <Landing publicSignup={publicSignupEnabled()} />;
}

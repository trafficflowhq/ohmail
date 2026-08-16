import type { Metadata } from "next";
import { AppShell } from "../../shell/AppShell";

/**
 * THE PUBLIC DEMO, as the REAL client — not a mockup.
 *
 * This route renders the same `AppShell` a signed-in `/` becomes, forced into demo mode, so
 * a stranger clicking around sees the shipped interface (the Ohbox two-pane list, the
 * Screener, the reading pane, the action bar, tags, History) drawn from the FixturesAdapter's
 * fictional mailbox, with zero network. `?demo=1` on `/` boots the identical shell through
 * `CloudShell`; this is that same decision on a STANDALONE, FRAMABLE url the landing can
 * embed in an iframe (`(marketing)/components/DemoSection.tsx`). Its policy lives in
 * `next.config.mjs` — the baseline bundle CSP with `frame-ancestors` relaxed to `'self'`,
 * which is safe here and only here because this surface holds no session and no action to
 * clickjack, while `/` keeps `frame-ancestors 'none'`.
 *
 * `demo` is the ONLY prop. `resolveOwner` and the four Cloud panes (Account, Mailboxes,
 * Billing, Security) are deliberately absent: that absence is what makes the demo inert.
 * `AppShell` withholds every one of them under demo mode, so nothing on this page can add a
 * mailbox, send for real, or write an account setting — the FixturesAdapter serves every
 * mutation locally and reaches no server. A visitor gets the real UI, never a form that tries
 * to touch a backend.
 */
export const metadata: Metadata = {
  title: "ohmail — demo",
  robots: { index: false, follow: false },
};

export default function DemoPage() {
  return <AppShell demo />;
}

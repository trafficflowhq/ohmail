import type { Metadata } from "next";
import { AppShell } from "../../shell/AppShell";

/**
 * The public demo, as the REAL client — not a mockup. This route renders the same `AppShell` a signed-in `/` becomes,
 * forced into demo mode, drawn from the FixturesAdapter's fictional mailbox with zero network — the same decision
 * `?demo=1` boots through `CloudShell`, on a STANDALONE, FRAMABLE url the landing embeds (`DemoSection.tsx`).
 */

/**
 * Its policy lives in `next.config.mjs`: the baseline CSP with `frame-ancestors` relaxed to `'self'`, safe here and
 * only here because this surface holds no session and no action to clickjack, while `/` keeps `frame-ancestors
 * 'none'`. `demo` is the ONLY prop: `resolveOwner` and the four Cloud panes are deliberately absent, and that absence
 * is what makes the demo inert — nothing on this page can add a mailbox, send for real, or write an account setting.
 */
export const metadata: Metadata = {
  title: "ohmail — demo",
  robots: { index: false, follow: false },
};

export default function DemoPage() {
  return <AppShell demo />;
}

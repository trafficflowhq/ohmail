"use client";

import type { ReactNode } from "react";
import { ThemeProvider, ToastHost, themeInitScript } from "@ohmail/ui";
import { columnsBootScript } from "../shell/column-store";

export function Providers({ children, nonce }: { children: ReactNode; nonce?: string }) {
  return (
    <>
      {/* Stamps the persisted theme on <html> before first paint — SSR'd
          at the top of <body>, executed as the HTML parses (contract
          shared with ThemeProvider: absent attribute = follow system).

          `nonce` is the one middleware minted for this request, handed down by
          the layout. Under the strict policy this group is served with
          (`script-src 'self' 'nonce-…'` — see app/security-headers.ts) an inline
          script without it does not run at all, and the page paints in the wrong
          theme until hydration corrects it. */}
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript("ohmail.theme", { faces: true }) }} />
      {/* …and the same contract for the THREE COLUMNS' widths. A separate script rather than a
          fourth axis inside `themeInitScript` because these are not appearance: they are two
          geometry properties this app's own stylesheet reads, and `packages/ui` — which every
          other host mounts — has no business knowing the shell's grid. Same nonce, same
          reason: without the pre-paint stamp the first frame is 224/400 and the second is the
          width somebody chose, which is the layout jump the boot skeleton exists to prevent.
          The desktop window and the served host client re-state this from their own bundles
          (`stampColumns`), exactly as they re-state the theme stamp above. */}
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: columnsBootScript() }} />
      {/* `faces` — the paper/ohmarchy axis is ACTIVE on the product door only: this is the
          host that wired the face controls (Settings → Look, the Option B offer). The
          landing and the admin mount the same provider and deliberately do not pass it. */}
      <ThemeProvider storageKey="ohmail.theme" faces>
        <ToastHost>{children}</ToastHost>
      </ThemeProvider>
    </>
  );
}

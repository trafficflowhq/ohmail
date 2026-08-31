"use client";

import type { ReactNode } from "react";
import { ThemeProvider, ToastHost, themeInitScript } from "@ohmail/ui";

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
      {/* `faces` — the paper/ohmarchy axis is ACTIVE on the product door only: this is the
          host that wired the face controls (Settings → Look, the Option B offer). The
          landing and the admin mount the same provider and deliberately do not pass it. */}
      <ThemeProvider storageKey="ohmail.theme" faces>
        <ToastHost>{children}</ToastHost>
      </ThemeProvider>
    </>
  );
}

"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ThemeProvider, ToastHost, themeInitScript } from "@ohmail/ui";
import { portalRenderer } from "@ohmail/ui/portal-renderer";
import { columnsBootScript } from "@ohmail/app-logic/lists/column-store";
// One door per host, at module scope; its face mirror names the account it was written for.
import { THEME_DOOR } from "../shell/face-mirror";
import { textSizeBootScript } from "../shell/text-size";
import { frameBootScript } from "@ohmail/app/frame/boot";
// Every product page hears a revoke and finishes a wipe a closed page left (`revoked-door.ts`),
// and drops the copy of an account the server says was erased (`erased-door.ts`).
import "../revoked-door";
import "../erased-door";

type AppearanceProps = {
  nonce?: string;
  deferLinuxFace?: boolean;
};

/** Set the saved appearance before the browser can paint the document's canvas. */
export function AppearanceBoot({ nonce, deferLinuxFace }: AppearanceProps) {
  return (
    <>
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript("ohmail.theme", { faces: true, deferLinuxFace }) }} />
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: frameBootScript() }} />
    </>
  );
}

export function Providers({ children, nonce, deferLinuxFace }: AppearanceProps & { children: ReactNode }) {
  return (
    <>
      {/* Restore the column widths and text size before the first server-drawn controls. */}
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: columnsBootScript() }} />
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: textSizeBootScript() }} />
      {/* The face controls live on the product door. The landing and admin leave faces disabled. */}
      <ThemeProvider storageKey="ohmail.theme" faces deferLinuxFace={deferLinuxFace} storage={THEME_DOOR}>
        <portalRenderer.Provider value={createPortal}>
          <ToastHost>{children}</ToastHost>
        </portalRenderer.Provider>
      </ThemeProvider>
    </>
  );
}

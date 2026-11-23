"use client";

import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ConfirmBrowserFaceOwner } from "./confirm-browser-face-owner";
import { setViewTransitions, ThemeProvider, themeInitScript } from "@ohmail/ui";
import { portalRenderer } from "@ohmail/ui/portal-renderer";
import { columnsBootScript } from "@ohmail/app-logic/lists/column-store";
// One door per host, at module scope; its face mirror names the account it was written for.
import { ownerBeforePaint } from "@ohmail/app-logic/storage/owner-cookie";
import { accountThemeDoor, currentFaceOwner, FACE_ACCOUNT_OWNER_KEY } from "../shell/face-mirror";
import { listenBrowserSession } from "../signed-out-signal";
import { textSizeBootScript } from "../shell/text-size";
import { frameBootScript } from "@ohmail/app/frame/boot";
// Every product page hears a revoke and finishes a wipe a closed page left (`revoked-door.ts`),
// and drops the copy of an account the server says was erased (`erased-door.ts`).
import "../revoked-door";
import "../erased-door";

// A document view transition captures pointer input. Fade the theme colors with the controls still live.
if (typeof window !== "undefined") setViewTransitions(false);

type AppearanceProps = {
  nonce?: string;
  deferLinuxFace?: boolean;
  owner?: string | null;
  /** Only set while resuming a remembered session. Null means the request carried no owner cookie. */
  rememberedOwner?: string | null;
};

/** Set the saved appearance before the browser can paint the document's canvas. */
export function AppearanceBoot({ nonce, deferLinuxFace, owner = null, rememberedOwner }: AppearanceProps) {
  const expected = owner ?? rememberedOwner;
  const accountFaceOwner = {
    storageKey: FACE_ACCOUNT_OWNER_KEY,
    read: expected === undefined ? null : ownerBeforePaint(expected),
  };
  return (
    <>
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript("ohmail.theme", { faces: true, deferLinuxFace, accountFaceOwner }) }} />
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: textSizeBootScript() }} />
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: frameBootScript() }} />
    </>
  );
}

export function Providers({ children, nonce, deferLinuxFace, owner = null, rememberedOwner }: AppearanceProps & { children: ReactNode }) {
  const currentOwner = useSyncExternalStore(listenBrowserSession, currentFaceOwner, () => owner);
  const [confirmed, confirm] = useState<string | null>(null);
  const verified = confirmed ?? owner;
  const faceOwner = verified === currentOwner ? verified : null;
  const pendingOwner = verified === null ? rememberedOwner : undefined;
  const appearanceOwner = pendingOwner === null || pendingOwner === currentOwner ? currentOwner : faceOwner;
  const storage = useMemo(() => accountThemeDoor(faceOwner, pendingOwner), [faceOwner, pendingOwner]);
  return (
    <>
      {/* Restore the column widths before the first server-drawn controls. */}
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: columnsBootScript() }} />
      {/* The face controls live on the product door. The landing and admin leave faces disabled. */}
      <ThemeProvider
        storageKey="ohmail.theme"
        faces
        deferLinuxFace={deferLinuxFace}
        preferAccountFace={deferLinuxFace}
        accountFaceScope={faceOwner}
        accountFaceReadScope={appearanceOwner}
        storage={storage}
      >
        <portalRenderer.Provider value={createPortal}>
          <ConfirmBrowserFaceOwner.Provider value={confirm}>
            {children}
          </ConfirmBrowserFaceOwner.Provider>
        </portalRenderer.Provider>
      </ThemeProvider>
    </>
  );
}

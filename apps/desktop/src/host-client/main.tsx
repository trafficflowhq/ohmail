/**
 * ohmail HOST CLIENT — the entry point of the SERVED browser bundle (the third desktop artifact).
 *
 * This is what the desktop's host door serves to the phone that scanned the pairing QR: the same
 * `AppShell` the window and app.ohmail.app render, built by the same vite config under
 * `OHMAIL_HOST_CLIENT=1`, delivered by the engine's static handler over the user's own tailnet.
 * What differs from the window's entry is exactly what a real browser tab needs and a webview
 * does not:
 *
 *  · **NO offline guard, and that is the artifact's defining line.** The window's bundle replaces
 *    `fetch` before anything mounts because its transport is a pipe and its promise is zero
 *    egress — which is precisely why the WINDOW dist can never be the thing the door serves.
 *    This bundle's transport IS `fetch`, to the one origin that served it, and the containment
 *    the guard provides there is provided here by the door's CSP (`connect-src 'self'`) and by
 *    the tailnet boundary the page lives behind.
 *  · **No Tauri bridge, no commands, no updater page** — there is no shell on the other side of
 *    a phone browser. The engine is built in `HostGate` over `HttpAdapter` in bearer mode.
 *  · The theme stamp and the locale provider are the window's own (`DesktopLocale` reads
 *    `localStorage` and needs no server), because a served page has no Next either.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import "../../../webapp/app/app.css";
import { DesktopLocale } from "../DesktopLocale.js";
import { BearerManager } from "./bearer.js";
import { HostGate } from "./HostGate.js";

/* The pre-paint theme stamp — the window entry's exact contract: an explicit preference is
   stamped on <html> before the first render, absent means follow the system. */
try {
  const stored = localStorage.getItem("ohmail.theme");
  if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
} catch {
  /* storage blocked — tokens.css falls back to prefers-color-scheme */
}

const root = document.getElementById("root");
if (!root) throw new Error("ohmail host client: #root is missing from index.html");

/** ONE manager per page — the credential's single owner; the gate and the engine both read it. */
const bearer = new BearerManager();

createRoot(root).render(
  <StrictMode>
    <DesktopLocale>
      <ThemeProvider storageKey="ohmail.theme">
        <ToastHost>
          <HostGate bearer={bearer} />
        </ToastHost>
      </ThemeProvider>
    </DesktopLocale>
  </StrictMode>,
);

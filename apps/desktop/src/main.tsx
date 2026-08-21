/**
 * ohmail Desktop — the entry point of the embedded UI.
 *
 * There is no desktop fork of the interface. The mail client this window renders is the same
 * `AppShell` app.ohmail.app renders; the rail, the Screener, the reader, the ⌘K palette and
 * every view come from `apps/webapp/app/{shell,views}` and `@ohmail/ui`. What is different here
 * is only what a window needs and a browser tab does not: providers wired by hand instead of by
 * Next, the offline guard, and `DesktopGate` around the shell — which asks the native process
 * what the engine is doing and shows the door chooser, an honest notice, or the mail client
 * running against the engine on this machine.
 *
 * There is deliberately NO other mount. The app has two states — not connected (the door
 * chooser) and connected (your mail) — and nothing else to show: no sample mailbox, no demo.
 * The one demo lives on ohmail.app's landing page, where "invented mail, nothing leaves this
 * tab" is the point rather than a lie about somebody's own mailbox. Loaded outside the app (a
 * development server, the render check) there is no shell to ask, and the gate shows the
 * not-connected surface, honestly.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { enableDesktopAttachments } from "../../webapp/app/shell/open-attachment";
import { enableExternalLinks, interceptLinkClicks } from "../../webapp/app/shell/open-external";
import { DesktopLocale } from "./DesktopLocale.js";
import "../../webapp/app/app.css";

import { bridgeAvailable, connectLocalEngine } from "./bridge-fetch.js";
import { DesktopGate } from "./DesktopGate.js";
import { errorSentence, GateBoundary } from "./GateBoundary.js";
import { GateNotice } from "./GateNotice.js";
import { installOfflineGuard } from "./offline-guard.js";

installOfflineGuard();

/* ── THE BOOT CHECK ─────────────────────────────────────────────────────────
   One status call over the shell's command channel. It proves two things at
   once: that this window can reach the shell at all, and that this build
   compiled the real sync client. The engine the MAIL runs on is built by
   `DesktopGate`, once the shell has said which mailbox is being served.

   ── ITS FAILURE REACHES THE SCREEN, AND THAT IS NOT A REFINEMENT ─────────────

   The rejection arm used to be `console.warn`, and a released build spent its
   whole life failing this check on every launch, into a console nobody in a
   packaged app can open, before going white a few seconds later for the same
   reason. The check was right and worth nothing. A boot check whose failure is a
   log line is not a check, so this one draws the same notice the gate draws.

   `waitForBoot` is what lets it: the render below is held for the length of one
   status call, so a failure REPLACES the first paint instead of racing it. The
   cost is bounded and small — the shell answers this over a pipe on the same
   machine — and the alternative is the door chooser appearing and then being
   taken away, which reads as the app changing its mind.

   OUTSIDE the app — a development server, the render check's headless DOM —
   there is no shell to check against; that is not a boot failure, it is the
   environment, and the gate already draws the honest not-connected surface for
   it. So the check simply does not run there, `readShell`'s own rule. */
async function waitForBoot(): Promise<string | null> {
  if (!bridgeAvailable()) return null;
  try {
    const status = await connectLocalEngine();
    console.info(`ohmail: local engine — ${status.state}`);
    return null;
  } catch (err: unknown) {
    console.warn(`ohmail: no local engine — ${String(err)}`);
    return errorSentence(err);
  }
}

/* ── LINKS GO TO THE USER'S OWN BROWSER, AND THIS IS WHERE THAT IS SWITCHED ON ──────────────
   In a tab, `target="_blank"` opens a tab. In this window there is no tab: a `_blank` click is
   a new-window REQUEST, and a webview whose host registered no handler for one answers it with
   no window — silently, correctly, and with no error anywhere. Every link in the app did
   nothing, in a mail body and out of it. `open-external.ts` carries the mechanism and why the
   seam is here; this is the one call that arms it, and the two documents it is armed on are
   this one and each message frame (`MessageBody.tsx`). */
/* AND AN ATTACHMENT OPENS IN THE VIEWER THIS COMPUTER ALREADY HAS, SWITCHED ON HERE FOR THE SAME
   REASONS. In a tab, a hidden `<a download>` saves the file. In this window the webview asks its
   host to perform the download and, finding no handler registered, cancels it — so every
   attachment press did nothing, silently, exactly as every link did. `open-attachment.ts`
   carries the mechanism; the shell writes the bytes under its own directory and opens the path
   with the platform's opener, which is Preview and Quick Look on macOS. Outside the app both
   arms find no shell and refuse per their own contracts. */
enableExternalLinks();
interceptLinkClicks(document, { trustSameOrigin: true });
enableDesktopAttachments();

/* The pre-paint theme stamp. `themeInitScript()` from @ohmail/ui exists for
   server-rendered pages, which inline it as a <script>; the desktop CSP forbids
   inline scripts, so the same contract is executed here from the bundle instead:
   an explicit preference is stamped on <html>, absent means follow the system. */
try {
  const stored = localStorage.getItem("ohmail.theme");
  if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
} catch {
  /* storage blocked — tokens.css falls back to prefers-color-scheme */
}

const root = document.getElementById("root");
if (!root) throw new Error("ohmail Desktop: #root is missing from index.html");

/**
 * PAINT, AND REPAINT IF THE BOOT CHECK COMES BACK BAD.
 *
 * NOT a top-level `await` on the check, and this is a real constraint rather than a style
 * preference: the render check loads this bundle as a CLASSIC script in a headless DOM, where a
 * top-level await is a syntax error that aborts the whole file and draws nothing — the same trap
 * `vite.config.ts` already neutralises `import.meta.url` for. So the window paints immediately,
 * which costs nothing: `DesktopGate`'s first render has no answer from the shell yet and draws one
 * quiet line, and the notice replaces that rather than replacing a chooser somebody had started
 * reading.
 *
 * Repainted only on FAILURE. The success path never calls this twice, so the gate is mounted once
 * and keeps its state.
 */
const reactRoot = createRoot(root);

const paint = (bootFailure: string | null): void =>
  reactRoot.render(
    <StrictMode>
      {/* THE LANGUAGE, wired by hand for the reason every provider here is: there is no Next.
          `DesktopLocale` is this window's `IntlProvider` plus the locale state the shared
          Settings row writes through. `localStorage` is the whole of the persistence — a
          standalone install has no account — and it is read before the first paint, so a
          German window opens in German rather than flipping. */}
      <DesktopLocale>
        <ThemeProvider storageKey="ohmail.theme">
          <ToastHost>
            {/* THE BOUNDARY IS OUTSIDE THE GATE, and it has to be: a component cannot catch its
                own render, and the throw this exists for comes from `DesktopGate` building the
                client engine. `GateBoundary.tsx` has the released build that went white for want
                of it. */}
            <GateBoundary>
              {bootFailure !== null ? (
                <GateNotice
                  reason={bootFailure}
                  actionLabel="Reload"
                  onAction={() => location.reload()}
                />
              ) : (
                <DesktopGate />
              )}
            </GateBoundary>
          </ToastHost>
        </ThemeProvider>
      </DesktopLocale>
    </StrictMode>,
  );

paint(null);
void waitForBoot().then((failure) => {
  if (failure !== null) paint(failure);
});

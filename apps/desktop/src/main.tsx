/**
 * ohmail Desktop — the entry point of the embedded UI. There is no desktop fork of the
 * interface: this window renders the same `AppShell` app.ohmail.app renders, every view from
 * `apps/webapp/app/{shell,views}` and `@ohmail/ui`. Different here is only what a window needs
 * and a browser tab does not: providers wired by hand instead of by Next, the offline guard,
 * and `DesktopGate` around the shell — the door chooser, an honest notice, or the mail client
 * against the engine on this machine. Deliberately NO other mount: two states — not connected
 * and connected — with no sample mailbox and no demo (the one demo lives on ohmail.app's
 * landing page). Loaded outside the app there is no shell to ask; the gate shows not-connected.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { localStorageDoor } from "@ohmail/client-engine/durable";

import { enableDesktopAttachments } from "../../webapp/app/shell/open-attachment";
import { enableExternalLinks, interceptLinkClicks } from "../../webapp/app/shell/open-external";
import { stampColumns } from "../../webapp/app/shell/column-store";
import { setUiVitalsInterval, setUiVitalsSink } from "../../webapp/app/shell/ui-vitals";
import { DesktopLocale } from "./DesktopLocale.js";
import "../../webapp/app/app.css";
// After app.css for the webapp door's reason: the Zero layout ladder (data-layout="zero",
// stamped by this file's boot block below) re-arranges the same shell in this window too.
import "../../webapp/app/zero-layout.css";

import { bridgeAvailable, connectLocalEngine } from "./bridge-fetch.js";
import { omarchySchemeSource, startOmarchyFeed } from "./omarchy.js";
import { startUpdateCadence } from "./update-cadence.js";
import { DesktopGate } from "./DesktopGate.js";
import { DOOR_COPY } from "./door-copy.js";
import { errorSentence, GateBoundary } from "./GateBoundary.js";
import { GateNotice } from "./GateNotice.js";
import { installOfflineGuard } from "./offline-guard.js";
import { reportUiVitals } from "./native.js";

installOfflineGuard();

/* ── THE WINDOW'S OWN VITALS GO INTO `engine.log` ────────────────────────────────────────────
   The shared shell times itself on every door and reports every five minutes; in a browser tab
   the report goes to `console.debug` and no further. This window has somewhere better: the log
   the engine and the shell already write, where a slow install's evidence is all in one file.
   Armed HERE, before the first render, so the very first report has somewhere to go — and
   outside the app `reportUiVitals` finds no shell and does nothing. The shell ANSWERS with the
   cadence it wants, which is how a measurement run shorter than five minutes gets a report at
   all; with no knob set it answers the same five minutes and nothing re-arms. */
setUiVitalsSink((report) => {
  void reportUiVitals(report).then(setUiVitalsInterval);
});

/* ── THE BOOT CHECK: one status call over the shell's command channel, proving the shell is
   reachable and this build compiled the real sync client (the MAIL engine is `DesktopGate`'s).
   Its failure reaches the SCREEN: the rejection arm used to be `console.warn`, and a released
   build failed this check on every launch into a console nobody in a packaged app can open — a
   boot check whose failure is a log line is not a check, so this one draws the gate's notice.
   `waitForBoot` holds the render for one status call, so a failure REPLACES the first paint
   instead of racing it. Outside the app (dev server, the render check's headless DOM) there is
   no shell — that is environment, not boot failure; the check does not run there (`readShell`). */
/* THE THROWN VALUE, not a sentence — and the difference is a language, not a style.
   `errorSentence` and the notice's button both read the message catalogue, and the catalogue is
   set by `DesktopLocale` DURING ITS RENDER. This function resolves off a promise chain that is
   not ordered against React's first flush, so composing the words here would read the register
   before the provider had filled it and put an English "Reload" in a German window. The words
   are composed inside {@link BootFailure}, which is a child of the provider by construction. */
async function waitForBoot(): Promise<unknown> {
  if (!bridgeAvailable()) return null;
  try {
    const status = await connectLocalEngine();
    console.info(`ohmail: local engine — ${status.state}`);
    return null;
  } catch (err: unknown) {
    console.warn(`ohmail: no local engine — ${String(err)}`);
    /* Never `null`: that is this function's word for "the boot was fine", and a throw with a
       falsy value is still a failed boot. */
    return err ?? new Error("");
  }
}

/** The boot check's failure, worded where the catalogue is reachable. See {@link waitForBoot}. */
function BootFailure({ error }: { error: unknown }) {
  return (
    <GateNotice
      reason={errorSentence(error)}
      actionLabel={DOOR_COPY.reload}
      onAction={() => location.reload()}
    />
  );
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

/* THE OMARCHY THEME FEED, armed here for the same reason the two arms above are: it is a
   capability of the WINDOW, not of any one view. On an Omarchy desktop the shell answers the
   active theme's raw material and pushes a fresh set whenever `omarchy theme set` completes;
   `omarchy.ts` maps it and holds the tokens where the ohmarchy face wears them. Everywhere
   else — and outside the app — the start is one refused ask and silence. Not awaited: the
   theme feed must never hold the first paint, and its failure mode is "static defaults",
   which is not a failure a person should wait on. */
void startOmarchyFeed();

/* THE APP'S OWN UPDATE, ON A CLOCK. The native process checks the signed release feed shortly
   after this window opens and whenever somebody asks it to; nothing asked again while the window
   stayed open, and a mail client is the archetype of a window nobody closes. This arms the daily
   re-ask — wall-clock, so a suspended laptop does not postpone it — and it is a capability of the
   WINDOW, like the three arms above, not of any view. It presses the same button a person
   presses and can install nothing; `update-cadence.ts` carries the whole reasoning. The teardown
   it hands back is dropped deliberately: this window's life IS the cadence's life. */
startUpdateCadence();

/* THE PRE-PAINT STAMP IS NOT HERE ANY MORE. This file is loaded as a MODULE script, and module
   scripts are DEFERRED — the theme, face and cached-palette stamps ran after the document had
   parsed, so the first frame was the app's own default face rather than the person's (measured
   on the Omarchy guest: 278 ms of the paper canvas before the ohmarchy one). They live in
   `boot-stamp.ts`, which the document head loads as a blocking script ahead of this bundle.
   What stays here is everything that cannot be paint-blocking: the columns stamp reaches React
   through `persisted-ui.ts`, and a framework in the head would cost every launch more than the
   reflow it saves. */
/* THE THREE COLUMNS' widths, from the device's own store. This window's localStorage is the
   app's own data directory, which is where the face pin the boot stamp reads already survives a
   relaunch — so a rail somebody widened is the width the next launch opens at, without a round
   trip to the sidecar (window chrome is not a mailbox fact). Before `createRoot`. */
stampColumns();

/**
 * THE THEME'S WRITE DOOR — one per window, at module scope so it is not rebuilt per frame.
 *
 * `packages/ui` declares the shape and implements none of it, so the provider that stamps
 * `<html data-theme>` reports a refused write through the SAME window event the shared shell's
 * notice already listens for.
 */
const THEME_DOOR = localStorageDoor("theme");

const root = document.getElementById("root");
if (!root) throw new Error("ohmail Desktop: #root is missing from index.html");

/**
 * PAINT, AND REPAINT IF THE BOOT CHECK COMES BACK BAD. NOT a top-level `await` on the check —
 * the render check loads this bundle as a CLASSIC script in a headless DOM, where a top-level
 * await is a syntax error that aborts the whole file and draws nothing (the same trap
 * `vite.config.ts` neutralises `import.meta.url` for). The window paints immediately, which
 * costs nothing: `DesktopGate`'s first render draws one quiet line before the shell answers,
 * and the notice replaces that rather than a chooser somebody had started reading. Repainted
 * only on FAILURE — the success path never calls this twice, so the gate mounts once and
 * keeps its state.
 */
const reactRoot = createRoot(root);

const paint = (bootFailure: unknown): void =>
  reactRoot.render(
    <StrictMode>
      {/* THE LANGUAGE, wired by hand for the reason every provider here is: there is no Next.
          `DesktopLocale` is this window's `IntlProvider` plus the locale state the shared
          Settings row writes through. `localStorage` is the whole of the persistence — a
          standalone install has no account — and it is read before the first paint, so a
          German window opens in German rather than flipping. */}
      <DesktopLocale>
        {/* `systemScheme`: on Omarchy "the system" is the ACTIVE DESKTOP THEME's mode, which
            `prefers-color-scheme` learns only through the GTK portal. The feed answers it; off
            Omarchy the source says null and the media query answers, exactly as before. */}
        <ThemeProvider
          storageKey="ohmail.theme"
          faces
          storage={THEME_DOOR}
          systemScheme={omarchySchemeSource}
        >
          <ToastHost>
            {/* THE BOUNDARY IS OUTSIDE THE GATE, and it has to be: a component cannot catch its
                own render, and the throw this exists for comes from `DesktopGate` building the
                client engine. `GateBoundary.tsx` has the released build that went white for want
                of it. */}
            <GateBoundary>
              {bootFailure !== null ? (
                <BootFailure error={bootFailure} />
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

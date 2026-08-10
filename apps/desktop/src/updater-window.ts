/**
 * THE AUTO-UPDATER'S PROGRESS WINDOW — a tiny static page, and deliberately NOT the main webview.
 *
 * ── WHY A SEPARATE PAGE AND A SEPARATE WINDOW ──────────────────────────────────────────────
 *
 * The updater is Rust-side (`src-tauri/src/updater.rs`) precisely so the main window can stay
 * granted NOTHING — `capabilities/main.json` is `"permissions": []` and stays that way. But a
 * download with no visible progress reads as a hang, so the Rust side emits an
 * `updater://progress` event carrying `{ downloaded, total }` and this page renders it.
 *
 * Rendering it in the MAIN window would mean granting that window `core:event:allow-listen`, which
 * breaks the empty-grant lock. So the progress lives in its OWN window (label `updater`), and that
 * window's OWN capability file (`capabilities/updater.json`) grants it exactly one permission — to
 * LISTEN for the one event above, and nothing else: no command, no emit-back, no filesystem, and
 * no network (the app-wide CSP is `connect-src 'none'`, which this window inherits). The main
 * window's grant is untouched.
 *
 * ── WHY THIS IS EMITTED INTO THE BUNDLE RATHER THAN LEFT AS A STATIC FILE ───────────────────
 *
 * The two strings below are emitted into `dist/` as `updater.html` and `updater.js` by a plugin in
 * `vite.config.ts`. They cannot live under a `public/` folder: the publish payload
 * (`scripts/publish-desktop.mjs`) ships `apps/desktop/src` as `.ts` only, so a static `.html`/`.js`
 * asset would never reach the mirror that builds every released binary — and the updater window
 * would open blank on a downloaded build. Kept as a published `.ts` module, they reach the mirror
 * and are exercised by `test/updater-window.test.ts` as the REAL artifact rather than a copy.
 *
 * ── HOW THE PAGE HEARS THE EVENT WITHOUT `@tauri-apps/api` ──────────────────────────────────
 *
 * The same seam `src/native.ts` uses: `window.__TAURI_INTERNALS__` is defined by the runtime's own
 * bootstrap before any script runs, regardless of `withGlobalTauri` (which is false). Listening is
 * one `invoke("plugin:event|listen", …)`, which the `core:event:allow-listen` grant permits;
 * emitting is neither granted nor attempted.
 */

/** The event the Rust updater emits, and the label of the window that hears it. */
export const PROGRESS_EVENT = "updater://progress";
export const PROGRESS_WINDOW_LABEL = "updater";

/**
 * The progress window's page. Self-contained: inline styles (the CSP allows `style-src
 * 'unsafe-inline'`), and its one script loaded from a same-origin file (`script-src 'self'` refuses
 * an inline `<script>`). No remote anything, no favicon fetch, no network.
 *
 * The `<meta>` CSP is belt-and-braces to the header the Tauri webview actually serves — the same
 * arrangement `index.html` documents — minus `frame-ancestors`, which a `<meta>` element is
 * specified to ignore.
 */
export const UPDATER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'" />
    <title>Updating ohmail</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #ffffff;
        --fg: #1a1a1a;
        --muted: #6b6b6b;
        --track: #ececec;
        --fill: #1a1a1a;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #17181a;
          --fg: #f2f2f2;
          --muted: #9a9a9a;
          --track: #2a2c2f;
          --fill: #f2f2f2;
        }
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; }
      body {
        background: var(--bg);
        color: var(--fg);
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        -webkit-user-select: none;
        user-select: none;
      }
      .up { width: 100%; max-width: 360px; padding: 0 28px; }
      .up-title { margin: 0 0 4px; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
      .up-status { margin: 0 0 16px; color: var(--muted); }
      .up-track {
        height: 6px;
        border-radius: 999px;
        background: var(--track);
        overflow: hidden;
      }
      .up-fill {
        height: 100%;
        width: 0%;
        border-radius: 999px;
        background: var(--fill);
        transition: width 160ms ease-out;
      }
      /* Unknown total: a slow indeterminate sweep rather than a bar frozen at zero. */
      .up-track.is-indeterminate .up-fill {
        width: 40%;
        animation: sweep 1.15s ease-in-out infinite;
      }
      @keyframes sweep {
        0% { margin-left: -40%; }
        100% { margin-left: 100%; }
      }
      @media (prefers-reduced-motion: reduce) {
        .up-fill { transition: none; }
        .up-track.is-indeterminate .up-fill { animation: none; margin-left: 30%; }
      }
      .up-pct { margin: 10px 0 0; color: var(--muted); font-variant-numeric: tabular-nums; min-height: 1.4em; }
    </style>
  </head>
  <body>
    <main class="up">
      <h1 class="up-title">Updating ohmail</h1>
      <p class="up-status" id="status">Preparing the download…</p>
      <div class="up-track is-indeterminate" id="track" role="progressbar" aria-label="Update download progress" aria-valuemin="0" aria-valuemax="100">
        <div class="up-fill" id="fill"></div>
      </div>
      <p class="up-pct" id="pct"></p>
    </main>
    <script src="./updater.js"></script>
  </body>
</html>
`;

/**
 * The page's one script, loaded as a same-origin classic script.
 *
 * It listens for `updater://progress` and renders it. `render` is tolerant BY CONSTRUCTION: a
 * payload that is missing, malformed, or throws while being read leaves the window in a sane state
 * rather than tearing the script down — there is no error surface in a transient window, so an
 * unhandled throw would just freeze the bar. `test/updater-window.test.ts` drives this exact string
 * with a valid payload, an absent one, a garbage one and one whose getter throws, and asserts none
 * of them throws.
 *
 * No `fetch`, no `WebSocket`, no `EventSource`, no `XMLHttpRequest`, no URL of any kind — the only
 * thing it reaches is the runtime's own event plugin, receive-only.
 */
export const UPDATER_JS = `(function () {
  "use strict";
  var internals = window.__TAURI_INTERNALS__;
  var fill = document.getElementById("fill");
  var pct = document.getElementById("pct");
  var status = document.getElementById("status");
  var track = document.getElementById("track");

  function humanBytes(n) {
    if (typeof n !== "number" || !isFinite(n) || n <= 0) return "";
    var units = ["B", "KB", "MB", "GB"];
    var i = 0;
    var v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? String(v) : v.toFixed(1)) + " " + units[i];
  }

  function render(event) {
    var downloaded = 0;
    var total = null;
    try {
      var payload = event && typeof event === "object" && "payload" in event ? event.payload : event;
      if (payload && typeof payload === "object") {
        if (typeof payload.downloaded === "number" && isFinite(payload.downloaded)) {
          downloaded = payload.downloaded;
        }
        if (typeof payload.total === "number" && isFinite(payload.total) && payload.total > 0) {
          total = payload.total;
        }
      }
    } catch (_e) {
      // A payload whose reading throws is not a reason to freeze — leave the indeterminate bar.
      return;
    }
    if (!fill || !pct || !status || !track) return;
    if (total !== null) {
      var percent = Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
      track.classList.remove("is-indeterminate");
      fill.style.width = percent + "%";
      track.setAttribute("aria-valuenow", String(percent));
      pct.textContent = percent + "%";
      status.textContent = percent >= 100 ? "Verifying the update…" : "Downloading the update…";
    } else {
      track.classList.add("is-indeterminate");
      track.removeAttribute("aria-valuenow");
      pct.textContent = humanBytes(downloaded);
      status.textContent = "Downloading the update…";
    }
  }

  if (!internals || typeof internals.invoke !== "function" || typeof internals.transformCallback !== "function") {
    // Opened outside the app (a dev server, a test without the shell): nothing to listen to.
    return;
  }

  var handler = internals.transformCallback(render);
  var listening = internals.invoke("plugin:event|listen", {
    event: "${PROGRESS_EVENT}",
    target: { kind: "Any" },
    handler: handler,
  });
  if (listening && typeof listening.catch === "function") {
    // A build that did not grant this window the listen permission: leave the indeterminate bar
    // rather than surface an error the user cannot act on. The install still proceeds.
    listening.catch(function () {});
  }
})();
`;

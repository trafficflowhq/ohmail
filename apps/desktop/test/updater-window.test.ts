/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROGRESS_EVENT,
  PROGRESS_WINDOW_LABEL,
  UPDATER_HTML,
  UPDATER_JS,
} from "../src/updater-window";

/**
 * THE AUTO-UPDATER'S PROGRESS WINDOW — the REAL emitted page, driven.
 *
 * These two strings are emitted verbatim into the bundle as `updater.html` / `updater.js`
 * (`vite.config.ts`), so this drives the exact bytes a released binary carries rather than a copy.
 * The window is opened by `src/updater.rs` while an update downloads and hears one event —
 * `updater://progress` — over the runtime's event plugin, granted `core:event:allow-listen` by
 * `capabilities/updater.json` and nothing else.
 *
 * The one behaviour worth proving is TOLERANCE. A transient window has no error surface: an
 * unhandled throw would just freeze the bar mid-download. So `render` is driven with a valid
 * payload, an absent one, a garbage one, and one whose fields throw while being read — and none of
 * them may throw or leave the window in a broken state.
 */

interface Internals {
  transformCallback(cb: (payload: unknown) => void, once?: boolean): number;
  invoke(command: string, payload?: Record<string, unknown>): Promise<unknown>;
}

/** Install the page's DOM (from the real HTML) and a stubbed shell, then run the page's script. */
function loadPage(internals: Internals | null): {
  captured: ((payload: unknown) => void) | null;
  invoked: { command: string; payload?: Record<string, unknown> }[];
} {
  const bodyInner = /<body[^>]*>([\s\S]*)<\/body>/.exec(UPDATER_HTML)?.[1] ?? "";
  // innerHTML never executes a <script>, so the page's own script tag is inert here; we run
  // UPDATER_JS by hand below, which is the point.
  document.body.innerHTML = bodyInner;

  const invoked: { command: string; payload?: Record<string, unknown> }[] = [];
  let captured: ((payload: unknown) => void) | null = null;

  const win = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (internals) {
    win.__TAURI_INTERNALS__ = {
      transformCallback(cb: (payload: unknown) => void) {
        captured = cb;
        return internals.transformCallback(cb);
      },
      invoke(command: string, payload?: Record<string, unknown>) {
        invoked.push({ command, payload });
        return internals.invoke(command, payload);
      },
    };
  } else {
    delete win.__TAURI_INTERNALS__;
  }

  // Run in the window scope so `window`/`document` resolve to the jsdom globals the script reads.
  window.eval(UPDATER_JS);
  return { captured, invoked };
}

const okInternals = (): Internals => ({
  transformCallback: () => 1,
  invoke: () => Promise.resolve(null),
});

describe("the updater progress page — structure", () => {
  it("names the same event and window label the Rust side does", () => {
    expect(PROGRESS_EVENT).toBe("updater://progress");
    expect(PROGRESS_WINDOW_LABEL).toBe("updater");
    const updaterRs = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/updater.rs"),
      "utf8",
    );
    expect(updaterRs).toContain(`PROGRESS_EVENT: &str = "${PROGRESS_EVENT}"`);
    expect(updaterRs).toContain(`PROGRESS_WINDOW_LABEL: &str = "${PROGRESS_WINDOW_LABEL}"`);
  });

  it("reaches nothing: no network API, no URL, one same-origin script, connect-src none", () => {
    expect(UPDATER_JS).not.toMatch(/\bfetch\s*\(|new WebSocket|new EventSource|XMLHttpRequest|sendBeacon/);
    expect(UPDATER_JS).not.toMatch(/https?:\/\//);
    expect(UPDATER_HTML).not.toMatch(/https?:\/\//);
    // Listens, never emits — the asymmetry the capability grant enforces.
    expect(UPDATER_JS).toContain("plugin:event|listen");
    expect(UPDATER_JS).not.toContain("plugin:event|emit");
    // The script is external and same-origin; `script-src 'self'` refuses an inline one.
    expect(UPDATER_HTML).toMatch(/<script src="\.\/updater\.js">/);
    expect(UPDATER_HTML).not.toMatch(/<script>[\s\S]/);
    expect(UPDATER_HTML).toContain("connect-src 'none'");
  });
});

describe("the updater progress page — behaviour", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("listens for the progress event over the runtime's event plugin", () => {
    const { captured, invoked } = loadPage(okInternals());
    expect(captured, "the page registered no listener").not.toBeNull();
    const listen = invoked.find((i) => i.command === "plugin:event|listen");
    expect(listen, "the page did not call plugin:event|listen").toBeTruthy();
    expect(listen!.payload?.event).toBe("updater://progress");
    expect(listen!.payload?.target).toEqual({ kind: "Any" });
  });

  it("renders a known total as a percentage and a filled bar", () => {
    const { captured } = loadPage(okInternals());
    captured!({ payload: { downloaded: 50, total: 100 } });
    const fill = document.getElementById("fill")!;
    const track = document.getElementById("track")!;
    expect((fill as HTMLElement).style.width).toBe("50%");
    expect(document.getElementById("pct")!.textContent).toBe("50%");
    expect(track.classList.contains("is-indeterminate")).toBe(false);
    expect(track.getAttribute("aria-valuenow")).toBe("50");
    expect(document.getElementById("status")!.textContent).toBe("Downloading the update…");

    // At 100% the copy turns to verifying — the minisign check runs after the last byte.
    captured!({ payload: { downloaded: 100, total: 100 } });
    expect(document.getElementById("status")!.textContent).toBe("Verifying the update…");
  });

  it("renders an unknown total as an indeterminate bar with the byte count", () => {
    const { captured } = loadPage(okInternals());
    captured!({ payload: { downloaded: 1024, total: null } });
    const track = document.getElementById("track")!;
    expect(track.classList.contains("is-indeterminate")).toBe(true);
    expect(track.getAttribute("aria-valuenow")).toBeNull();
    expect(document.getElementById("pct")!.textContent).toBe("1.0 KB");
  });

  it("survives an absent, a garbage, and a throwing payload without tearing down", () => {
    const { captured } = loadPage(okInternals());
    // Absent.
    expect(() => captured!(undefined)).not.toThrow();
    expect(document.getElementById("track")!.classList.contains("is-indeterminate")).toBe(true);
    // Garbage of several shapes.
    expect(() => captured!("nonsense")).not.toThrow();
    expect(() => captured!(42)).not.toThrow();
    expect(() => captured!({ payload: null })).not.toThrow();
    expect(() => captured!({ payload: { downloaded: "lots", total: "all" } })).not.toThrow();
    // A payload whose field THROWS while being read — the nastiest shape, and the one the
    // try/catch exists for.
    const evil: Record<string, unknown> = {};
    Object.defineProperty(evil, "downloaded", {
      get() {
        throw new Error("boom");
      },
    });
    expect(() => captured!({ payload: evil })).not.toThrow();
  });

  it("does nothing, and does not throw, when opened without the shell", () => {
    const { captured, invoked } = loadPage(null);
    expect(captured).toBeNull();
    expect(invoked).toHaveLength(0);
  });

  it("swallows a refused listen rather than surfacing an error the user cannot act on", () => {
    const refusing: Internals = {
      transformCallback: () => 1,
      invoke: () => Promise.reject(new Error("event.listen not allowed")),
    };
    expect(() => loadPage(refusing)).not.toThrow();
  });
});

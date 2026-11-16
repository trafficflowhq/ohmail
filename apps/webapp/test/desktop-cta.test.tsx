/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * "GET OHMAIL FOR DESKTOP" — SHOWN IN THE SIGNED-IN BROWSER, NEVER IN THE DESKTOP APP ITSELF.
 *
 * The prompt invites a browser reader to install the desktop app, so it must not appear inside
 * that app. The shell's own platform tell is the injected `desktopSection` — the pane only a
 * native process can have — so its presence IS "this build is the desktop app". `showDesktopCta`
 * is that branch, made a pure value a test can drive; the demo is excluded because it is a shop
 * window, not an account.
 *
 * MUTATION WATCH: drop the `!opts.desktop` term and the desktop case goes red; drop `!opts.demo`
 * and the demo case does. Point the link away from the download section, or take the dismiss out,
 * and the component cases go red.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

beforeEach(() => { try { localStorage.clear(); } catch { /* no store */ } });
afterEach(async () => { await unmount(); vi.restoreAllMocks(); });

describe("the platform branch — where the prompt may appear", () => {
  it("shows only in the signed-in browser (not the desktop app, not the demo)", async () => {
    const { showDesktopCta } = await import("../app/shell/AppShell.js");
    expect(showDesktopCta({ demo: false, desktop: false }), "the signed-in browser must offer it").toBe(true);
    expect(showDesktopCta({ demo: false, desktop: true }), "the desktop app must NOT offer it").toBe(false);
    expect(showDesktopCta({ demo: true, desktop: false }), "the demo must NOT offer it").toBe(false);
  });
});

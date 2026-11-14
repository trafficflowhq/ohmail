/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * the offline word. "As of {time} · catching up" is an ACTIVITY claim, and over a dead
 * network nothing is catching up: the strip said something false for exactly the period a person
 * was trying to understand. When the state is a fetch-shaped claim (`stale`, `catchingUp`,
 * `failing`) AND the browser itself says offline (`navigator.onLine === false` — the one
 * trustworthy reading), the strip says the true thing instead: the mirror is usable offline and
 * what is on screen is what this device holds. Both conditions are driven together and each
 * alone, because either alone must change nothing: a failing server is not "offline", and an
 * offline browser over settled content has nothing to correct.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const STALE_STAMP = new Date(NOW - 3 * 24 * 60 * 60_000).toISOString();

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null,
  asOf: null, address: null, minutes: null, slow: false, screenerCandidate: false,
  pending: 0, filing: null, continuesAtFolder: null, settled: true, owed: false,
};

let current: MailState = QUIET;
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: current, refresh: () => {} }),
}));

const OFFLINE_SENTENCE = "Offline — showing what this device holds.";

/** Drive the browser's own reading. jsdom's default is `true`. */
function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
}

const roots: Root[] = [];
afterEach(() => {
  roots.forEach((r) => r.unmount());
  roots.length = 0;
  document.body.innerHTML = "";
  setOnline(true);
});

async function render(state: MailState): Promise<HTMLElement> {
  current = state;
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date(NOW),
        children: h(SyncBar, null),
      }),
    );
  });
  return container;
}

const STALE: MailState = { ...QUIET, key: "stale", clock: true, count: 495, asOf: STALE_STAMP };

describe("the offline word", () => {
  it("offline + stale — the false activity claim yields to the true one, calmly and standing still", async () => {
    setOnline(false);
    const c = await render(STALE);
    expect(c.textContent).toContain(OFFLINE_SENTENCE);
    expect(c.textContent).not.toContain("catching up");
    expect(c.querySelector(".mbx-spin"), "nothing is running — no spinner").toBeNull();
    expect(c.querySelector('[role="status"]'), "a status region, never an alert").not.toBeNull();
    expect(c.querySelector('[role="alert"]')).toBeNull();
  });

  it("offline + failing — a retry that cannot run says offline, not 'Retrying'", async () => {
    setOnline(false);
    const c = await render({ ...QUIET, key: "failing" });
    expect(c.textContent).toContain(OFFLINE_SENTENCE);
    expect(c.textContent).not.toContain("Retrying");
  });

  it("online + stale — the fetch-failure condition alone changes nothing", async () => {
    setOnline(true);
    const c = await render(STALE);
    expect(c.textContent).toContain("catching up");
    expect(c.textContent).not.toContain(OFFLINE_SENTENCE);
  });

  it("offline + settled — the offline condition alone changes nothing: the strip stays silent", async () => {
    setOnline(false);
    const c = await render(QUIET);
    expect(c.textContent ?? "").toBe("");
  });

  it("offline + stopped — a sentence about the server outranks the network's", async () => {
    setOnline(false);
    const c = await render({ ...QUIET, key: "stopped" });
    expect(c.textContent).not.toContain(OFFLINE_SENTENCE);
    expect(c.textContent).toContain("no longer authorized");
  });

  it("follows the browser's events — the sentence arrives when the network goes, and leaves with it", async () => {
    setOnline(true);
    const c = await render(STALE);
    expect(c.textContent).toContain("catching up");

    setOnline(false);
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    expect(c.textContent).toContain(OFFLINE_SENTENCE);

    setOnline(true);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(c.textContent).toContain("catching up");
    expect(c.textContent).not.toContain(OFFLINE_SENTENCE);
  });

  it("both catalogues carry the sentence", () => {
    expect((messages as { sync: Record<string, string> }).sync.offline).toBe(OFFLINE_SENTENCE);
    expect((de as { sync: Record<string, string> }).sync.offline).toBe(
      "Offline — gezeigt wird, was auf diesem Gerät liegt.",
    );
  });
});

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JunkWire } from "@ohmail/app-logic/screener/junk-window";
import { capturePairedFrame, mountLiveWindows } from "../../../test/paired-host/paired-frame-capture.js";

/**
 * ═══ THE PAIRED PHONE'S TWO LIVE WINDOWS — the wires the host door was not handing in ════════
 *
 * ── WHAT WAS BROKEN ─────────────────────────────────────────────────────────────────────────
 *
 * `HostGate` mounts the SAME shell the desktop window mounts, and this artifact aliases
 * `app/api-client` to a refusing stub exactly as the window's does — so both live windows (the
 * Screener's Junk segment and the Trash view's second section) decide `supported` from a wire
 * that is not there and report "no server". The gate handed in `olderBodyWire` and nothing else,
 * so on a paired phone or host client both sections were absent with no state naming why, while
 * `desktopHostRoutes` spreads `localRoutes` and serves all four reads one hop away.
 *
 * ── WHY IT IS ONE FIX AND NOT TWO ───────────────────────────────────────────────────────────
 *
 * The two windows are one absence with one cause: neither folder is ever mirrored, so neither can
 * be answered locally, and both hooks read the same refusing stub. Wiring one would leave the
 * other silently missing on the same door for the same reason, so the pair is asserted as a pair.
 *
 * ── WHAT IS MEASURED HERE ───────────────────────────────────────────────────────────────────
 *
 * The composition, driven: `HostGate` renders with a bearer whose transport RECORDS, and the
 * wires it hands the shell are taken from the render and used. Everything above the seam — the
 * states, the session body caches, the rescue verbs — is the shared shell's and is measured in
 * `apps/webapp/test`. What only this file can get wrong is which wires reach the shell and what
 * leaves the page when they are used.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

let platformFetchCalls = 0;
beforeEach(() => {
  platformFetchCalls = 0;
  vi.stubGlobal("fetch", async () => {
    platformFetchCalls += 1;
    throw new Error("the page opened a socket of its own");
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

/* The paired-device route table and transport source checks live in host-client-live-windows-routes.test.ts. */

describe("what the wires DO to the two windows, through the shared hooks", () => {
  it("uses both windows handed to the mail frame through the paired bearer", async () => {
    const requests = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).includes("/body")
      ? Response.json({ subject: "Letter", text: "One body" })
      : Response.json({ mailboxes: [], items: [], nextCursor: null }));
    const host = await capturePairedFrame(requests);
    expect(host.wires.junk).not.toBe("none");
    expect(host.wires.trash).not.toBe("none");
    const junk = host.wires.junk as JunkWire;
    const trash = host.wires.trash as Exclude<typeof host.wires.trash, "none">;
    await expect(junk.list()).resolves.toMatchObject({ items: [] });
    await expect(trash.list()).resolves.toMatchObject({ items: [] });
    const letter = { subject: "Letter", text: "One body" };
    await expect(junk.body("mb-1", 1, "2")).resolves.toEqual(letter);
    await expect(trash.body("mb-1", 1, "2")).resolves.toEqual(letter);
    const relevant = requests.mock.calls
      .map(([input, init]) => [new URL(String(input), "http://localhost").pathname, init?.method ?? "GET"])
      .filter(([pathname]) => pathname?.startsWith("/screener/junk") || pathname?.startsWith("/trash/window"));
    expect(relevant).toEqual([
      ["/screener/junk", "GET"], ["/trash/window", "GET"],
      ["/screener/junk/body", "GET"], ["/trash/window/body", "GET"],
    ]);
    const supported = await mountLiveWindows(junk, trash);
    expect(supported.junk.supported).toBe(true);
    expect(supported.trash.supported).toBe(true);
  });

  it("THE DEFECT: with no wires handed in, this build supports neither window and asks nothing", async () => {
    const got = await mountLiveWindows();

    // The state before this lane: the Cloud client is the refusing stub, so both hooks answer
    // "no server" and `AppShell` passes neither control to its view. Nothing on screen says why.
    expect(got.junk.supported).toBe(false);
    expect(got.trash.supported).toBe(false);
    expect(platformFetchCalls, "a wireless build asked something anyway").toBe(0);
  });

});

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";

import messages from "../../webapp/messages/en.json";
import type { JunkWire } from "../../webapp/app/shell/junk-window";
import type { TrashWire } from "../../webapp/app/shell/trash-window";
import { NONE } from "@ohmail/app/host";
import { capturePairedFrame } from "./paired-frame-capture.js";

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

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

/**
 * THE CLOUD CLIENT AS THIS ARTIFACT HAS IT — refusing, because `vite.config.ts` aliases it to
 * `no-api-client.ts` in the host-client bundle too. Without this the no-wire arm below would
 * measure a browser's client that this build does not carry.
 */
vi.mock("../../webapp/app/api-client", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/api-client")>(
    "../../webapp/app/api-client",
  );
  const refuse = (): never => {
    throw new Error("the ohmail Cloud API is not part of this build");
  };
  return {
    ...real,
    apiConfigured: () => false,
    trashWindow: { list: refuse, body: refuse },
    screener: { junkList: refuse, junkBody: refuse },
  };
});

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
  /** Both real hooks, active, over whatever wires are handed in. */
  async function mountHooks(junk?: JunkWire, trash?: TrashWire): Promise<{
    junk: { supported: boolean }; trash: { supported: boolean };
  }> {
    const { useJunkWindow } = await import("../../webapp/app/shell/junk-window");
    const { useTrashWindow } = await import("../../webapp/app/shell/trash-window");
    const out: { junk?: { supported: boolean }; trash?: { supported: boolean } } = {};
    function Probe(): null {
      /* No wire handed in is the host saying it has none: the Junk window takes its wire or `none`, never a default. */
      out.junk = useJunkWindow(true, (() => undefined) as never, junk ?? "none", useTranslations("screener") as never);
      out.trash = useTrashWindow(true, trash);
      return null;
    }
    const el = document.createElement("div");
    document.body.append(el);
    const r = createRoot(el);
    await act(async () => {
      r.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", children: h(Probe),
      }));
    });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    await act(async () => r.unmount());
    el.remove();
    return { junk: out.junk!, trash: out.trash! };
  }

  it("uses both windows handed to the mail frame through the paired bearer", async () => {
    const requests = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).includes("/body")
      ? Response.json({ subject: "Letter", text: "One body" })
      : Response.json({ mailboxes: [], items: [], nextCursor: null }));
    const host = await capturePairedFrame(requests);
    expect(host.wires.junk).not.toBe(NONE);
    expect(host.wires.trash).not.toBe(NONE);
    const junk = host.wires.junk as JunkWire;
    const trash = host.wires.trash as TrashWire;
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
    const supported = await mountHooks(junk, trash);
    expect(supported.junk.supported).toBe(true);
    expect(supported.trash.supported).toBe(true);
  });

  it("THE DEFECT: with no wires handed in, this build supports neither window and asks nothing", async () => {
    const got = await mountHooks(undefined, undefined);

    // The state before this lane: the Cloud client is the refusing stub, so both hooks answer
    // "no server" and `AppShell` passes neither control to its view. Nothing on screen says why.
    expect(got.junk.supported).toBe(false);
    expect(got.trash.supported).toBe(false);
    expect(platformFetchCalls, "a wireless build asked something anyway").toBe(0);
  });

});

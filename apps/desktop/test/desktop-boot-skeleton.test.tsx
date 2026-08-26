/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import { BOOT_SKELETON_GRACE_MS } from "../../webapp/app/shell/BootSkeleton";
import { DesktopGate } from "../src/DesktopGate.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { mailMount } from "../src/doors.js";

/**
 * ═══ THE LONG FIRST LAUNCH GETS A SHAPE. THE ORDINARY ONE STILL GETS NOTHING. ═════════════
 *
 * There is one launch this app can spend a long time in and it is not the common one. An
 * install whose previous run left a large write-ahead log replays it inside the engine's
 * database open, before anything can serve — measured at roughly a hundred seconds on a
 * directory that had grown to tens of gigabytes. That launch heals the install and every launch
 * after it is sub-second, but somebody is sitting in front of it once, and until now the whole
 * of it was one centred sentence over an empty window.
 *
 * ── THE GRACE IS WHAT MAKES THIS SAFE, AND IT IS THE WHOLE ARGUMENT ─────────────────────
 *
 * The measurement that says "draw a silhouette for the long recovery" is the same measurement
 * that says "never draw one for the ordinary launch": an engine opening an established mirror
 * answers in well under a second, and a skeleton that appears and vanishes inside that window is
 * a strobe, not information. So the bars are delayed behind `loading-grace.ts`'s idiom and both
 * sides of that boundary are asserted here. A guard that only proved they eventually appear
 * would pass just as happily for the version that flashes on every healthy boot.
 *
 * ── AND `mailMount` IS STILL THE ONLY THING THAT ROUTES ─────────────────────────────────
 *
 * The silhouette is drawn INSIDE a branch that decision already chose. It decides nothing, and
 * the case below with no shell at all is the proof: that window shows the interface preview's
 * own mailbox and must never show bars instead, because "there is no engine to have a state" is
 * not a wait.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback: (cb: unknown, once?: boolean) => number };
}
const host = globalThis as unknown as Host;

const SERVING: EngineStatus = {
  state: "serving",
  mode: "local",
  address: "someone@example.test",
  mailboxId: "mbx-1",
  credentialState: "ready",
};

/** One `engine_request` answer, framed exactly as the shell frames one. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "MA",
  hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({
  asOfSeq: 0,
  changes: [],
  nextCursor: null,
  window: { days: 90, minRows: 500 },
});
const MAILBOX_LIST = JSON.stringify({
  items: [{
    id: "mbx-1",
    address: "someone@example.test",
    status: "connected",
    errorCode: null,
    disabledReason: null,
    syncBlockedReason: null,
    syncBlockedSince: null,
    lastSyncAt: "2026-01-01T00:00:00.000Z",
    initialImportCompletedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2025-12-01T00:00:00.000Z",
  }],
});

/** A shell reporting one engine state, or no shell at all. */
function shell(status: EngineStatus | null): void {
  if (status === null) {
    delete host.__TAURI_INTERNALS__;
    return;
  }
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_status") return status;
      if (command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, MAILBOX_LIST);
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      h(
        IntlProvider,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        h(ThemeProvider, { storageKey: "ohmail.theme" }, h(ToastHost, null, h(DesktopGate, null))),
      ),
    );
  });
  // The status call and the effects behind it settle on the microtask queue; the clock is fake
  // so the grace cannot elapse here by accident, which is the point of the first case below.
  await advance(0);
  return mountPoint;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const skeleton = (): HTMLElement | null => mountPoint!.querySelector(".boot-sk");
const text = (): string => mountPoint!.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the window while an engine is still coming up", () => {
  it("draws no bars inside the grace — the healthy launch is unchanged", async () => {
    shell({ ...SERVING, state: "starting", mailboxId: undefined });
    await render();

    // The premise: this IS the opening state, so a null below means the grace held rather than
    // that the test is looking at the wrong screen.
    expect(text(), "the window is not in the opening state — this case measures nothing")
      .toContain("Opening your mailbox");
    expect(skeleton(), "the silhouette flashed on a launch fast enough not to need one").toBeNull();

    await advance(BOOT_SKELETON_GRACE_MS - 50);
    expect(skeleton(), "the silhouette arrived before the grace had elapsed").toBeNull();
  });

  it("draws the rail and the list once the wait outlasts the grace", async () => {
    shell({ ...SERVING, state: "starting", mailboxId: undefined });
    await render();
    await advance(BOOT_SKELETON_GRACE_MS + 50);

    const sk = skeleton();
    expect(sk, "a hundred seconds of recovery behind one centred sentence and nothing else")
      .not.toBeNull();
    /* THE WHOLE WINDOW, IN ITS OWN GEOMETRY (owner report 2026-08-26): the desktop boot draws
       this as the window, so it must be the window — three columns (rail, list panel, reading
       pane), the list panel carrying its `.vhead` slot, the rows carrying `.row`'s anatomy.
       A regression to generic text lines goes red on every one of these. */
    expect(sk!.classList.contains("boot-sk-window"), "not the whole-window silhouette").toBe(true);
    expect(sk!.querySelector(".boot-sk-pane"), "no list panel").not.toBeNull();
    expect(sk!.querySelector(".boot-sk-head"), "no view-head slot on the list panel").not.toBeNull();
    expect(sk!.querySelector(".boot-sk-reader"), "no reading-pane frame").not.toBeNull();
    expect(sk!.querySelector(".boot-sk-pill"), "no compose-capsule slot in the rail").not.toBeNull();
    expect(sk!.querySelector(".boot-sk-topbar"), "no narrow-topbar shape (shown ≤900px)").not.toBeNull();
    expect(sk!.querySelectorAll(".boot-sk-item").length, "a rail with no nav items")
      .toBeGreaterThan(3);
    expect(sk!.querySelectorAll(".boot-sk-row .boot-sk-av").length, "rows without lead circles")
      .toBeGreaterThan(0);
    expect(sk!.querySelector(".boot-sk-rail"), "no rail column in the window's own geometry")
      .not.toBeNull();
    expect(sk!.querySelectorAll(".boot-sk-row").length, "a silhouette with no rows in it")
      .toBeGreaterThan(0);
  });

  it("keeps the honest sentence over the bars — the long recovery still says what it is", async () => {
    shell({ ...SERVING, state: "restarting", mailboxId: undefined });
    await render();
    await advance(BOOT_SKELETON_GRACE_MS * 8);

    expect(skeleton(), "the geometry never arrived").not.toBeNull();
    expect(text(), "the silhouette swallowed the one sentence that says what is happening")
      .toContain("Opening your mailbox");
  });

  it("says nothing inside itself — not a sender, not a subject, not a count", async () => {
    shell({ ...SERVING, state: "starting", mailboxId: undefined });
    await render();
    await advance(BOOT_SKELETON_GRACE_MS * 8);
    const sk = skeleton()!;

    /**
     * The rule this window has always held, now that there is a shape on it: the two things it
     * could put on screen instead of mail are a guess and the invented mailbox, and the invented
     * mailbox under somebody's own address is the worse of the two. A silhouette is neither only
     * for as long as there is nothing in it.
     *
     * MUTATION WATCH: render any string inside `BootSkeleton` — a fixture sender, an ellipsis, a
     * single space — and this goes red.
     */
    expect(sk.textContent, "the silhouette started saying things").toBe("");
    expect(sk.getAttribute("aria-hidden")).toBe("true");
    // And no mail rows at all: bars are not rows and must never be counted as any.
    expect(mountPoint!.querySelectorAll(".row").length, "mail on screen before an engine served")
      .toBe(0);
  });

  it("is gone once the engine serves", async () => {
    shell(SERVING);
    await render();
    await advance(BOOT_SKELETON_GRACE_MS * 8);

    expect(text(), "the window never left the opening state").not.toContain("Opening your mailbox");
    expect(skeleton(), "the silhouette outlived the mailbox it was standing in for").toBeNull();
  });
});

describe("the silhouette decides nothing — `mailMount` still routes", () => {
  it("no shell at all is the door chooser, never bars", async () => {
    /* `kind: "none"` — a development server, or the render check that loads the built files in a
       headless DOM. There is no engine to have a state, so there is no wait to draw. A window
       that showed a silhouette here would be claiming to be opening something. (This used to
       land on a sample mailbox; the no-demo rule routes it to the not-connected surface — the
       chooser — and no mail of any kind is on screen.) */
    shell(null);
    await render();
    await advance(BOOT_SKELETON_GRACE_MS * 20);

    expect(mailMount({ kind: "none" }, null)).toEqual({ kind: "opening" });
    expect(skeleton(), "the silhouette appeared over a window with nothing to open").toBeNull();
    // …and the chooser is what is on screen: no rows, because there is no mail to draw.
    expect(mountPoint!.textContent ?? "").toMatch(/Which mailbox is this\?/);
    expect(mountPoint!.querySelectorAll(".row").length).toBe(0);
  });

  it("the decision table is untouched by the silhouette", () => {
    /* Restated here, small, so a change to the gate's rendering that also moved the routing
       cannot pass this file. `desktop-engine.test.ts` owns the full table. */
    const at = (state: EngineStatus["state"]): EngineStatus => ({ ...SERVING, state });
    expect(mailMount({ kind: "status", status: at("serving") }, null))
      .toEqual({ kind: "engine", key: "mbx-1" });
    for (const state of ["starting", "restarting"] as const) {
      const { mailboxId: _drop, ...rest } = at(state);
      expect(mailMount({ kind: "status", status: rest }, null)).toEqual({ kind: "opening" });
      expect(mailMount({ kind: "status", status: rest }, "mbx-1"))
        .toEqual({ kind: "engine", key: "mbx-1" });
    }
  });
});

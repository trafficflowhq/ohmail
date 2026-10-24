/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import messages from "../messages/en.json";
import { shellFrameOf, shellSliceOf } from "./source-anchor";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * TRI-F4 / TRI-F6 / TRI-F11 — THE MESSAGE VERBS INSIDE TRIAGE, AND THE WAY OUT OF A PILE.
 *
 * Network-verified on the live build: `a` and `e` pressed inside #/triage produced no
 * request, no toast and no state change, while the same keys worked in the Ohbox and the
 * footer buttons worked everywhere. And no surface anywhere dispatched the `state:"none"`
 * the wire has always accepted — one mis-key was irreversible until reply or resurface.
 *
 * The cases below run the fixture world through the real shell: the keys act inside the
 * Triage view, and the verb that filed a message takes it back out (the toggle).
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

beforeEach(() => {
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-02T09:00:00.000Z"),
        children: node,
      }),
    );
  });
  return container;
}

async function shell(): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  return mount(h(ThemeProvider, { children: h(ToastHost, { children: h(AppShell, { demo: true }) }) }));
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

/** The segmented control's label for a pile, count included — the view's own claim. */
const segText = (el: HTMLElement): string =>
  el.querySelector(".triage-seg")?.textContent ?? "";

describe("TRI-F4 — a/e/b act INSIDE the Triage view", () => {
  it("`e` on the shown Answer-Later message parks it — key, not footer", async () => {
    const container = await shell();
    await key("g");
    await key("l");
    await waitFor(() => container.querySelector(".view-triage") != null, "triage view");
    // The fixture world queues two message-backed entries; the first openable is shown.
    expect(segText(container)).toContain("Answer Later 2");

    await key("e");
    await waitFor(() => segText(container).includes("Answer Later 1"), "the pile shrank");
    // Parked grew: one fixture orphan plus the message just parked.
    expect(segText(container)).toContain("Parked 2");
  }, 20000);

  it("`a` on a message already queued takes it OUT — the un-triage path (TRI-F6)", async () => {
    const container = await shell();
    await key("g");
    await key("l");
    await waitFor(() => container.querySelector(".view-triage") != null, "triage view");
    expect(segText(container)).toContain("Answer Later 2");

    // The shown message is IN the Answer Later pile, so the verb that put it there is the
    // verb that takes it out. Before the toggle this keypress was a silent no-op (and in
    // the Ohbox, a "{name} is already queued" toast) — the pile count is what bites.
    await key("a");
    await waitFor(() => segText(container).includes("Answer Later 1"), "the message left the pile");
    await waitFor(
      () => (document.body.textContent ?? "").includes("Out of Answer Later"),
      "the toast states the direction",
    );
  }, 20000);
});

describe("⇧F inside Triage — the pill's keycap and the key are one claim", () => {
  /**
   * A review finding, and it is the same defect this whole file was written for, one verb later.
   *
   * The shell's global bindings act on `focused`, which has NO arm for this view: the message on
   * screen here is `TriageView`'s own `shown`. So a verb declared only at the shell is inert in
   * this view while the pill it mounts still prints the verb's keycap — read from the registry,
   * which owns the chord whether or not it is disabled. That is exactly the "advertises a key
   * that does nothing" failure the keycap-always law exists to prevent, and it is why `a`, `e`,
   * `b` and `r` are declared locally here. Forward joins them rather than becoming a fourth
   * silent chord.
   *
   * Asserted on the OUTCOME the key produces — the forward dock, in forward mode, over the shown
   * message — rather than on the binding table, because a registered-but-wrong binding would pass
   * a table check. Mutation: drop the `shift+f` entry from `TriageView`'s `verbs` and this reddens
   * while the keycap on the bar is unchanged.
   */
  it("`⇧F` on the shown message opens the forward dock — the key the pill advertises here", async () => {
    const container = await shell();
    await key("g");
    await key("l");
    await waitFor(() => container.querySelector(".view-triage") != null, "triage view");

    // The bar in this view prints the keycap, which is the claim the key has to honour.
    const fwd = [...container.querySelectorAll<HTMLButtonElement>(".view-triage .abar-b")]
      .find((b) => (b.textContent ?? "").startsWith("Forward"));
    expect(fwd, "no Forward button on the triage pane").toBeDefined();
    expect(fwd!.querySelector("kbd")?.textContent, "the bar advertises the chord").toBe("⇧ f");

    await key("F", { shiftKey: true });
    await waitFor(
      () => container.querySelector(".view-triage .reply .reply-forwarding") != null,
      "the forward dock, opened by the key the bar advertises",
    );
  }, 20000);
});

describe("the NARROW reader and the view's cursor are the same message", () => {
  /**
   * A second review finding — a WRONG-TARGET bug, and the worst kind: it acts, successfully, on
   * somebody else's mail.
   *
   * `shown` falls back to `openable[0]` when `selectedId` is null, and on the narrow layout
   * `openRow` used to raise the reader (`onOpen`) WITHOUT setting the cursor. So tapping the
   * second row of a pile put that row in the reader while `shown` still pointed at the first —
   * and every verb this view declares reads `shown`. `⇧F` would then have forwarded a different
   * person's message than the one filling the screen, silently and successfully. `r`, `a`, `e`
   * and `b` had the identical staleness; the fix is at the cursor, so it closes all five.
   *
   * There is no reader-aware binding underneath to save it: a view's binding OUTRANKS the
   * shell's global one, which is the whole reason these are declared here.
   *
   * Asserted on IDENTITY — the dock's `data-reply-for` against the id of the row that was
   * tapped — not on "a dock opened", because the bug's signature is a dock that opens over the
   * WRONG id. Mutation: put `if (readColumnHidden()) onOpen(m); else setSelectedId(m.id);` back
   * and this reddens naming both ids.
   */
  it("`⇧F` after tapping the SECOND row forwards that row — not the pile's first", async () => {
    // The narrow world: `readColumnHidden()` asks `(max-width: 699.98px)`, so a matching query is
    // the phone layout where the reading column is `display:none` and a tap raises the reader.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: /max-width/.test(query),
        media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      }),
    });

    const container = await shell();
    await key("g");
    await key("l");
    await waitFor(() => container.querySelector(".view-triage") != null, "triage view");

    const rows = [...container.querySelectorAll<HTMLElement>(".view-triage .row[data-id]")];
    expect(rows.length, "the fixture pile needs a second row for this case to mean anything")
      .toBeGreaterThan(1);
    const first = rows[0]!.dataset.id!;
    const second = rows[1]!.dataset.id!;
    expect(second).not.toBe(first);

    await act(async () => { rows[1]!.click(); });
    await waitFor(() => document.querySelector(".reader") != null, "the reader sheet");

    await key("F", { shiftKey: true });
    await waitFor(
      () => document.querySelector(".reply[data-reply-for]") != null,
      "the forward dock",
    );
    const target = document.querySelector<HTMLElement>(".reply[data-reply-for]")!.dataset.replyFor;
    expect(
      target,
      `⇧F forwarded ${target === first ? "the pile's FIRST row" : String(target)} while the ` +
        "reader was showing the second — the view's cursor did not follow the tap",
    ).toBe(second);
  }, 20000);
});

describe("TRI-F6 — the footer button is the same toggle", () => {
  it("the pane's Later button un-queues a queued message", async () => {
    const container = await shell();
    await key("g");
    await key("l");
    await waitFor(() => container.querySelector(".view-triage") != null, "triage view");
    expect(segText(container)).toContain("Answer Later 2");

    // The reading column's action bar — the button and the key dispatch one code path.
    const later = [...container.querySelectorAll<HTMLButtonElement>(".view-triage .abar-b")]
      .find((b) => (b.textContent ?? "").includes("Later"));
    expect(later, "no Later button on the pane").toBeDefined();
    await act(async () => later!.click());
    await waitFor(() => segText(container).includes("Answer Later 1"), "the button un-queued it");
  }, 20000);
});

describe("TRI-F11 — `b` matches the picker and is reversible", () => {
  /**
   * BOOKING TAKES THE ROW OUT OF THE OHBOX, so the way out is pressed WHERE THE ROW WENT.
   *
   * This used to press `b` twice in the Ohbox on the same cursor. That worked while a parked
   * message stayed listed in the Ohbox as well as in its pile — the double presentation
   * `selectors.ts#parkedMessageIds` closes. Now the first `b` files the row under Resurface and it
   * leaves every Ohbox group in the same frame, so there is nothing under the cursor to press
   * again: the cancel is taken in the Resurface pile, which is the one place the message is.
   *
   * That the row LEAVES is asserted first, because it is the half a regression would restore
   * silently — a second `b` that "worked" in the Ohbox would mean the row was still there.
   */
  it("books, states the day, leaves the Ohbox, and `b` in the pile opens the chooser whose Now brings it back", async () => {
    const container = await shell();
    // Queue nothing — act on the Ohbox cursor. `j` enters the list, `b` books resurface.
    await key("j");
    const booked = container.querySelector<HTMLElement>(".view-ohbox .row.sel")?.dataset.id;
    expect(booked, "`j` put the cursor on no row").toBeDefined();
    await key("b");
    await waitFor(
      () => (document.body.textContent ?? "").includes("Resurfaces"),
      "the toast states the horizon",
    );
    // ONE PILE: the booked row is gone from the Ohbox the moment it is booked.
    await waitFor(
      () => container.querySelector(`.view-ohbox .row[data-id="${booked!}"]`) == null,
      "the booked row left the Ohbox",
    );

    // The way out TRI-F6 names, taken in the pile the row moved to.
    window.location.hash = "#/triage/resurface";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await waitFor(() => container.querySelector(".view-triage") != null, "the Resurface pile");
    /* INVERTED for that change: `b` in the pile used to cancel the booking; it opens the chooser
       its Resurface button opens, focused on Now (jsdom does not press a focused button on ↵). */
    await key("b");
    await waitFor(
      () => (document.body.textContent ?? "").includes("Resurface when?"),
      "`b` in the pile opens the chooser",
    );
    const now = [...document.querySelectorAll<HTMLButtonElement>(".abar button")]
      .find((el) => (el.textContent ?? "").trim() === "Now");
    await act(async () => { now?.click(); });
    await waitFor(
      () => (document.body.textContent ?? "").includes("Back at the top"),
      "Now brings it back",
    );
  }, 20000);

  it("the keyboard default IS a picker option — tomorrow, at the hour the strip shows", async () => {
    // The picker's presets are `tomorrowAt` / `nextWeekAt` (MessagePane); the keyboard and
    // palette default used `nextFridayNine`, a horizon the picker cannot produce — so the key's
    // outcome could be neither predicted nor reproduced from the documented control. Both
    // dispatch sites mint the picker's own first dated preset.
    //
    // SINCE mail 0110 the preset takes an HOUR, and the invariant is one degree stronger: the
    // key and the strip must agree about WHICH hour, not merely which day. Both must read
    // `consent.resurfaceTime` — the value the strip's control is filled from — so a key that
    // kept minting 09:00 after somebody set 14:30 goes red here. The single-message verb and
    // the selection verb are asserted apart: one of the pair was fixed alone once.
    /* THE TWO VERBS MOVED to `shell-verbs.ts` at ARCH-022 and the chrome supply stayed in
       `AppShell.tsx`, so the claim is asked of each frame that holds its half — and the two
       negatives are asked of BOTH, because a bare 09:00 written back into either is the same
       defect. Each verb is read inside its OWN declaration: one of the pair was fixed alone
       once, and a file-wide match cannot tell them apart. */
    const src = read("../app/shell/AppShell.tsx");
    const verbs = shellFrameOf("onMessageAction").source;
    for (const [where, text] of [["AppShell.tsx", src], ["shell-verbs.ts", verbs]] as const) {
      expect(text, `${where} mints the retired Friday horizon`).not.toMatch(/nextFridayNine/);
      // Neither site may mint a bare 09:00 any more — the `*Nine` wrappers belong to send later.
      expect(text, `${where} mints a bare 09:00`).not.toMatch(/tomorrowNine/);
    }
    // `.iso` since a horizon carries the wall clock it booked as well as the instant: both sites
    // take the instant off the SAME value the strip labels its buttons from.
    // `nowAt()` and not `now`: the shell's rendered clock is at most a minute old, and a horizon
    // minted from it at 00:00:30 books yesterday's tomorrow. A press asks the clock itself
    // (`resurface-horizon-at-the-press.test.tsx` drives that on the rendered strip).
    expect(shellSliceOf("onMessageAction"), "the single-message verb")
      .toMatch(/const when = tomorrowAt\(nowAt\(\), consent\.resurfaceTime\)\.iso;/);
    expect(shellSliceOf("onBulkAction"), "the selection verb").toMatch(
      /const when = action === "resurface" \? tomorrowAt\(nowAt\(\), consent\.resurfaceTime\)\.iso : null;/,
    );
    // …and the strip fills its control from the SAME field, through the chrome the shell
    // supplies it on — one source, or the key and the control are two answers again.
    expect(src).toMatch(/resurfaceTime: consent\.resurfaceTime,/);
    const pane = read("../app/shell/MessagePane.tsx");
    expect(pane).toMatch(/resurfaceClock\(chrome\.resurfaceTime\)/);
    expect(pane).toMatch(/resurfaceHorizons\(base, resurfaceAt\)/);
  });
});

describe("STA-F8 — the pile hint renders once", () => {
  it("an empty Parked pile does not repeat the header's sentence in the empty state", async () => {
    const { TriageView } = await import("../app/views/TriageView.js");
    const { KeymapProvider } = await import("../app/shell/keymap.js");
    const { WithListGone } = await import("./_list-gone.js");
    const container = await mount(
      h(KeymapProvider, {
        children: h(WithListGone, { children: h(TriageView, {
          piles: { replyLater: [], setAside: [], resurface: [] },
          settled: true,
          owed: false,
          pile: "aside",
          onPile: () => {},
          frDone: new Set<string>(),
          onStartFR: () => {},
          messageOf: () => null,
          tags: [],
          now: new Date("2026-08-02T09:00:00.000Z"),
          onOpen: () => {},
          hydrateBody: () => {},
          onAction: () => {},
          onAddTag: () => {},
        }) }),
      }),
    );
    const hint = (messages as unknown as Record<string, Record<string, string>>).triage!.hintAside!;
    const text = container.textContent ?? "";
    const occurrences = text.split(hint).length - 1;
    // The header's `.triage-cta` line carries the sentence; the empty state must not say it
    // again 150px below. Exactly once.
    expect(occurrences, `the pile hint appears ${occurrences}× — expected once`).toBe(1);
  });
});

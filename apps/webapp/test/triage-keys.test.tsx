/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { cleanup, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { listSeat } from "../../../packages/app/test/places/list-seat.js";

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
  cleanup();
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

async function shell(hash = "#/triage"): Promise<HTMLElement> {
  window.location.hash = hash;
  const { DemoShell } = await import("../app/(product)/demo/DemoShell");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  return mount(h(ThemeProvider, { children: h(ToastHost, { children: h(DemoShell, { serverDemo: true, says: { service: "managed", sendCeiling: "strict" } }) }) }));
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
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

const segment = (label: string) =>
  within(screen.getByRole("group", { name: "Piles" })).queryByRole("button", { name: label });
const laterRows = () => within(screen.getByRole("listbox", { name: "Answer Later" })).getAllByRole("option");
const reading = () => within(screen.getByRole("region", { name: "Reading" }));
const forwardEditor = () => screen.queryByRole("textbox", { name: "Forward body" });

async function openLater(): Promise<void> {
  await shell();
  await screen.findByRole("listbox", { name: "Answer Later" });
  await screen.findByRole("region", { name: "Reading" });
}

describe("TRI-F4 — a/e/b act INSIDE the Triage view", () => {
  it("`e` on the shown Answer-Later message parks it — key, not footer", async () => {
    await openLater();
    // The fixture world queues two message-backed entries; the first openable is shown.
    expect(segment("Answer Later 2")).not.toBeNull();

    await key("e");
    await waitFor(() => segment("Answer Later 1") !== null, "the pile shrank");
    // Parked grew: one fixture orphan plus the message just parked.
    expect(segment("Parked 2")).not.toBeNull();
  }, 20000);

  it("`a` on a message already queued takes it OUT — the un-triage path (TRI-F6)", async () => {
    await openLater();
    expect(segment("Answer Later 2")).not.toBeNull();

    // The shown message is IN the Answer Later pile, so the verb that put it there is the
    // verb that takes it out. Before the toggle this keypress was a silent no-op (and in
    // the Ohbox, a "{name} is already queued" toast) — the pile count is what bites.
    await key("a");
    await waitFor(() => segment("Answer Later 1") !== null, "the message left the pile");
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
    await openLater();

    // The bar in this view prints the keycap, which is the claim the key has to honour.
    const fwd = reading().getByRole("button", { name: /^Forward/ });
    expect(fwd, "no Forward button on the triage pane").toBeDefined();
    const shortcut = fwd.getAttribute("aria-keyshortcuts");
    await key("F", { shiftKey: true });
    await waitFor(
      () => forwardEditor() !== null,
      "the forward dock, opened by the key the bar advertises",
    );
    expect(shortcut, "the bar advertises the chord").toBe("Shift+F");
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
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      await shell();
      await screen.findByRole("listbox", { name: "Answer Later" });
      const [first, second] = laterRows();
      expect(second, "the fixture pile needs a second row").toBeDefined();
      expect(second!.getAttribute("aria-label")).not.toBe(first!.getAttribute("aria-label"));

      await act(async () => { second!.click(); });
      const sheet = within(await screen.findByRole("dialog", { name: "Reading" }));
      const subject = sheet.getByRole("heading", { level: 2 }).textContent!;
      expect(second!.getAttribute("aria-label")).toContain(subject);
      expect(first!.getAttribute("aria-label")).not.toContain(subject);

      await key("F", { shiftKey: true });
      await waitFor(() => forwardEditor() !== null, "the forward editor");
      expect(sheet.getByRole("textbox", { name: "Forward body" })).toBeTruthy();
      expect(sheet.getByRole("heading", { level: 2 }).textContent).toBe(subject);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  }, 20000);
});

describe("TRI-F6 — the footer button is the same toggle", () => {
  it("the pane's Later button un-queues a queued message", async () => {
    await openLater();
    expect(segment("Answer Later 2")).not.toBeNull();

    // The reading column's action bar — the button and the key dispatch one code path.
    const later = reading().getByRole("button", { name: /Later/ });
    expect(later, "no Later button on the pane").toBeDefined();
    await act(async () => later!.click());
    await waitFor(() => segment("Answer Later 1") !== null, "the button un-queued it");
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
    await shell("#/ohbox");
    await screen.findByRole("heading", { name: "Ohbox" });
    await screen.findAllByRole("option");
    await key("j");
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    const id = window.location.hash.split("/m/")[1];
    expect(id, "`j` put the cursor on no row").toBeTruthy();
    const booked = screen.getAllByRole("option").find((row) => row.dataset.id === id)
      ?.getAttribute("aria-label");
    expect(booked).toBeTruthy();
    await key("b");
    await waitFor(
      () => (document.body.textContent ?? "").includes("Resurfaces"),
      "the toast states the horizon",
    );
    // ONE PILE: the booked row is gone from the Ohbox the moment it is booked.
    await waitFor(
      () => screen.queryByRole("option", { name: booked! }) === null,
      "the booked row left the Ohbox",
    );

    // The way out TRI-F6 names, taken in the pile the row moved to.
    window.location.hash = "#/triage/resurface";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    const pile = await screen.findByRole("listbox", { name: "Resurface" });
    const moved = within(pile).getAllByRole("option").find((row) => row.dataset.id === id);
    expect(moved, "the booking did not reach the Resurface pile").toBeDefined();
    await act(async () => { moved!.click(); });
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    /* INVERTED for that change: `b` in the pile used to cancel the booking; it opens the chooser
       its Resurface button opens, focused on Now (jsdom does not press a focused button on ↵). */
    await key("b");
    const picker = await screen.findByRole("menu", { name: "Resurface" });
    const now = within(picker).getByRole("menuitem", { name: "Now" });
    await act(async () => { now.click(); });
    await waitFor(
      () => (document.body.textContent ?? "").includes("Back at the top"),
      "Now brings it back",
    );
  }, 20000);
});

describe("the empty Parked list", () => {
  it("says the pile is empty once", async () => {
    listSeat({ letters: [], first: "#/triage/aside" });
    await screen.findByRole("heading", { name: "Triage" });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getAllByText((_, element) =>
      element?.tagName === "P" && element.textContent === messages.parked.empty,
    )).toHaveLength(1);
    expect(screen.queryByText(messages.triage.hintAside)).toBeNull();
  });
});

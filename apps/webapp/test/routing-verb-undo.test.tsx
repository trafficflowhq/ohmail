/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter, type EngineMutation } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { UNDO_MS } from "../app/shell/screener-state";

/**
 * MOVE, FILE AND JUNK CAN BE TAKEN BACK — driven through the whole shell, counted at the adapter.
 *
 * The press is two halves: the mail moves NOW and the sender's ROUTING is held for `UNDO_MS`
 * (`routing-undo.ts`), because no rule mutation has a wire inverse. So the cases here read the
 * wire twice — at the press, where a rule must NOT be, and past the window, where exactly one
 * must — and they read Undo as the mutations it dispatched and the rule it never let out, never
 * as view state.
 */

// See `verb-undo-shell.test.tsx` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  await key("j");
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
};

const toastText = (): string => (host!.querySelector(".toast")?.textContent ?? "").trim();
const undoButton = (): HTMLButtonElement | null =>
  host!.querySelector<HTMLButtonElement>(".toast .toast-act");

const buttonStarting = (label: string): HTMLButtonElement | undefined =>
  [...host!.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));

const click = async (b: HTMLButtonElement | undefined): Promise<void> => {
  expect(b, "nothing to click").toBeTruthy();
  await act(async () => { b!.click(); });
  await flush();
};

/** Every mutation of this kind the adapter was asked to perform, in order. */
const kinds = (kind: string) => sent.filter((m) => m.kind === kind);
/** Anything that writes where a sender's mail goes from now on. */
const routing = () => sent.filter((m) => m.kind.startsWith("rule_") || m.kind === "screener_decide");

/** Press Move on the focused row and pick a destination. */
async function moveFocusedTo(place: string): Promise<void> {
  await click(buttonStarting("Move"));
  await click(buttonStarting(`→ ${place}`));
}

/** Close the routing window — the REAL constant, on the fake clock this file installs. */
async function closeTheWindow(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(UNDO_MS + 1000); });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  setViewport();
  window.location.hash = "#/ohbox";
  sent = [];
  try { window.localStorage.clear(); } catch { /* a jar that refuses is its own case, below */ }
  // Counted at the ADAPTER — the last thing before the wire — and CALLED THROUGH, so the
  // engine's overlay is reconciled rather than frozen. `verb-undo-shell.test.tsx`'s rig.
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter,
    ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a routing press is two halves and one sentence", () => {
  it("the mail moves at the press and the rule does not — the toast carries Undo", async () => {
    await mountShell();
    await moveFocusedTo("News");

    expect(kinds("move").length, "the mail did not move at the press").toBeGreaterThan(0);
    /* The press rewrites the route: its moves are no override of it (`pressRule`). */
    expect(kinds("move").every((m) => (m as { pressRule?: true }).pressRule === true),
      "a rule press's move would count against the route it rewrites").toBe(true);
    expect(routing(), "a rule went out inside the window — there would be nothing to undo")
      .toEqual([]);
    expect(undoButton(), "the Move toast carries no Undo").toBeTruthy();
  });

  it("Undo puts the mail back and NO rule is ever made", async () => {
    await mountShell();
    await moveFocusedTo("News");
    const moved = kinds("move") as Array<{ messageId: string; folder: string }>;
    expect(moved.length).toBeGreaterThan(0);

    sent = [];
    await click(undoButton() ?? undefined);

    /* THE MAIL CAME BACK — the engine's own inverse on the wire, never a local state hack. */
    const back = kinds("move") as Array<{ messageId: string; folder: string }>;
    expect(back.length, "Undo dispatched no move").toBeGreaterThan(0);
    expect(back.every((m) => (m as { pressRule?: true }).pressRule === true),
      "taking the press back would count against the route as a correction").toBe(true);
    expect(new Set(back.map((m) => m.folder)), "the mail went back to the place it was filed in")
      .not.toContain("ohmail/News");
    expect(toastText()).toBe("The mail is back where it was, and no rule was made.");

    /* AND THE WINDOW IS GONE WITH IT: letting the clock run past it sends nothing. */
    sent = [];
    await closeTheWindow();
    expect(routing(), "the cancelled rule was written when the window would have closed")
      .toEqual([]);
  });

  it("`z` presses the same offer, and a second press takes nothing back", async () => {
    await mountShell();
    await moveFocusedTo("News");

    sent = [];
    await key("z");
    await flush();
    expect(kinds("move").length, "z did not press the live offer").toBeGreaterThan(0);

    sent = [];
    await key("z");
    await flush();
    expect(sent, "a second z re-dispatched the undo").toEqual([]);
  });

  it("left alone, the rule is made when the window closes — once", async () => {
    await mountShell();
    await moveFocusedTo("News");
    expect(routing()).toEqual([]);

    await closeTheWindow();
    const wrote = routing();
    expect(wrote.length, "the window closed and no rule was made").toBeGreaterThan(0);

    /* ONCE. A second turn of the clock has nothing left to send. */
    sent = [];
    await closeTheWindow();
    expect(routing(), "the rule was written a second time").toEqual([]);
  });

  it("a late Undo takes the mail back and does NOT claim the rule was never made", async () => {
    await mountShell();
    await moveFocusedTo("News");
    const offer = undoButton();
    expect(offer).toBeTruthy();

    // Just past the window, inside the capsule's fade: the rule is sent and the button is still
    // in the tree (it leaves after the fade), so a late press is reachable and must tell the
    // truth — the mail comes back, the rule stands.
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    await flush();
    expect(routing().length, "the window did not close").toBeGreaterThan(0);
    expect(offer!.isConnected, "the premise: the late press is reachable").toBe(true);

    sent = [];
    await act(async () => { offer!.click(); });
    await flush();
    /* POSITIVELY, because the negative form passed for nothing: measured, `toastText()` read
       empty after the clock ran and `not.toBe(…)` was true of a toast that was not there. The
       mail must come back AND the sentence must be the plain one. */
    expect(kinds("move").length, "the late Undo dispatched no move, so nothing below reads")
      .toBeGreaterThan(0);
    expect(toastText(), "a late Undo claimed no rule was made over a rule that was")
      .toBe("Undone.");
  });
});

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter, type EngineMutation } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * ONE UNDO TOAST ON EVERY VERB (the 0.20 review) — driven through the whole shell, counted at the
 * adapter. The verbs that silently moved mail (Later, Park, Resurface) now raise a sentence
 * whose Undo dispatches the ENGINE'S OWN INVERSE (`inverseMutations`) through the ordinary
 * mutate seam — asserted here as the mutation the adapter receives, never as view state. The
 * same offer is on the keyboard (`z`), consumed at most once, and dead once the window closes:
 * claiming an undo that did not happen is the Screener's own forbidden shape.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
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
  // The Ohbox selects nothing by itself — land the cursor on the first row.
  await key("j");
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
};

const toastText = (): string => (host!.querySelector(".toast")?.textContent ?? "").trim();
const undoButton = (): HTMLButtonElement | null => host!.querySelector<HTMLButtonElement>(".toast .toast-act");

const selectedId = (): string => {
  const id = host!.querySelector<HTMLElement>(".row.sel")?.dataset.id;
  expect(id, "no row under the cursor").toBeTruthy();
  return id!;
};

const kinds = (kind: string) => sent.filter((m) => m.kind === kind);

beforeEach(() => {
  vi.useFakeTimers();
  setViewport();
  window.location.hash = "#/ohbox";
  sent = [];
  // Counted at the ADAPTER — the last thing before the wire — and CALLED THROUGH, so the
  // engine's overlay is reconciled rather than frozen. See `resurface-now-shell.test.ts`.
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

describe("the verb toast carries Undo, and Undo drives the engine's inverse", () => {
  it("Later: the toast offers Undo; pressing it dispatches the inverse triage_set", async () => {
    await mountShell();
    const id = selectedId();

    await key("a");
    await flush();
    expect(toastText()).toContain("Queued in Answer Later");
    const undo = undoButton();
    expect(undo, "the Later toast carries no Undo").toBeTruthy();
    expect(kinds("triage_set")).toEqual([{ kind: "triage_set", messageId: id, state: "reply_later" }]);

    sent = [];
    await act(async () => { undo!.click(); });
    await flush();
    // The REAL inverse on the wire — the row had no pile state, so back to none.
    expect(kinds("triage_set")).toEqual([{ kind: "triage_set", messageId: id, state: "none" }]);
    expect(toastText()).toBe("Undone.");
  });

  it("Park undone from the keyboard: z presses the live offer, at most once", async () => {
    await mountShell();
    const id = selectedId();

    await key("e");
    await flush();
    expect(toastText()).toContain("Parked");
    expect(undoButton(), "the Park toast carries no Undo").toBeTruthy();

    sent = [];
    await key("z");
    await flush();
    expect(kinds("triage_set")).toEqual([{ kind: "triage_set", messageId: id, state: "none" }]);

    // Consumed with the press: a second z re-dispatches nothing.
    sent = [];
    await key("z");
    await flush();
    expect(sent).toEqual([]);
  });

  it("Resurface: the sentence states the day the default booked, and Undo takes the booking back", async () => {
    await mountShell();
    const id = selectedId();

    await key("b");
    await flush();
    // The silent default is a stated one: the sentence names when the mail returns.
    expect(toastText()).toMatch(/^Resurfaces /);
    const booked = kinds("triage_set") as Array<{ state: string; bubbleUpAt?: string | null }>;
    expect(booked).toHaveLength(1);
    expect(booked[0]!.state).toBe("bubbled_up");
    const undo = undoButton();
    expect(undo, "the Resurface toast carries no Undo").toBeTruthy();

    sent = [];
    await act(async () => { undo!.click(); });
    await flush();
    expect(kinds("triage_set")).toEqual([{ kind: "triage_set", messageId: id, state: "none" }]);
  });

  it("z pressed before the Park's answer is back undoes it once the answer lands", async () => {
    await mountShell();
    const id = selectedId();
    let answer: () => void = () => {};
    // The Park's answer is held back; the spy it then calls through records it.
    const spy = FixturesAdapter.prototype.mutate;
    vi.mocked(FixturesAdapter.prototype.mutate).mockImplementationOnce(async function (
      this: FixturesAdapter, ...args: Parameters<FixturesAdapter["mutate"]>
    ) {
      await new Promise<void>((r) => { answer = r; });
      return spy.apply(this, args);
    } as never);

    await key("e");
    await key("z");
    expect(undoButton(), "no offer stands yet").toBeNull();
    await act(async () => { answer(); });
    await flush();
    expect(kinds("triage_set")).toEqual([
      { kind: "triage_set", messageId: id, state: "set_aside" },
      { kind: "triage_set", messageId: id, state: "none" },
    ]);
    expect(toastText()).toBe("Undone.");
  });

  it("the offer dies with its window: a late z takes nothing back and dispatches nothing", async () => {
    await mountShell();

    await key("a");
    await flush();
    expect(undoButton()).toBeTruthy();

    // Past UNDO_MS the armed offer is dead — a late press must not claim an undo.
    await act(async () => { vi.advanceTimersByTime(9000); });
    sent = [];
    await key("z");
    await flush();
    expect(sent).toEqual([]);
  });
});

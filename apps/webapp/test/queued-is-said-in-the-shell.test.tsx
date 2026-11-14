/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MutationRejectedError, type EngineMutation } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { QUEUED_HOLDER, queuedByOrganizer } from "../../../packages/client-engine/test/fixtures/press-answers.js";

/**
 * ═══ A QUEUED ANSWER IS SAID AS QUEUED, AND NEVER COUNTED AS LANDED ═════════════════════════
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────
 *
 * The seam answered `status === "rolled_back" ? refused : applied`, which put BOTH waits on the
 * completion side. Press Later on a mailbox this install only READS and the server records the
 * press for the install that organizes it (`202 {pending: true}`) — nothing is in any pile —
 * and the shell said "Queued in Answer Later." over a message that had not moved.
 *
 * ── THE DOUBLE ANSWERS THE WAY PRODUCTION ANSWERS ───────────────────────────────────────────
 *
 * `HttpAdapter.queuedAnswer` builds a `MutationQueued` from a real queued answer and the engine turns it
 * into `awaiting_organizer`. The double returns THAT VALUE, from the shared fixture the phone's
 * twin is driven against — not a status invented here, and not a throw, which is a refusal and
 * a different ending.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * In `AppShell.mutateAndReport`, delete the `out.kind === "queued"` arm — the shape every one of
 * these presses shipped with — and each case goes red on the rendered sentence, while the
 * positive controls (an ordinary confirmed press) stay green.
 */

(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = messages.ohbox as unknown as Record<string, string>;
/** The sentence the seam renders for a press recorded for the organizing install. */
const QUEUED_SAID = `Queued for ${QUEUED_HOLDER}`;

let roots: Root[] = [];
let host: HTMLElement | null = null;
let sent: EngineMutation[] = [];
/** Armed by a case: from here the server RECORDS the press instead of carrying it out. */
let recording = false;
/** …or refuses it, for the mixed cases where a set has both endings. */
let refuseEvery = 0;

beforeEach(() => {
  window.location.hash = "";
  sent = [];
  recording = false;
  refuseEvery = 0;
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
      onchange: null, dispatchEvent: () => false,
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
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});

  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter,
    ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    if (refuseEvery > 0 && sent.length % refuseEvery === 0) {
      throw new MutationRejectedError("another install is organizing this mailbox", {
        status: 409, code: "organized_elsewhere", retryable: false,
        details: { by: { kind: "local", name: QUEUED_HOLDER } },
      });
    }
    if (recording) return queuedByOrganizer() as never;
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  host = null;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function shell(): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
      }),
    }));
  });
  host = container;
  return container;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

async function waitFor(predicate: () => boolean, what: string, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

/** What the toast says, and nothing else on the screen — the pile labels would answer for it. */
const said = (needle: string): boolean =>
  [...document.querySelectorAll('[role="status"]')]
    .some((n) => (n.textContent ?? "").includes(needle));

async function cursorOnFirstRow(): Promise<string> {
  await key("j");
  const id = host!.querySelector<HTMLElement>(".view-ohbox .row.sel")?.dataset.id;
  expect(id, "`j` put the cursor on no row").toBeTruthy();
  return id!;
}

describe("one press: a recorded request is told as a wait, never as a completion", () => {
  it("Answer Later — says who it is waiting for, never that the message is in the pile", async () => {
    await shell();
    await cursorOnFirstRow();
    recording = true;
    await key("a");
    await waitFor(() => said(QUEUED_SAID), "the wait is never rendered");
    expect(said(copy.toastQueued!), "the press claimed the message was queued in Answer Later").toBe(false);
  }, 20000);

  it("Park — the same", async () => {
    await shell();
    await cursorOnFirstRow();
    recording = true;
    await key("e");
    await waitFor(() => said(QUEUED_SAID), "the wait is never rendered");
    expect(said(copy.toastAside!), "the press claimed the message was parked").toBe(false);
  }, 20000);

  /** THE POSITIVE CONTROL: an ordinary press still says what it did, and never the wait. */
  it("an applied press still says it applied", async () => {
    await shell();
    await cursorOnFirstRow();
    await key("e");
    await waitFor(() => said(copy.toastAside!), "the ordinary press said nothing");
    expect(said("Queued for"), "an applied press was reported as waiting").toBe(false);
  }, 20000);
});

describe("a set: the sentence counts the whole press", () => {
  it("nothing applied and everything waiting is the wait, not a count of zero", async () => {
    await shell();
    await cursorOnFirstRow();
    await key("ArrowDown", { shiftKey: true });
    await waitFor(
      () => host!.querySelectorAll(".view-ohbox .row.picked, .view-ohbox .row[aria-selected='true']").length > 0,
      "nothing was picked",
    );
    recording = true;
    await key("a");
    await waitFor(() => said(QUEUED_SAID), "the wait is never rendered");
    expect(said("queued in Answer Later"), "the set claimed a count nothing applied").toBe(false);
  }, 20000);

  /**
   * THE PARTIAL, which is the row's own defect: a set where some applied and some were refused
   * said the count that applied and never mentioned the rest.
   */
  it("a partial refusal is counted beside what applied", async () => {
    await shell();
    await cursorOnFirstRow();
    await key("ArrowDown", { shiftKey: true });
    await waitFor(
      () => host!.querySelectorAll(".view-ohbox .row.picked, .view-ohbox .row[aria-selected='true']").length > 0,
      "nothing was picked",
    );
    sent = [];
    refuseEvery = 2;
    await key("a");
    await waitFor(() => said("did not change"), "the refused half of the press was never mentioned");
  }, 20000);
});

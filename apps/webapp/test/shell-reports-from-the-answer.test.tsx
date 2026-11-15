/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MutationRejectedError, type EngineMutation } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * ═══ A PRESS IS REPORTED FROM ITS ANSWER — THE SHELL'S ONE DISPATCH SEAM ════════════════════
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────
 *
 * `resurface_done` dispatched `triage_set: none`, marked the message read and raised "Done —
 * filed under Earlier" — all three without waiting for anything. On a READER install the service
 * refuses triage (`organized_elsewhere`), the engine rolls the optimistic overlay back, and the
 * refusal was discarded: the booking stood, the mail came back, and the person had been told it
 * was filed. The review round that widened this found the same habit in every verb the shell
 * dispatches — Later, Park, the resurface horizons, read marks, tags, the bulk verbs.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────
 *
 * The RENDERED sentence, never a source read. Nine families, one case each, all through
 * `mutateAndReport` / `mutateSetAndReport`:
 *
 *   1 Later · 2 Park · 3 Resurface (book) · 4 Resurface (clear) · 5 Resurface now ·
 *   6 Resurface at a chosen instant · 7 Done — the release · 8 Tags · 9 The bulk verbs
 *
 * plus the finding's own three: a reader's Done renders the refusal and files nothing, an
 * organizer's Done still files and still says so, and the interface agrees with the rollback.
 *
 * ── THE DOUBLE REFUSES THE WAY PRODUCTION REFUSES ───────────────────────────────────────────
 *
 * The refusal is thrown BY THE ADAPTER as a `MutationRejectedError` with the server's own code
 * and details — the same class, the same wrapping and the same place the wire adapter throws it,
 * so the engine rolls back exactly as it does live. A double that answered differently has
 * already hidden one press defect in this product.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * Mutate the SEAM — in `AppShell.mutateAndReport`, `if (!out.applied)` → `if (false)`, which is
 * the shape every one of these arms shipped with — and all nine families go red on the rendered
 * sentence together. The positive controls (an organizer's presses) stay green.
 */

(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = messages.ohbox as unknown as Record<string, string>;
/* The Done sentence up to its `{when}` placeholder — the release names the date the row is filed
   under, and `said` matches by inclusion. */
const doneSaid = copy.toastResurfaceDone!.replace(/\s*\{when\}.*$/u, "");
/** The refusal the seam renders for an organizer-only verb, with the holder named. */
const REFUSED = "Nothing changed — the laptop organizes this mailbox";

let roots: Root[] = [];
let host: HTMLElement | null = null;
let sent: EngineMutation[] = [];
/** Armed by a case: from here on the service refuses the way a reader install is refused. */
let refusing = false;
/** The refusal's `details` — a named holder, and the reason the server's decider chose, if any. */
const LIVE_HOLDER = { by: { kind: "local", name: "the laptop" } };
let refusal: Record<string, unknown> = LIVE_HOLDER;

beforeEach(() => {
  window.location.hash = "";
  sent = [];
  refusing = false;
  refusal = LIVE_HOLDER;
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
    if (refusing) {
      /* PRODUCTION'S OWN SHAPE: `assertOrganizerRole` raises `OrganizedElsewhereError`, the wire
         adapter turns it into this class with this code and these details, and the engine rolls
         the overlay back on it. Not retryable — a reader's refusal is settled, not a wait. */
      throw new MutationRejectedError("another install is organizing this mailbox", {
        status: 409, code: "organized_elsewhere", retryable: false,
        details: refusal,
      });
    }
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

const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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

/**
 * WHAT THE TOAST SAYS, and nothing else on the screen. `document.body.textContent` would have
 * made "Parked" true from the pile's own segment label — an assertion about the nav, not the
 * press.
 */
const said = (needle: string): boolean =>
  [...document.querySelectorAll('[role="status"]')]
    .some((n) => (n.textContent ?? "").includes(needle));
const barButton = (label: string): HTMLButtonElement | undefined =>
  [...host!.querySelectorAll<HTMLButtonElement>(".abar button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));
const kinds = (kind: string) => sent.filter((m) => m.kind === kind);

/** The cursor on the Ohbox's first row, the way every one of these presses reaches a message. */
async function cursorOnFirstRow(): Promise<string> {
  await key("j");
  const id = host!.querySelector<HTMLElement>(".view-ohbox .row.sel")?.dataset.id;
  expect(id, "`j` put the cursor on no row").toBeTruthy();
  return id!;
}

/** Book a return for the row under the cursor and land in the pile it moved to. */
async function bookAndOpenThePile(id: string): Promise<void> {
  await key("Enter");
  await click(barButton("Resurface"));
  await click(barButton("Tomorrow"));
  await waitFor(() => said("Resurfaces"), "the booking states its horizon");
  await act(async () => {
    window.location.hash = "#/triage/resurface";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await waitFor(
    () => host!.querySelector(`.view-triage .row[data-id="${id}"]`) != null,
    "the booked row is in the Resurface pile",
  );
}

describe("the finding: a reader install's Done says what the service answered", () => {
  it("renders the refusal, files nothing, and leaves the booking standing", async () => {
    await shell();
    const id = await cursorOnFirstRow();
    await bookAndOpenThePile(id);

    // From here the install is a reader: the service refuses organizer-only verbs.
    refusing = true;
    sent = [];
    const row = host!.querySelector<HTMLElement>(`.view-triage .row[data-id="${id}"]`);
    await click(row!.parentElement?.querySelector<HTMLButtonElement>(".rsf-done"));
    await waitFor(() => said(REFUSED), "the refusal is never rendered");

    expect(said(doneSaid), "the press claimed it filed the message").toBe(false);
    // HALF A RELEASE IS WORSE THAN NONE: the booking stands, so the deliberate read that would
    // file the row out of the pile is never sent.
    expect(kinds("mark_seen"), "the release was sent over a refused clear").toHaveLength(0);
    // …and the interface agrees with the engine's rollback: the row is still in its pile.
    expect(
      host!.querySelector(`.view-triage .row[data-id="${id}"]`),
      "the row left the pile the refusal kept it in",
    ).not.toBeNull();
  }, 20000);

  it("an organizer's Done still files and still says so (the positive control)", async () => {
    await shell();
    const id = await cursorOnFirstRow();
    await bookAndOpenThePile(id);

    sent = [];
    const row = host!.querySelector<HTMLElement>(`.view-triage .row[data-id="${id}"]`);
    await click(row!.parentElement?.querySelector<HTMLButtonElement>(".rsf-done"));
    await waitFor(() => said(doneSaid), "the release said nothing");
    expect(said(REFUSED), "an organizer was told a reader's refusal").toBe(false);
    await waitFor(
      () => kinds("mark_seen").length === 1,
      "the deliberate release never followed the cleared booking",
    );
  }, 20000);
});

describe("the seam: nine families, each refused, each told", () => {
  it("1 — Later", async () => {
    await shell();
    await cursorOnFirstRow();
    refusing = true;
    await key("e");
    await waitFor(() => said(REFUSED), "the refusal is never rendered");
    expect(said(copy.toastQueued!), "the press claimed the message was queued").toBe(false);
  }, 20000);

  it("2 — Park", async () => {
    await shell();
    await cursorOnFirstRow();
    refusing = true;
    await key("a");
    await waitFor(() => said(REFUSED), "the refusal is never rendered");
    expect(said(copy.toastAside!), "the press claimed the message was parked").toBe(false);
  }, 20000);

  it("3 — Resurface, booked from the key", async () => {
    await shell();
    await cursorOnFirstRow();
    refusing = true;
    await key("b");
    await waitFor(() => said(REFUSED), "the refusal is never rendered");
    expect(said("Resurfaces"), "the press claimed a return it had not booked").toBe(false);
  }, 20000);

  it("4 — Resurface, from the pile's own key", async () => {
    // Since that change `b` in the pile opens the chooser its button opens (it used to clear the
    // booking); this family's door is that key, and its refused answer is still told.
    await shell();
    const id = await cursorOnFirstRow();
    await bookAndOpenThePile(id);
    refusing = true;
    await key("b");
    await click(barButton("Now"));
    await waitFor(() => said(REFUSED), "the refusal is never rendered");
    expect(said(copy.toastResurfaceNow!), "the press claimed the message was back at the top").toBe(false);
  }, 20000);

  it("5 — Resurface now", async () => {
    await shell();
    await cursorOnFirstRow();
    await key("Enter");
    refusing = true;
    await click(barButton("Resurface"));
    await click(barButton("Now"));
    await waitFor(() => said(REFUSED), "the refusal is never rendered");
    expect(said(copy.toastResurfaceNow!), "the press claimed the message was back at the top").toBe(false);
  }, 20000);

  it("6 — Resurface at a chosen instant", async () => {
    await shell();
    await cursorOnFirstRow();
    await key("Enter");
    refusing = true;
    await click(barButton("Resurface"));
    await click(barButton("Tomorrow"));
    await waitFor(() => said(REFUSED), "the refusal is never rendered");
    expect(said("Resurfaces"), "the press claimed a return it had not booked").toBe(false);
  }, 20000);

  it("7 — Done, the release", async () => {
    await shell();
    const id = await cursorOnFirstRow();
    await bookAndOpenThePile(id);
    refusing = true;
    const row = host!.querySelector<HTMLElement>(`.view-triage .row[data-id="${id}"]`);
    await click(row!.parentElement?.querySelector<HTMLButtonElement>(".rsf-done"));
    await waitFor(() => said(REFUSED), "the refusal is never rendered");
    expect(said(doneSaid), "the press claimed it filed the message").toBe(false);
  }, 20000);

  it("8 — Tags", async () => {
    await shell();
    await cursorOnFirstRow();
    await key("Enter");
    await click(barButton("Tag"));
    const option = host!.querySelector<HTMLElement>('.tagp li[role="option"]');
    expect(option, "the tag picker offered nothing to press").toBeTruthy();
    refusing = true;
    await click(option);
    await waitFor(() => said(REFUSED), "the refusal is never rendered");
    expect(said("Tagged"), "the press claimed the tag was applied").toBe(false);
  }, 20000);

  it("9 — the bulk verbs, one sentence for the set", async () => {
    await shell();
    await cursorOnFirstRow();
    // ⇧↓ starts a selection — the shell's own pick gesture.
    await key("ArrowDown", { shiftKey: true });
    await waitFor(
      () => host!.querySelectorAll(".view-ohbox .row.picked, .view-ohbox .row[aria-selected='true']").length > 0,
      "nothing was picked",
    );
    refusing = true;
    await key("e");
    await waitFor(() => said(REFUSED), "the refusal is never rendered");
    expect(said("queued in Answer Later"), "the set claimed a count nothing applied").toBe(false);
  }, 20000);
});

describe("a refusal whose holder stopped names nobody (the server's reason, not its holder)", () => {
  it("no_organizer: nothing organizes this mailbox, and the laptop is not called the organizer", async () => {
    await shell();
    await cursorOnFirstRow();
    refusal = { by: { kind: "local", name: "the laptop" }, reason: "no_organizer" };
    refusing = true;
    await key("e");
    await waitFor(() => said(copy.refusedNobody!), "the nobody sentence is never rendered");
    expect(said(REFUSED), "a machine that stopped was called the organizer").toBe(false);
  }, 20000);

  it("CONTROL: organizer_outdated keeps the holder's name", async () => {
    await shell();
    await cursorOnFirstRow();
    refusal = { by: { kind: "local", name: "the laptop" }, reason: "organizer_outdated" };
    refusing = true;
    await key("e");
    await waitFor(() => said(REFUSED), "the named refusal is never rendered");
    expect(said(copy.refusedNobody!)).toBe(false);
  }, 20000);
});

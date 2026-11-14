/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { type EngineMutation } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * "DONE" ON A RESURFACE, DRIVEN THROUGH THE SHELL — what the verb puts on the wire.
 *
 * `ohbox-resurface-done.test.tsx` pins where the control renders and that it dispatches
 * `resurface_done`. This counts what the SHELL does with that dispatch, at the adapter, because
 * both failure shapes are silent there:
 *
 *   · `onMessageAction`'s switch ends in a `default` that parses anything unrecognised as
 *     `move:<view>` — a missing case is a no-op, not an error (the `resurface_now` lesson);
 *   · the release must be THE EXISTING deliberate `mark_seen` — no `via`, and for a PINNED
 *     message NO `triage_set` beside it. A `triage_set: none` on a pinned row would be a second
 *     writer of the fact the server's `spendResurface` already writes inside the read's own
 *     transaction; a `via` would make the release a glance, which the engine drops for pins.
 *
 * And the choreography the release buys is asserted on the same mount: the pin is spent
 * first-frame (the control disappears with it), and after the slide the row files back at its
 * ARRIVAL slot in "Earlier" — a resurfaced row is never held open, so Done is no open read and
 * places nothing (owner 2026-09-18, narrowed 2026-10-07). The row pinned is NOT the newest of
 * Earlier, so the top and the arrival slot are different answers.
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

const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

/** An action-bar control by the START of its label — labels carry keycaps. */
const barButton = (label: string): HTMLButtonElement | undefined =>
  [...host!.querySelectorAll<HTMLButtonElement>(".abar button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));

const kinds = (kind: string) => sent.filter((m) => m.kind === kind);

/** The ids rendered in a labelled listbox, top to bottom. */
function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll(".row[data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

/**
 * Put the cursor on Earlier's SECOND row — older than the first, so "the top" and "its arrival
 * slot" differ — and return Earlier as it stood.
 */
async function cursorOnOlderEarlierRow(): Promise<string[]> {
  const before = idsInGroup("Earlier");
  expect(before.length, "the demo's Earlier needs two rows").toBeGreaterThan(1);
  await click(host!.querySelector(`[role="listbox"][aria-label="Earlier"] .row[data-id="${before[1]}"]`));
  expect(host!.querySelector<HTMLElement>(".row.sel")?.dataset.id).toBe(before[1]);
  return before;
}

/** Pin the message under the cursor via the chooser, and return its id. */
async function pinSelected(): Promise<string> {
  const id = host!.querySelector<HTMLElement>(".row.sel")?.dataset.id;
  expect(id, "no row under the cursor").toBeTruthy();
  await key("Enter");
  await click(barButton("Resurface"));
  await click(barButton("Now"));
  expect(idsInGroup("Resurfaced")).toContain(id!);
  return id!;
}

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

describe("Done on a PINNED message — the deliberate release, nothing else", () => {
  it("the bar offers Done in the read slot, and no bare Mark-as-read beside it", async () => {
    await mountShell();
    await pinSelected();
    expect(barButton("Done"), "the pinned message's bar has no Done").toBeTruthy();
    // The slot is a slot: on a pinned message the release owns it, the plain directions do not.
    expect(barButton("Mark read")).toBeUndefined();
    expect(barButton("Mark unread")).toBeUndefined();
  });

  it("clicking it sends ONE deliberate mark_seen — no via, no triage_set", async () => {
    await mountShell();
    const id = await pinSelected();

    sent = [];
    await click(barButton("Done"));

    const seen = kinds("mark_seen") as Array<{ messageIds: string[]; unread: boolean; via?: string }>;
    expect(seen, "the press reached the adapter as nothing at all").toHaveLength(1);
    expect(seen[0]!.messageIds).toEqual([id]);
    expect(seen[0]!.unread).toBe(false);
    // Deliberate means NO label: a `via: "glance"` here would be dropped by the engine's pin
    // filter and the release would never reach the server.
    expect(seen[0]!.via, "the release was labelled a glance").toBeUndefined();
    // And no second writer: the read itself spends the pin, on both sides of the wire.
    expect(kinds("triage_set"), "a triage_set rode along with the release").toHaveLength(0);
  });

  it("the pin is spent first-frame, and the row files back at its ARRIVAL slot in Earlier", async () => {
    await mountShell();
    const before = await cursorOnOlderEarlierRow();
    const id = await pinSelected();

    await click(barButton("Done"));
    // First frame: the release control is gone with the pin it released (the row itself keeps
    // its slot for the slide — see `MessageRow.actions` — but offers nothing).
    expect(host!.querySelector(".rsf-done"), "a spent pin still offers Done").toBeNull();

    // The slide (SETTLE_MS = 280) re-files the row under "Earlier" at its arrival slot: the
    // release stamps `lastReadAt`, which is state and sorts nothing, and writes no open read.
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(idsInGroup("Resurfaced")).toEqual([]);
    const earlier = idsInGroup("Earlier");
    expect(earlier.indexOf(id), "Done placed the row somewhere other than its arrival").toBe(1);
    expect(earlier).toEqual(before);
  });
});

/**
 * The Ohbox's Resurfaced block is one row per CONVERSATION now, so its Done goes through the
 * batched `bulk.run("done", ids)` seam rather than the per-message `onAction` the bar uses. That
 * is a NEW case in `onBulkAction`, and this file's own premise applies to it hardest: the switch
 * it lives in ends in a `default` that parses anything unrecognised as `move:<view>`, so a typo
 * in the case label does not fail — it MOVES the conversation.
 */
describe("Done on the Resurfaced ROW — the batched release, at the adapter", () => {
  it("sends ONE deliberate mark_seen for the row's members, and moves nothing", async () => {
    await mountShell();
    const id = await pinSelected();

    sent = [];
    const rowEl = host!.querySelector<HTMLElement>(`[role="listbox"][aria-label="Resurfaced"] .row[data-id="${id}"]`);
    expect(rowEl, "the pinned row is not under Resurfaced").toBeTruthy();
    await click(rowEl!.parentElement?.querySelector<HTMLButtonElement>(".rsf-done"));

    const seen = kinds("mark_seen") as Array<{ messageIds: string[]; unread: boolean; via?: string }>;
    expect(seen, "the row's Done reached the adapter as nothing at all").toHaveLength(1);
    expect(seen[0]!.messageIds).toEqual([id]);
    expect(seen[0]!.unread).toBe(false);
    expect(seen[0]!.via, "the release was labelled a glance").toBeUndefined();
    // This member carries no booking, so there is nothing to clear — and NOTHING MOVED, which is
    // what the `default` arm would have done with an action label it did not know.
    expect(kinds("triage_set"), "a triage_set rode along with a pin that had no booking").toHaveLength(0);
    expect(kinds("move"), "the release was parsed as a move").toHaveLength(0);
  });

  it("spends the pin first-frame and files the row at its arrival slot, as the bar's Done does", async () => {
    await mountShell();
    const before = await cursorOnOlderEarlierRow();
    const id = await pinSelected();
    const rowEl = host!.querySelector<HTMLElement>(`[role="listbox"][aria-label="Resurfaced"] .row[data-id="${id}"]`);
    await click(rowEl!.parentElement?.querySelector<HTMLButtonElement>(".rsf-done"));

    await act(async () => { vi.advanceTimersByTime(400); });
    expect(idsInGroup("Resurfaced")).toEqual([]);
    expect(idsInGroup("Earlier").indexOf(id)).toBe(1);
    expect(idsInGroup("Earlier")).toEqual(before);
  });
});

describe("Done on a SCHEDULED row — the same release, plus the cancelled booking", () => {
  it("the pile row's Done sends triage_set:none AND the deliberate mark_seen", async () => {
    await mountShell();
    // Book a return for the message under the cursor: Resurface → Tomorrow parks it into the
    // Resurface pile (one pile only — it leaves the Ohbox entirely).
    const id = host!.querySelector<HTMLElement>(".row.sel")?.dataset.id;
    expect(id).toBeTruthy();
    await key("Enter");
    await click(barButton("Resurface"));
    await click(barButton("Tomorrow"));

    // To the Resurface pile — by the hash, the way a link arrives, because jsdom's own
    // hashchange task does not run under fake timers.
    await act(async () => {
      window.location.hash = "#/triage/resurface";
      window.dispatchEvent(new Event("hashchange"));
    });

    const rowEl = host!.querySelector<HTMLElement>(`.view-triage .row[data-id="${id}"]`);
    expect(rowEl, "the booked message is not in the Resurface pile").toBeTruthy();
    const done = rowEl!.parentElement?.querySelector<HTMLButtonElement>(".rsf-done");

    sent = [];
    await click(done);

    // The booking is cancelled — the same un-triage the horizon toggles use, never a new state…
    const sets = kinds("triage_set") as Array<{ messageId: string; state: string }>;
    expect(sets).toHaveLength(1);
    expect(sets[0]!.messageId).toBe(id);
    expect(sets[0]!.state).toBe("none");
    // …and the SAME deliberate release files it: read, stamped, top of Earlier.
    const seen = kinds("mark_seen") as Array<{ messageIds: string[]; unread: boolean; via?: string }>;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.messageIds).toEqual([id]);
    expect(seen[0]!.unread).toBe(false);
    expect(seen[0]!.via).toBeUndefined();

    // The pile lets go of the row in the same gesture.
    expect(host!.querySelector(`.view-triage .row[data-id="${id}"]`)).toBeNull();
  });
});

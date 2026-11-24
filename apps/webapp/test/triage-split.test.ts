/** @vitest-environment jsdom */
/**
 * ═══ TRIAGE IS THE OHBOX'S COMPOSITION, NOT A STACK OF TILES ══════════════════════════════
 *
 * The three horizons were `PilesStack` — a tile per entry, showing a name and a subject and
 * nothing else. They are piles of the reader's own mail and they were the only piles in the
 * product that could not be READ from: no time, no unread state, no tags, no attachment badge,
 * and no way to open the message. Answering something parked meant remembering where it was
 * and finding it again in the Ohbox.
 *
 * `TriageView` now composes `ListPane` + the shared Reader — the same two components the Ohbox,
 * Tag and History compose — so reading a triage message is the same act, with the same verbs,
 * as reading an Ohbox message.
 *
 * ── WHAT EACH ASSERTION IS FOR ──────────────────────────────────────────────────────────
 *
 *  · **Reverting to tiles is impossible.** The first block pins the composition from both
 *    ends: the list and reading columns are present, AND `.piles` / `.pile-item` — the tile
 *    stack's own classes — are absent. A test that only asserted the new markup would pass a
 *    view that rendered both.
 *
 *  · **The segments are HEADER furniture.** `ListPane.header` renders between the title and
 *    the scroller, which is what keeps the switcher and the Reply Run on screen while a long
 *    pile scrolls. Put them back inside the scroller and the second block goes red — the whole
 *    point of moving the run was that on a pile of any length it had been below the fold.
 *
 *  · **The Reply Run still clears `reply_later`.** The button moved; the wiring did not. The
 *    last block drives the run FROM THE HEADER BUTTON and asserts the `triage_set` that
 *    discharges the debt, which is the one thing a re-layout could plausibly break by wiring
 *    the new button to something else. `reply-run.test.ts` owns the run's own semantics (a
 *    failed send discharges nothing); this owns the fact that the header's button is that run.
 */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine, type MutationResult } from "@ohmail/client-engine";
import { triage } from "@ohmail/testing";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/**
 * The demo world's first Answer Later sender, READ FROM the fixture rather than spelled here.
 *
 * Which ids the demo parks is not this file's subject and it has moved once already: the pile was
 * `giulia`/`petra` until the one-pile rule honoured it and took both out of the Ohbox, so the
 * fixture now parks two mails written for the pile. A hard-coded name that has drifted off it
 * fails as "the pile rendered no rows" — a composition failure this file would be right to
 * report, and wrong about.
 */
const FIRST_SENDER = triage.replyLater[0]!.title;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let dispatched: EngineMutation[] = [];
const REAL_MUTATE = OhmailEngine.prototype.mutate;

beforeEach(() => {
  dispatched = [];
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked; the in-memory half still runs */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    // `false` is the SPLIT width: `readColumnHidden()` asks `(max-width: 699.98px)`, so a
    // non-matching query is a desktop window with a reading column beside the list.
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(OhmailEngine.prototype, "mutate").mockImplementation(async function patched(
    this: OhmailEngine, m: EngineMutation,
  ): Promise<MutationResult> {
    dispatched.push(m);
    return REAL_MUTATE.call(this, m);
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function drain(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve(); });
}

async function mountTriage(pile = ""): Promise<void> {
  const { DemoShell } = await import("../app/(product)/demo/DemoShell");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(DemoShell, { serverDemo: true, says: { service: "managed", sendCeiling: "strict" } }) }),
        }),
      }),
    );
  });
  await drain(10);
  await act(async () => {
    window.location.hash = pile ? `#/triage/${pile}` : "#/triage";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await drain();
  await screen.findByRole("heading", { name: "Triage" });
}

const later = () => within(screen.getByRole("listbox", { name: "Answer Later" }));
const reader = () => within(screen.getByRole("region", { name: "Reading" }));
const switcher = () => screen.getByRole("group", { name: "Piles" });
const select = async (name: RegExp): Promise<void> => {
  await act(async () => within(switcher()).getByRole("button", { name }).click());
  await drain();
};
const laterRow = () => later().getByRole("option", { name: new RegExp(FIRST_SENDER) });

const kindsOf = (kind: string): EngineMutation[] => dispatched.filter((m) => m.kind === kind);

describe("triage renders a list and a reader", () => {
  it("is the split composition — a list column and a reading column, and no tile stack", async () => {
    await mountTriage();

    const list = screen.getByRole("listbox", { name: "Answer Later" });
    const reading = screen.getByRole("region", { name: "Reading" });
    expect(list.contains(reading)).toBe(false);
    expect(reading.contains(list)).toBe(false);
    expect(laterRow()).toBeTruthy();
  });

  it("opens a message in the reading column, with the message pane's own verbs", async () => {
    await mountTriage();
    const row = laterRow();
    const selected = row.getAttribute("aria-label");
    await act(async () => { row.click(); });
    await drain();
    const heading = reader().getByRole("heading", { level: 2 });
    expect(selected).toContain(heading.textContent);
    expect(reader().getByRole("button", { name: /^Reply/ })).toBeTruthy();
    expect(reader().getByRole("button", { name: /^Forward/ })).toBeTruthy();
  });
});

describe("the pile switcher and the Reply Run are header furniture", () => {
  it("puts the segments ABOVE the scroller, not inside it", async () => {
    await mountTriage();

    const seg = switcher();
    const rows = screen.getByRole("listbox", { name: "Answer Later" });
    const scroller = rows.closest("[tabindex]");
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(seg)).toBe(false);
    expect(seg.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const name of [/^Answer Later \d/, /^Parked \d/, /^Resurface \d/]) {
      expect(within(seg).getByRole("button", { name })).toBeTruthy();
    }
  });

  it("keeps the Reply Run on the Answer Later pane only, in the header", async () => {
    await mountTriage();
    const start = screen.getByRole("button", { name: "Reply Run" });
    const rows = screen.getByRole("listbox", { name: "Answer Later" });
    expect(start.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const scroller = rows.closest("[tabindex]");
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(start)).toBe(false);

    await select(/^Parked/);
    await waitFor(() => expect(within(switcher()).getByRole("button", { name: /^Parked/ }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByRole("button", { name: "Reply Run" })).toBeNull();
    const parked = within(screen.getByRole("listbox", { name: "Parked" }));
    expect(parked.getAllByRole("option").map((row) => row.querySelector(".oh-row-who")?.textContent))
      .toEqual(triage.setAside.map((letter) => letter.title));
  });

  it("switching horizons drops the cursor — the reader never keeps the last pile's mail", async () => {
    await mountTriage();
    const row = laterRow();
    await act(async () => { row.click(); });
    await drain();
    const previous = reader().getByRole("heading", { level: 2 }).textContent!;
    await select(/^Resurface/);
    expect(reader().queryByRole("heading", { name: previous })).toBeNull();
  });
});

describe("the header's Reply Run IS the run, and it still clears reply_later", () => {
  it("opens the run over the Answer Later pile and discharges the debt on a delivered reply", async () => {
    await mountTriage();
    const first = laterRow().getAttribute("aria-label");
    const start = screen.getByRole("button", { name: "Reply Run" });
    await act(async () => { start.click(); });
    const box = await screen.findByRole("textbox", { name: "Reply body" });
    const panel = within(screen.getByRole("toolbar", { name: "Reply run" }));
    expect(first).toContain(reader().getByRole("heading", { level: 2 }).textContent);

    await act(async () => { typeInto(box, "Grazie mille — perfetto."); });
    await act(async () => { panel.getByRole("button", { name: "Done → next" }).click(); });
    await drain(12);

    expect(kindsOf("mail_send"), "Done did not send").toHaveLength(1);
    // THE DEBT. `reply-send.ts:settle` writes it; a re-layout that wired the header button to
    // anything but `onStartFR` would leave this empty while everything else still looked right.
    const cleared = kindsOf("triage_set") as Array<{ state?: string }>;
    expect(cleared.length, "the delivered reply cleared no triage state").toBeGreaterThan(0);
    expect(cleared.map((m) => m.state), "the reply set a state other than `none`")
      .toContain("none");
  });
});

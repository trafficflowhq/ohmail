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
 * `TriageView` now composes `ListPane` + `MessagePane` — the same two components the Ohbox,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine, type EngineMutation, type MutationResult } from "@ohmail/client-engine";
import { triage } from "@ohmail/testing";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";

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
  const { AppShell } = await import("../app/shell/AppShell.js");
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
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
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
}

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);
const all = (sel: string): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(sel)];
const rowNames = (): string[] =>
  all(".view-triage .list-col .rows .row .who").map((n) => n.textContent ?? "");
const kindsOf = (kind: string): EngineMutation[] => dispatched.filter((m) => m.kind === kind);

describe("triage renders a list and a reader", () => {
  it("is the split composition — a list column and a reading column, and no tile stack", async () => {
    await mountTriage();

    const view = q<HTMLElement>(".view-triage");
    expect(view, "triage did not render at all").not.toBeNull();
    expect(view!.classList.contains("split"), "triage is not the split layout").toBe(true);
    expect(q(".view-triage .list-col"), "triage has no list column").not.toBeNull();
    expect(q(".view-triage .read-col"), "triage has no reading column").not.toBeNull();

    // The tiles, by their own class names. This is the half that makes a revert impossible.
    expect(q(".view-triage .piles"), "the PilesStack tile stack is back").toBeNull();
    expect(q(".view-triage .pile-item"), "triage is rendering tiles again").toBeNull();

    expect(rowNames(), "the demo Answer Later pile rendered no rows").toContain(FIRST_SENDER);
  });

  it("opens a message in the reading column, with the message pane's own verbs", async () => {
    await mountTriage();
    const row = all(".view-triage .list-col .rows button.row").find(
      (r) => (r.querySelector(".who")?.textContent ?? "") === FIRST_SENDER,
    );
    expect(row, `no openable row for ${FIRST_SENDER}`).toBeDefined();

    await act(async () => { row!.click(); });
    await drain();

    const pane = q<HTMLElement>(".view-triage .read-col .msg");
    expect(pane, "clicking a triage row opened no message pane").not.toBeNull();
    // The pane's action bar is what makes this the Ohbox's reader and not a preview.
    expect(
      q(".view-triage .read-col .abar"),
      "the reading column has no action bar — triage mail still has no verbs",
    ).not.toBeNull();
  });
});

describe("the pile switcher and the Reply Run are header furniture", () => {
  it("puts the segments ABOVE the scroller, not inside it", async () => {
    await mountTriage();

    const seg = q<HTMLElement>(".view-triage .triage-seg");
    expect(seg, "the pile switcher is gone").not.toBeNull();
    expect(
      seg!.parentElement!.classList.contains("list-col"),
      "the pile switcher is back inside the scroller — it would scroll away with the rows",
    ).toBe(true);
    expect(
      q(".view-triage .scroller .triage-seg"),
      "the pile switcher is inside the scroller",
    ).toBeNull();

    // Three positions, each carrying its own count — the question this screen answers first.
    const labels = all(".view-triage .triage-seg button").map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.startsWith("Answer Later")), `segments were: ${labels}`).toBe(true);
    expect(labels.some((l) => l.startsWith("Parked")), `segments were: ${labels}`).toBe(true);
    expect(labels.some((l) => l.startsWith("Resurface")), `segments were: ${labels}`).toBe(true);
  });

  it("keeps the Reply Run on the Answer Later pane only, in the header", async () => {
    await mountTriage();
    const cta = q<HTMLElement>(".view-triage .triage-cta");
    expect(cta, "the Reply Run row is gone").not.toBeNull();
    expect(
      cta!.parentElement!.classList.contains("list-col"),
      "the Reply Run is back inside the scroller — on a long pile it is below the fold",
    ).toBe(true);
    expect(cta!.querySelector("button"), "the Reply Run button is gone").not.toBeNull();

    // Parked: the same row, the pile's own sentence, and NO button that acts on another pile.
    await act(async () => {
      window.location.hash = "#/triage/aside";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await drain();
    expect(
      q(".view-triage .triage-cta button"),
      "the Reply Run is offered on Parked, where it operates on a different pile",
    ).toBeNull();
    expect(q<HTMLElement>(".view-triage .triage-cta")!.textContent)
      .toContain("Held here until you come back for it.");
  });

  it("switching horizons drops the cursor — the reader never keeps the last pile's mail", async () => {
    await mountTriage();
    const row = all(".view-triage .list-col .rows button.row")[0]!;
    await act(async () => { row.click(); });
    await drain();
    const first = q<HTMLElement>(".view-triage .read-col .msg")!.textContent ?? "";

    await act(async () => {
      window.location.hash = "#/triage/resurface";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await drain();

    const after = q<HTMLElement>(".view-triage .read-col .msg")?.textContent ?? "";
    expect(after, "the reader is still on the previous pile's message").not.toBe(first);
  });
});

describe("the header's Reply Run IS the run, and it still clears reply_later", () => {
  it("opens the run over the Answer Later pile and discharges the debt on a delivered reply", async () => {
    await mountTriage();
    expect(rowNames(), "the demo pile is empty — nothing below would prove anything")
      .toContain(FIRST_SENDER);

    await act(async () => { q<HTMLButtonElement>(".view-triage .triage-cta button")!.click(); });
    await drain();
    // The run's editor is behind `RichEditorLazy` — one seam, one helper.
    await settleEditor();

    const box = q<HTMLElement>(".fr-card .rte-surface");
    expect(box, "the header's Reply Run button did not open the run").not.toBeNull();
    // It is the ANSWER LATER pile the run stepped into, not some other list.
    expect(q(".fr-card h3")?.textContent ?? "", "the run opened on a message from another pile")
      .not.toBe("");

    await act(async () => { typeInto(box!, "Grazie mille — perfetto."); });
    await act(async () => { q<HTMLButtonElement>(".fr-foot button")!.click(); });
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

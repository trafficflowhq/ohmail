/** @vitest-environment jsdom */
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore, senderKey,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import type { ScreenerState } from "@ohmail/app-logic/screener/screener-state";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE SCREENER'S FILTER CHIPS — and the apply count they were built to make legible.
 *
 * "Apply 12 — Ohbox, News & Receipts" over a queue of nineteen is a true sentence that leaves
 * seven senders unaccounted for. It is true because the bulk deliberately refuses the senders the
 * model held or was never asked about — but nothing on screen said so, and a reader pressing it
 * had no way to find out which seven were being stepped over or where they had gone.
 *
 * So the two claims under test are the two halves of that fix:
 *
 *  1. THE COUNTS ARE THE STORE'S. The apply-able chips add up to `suggestedCount` exactly,
 *     and the chips that carry a number are exactly `suggestedDests`. Both are read off the live
 *     state object, so a chip derived from a second, drifting predicate goes red here rather
 *     than shipping a partition that disagrees with the button above it.
 *  2. THE FILTER IS A VIEW, NOT A DECISION. Pressing a chip narrows the list and touches
 *     nothing else — no mutation, no mirror write, and the queue's own counts are unmoved.
 *
 * SPAM IS ONE OF THE APPLY-ABLE CHIPS, and used to be part of the remainder. The bulk once refused
 * to file a spam verdict — which is what "it stops at the spam and shows one only the remaining
 * spam messages" looked like from the outside — and now files it like any other destination. The
 * chip is in the same place because both lists come from `APPLY_PILE_ORDER`; what changed is which
 * side of the sum it falls on, which is exactly what the first test measures.
 *
 * MUTATION WATCH — each of these was applied to `ScreenerView.tsx`, watched go red, and reverted
 * (2026-08-09):
 *   · `filterGroupOf` sending a hold and a `noAnswer` to the `screened` chip instead of `none`
 *     → the counts test.
 *   · `items` left unfiltered while a chip is pressed → the narrowing test.
 *   · `FilterChips`' `shown.length < 2` relaxed to `< 1` → the no-partition test.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;

function held(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

async function engineWith(mail: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    mail.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
}

/**
 * ONE SENDER PER SUGGESTION SHAPE, so every chip has something to count.
 *
 * Two News on purpose: a chip whose count is always 1 cannot tell a count from a presence.
 */
const WORLD: Array<{ address: string; dest: string | null; noAnswer?: string }> = [
  { address: "box@example.test", dest: "ohbox" },
  { address: "read1@example.test", dest: "reads" },
  { address: "read2@example.test", dest: "reads" },
  { address: "bill@example.test", dest: "receipts" },
  { address: "out@example.test", dest: "screened" },
  { address: "junk@example.test", dest: "spam" },
  { address: "hold@example.test", dest: "screener" },
  { address: "unasked@example.test", dest: "screener", noAnswer: "out_of_credits" },
  { address: "never@example.test", dest: null },
];

function overlay(): ReadonlyMap<string, unknown> {
  const m = new Map<string, unknown>();
  for (const w of WORLD) {
    if (!w.dest) continue;
    m.set(senderKey(w.address), {
      dest: w.dest, confidence: 0.9, rationale: "because",
      ...(w.noAnswer ? { noAnswer: w.noAnswer } : {}),
    });
  }
  return m;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

/** Mount the REAL waiting Screener over the REAL state hook. */
async function mount(only?: string[]): Promise<{ latest: () => ScreenerState }> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");
  const world = only ? WORLD.filter((w) => only.includes(w.address)) : WORLD;
  const engine = await engineWith(
    world.map((w, i) => held(`m${i}`, w.address, 9 + (i % 12))),
  );

  let live: ScreenerState | null = null;
  const suggestions = overlay();

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText(), suggestions as never);
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: null, screened: null, spam: null,
    });
    live = state;
    return h(ScreenerView, {
      owed: false,
      state,
      segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(KeymapProvider, { children: h(Probe) }),
        }),
      }),
    );
  });
  await flush();
  await settleFirstPaint();
  return { latest: () => live! };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

/** The chips, as `{ label: count }` read straight off the rendered row. */
function chips(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of host!.querySelectorAll(".scn-chips .scn-chip")) {
    const n = b.querySelector(".num")?.textContent ?? "";
    out[(b.textContent ?? "").replace(n, "").trim()] = Number(n);
  }
  return out;
}

async function pressChip(label: string): Promise<void> {
  const b = [...host!.querySelectorAll<HTMLElement>(".scn-chips .scn-chip")].find(
    (x) => (x.textContent ?? "").trim().startsWith(label),
  );
  if (!b) throw new Error(`no chip "${label}" — on screen: ${Object.keys(chips()).join(", ")}`);
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

const rowCount = () => host!.querySelectorAll(".rows .row").length;

describe("the Screener's filter chips", () => {
  it("counts every group, and the apply-able five add up to the number on the apply button", async () => {
    const { latest } = await mount();
    const st = latest();
    const c = chips();

    // Premise: the queue really is the nine senders below, or a green means nothing.
    expect(st.waitingCount).toBe(9);

    expect(c).toEqual({
      All: 9,
      Ohbox: 1,
      News: 2,
      Receipts: 1,
      "Screened out": 1,
      Spam: 1,
      // The hold, the sender the run could not answer for, and the sender nobody bought advice
      // for are ONE group: three reasons, one thing left to do about them.
      "No suggestion": 3,
    });

    // ── THE IDENTITY THIS ROW EXISTS FOR ────────────────────────────────────────────────────
    // The five the bulk WILL file add up to the count on its button; the one it steps over is
    // the remainder, and it is now on screen instead of being implied by a gap.
    const applyable = c.Ohbox + c.News + c.Receipts + c["Screened out"]! + c.Spam!;
    expect(applyable).toBe(st.suggestedCount);
    expect(applyable + c["No suggestion"]!).toBe(st.waitingCount);

    // And the piles the button NAMES are exactly the apply-able chips carrying a number.
    expect(st.suggestedDests).toEqual(["ohbox", "reads", "receipts", "screened", "spam"]);

    // The button's own label, over the same set — the sentence the chips explain.
    const apply = [...host!.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").startsWith("Apply "),
    );
    // `toContain`, because the Button carries its own `a` keycap after the label.
    expect(apply?.textContent).toContain("Apply 6 — Ohbox, News, Receipts, Screened out & Spam");
  });

  it("a chip narrows the list and decides nothing", async () => {
    const { latest } = await mount();
    expect(rowCount()).toBe(9);

    await pressChip("News");
    expect(rowCount(), "the News chip did not narrow the list to its own two senders").toBe(2);
    for (const row of host!.querySelectorAll(".rows .row")) {
      expect(row.textContent).toMatch(/read[12]@example\.test/);
    }

    // A VIEW, NOT A DECISION. Nothing was filed, so the queue is the size it was.
    const st = latest();
    expect(st.waitingCount).toBe(9);
    expect(st.waiting.filter((w) => st.isExiting(w.id))).toHaveLength(0);
    // …and the apply button still names the whole set it would act on, not the filtered view.
    const apply = [...host!.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").startsWith("Apply "),
    );
    expect(apply?.textContent).toContain("Apply 6 — Ohbox, News, Receipts, Screened out & Spam");

    // Pressing the pressed chip is the way back.
    await pressChip("News");
    expect(rowCount()).toBe(9);
  });

  it("the group nobody can act on is still visible and still selectable", async () => {
    // The whole point: the held senders are the invisible remainder of the apply count.
    // Filtering to them has to WORK, or the row only names the gap without closing it.
    await mount();
    await pressChip("No suggestion");
    expect(rowCount()).toBe(3);
    // Spam is on the other side of the sum now — an apply-able pile — and still filters.
    await pressChip("Spam");
    expect(rowCount()).toBe(1);
  });

  it("offers no chips at all when there is no partition to make", async () => {
    // Every sender in one group is a row of one chip, which filters the list to itself. An
    // inert control the reader has to try before learning it does nothing.
    await mount(["never@example.test", "hold@example.test"]);
    expect(host!.querySelector(".scn-chips")).toBeNull();
    expect(rowCount()).toBe(2);
  });
});

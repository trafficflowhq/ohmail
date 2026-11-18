/** @vitest-environment jsdom */
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE TWO BULK RUNS, AS TRACKS — and the arithmetic that must never reach the screen.
 *
 * Buying suggestions and applying them are both several seconds of work dispatched a chunk (or a
 * row) at a time, and until now the only evidence either was happening was a sentence whose
 * numbers changed. Both paths publish their progress as TWO NUMBERS beside that sentence rather
 * than as a string to be parsed back out of it — see `SuggestBatchControl.progress` — and this is
 * the surface reading them.
 *
 * Three claims, and the third is the one worth writing a file for:
 *
 *  1. A RUNNING BULK DRAWS A TRACK, off the field, with the field's own two numbers.
 *  2. NO FIELD, NO TRACK. Both fields are null in every state but "in flight", so a finished run
 *     leaves nothing behind — a filled bar that never goes away is a claim that work is still
 *     happening.
 *  3. A DENOMINATOR OF ZERO DRAWS NOTHING. `value/max` with `max` of 0 is an indeterminate bar
 *     and `NaN%` in the accessibility tree: a run that claims to be in flight for ever, narrated
 *     as arithmetic that went wrong. There is no honest track without a total, so there is no
 *     track.
 *
 * MUTATION WATCH — each of these was applied to `ScreenerView.tsx`, watched go red, and reverted
 * (2026-08-09):
 *   · `BulkProgress`' `total > 0` guard relaxed to `total < 0` → both zero-denominator tests.
 *   · the suggest bar rendered unconditionally, defaulting a null `progress` to `0 of 40` →
 *     the not-in-flight test.
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
 * The hosted purchase control, mid-run.
 *
 * Hand-built rather than driven through the hook — `screener-suggest.test.tsx` owns the hook's
 * own behaviour, and what is under test here is the VIEW's decision about what to draw from the
 * fields it is handed.
 */
const running = (progress: { done: number; total: number } | null) => ({
  available: 40, sizes: [40], size: 40, phase: "running" as const,
  quote: { senders: 40, credits: 40 },
  notice: "3 of 40 suggested…",
  progress,
  open: () => {}, choose: () => {}, confirm: () => {}, cancel: () => {},
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

/**
 * Mount the real waiting Screener; `applying` is overlaid on the real state object.
 *
 * The overlay is the point: `ScreenerState.applying` is the bulk's own bookkeeping, dispatched
 * one row per 240ms timer, and reproducing ten seconds of that here would test the reducer.
 * What must be guarded is that the VIEW renders the field it is given and nothing else — so the
 * field is given, directly, in each of the three states it can be in.
 */
async function mount(props: {
  suggest?: unknown;
  applying?: { done: number; total: number } | null;
  /** Further fields laid over the real state — the apply verb's gate, for the run-dress case. */
  overlay?: Record<string, unknown>;
}): Promise<HTMLElement> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const engine = await engineWith([held("m1", "one@example.test", 9)]);

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const real = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText());
    const state = {
      ...real,
      ...(props.applying === undefined ? {} : { applying: props.applying }),
      ...(props.overlay ?? {}),
    };
    return h(ScreenerView, {
      owed: false,
      state,
      ...(props.suggest ? { suggest: props.suggest } : {}),
      segment: "waiting", settled: true,
      selection: { waiting: null, screened: null, spam: null },
      onSelect: () => {}, hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
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
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
  await settleFirstPaint();
  return host;
}

/** Every track on screen, as `[value, max]` read off the DOM. */
const tracks = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLProgressElement>("progress.scn-prog")].map((p) => [
    p.getAttribute("value"),
    p.getAttribute("max"),
  ]);

describe("the suggest run's progress bar", () => {
  it("draws the field's own two numbers, and stays out of the announcement", async () => {
    const el = await mount({ suggest: running({ done: 3, total: 40 }) });
    expect(tracks(el)).toEqual([["3", "40"]]);
    // The sentence beside it is already in a `role="status"`. A labelled track would announce
    // the same fact a second time — once as prose, once as a percentage — every chunk.
    const bar = el.querySelector("progress.scn-prog")!;
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelector(".scn-sg-note")?.textContent).toBe("3 of 40 suggested…");
  });

  it("draws nothing when the run is not in flight", async () => {
    // `progress` is null in every phase but `running`, and CLEARED rather than left full when
    // the run ends. A bar that outlives its run claims work is still happening.
    const el = await mount({ suggest: running(null) });
    expect(tracks(el)).toEqual([]);
    // The control itself is still there — it is the bar that is absent, not the surface.
    expect(el.querySelector(".scn-suggest")).not.toBeNull();
  });

  it("draws nothing rather than NaN when there is no denominator", async () => {
    const el = await mount({ suggest: running({ done: 0, total: 0 }) });
    expect(tracks(el)).toEqual([]);
    expect(el.textContent ?? "").not.toContain("NaN");
  });
});

describe("the apply-all run's progress", () => {
  it("says how far it has got, in words and as a track", async () => {
    const el = await mount({ applying: { done: 7, total: 40 } });
    expect(el.querySelector(".scn-applying-lab")?.textContent).toBe("Applying 7 of 40…");
    // Announced once, as the sentence — the track is the visual half of the same fact.
    expect(el.querySelector(".scn-applying-lab")?.getAttribute("role")).toBe("status");
    expect(tracks(el)).toEqual([["7", "40"]]);
  });

  it("shows nothing at all when no bulk is running", async () => {
    const el = await mount({ applying: null });
    expect(el.querySelector(".scn-applying")).toBeNull();
    expect(tracks(el)).toEqual([]);
  });

  it("the Apply verb carries the run and refuses a second press while it is on", async () => {
    // The Send verb's dress on the strip: `data-run="working"` paints the band along the
    // capsule's foot, `aria-busy` says so to a reader, and `disabled` is the refusal
    // `applyAll`'s own `bulkBusy` guard already makes — now visible on the control.
    // The verb exists only over a queue with suggestions (`suggestedCount`), so the gate is
    // overlaid with the run — the fixture's one held sender carries no answer.
    const gate = { suggestedCount: 3, suggestedDests: ["ohbox", "reads"] };
    const el = await mount({ applying: { done: 7, total: 40 }, overlay: gate });
    const apply = el.querySelector<HTMLButtonElement>('.scn-bulk .btn[data-run="working"]');
    expect(apply, "no bulk verb wears the run").toBeTruthy();
    expect(apply!.disabled).toBe(true);
    expect(apply!.getAttribute("aria-busy")).toBe("true");
    const idle = await mount({ applying: null, overlay: gate });
    expect(idle.querySelector(".scn-bulk .btn"), "the verb is gone with the run").not.toBeNull();
    expect(idle.querySelector(".scn-bulk .btn[data-run]")).toBeNull();
  });

  it("draws nothing rather than NaN when there is no denominator", async () => {
    const el = await mount({ applying: { done: 0, total: 0 } });
    expect(tracks(el)).toEqual([]);
    expect(el.textContent ?? "").not.toContain("NaN");
  });
});

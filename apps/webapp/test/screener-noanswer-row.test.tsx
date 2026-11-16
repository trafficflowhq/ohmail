/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore, senderKey,
  type EngineMessage, type Folder, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import type { SuggestionOverlay, SuggestBatchControl } from "../app/shell/screener-suggest";

/**
 * ═══ A ROW THE RUN COULD NOT ANSWER FOR SAYS SO — NEVER "→ No answer 0.00" ════════════════
 *
 * MEASURED (a reported screenshot, de locale, 2026-09-19; production read-only the same day): every
 * waiting sender a stopped run had not answered for wore "→ Keine Antwort 0.00" — the non-answer
 * LABEL rendered as a destination chip, over a confidence that measured nothing — while the
 * header said "All N senders have a suggestion" against filter chips reading "No suggestion N".
 * The cause on the account was real (`spend_unavailable`: the plane refuses a canceled
 * subscription's spend); the client's rendering of it was the defect.
 *
 * Three claims:
 *
 *  1. A `noAnswer` row renders ONE PLAIN SENTENCE (`aiSkipRow.*`) — no arrow, no number.
 *  2. The partition has ONE spelling (`hasRealSuggestion`): the apply button's count and the
 *     filter chips' groups come from the same predicate. Mutating that selector to admit a
 *     `noAnswer` row reddens the agreement assertion here — watched red while building this
 *     (the apply count moved to 5; the chips followed), then restored.
 *  3. The suggest control's resting sentence may claim "all N have a suggestion" only when NO
 *     waiting sender is in the chips' "none" group (`unanswered === 0`).
 */

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

const NOW = new Date("2026-09-19T12:00:00.000Z");
let seq = 0;

function held(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-09-19T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-09-19T09:00:00.000Z",
  };
}

/** Two answered (Reads), three the run could not answer for — the reported shape, small. */
const ANSWERED = ["paper@x.test", "letters@x.test"];
const UNANSWERED = ["a@y.test", "b@y.test", "c@y.test"];

function overlay(): SuggestionOverlay {
  const m = new Map();
  for (const s of ANSWERED) {
    m.set(senderKey(s), { dest: "reads", confidence: 0.91, rationale: "a newsletter" });
  }
  for (const s of UNANSWERED) {
    m.set(senderKey(s), {
      dest: "screener", confidence: 0, rationale: "", noAnswer: "spend_unavailable",
    });
  }
  return m;
}

async function engineWith(): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  const rows = [...ANSWERED, ...UNANSWERED].map((s, i) => held(`m${i}`, s, 6 + i));
  await store.applyChanges(rows.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
    } as never,
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}


async function mount(suggest?: SuggestBatchControl): Promise<void> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const engine = await engineWith();
  const rows = overlay();

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText(), rows);
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: null, screened: null, spam: null,
    });
    return h(ScreenerView, {
      state,
      segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
      ...(suggest ? { suggest } : {}),
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
  /* THE QUEUE IS DERIVED ON A TIMER (`scheduleFirstDerivation`), and twelve microtask turns raced
     it: under load the cases read the withheld "all clear" state. The shared seam awaits the tick,
     and the seeded rows are asserted rendered, so no case below can pass over an empty queue. */
  await settleFirstPaint();
  expect(host!.textContent, "the Screener did not render the seeded queue").toContain(ANSWERED[0]);
}

const rowFor = (address: string): HTMLElement => {
  const el = [...host!.querySelectorAll<HTMLElement>('[role="option"], .msg-row, li, button')]
    .find((n) => (n.textContent ?? "").includes(address));
  if (!el) throw new Error(`no row shows ${address}`);
  return el;
};

const chipTexts = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>(".scn-chips button")].map((b) => (b.textContent ?? "").trim());

/** A resting control, hand-built: this component reads fields, not the hook. */
function restingControl(over: Partial<SuggestBatchControl>): SuggestBatchControl {
  return {
    available: 0, resuggestable: 19, unanswered: 0, mode: "new", pool: 0, sizes: [], size: 0,
    phase: "closed", quote: null, notice: null, progress: null,
    open: () => {}, openAgain: () => {}, choose: () => {}, cancel: () => {},
    confirm: () => {},
    ...over,
  } as SuggestBatchControl;
}

describe("a noAnswer row", () => {
  it("renders one plain sentence — no destination arrow, no 0.00", async () => {
    await mount();
    const text = rowFor("a@y.test").textContent ?? "";
    expect(text).toContain("No suggestion — AI is unavailable for this account right now.");
    expect(text, "a non-answer wearing a confidence").not.toContain("0.00");
    expect(text, "a non-answer wearing a destination arrow").not.toContain("→");
    // The answered row keeps its real chip, arrow, pile and confidence.
    const answered = rowFor("paper@x.test").textContent ?? "";
    expect(answered).toContain("→ News");
    expect(answered).toContain("0.91");
  });

  it("the apply button and the filter chips read one selector", async () => {
    await mount();
    // Apply covers the two REAL suggestions; the chips put the three noAnswers under "No suggestion".
    const apply = [...host!.querySelectorAll<HTMLElement>("button")]
      .find((b) => (b.textContent ?? "").startsWith("Apply"));
    expect(apply?.textContent).toContain("Apply 2");
    const chips = chipTexts();
    expect(chips.find((c) => c.startsWith("All"))).toContain("5");
    expect(chips.find((c) => c.startsWith("News"))).toContain("2");
    expect(chips.find((c) => c.startsWith("No suggestion"))).toContain("3");
  });
});

describe("the suggest control's resting sentence", () => {
  it("claims 'all suggested' only when no waiting sender lacks one", async () => {
    await mount(restingControl({ unanswered: 17 }));
    expect(host!.textContent).not.toContain("have a suggestion");
  });

  it("still states it when every sender truly has one — the positive control", async () => {
    await mount(restingControl({ unanswered: 0 }));
    expect(host!.textContent).toContain("All 19 senders have a suggestion.");
  });
});

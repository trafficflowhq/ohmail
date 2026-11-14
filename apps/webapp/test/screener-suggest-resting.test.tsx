/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { useSuggestText } from "../app/shell/suggest-text";
import {
  OhmailEngine, MemoryMirrorStore,
  type EngineMessage, type Folder, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import type { SuggestBatchControl } from "../app/shell/screener-suggest";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE AI SURFACE MUST NOT DISAPPEAR WHEN IT HAS FINISHED ITS WORK.
 *
 * Reported from a live account: a Screener of waiting senders, every one of them with a bought suggestion,
 * and no AI anything in the Screener. Not a broken control, not an error — nothing. The buy
 * control's first line was `if (control.available === 0) return null`, and `available` is the
 * count of senders with NO answer yet, so working the queue to completion deleted the feature
 * from the view. "There is nothing left to buy" and "this build has no AI" rendered identically.
 *
 * The two claims below are what replaces that hide, and each was watched go RED against the
 * mutation named in its comment:
 *
 *  1. A ZERO BUY LIST RESTS. The surface stays, states how many senders have an answer, and keeps
 *     the one action still available — asking again — beside it. It renders nothing only when
 *     there is also nothing to re-ask, which is an empty gate the list already speaks for.
 *  2. THE RE-ASK IS THE SAME PURCHASE. It enters the existing machinery — a server dry run, a
 *     confirm carrying the server's own count, one idempotency key per chunk — over the senders
 *     that HAVE an answer. It is not a second flow, and it may not spend before a price lands.
 *
 * The chips and the apply banner are asserted alongside, because the report was about the whole
 * strip: a fix that restored the suggest control by displacing its neighbours would be no fix.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
// BEFORE any import of `api-client`: `API_BASE` is read once at module load.
process.env.NEXT_PUBLIC_API_BASE = "/api";

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
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

// ── the wire, recorded ────────────────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body: { senders?: string[]; dryRun?: boolean } | null;
  idempotencyKey: string | null;
}

let calls: Recorded[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let realFetch: typeof fetch;

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** What `GET /screener` answers — the already-bought half, which is the whole queue here. */
let listReply: () => Response;
/** What `POST /screener/suggest` answers next. */
let suggestReply: (body: { senders: string[]; dryRun?: boolean }) => Response;

const dryRuns = () => calls.filter((c) => c.path.startsWith("/screener/suggest") && c.body?.dryRun === true);
const purchases = () => calls.filter((c) => c.path.startsWith("/screener/suggest") && c.body?.dryRun !== true);

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const path = url.replace(/^\/api/, "");
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as Recorded["body"]) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method: init?.method ?? "GET",
      path,
      body: raw,
      idempotencyKey: headers["Idempotency-Key"] ?? null,
    });
    if (path.startsWith("/screener/suggest")) {
      return suggestReply(raw as { senders: string[]; dryRun?: boolean });
    }
    if (path.startsWith("/screener")) return listReply();
    return json({});
  }) as typeof fetch;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

/** Press the button whose visible text is exactly `label`. */
async function press(label: string): Promise<void> {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!btn) {
    throw new Error(
      `no button labelled "${label}" — on screen: ${[...document.querySelectorAll("button")]
        .map((b) => JSON.stringify(b.textContent?.trim()))
        .join(", ")}`,
    );
  }
  await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

/**
 * Press the re-ask CONFIRM, whichever number it is currently quoting.
 *
 * Prefix-matched for the reason `screener-suggest.test.tsx` gives about its own confirm: the
 * count is a fact under test elsewhere, and restating it here would make a pricing change fail
 * as "the button vanished".
 */
async function pressConfirmAgain(): Promise<void> {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith("Suggest again for "));
  if (!btn) {
    throw new Error(
      `no re-ask confirm — on screen: ${[...document.querySelectorAll("button")]
        .map((b) => JSON.stringify(b.textContent?.trim()))
        .join(", ")}`,
    );
  }
  await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

const text = () => host?.textContent ?? "";

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  listReply = () => json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 50 } });
  suggestReply = () => json({ dryRun: true, requested: 0, quoted: 0, quotedCredits: 0, charged: 0, suggestions: [], skipped: [] });
  installFetch();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

// ══ 1. THE RESTING STATE ═══════════════════════════════════════════════════════════════════

/**
 * A control at rest, hand-built.
 *
 * Hand-built rather than driven through the hook because what is under test in this half is the
 * VIEW's decision about what to draw at each of the two zeroes. The hook's own behaviour is the
 * second half of this file, over the real endpoint.
 */
function restingControl(over: Partial<SuggestBatchControl> = {}): SuggestBatchControl {
  return {
    available: 0,
    resuggestable: 74,
    unanswered: 0,
    mode: "new",
    pool: 0,
    sizes: [],
    size: 0,
    phase: "closed",
    quote: null,
    notice: null,
    progress: null,
    open: () => {},
    openAgain: () => {},
    choose: () => {},
    confirm: () => {},
    cancel: () => {},
    ...over,
  };
}

async function mountView(props: Record<string, unknown>): Promise<HTMLElement> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const engine = await engineWith([
    held("m1", "one@example.test", 9),
    held("m2", "two@example.test", 10),
    held("m3", "three@example.test", 11),
  ]);

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText());
    return h(ScreenerView, {
      owed: false,
      state,
      segment: "waiting", settled: true,
      selection: { waiting: null, screened: null, spam: null },
      onSelect: () => {}, hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
      ...props,
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
  return host;
}

describe("a Screener with nothing left to buy still shows the AI surface", () => {
  it("states how many senders have an answer, instead of vanishing", async () => {
    // The reported state exactly: no unsuggested senders, 74 answered ones.
    // RED against `if (control.available === 0) return null` — the whole strip renders, the
    // chips and the apply banner render, and the AI surface is simply not in the tree.
    const el = await mountView({ suggest: restingControl() });
    const rest = el.querySelector(".scn-sg-rest");
    expect(rest, "the suggest surface vanished on a fully-suggested queue").not.toBeNull();
    expect(el.textContent).toContain("All 74 senders have a suggestion.");
    // A FACT, NOT A CONTROL. The sentence must not be pressable — a person who clicks the thing
    // telling them the work is done is looking for an action that does not exist.
    expect(el.querySelector(".scn-sg-all")?.tagName).toBe("SPAN");
    // And the buy control is NOT drawn beside it: there is nothing to buy, and an enabled
    // "Suggest…" over an empty list is the inert button this view refuses everywhere else.
    expect([...el.querySelectorAll("button")].map((b) => b.textContent?.trim()))
      .not.toContain("Suggest…");
  });

  it("offers the re-ask beside it — the one action still true", async () => {
    const el = await mountView({ suggest: restingControl() });
    // RED if `openAgain` is not offered at rest: the honest state would then be a dead end,
    // which is the half of the report that asked for a way back in.
    expect([...el.querySelectorAll("button")].map((b) => b.textContent?.trim()))
      .toContain("Suggest again…");
  });

  it("renders NOTHING when there is also nothing to ask about again", async () => {
    // An empty gate. The list beside this already says "No one's waiting."; "All 0 senders have
    // a suggestion." would be a second, worse way to say it — and a false one.
    const el = await mountView({ suggest: restingControl({ resuggestable: 0 }) });
    expect(el.querySelector(".scn-sg-rest")).toBeNull();
    expect(el.querySelector(".scn-suggest")).toBeNull();
    expect(el.textContent).not.toContain("have a suggestion.");
  });

  it("still opens the ordinary buy control while the queue is mixed", async () => {
    // The resting state is the ZERO arm and must not have replaced the ordinary one.
    const el = await mountView({ suggest: restingControl({ available: 5, pool: 5 }) });
    const labels = [...el.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).toContain("Suggest…");
    expect(labels).toContain("Suggest again…");
    expect(el.textContent).not.toContain("have a suggestion.");
  });

  it("labels the ladder's largest size off the set it is bound to, not off the buy list", async () => {
    // `pool`, not `available`. Read off the buy list a re-ask ladder over 74 would print a bare
    // "74" at its top — the one size that means "everything" left unnamed.
    const el = await mountView({
      suggest: restingControl({
        mode: "again", pool: 74, sizes: [10, 25, 50, 74], size: 74,
        phase: "ready", quote: { senders: 3, credits: 3 },
      }),
    });
    expect(el.textContent).toContain("all 74");
    // And the wording is the re-ask's throughout, not the purchase's.
    expect(el.textContent).toContain("Suggest again for the first");
    expect(el.textContent).toContain("Suggest again for 3 senders");
  });
});

// ══ 2. THE RE-ASK IS THE SAME PURCHASE ═════════════════════════════════════════════════════

/** Twelve senders, all of whom will arrive already answered for. */
const TWELVE = Array.from({ length: 12 }, (_, i) =>
  held(`m${String(i).padStart(2, "0")}`, `s${i}@ex.example`, 23 - i));

/**
 * `GET /screener` answering with a suggestion for EVERY sender — the reported account's state.
 *
 * Two different decisions on purpose: a unanimous queue renders no filter chips (they need two
 * groups), and the chips are one of the things asserted to survive.
 */
const allAnswered = () =>
  json({
    items: TWELVE.map((m, i) => ({
      id: m.id, messageId: m.id, sender: { name: null, address: m.from.address },
      subject: m.subject, snippet: m.snippet, receivedAt: m.date,
      aiSuggestion: {
        decision: i % 2 === 0 ? "yes" : "no",
        confidence: 0.8,
        rationale: `because ${i}`,
      },
    })),
    nextCursor: null,
    suggestable: { senders: [], credits: 0, maxPerRequest: 50 },
  });

interface Live {
  unsuggested: () => string[];
  suggested: () => string[];
  control: () => SuggestBatchControl;
}

/** Mount the REAL view over the REAL hooks — nothing faked but the server. */
async function mountLive(): Promise<Live> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
  const { CLOUD_WIRE } = await import("../app/(product)/mailbox/suggest-wire.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const engine = await engineWith(TWELVE);

  let live: { unsuggestedSenders: string[]; suggestedSenders: string[] } | null = null;
  let control: SuggestBatchControl | null = null;

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const suggestions = useScreenerSuggestions({ text: useSuggestText(), wire: CLOUD_WIRE, active: true, toast: (() => {}) as never });
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText(), suggestions.suggestions);
    live = state;
    // Bound exactly as `AppShell` binds it — both halves of the queue.
    control = suggestions.forSenders(state.unsuggestedSenders, state.suggestedSenders);
    return h(ScreenerView, {
      owed: false,
      state,
      suggest: control,
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
  await flush();
  return {
    unsuggested: () => live!.unsuggestedSenders,
    suggested: () => live!.suggestedSenders,
    control: () => control!,
  };
}

describe("re-asking enters the EXISTING quote → confirm → purchase flow", () => {
  it("prices the ALREADY-ANSWERED senders on the server before anything is pressable", async () => {
    listReply = allAnswered;
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true, requested: body.senders.length,
        // The reported shape: one sender has new mail since the answer was bought, eleven do not.
        quoted: 1, quotedCredits: 1, charged: 0, suggestions: [], skipped: [],
      });
    const live = await mountLive();
    // The state the report describes: nothing to buy, everything re-askable.
    expect(live.unsuggested()).toEqual([]);
    expect(live.suggested()).toHaveLength(12);

    await press("Suggest again…");
    // A DRY RUN FIRST, over the senders that HAVE an answer — never the (empty) buy list.
    // RED if `confirm`/`price` slice `addresses`: the posted set is empty and no price arrives.
    expect(dryRuns()).toHaveLength(1);
    expect(dryRuns()[0]!.body?.senders).toEqual(live.suggested());
    // And nothing was bought to learn the price.
    expect(purchases()).toHaveLength(0);
    // The SERVER's figure, on the confirm — one sender, not the twelve that were asked about.
    expect(text()).toContain("Suggest again for 1 sender");
  });

  it("rests beside the filter chips and the apply banner, not in place of them", async () => {
    listReply = allAnswered;
    await mountLive();
    // The report was about the whole strip, not one control. A "fix" that restored the suggest
    // surface by displacing its neighbours would be no fix, and this is what watches for it.
    expect(host!.querySelector(".scn-sg-rest"), "the suggest surface is not on screen").not.toBeNull();
    expect(host!.querySelector(".scn-chips"), "the filter chips went with it").not.toBeNull();
    expect(text()).toMatch(/Apply \d+ —/);
    expect(text()).toContain("All 12 senders have a suggestion.");
  });

  it("buys the same set on confirm, with an idempotency key", async () => {
    listReply = allAnswered;
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true, requested: body.senders.length,
        quoted: 1, quotedCredits: 1, charged: body.dryRun === true ? 0 : 1,
        suggestions: body.dryRun === true
          ? []
          : [{ sender: body.senders[0], messageId: "m00", decision: "no", destination: "ohmail/Screened", confidence: 0.9, rationale: "re-asked" }],
        skipped: [],
      });
    const live = await mountLive();
    await press("Suggest again…");
    await pressConfirmAgain();

    expect(purchases()).toHaveLength(1);
    expect(purchases()[0]!.body?.senders).toEqual(live.suggested());
    // ONE KEY PER CHUNK — the existing spend rule, reached because this is the existing flow.
    // RED if the re-ask ever grows a path of its own that posts without one: a lost response
    // would then be retried as a second purchase.
    expect(purchases()[0]!.idempotencyKey).toBeTruthy();
    // The fresh answer landed in the same overlay the chips read.
    expect(text()).toContain("re-asked");
  });

  it("says so honestly when the ledger has nothing new to sell", async () => {
    listReply = allAnswered;
    // Every sender's newest mail is the one already bought for, so the server quotes zero and
    // will answer from what it is holding. That is a real answer, not a failure.
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true, requested: body.senders.length,
        quoted: 0, quotedCredits: 0, charged: 0, suggestions: [], skipped: [],
      });
    await mountLive();
    await press("Suggest again…");
    expect(text()).toContain("Every one of these already has an answer for their latest mail.");
    // And the confirm is not pressable over a set the server priced at nothing.
    const confirm = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.trim().startsWith("Suggest again for "));
    expect(confirm?.hasAttribute("disabled")).toBe(true);
    expect(purchases()).toHaveLength(0);
  });

  it("never feeds the re-ask list to the AUTOMATIC batch", async () => {
    listReply = allAnswered;
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true, requested: body.senders.length,
        quoted: 0, quotedCredits: 0, charged: 0, suggestions: [], skipped: [],
      });
    const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
    const { useScreenerText } = await import("../app/shell/screener-text.js");
    const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
    const { CLOUD_WIRE } = await import("../app/(product)/mailbox/suggest-wire.js");
    const engine = await engineWith(TWELVE);
    function Probe(): null {
      const [v, setV] = React.useState(0);
      React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
      // OPTED IN. The path that spends with no press at all.
      const s = useScreenerSuggestions({ text: useSuggestText(), wire: CLOUD_WIRE, active: true, autoSuggest: true, toast: (() => {}) as never });
      const st = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText(), s.suggestions);
      s.forSenders(st.unsuggestedSenders, st.suggestedSenders);
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe),
      }));
    });
    await flush();
    // RED if `io.current.queue` is widened to include the re-ask list. The automatic batch's
    // licence is a figure quoted when the setting was turned on, over senders with no answer;
    // there are none, so it must buy nothing at all rather than spend on twelve unpressed.
    expect(purchases()).toHaveLength(0);
    expect(dryRuns()).toHaveLength(0);
  });
});

/** @vitest-environment jsdom */
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { useSuggestText } from "../app/shell/suggest-text";
import {
  OhmailEngine, MemoryMirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * ═══ A WAITING SENDER WITH NO SUGGESTION SAYS WHY, AND "YET" IS ONE OF THREE ANSWERS ══════
 *
 * Every row with no advice rendered "No suggestion yet for this sender." On a measured queue that
 * was most of the rows, and the word is a promise: it says one is coming. It is not coming for
 * a sender whose mail is kept away from every model, and it is not coming on an account whose
 * spend is refused — a STANDING condition that reached the person once, as a toast under the batch
 * that discovered it, while every row went on promising.
 *
 * So the sentence is derived from the reason, and the three are told apart on screen:
 *   pending      — nobody has asked about this sender. The only "yet".
 *   unavailable  — a run stopped on the spend gate; the rows it never reached wait on that.
 *   no_auto_ai   — the representative is `no_ai`; the automatic pass never asks about it.
 *
 * The assertion reads `data-why`, the state, AND the rendered sentence — the state so the test is
 * not an assertion about wording, the sentence so a state with the wrong copy attached cannot pass.
 *
 * MUTATIONS WATCHED RED (each restored and `cmp`-verified):
 *   · `noSuggestionReason` returning `"pending"` unconditionally  → the `no_ai` and stopped cases;
 *   · dropping the `sender.noAi` arm                              → the `no_ai` case alone;
 *   · dropping `setStanding(stopped ?? null)` from the run        → the stopped case alone;
 *   · `screenerSegments` no longer deriving `noAi` from the rep    → the `no_ai` case alone.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
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

function msg(
  id: string, from: string, hour: number, opts: { noAi?: boolean } = {},
): EngineMessage {
  const folder: Folder = "ohmail/Screener";
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: from },
    to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder,
    snippet: `snippet ${id}`,
    unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null,
      no_ai: opts.noAi === true,
      no_forward: false, no_kb: false, priority: false,
    },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** What `POST /screener/suggest` answers next — varied per test. */
let suggestReply: (body: { senders: string[]; dryRun?: boolean }) => Response | Promise<Response>;
/** What `GET /account/access` answers — the read that lifts a refusal it describes. */
let accessReply: () => Response;
/** Every real (non-dry) purchase the client sent — the positive control that a request left. */
let purchases = 0;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  suggestReply = (body) => json({
    dryRun: body.dryRun === true, requested: body.senders.length,
    quoted: body.senders.length, quotedCredits: body.senders.length,
    charged: 0, suggestions: [], skipped: [],
  });
  accessReply = () => json({});
  purchases = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(typeof input === "string" ? input : input).replace(/^\/api/, "");
    const raw = typeof init?.body === "string"
      ? (JSON.parse(init.body) as { senders: string[]; dryRun?: boolean })
      : { senders: [] };
    if (path.startsWith("/screener/suggest")) {
      if (raw.dryRun !== true) purchases++;
      return suggestReply(raw);
    }
    if (path.startsWith("/account/access")) return accessReply();
    if (path.startsWith("/screener")) return json({ senders: [], nextCursor: null });
    return json({});
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  root = null; host = null;
});

async function engineWith(held: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(held.map((m): SyncChange => ({
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
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

/** Mount the REAL view over the REAL hooks — only the server is a double. */
/**
 * `optedIn` opts the HOOK in, so the automatic batch runs; the VIEW reads the hook's own in-flight
 * set, the production shape (`AppShell` hands `suggestions.inFlight` over).
 */
async function mountView(
  engine: OhmailEngine, opts: { optedIn?: boolean; subscriptionPane?: boolean } = {},
): Promise<void> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
  const { CLOUD_WIRE } = await import("../app/(product)/mailbox/suggest-wire.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const suggestions = useScreenerSuggestions({
      text: useSuggestText(),
      wire: CLOUD_WIRE,
      active: true, toast: (() => {}) as never, autoSuggest: opts.optedIn === true,
    });
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText(), suggestions.suggestions);
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: null, screened: null, spam: null,
    });
    return h(ScreenerView, {
      state,
      suggest: suggestions.forSenders(state.unsuggestedSenders),
      noSuggestionStanding: suggestions.standing,
      suggestingFor: suggestions.inFlight,
      subscriptionPane: opts.subscriptionPane === true,
      segment: "waiting",
      settled: true,
      owed: false,
      selection: sel as never,
      onSelect: (segment: string, id: string | null) => setSel((m) => ({ ...m, [segment]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {},
      full: false,
      onFull: () => {},
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(KeymapProvider, { children: h(Probe) }),
      }),
    }));
  });
  await flush();
  await settleFirstPaint();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
}

async function press(label: string): Promise<void> {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!btn) {
    throw new Error(`no button labelled "${label}" — on screen: ${
      [...document.querySelectorAll("button")].map((b) => JSON.stringify(b.textContent?.trim())).join(", ")}`);
  }
  await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

async function pressConfirm(): Promise<void> {
  const btn = [...document.querySelectorAll("button")]
    .find((b) => b.textContent?.trim().startsWith("Suggest for "));
  if (!btn) throw new Error("no confirm button on screen");
  await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

/** Select the LAST row in the queue — the sender a bounded run is least likely to have reached. */
async function selectLastRow(): Promise<void> {
  const rows = [...document.querySelectorAll(".row")];
  const last = rows[rows.length - 1];
  if (!last) throw new Error("no waiting rows on screen");
  await act(async () => { last.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

const why = (): string | null =>
  document.querySelector(".scn-why-none")?.getAttribute("data-why") ?? null;
const text = (): string => host?.textContent ?? "";

/** Twelve senders, newest first — enough that a bounded run cannot reach the back of the queue. */
const MANY = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, `s${i}@ex.example`, 23 - i));

describe("why a waiting sender has no suggestion", () => {
  it("PENDING — nobody has asked, and that is the one state that may say 'yet'", async () => {
    await mountView(await engineWith(MANY));
    expect(why()).toBe("pending");
    expect(text()).toContain("No suggestion yet for this sender");
  });

  it("NO_AUTO_AI — nothing was suggested by itself, and the row says that instead of 'yet'", async () => {
    // The representative is the newest held message, which is the row selected first.
    const held = [msg("nx", "quiet@ex.example", 23, { noAi: true }), ...MANY.slice(1)];
    await mountView(await engineWith(held));
    expect(why()).toBe("no_auto_ai");
    expect(text()).toContain("kept out of automatic AI");
    expect(text(), "the promise is what this case exists to remove").not.toContain("No suggestion yet");
  });

  it("UNAVAILABLE — a run stopped on the spend gate, and the rows it never reached say so", async () => {
    await mountView(await engineWith(MANY));
    // Before the run, the same row says "yet" — the control that this is the run's doing.
    await selectLastRow();
    expect(why()).toBe("pending");

    suggestReply = (body) => json({
      dryRun: body.dryRun === true, requested: body.senders.length,
      quoted: body.senders.length, quotedCredits: body.senders.length,
      charged: 0,
      // The gate refused before anything was answered, which is the entitlement shape.
      ...(body.dryRun === true ? {} : { stopped: "spend_unavailable" }),
      suggestions: [], skipped: [],
    });
    await press("Suggest…");
    /* TEN OF TWELVE, deliberately. A purchase is bounded, so the senders it never reaches are the
       majority of a real queue and the whole point of this state — buying "all" would leave no
       such row and the case would be satisfiable by the run’s own `noAnswer` chips. */
    await press("10");
    await pressConfirm();

    await selectLastRow();
    expect(why()).toBe("unavailable");
    expect(text()).toContain("AI suggestions are not available for this account");
    expect(text()).not.toContain("No suggestion yet");
  });

  it("A RUN THAT ASKED ABOUT THIS SENDER OUTRANKS BOTH — the nearer, more specific fact", async () => {
    /* The precedence, stated because it is the one a reader would get wrong: a sender the run
       ASKED about carries the run’s own `noAnswer` and renders that, not a standing state — it
       describes an attempt that actually happened. The two states this file is about are for rows
       no run has reached, which on a bounded purchase is most of the queue. Without this case the
       `unavailable` assertion could be satisfied by a row that was asked about. */
    const held = [msg("nx", "quiet@ex.example", 23, { noAi: true }), ...MANY.slice(1)];
    await mountView(await engineWith(held));
    suggestReply = (body) => json({
      dryRun: body.dryRun === true, requested: body.senders.length,
      quoted: body.senders.length, quotedCredits: body.senders.length, charged: 0,
      ...(body.dryRun === true ? {} : { stopped: "spend_unavailable" }),
      suggestions: [], skipped: [],
    });
    await press("Suggest…");
    await pressConfirm();
    // The first row was in the asked set, so it now carries the run’s reason and this branch is
    // not rendered at all.
    expect(why()).toBeNull();
    expect(text()).toContain("AI is switched off or unavailable for this account");
  });
});

/**
 * ═══ COMING — only while a run is buying this sender (ruled) ════════════════════════════════════
 *
 * The opt-in alone used to say a suggestion was coming, and on an account with no credits the paired
 * desktop said it for minutes while the web said none were left. A row now says one is coming only
 * while a run of this surface is buying that sender; otherwise it offers the press.
 *
 * MUTATIONS WATCHED RED: answering `coming` from the opt-in again reddens the second case; dropping
 * the in-flight arm reddens the first; the chip case reddens if a suggestion stops replacing it.
 */
describe("the coming state — a run is buying this sender", () => {
  it("while the automatic batch is buying the row, it says a suggestion is coming", async () => {
    suggestReply = (body) => body.dryRun === true
      ? json({ dryRun: true, requested: body.senders.length, quoted: body.senders.length,
          quotedCredits: body.senders.length, charged: 0, suggestions: [], skipped: [] })
      : new Promise<Response>(() => {});
    await mountView(await engineWith(MANY), { optedIn: true });
    expect(purchases, "the batch left — this case would measure nothing").toBe(1);
    expect(why()).toBe("coming");
    expect(text()).toContain("A suggestion is coming for this sender");
  });

  it("an opted-in account with no run buying the row promises nothing", async () => {
    await mountView(await engineWith(MANY));
    expect(why()).toBe("pending");
    expect(text()).not.toContain("A suggestion is coming");
  });

  it("…and it outranks nothing: no_ai mail and a stopped run keep their own sentences", async () => {
    const held = [msg("nx", "quiet@ex.example", 23, { noAi: true }), ...MANY.slice(1)];
    await mountView(await engineWith(held), { optedIn: true });
    // The selected (newest) row is the no_ai one — the opt-in does not promise what the
    // sensitivity pass keeps away from every model.
    expect(why()).toBe("no_auto_ai");
    expect(text()).not.toContain("A suggestion is coming");
  });

  it("…and it disappears with the chip", async () => {
    suggestReply = (body) => json({
      dryRun: body.dryRun === true, requested: body.senders.length,
      quoted: body.senders.length, quotedCredits: body.senders.length,
      charged: body.dryRun ? 0 : body.senders.length,
      suggestions: body.dryRun ? [] : body.senders.map((s) => ({
        sender: s, messageId: `m-${s}`, decision: "no" as const,
        confidence: 0.9, rationale: "stranger",
      })),
      skipped: [],
    });
    await mountView(await engineWith(MANY));
    expect(why()).toBe("pending");
    await press("Suggest…");
    await press("10");
    await pressConfirm();
    // The selected row is in the front ten, so it now carries an answer: the coming sentence is
    // gone and the chip's own block renders in its place.
    expect(why()).toBeNull();
    expect(document.querySelector(".scn-why"), "no chip block replaced the coming state").not.toBeNull();
  });
});

/**
 * ═══ A REFUSED REQUEST TELLS THE TRUTH — thrown or answered, it is never "coming" ═══════════════
 *
 * A request the route refuses OUTRIGHT (a 402 for budget, 409, 503) throws, and only an answered
 * run's `stopped` used to reach the standing: an opted-in account toasted "No AI budget left" while
 * every waiting row said a suggestion was coming. Each refusal now sets the standing, and the row
 * names the reason. MUTATIONS WATCHED RED: the automatic batch's `writeStanding(stood)` removed →
 * the thrown-402 automatic case; the confirm's removed → the manual case; `standingOfRefusal`
 * answering `refused` for every code → the per-reason table.
 */
const refusal = (status: number, code: string, message: string) => () =>
  json({ error: { code, message } }, status);

describe("a refused suggest request sets the standing, and the row says why", () => {
  it("the AUTOMATIC batch refused for budget (402, thrown): unavailable with the reason, never coming", async () => {
    suggestReply = refusal(402, "insufficient_credits", "no AI credits remain on this account");
    await mountView(await engineWith(MANY), { optedIn: true });
    expect(purchases, "the automatic batch never asked — this case would measure nothing").toBe(1);
    expect(why()).toBe("unavailable");
    expect(text()).toContain(messages.screener.noSuggestionNoBudget);
    expect(text()).not.toContain("A suggestion is coming");
  });

  it("…and says where credits come from only where Settings lists the Subscription pane", async () => {
    suggestReply = refusal(402, "insufficient_credits", "no AI credits remain on this account");
    await mountView(await engineWith(MANY), { optedIn: true, subscriptionPane: true });
    expect(why()).toBe("unavailable");
    expect(text()).toContain(messages.screener.noSuggestionNoBudgetWhere);
    expect(messages.screener.noSuggestionNoBudgetWhere).toContain(messages.settings.billing);
  });

  it("a MANUAL purchase refused outright (402, thrown): the rows it never reached say so", async () => {
    await mountView(await engineWith(MANY));
    await selectLastRow();
    expect(why(), "the control: before the press this row is only pending").toBe("pending");
    suggestReply = (body) => body.dryRun === true
      ? json({ dryRun: true, requested: body.senders.length, quoted: body.senders.length,
          quotedCredits: body.senders.length, charged: 0, suggestions: [], skipped: [] })
      : json({ error: { code: "insufficient_credits", message: "no AI credits remain on this account" } }, 402);
    await press("Suggest…");
    await press("10");
    await pressConfirm();
    await selectLastRow();
    expect(purchases).toBe(1);
    expect(why()).toBe("unavailable");
    expect(text()).toContain(messages.screener.noSuggestionNoBudget);
    expect(text()).not.toContain("No suggestion yet");
  });

  /* Every refusal code the route answers, and the reason the row names for it. */
  const TABLE: Array<[string, () => Response, string]> = [
    ["409 ai_disabled", refusal(409, "ai_disabled", "managed AI is switched off"), "AI is switched off."],
    ["503 ai_unavailable", refusal(503, "ai_unavailable", "temporarily unavailable"), "AI is not answering"],
    ["409 organized_elsewhere", refusal(409, "organized_elsewhere", "another install organizes this mailbox"),
      "the server refused the request"],
    ["402 subscription_required", refusal(402, "subscription_required", "subscription required"),
      "the server refused the request"],
  ];
  for (const [what, reply, sentence] of TABLE) {
    it(`${what} — unavailable, with its own reason`, async () => {
      suggestReply = reply;
      await mountView(await engineWith(MANY), { optedIn: true });
      expect(purchases).toBe(1);
      expect(why()).toBe("unavailable");
      expect(text()).toContain(sentence);
      expect(text()).not.toContain("A suggestion is coming");
    });
  }

  it("a request that never reached a server is not a fact about the account — no standing, no promise", async () => {
    // The positive control for the table: an unreachable server sets no standing, and its run is over.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^\/api/, "");
      if (path.startsWith("/screener/suggest")) { purchases++; throw new TypeError("Failed to fetch"); }
      if (path.startsWith("/screener")) return json({ senders: [], nextCursor: null });
      return json({});
    }) as typeof fetch;
    await mountView(await engineWith(MANY), { optedIn: true });
    expect(purchases).toBe(1);
    expect(why()).toBe("pending");
  });

  it("the QUOTE's own stop is the number pressed, not the account — no standing", async () => {
    await mountView(await engineWith(MANY));
    suggestReply = (body) => json({
      dryRun: body.dryRun === true, requested: body.senders.length,
      quoted: body.senders.length, quotedCredits: body.senders.length, charged: 0,
      ...(body.dryRun === true ? {} : { stopped: "over_quote" }),
      suggestions: [], skipped: [],
    });
    await press("Suggest…");
    await press("10");
    await pressConfirm();
    await selectLastRow();
    expect(why()).toBe("pending");
    expect(text()).not.toContain("AI suggestions are not available");
  });

  it("an access read that says AI is on takes the ai_disabled reason down again", async () => {
    suggestReply = refusal(409, "ai_disabled", "managed AI is switched off");
    accessReply = () => json({ metered: false });
    await mountView(await engineWith(MANY), { optedIn: true });
    expect(purchases).toBe(1);
    await flush();
    expect(why()).toBe("pending");
  });
});

describe("standingOfRefusal / standingOfStop — the two doors into the standing", () => {
  it("reads the envelope's code on either transport, and nothing a server did not state", async () => {
    const { standingOfRefusal, standingOfStop } = await import("../app/shell/screener-suggest.js");
    const { ApiError } = await import("../app/api-client.js");
    const coded = (status: number, code: string) => new ApiError(status, code, "m", undefined, { coded: true });
    expect(standingOfRefusal(coded(402, "insufficient_credits"))).toBe("no_budget");
    expect(standingOfRefusal(coded(409, "ai_disabled"))).toBe("ai_disabled");
    expect(standingOfRefusal(coded(503, "ai_unavailable"))).toBe("ai_unavailable");
    expect(standingOfRefusal(coded(503, "suggest_unconfigured"))).toBe("refused");
    // The desktop bridge's refusal is not an `ApiError`, and carries the same code off the same envelope.
    expect(standingOfRefusal(Object.assign(new Error("m"), { status: 402, code: "insufficient_credits" })))
      .toBe("no_budget");
    // Nothing a server stated: a client-side refusal, a platform page, a bridge that never answered.
    expect(standingOfRefusal(new ApiError(0, "network_unreachable", "m"))).toBeNull();
    expect(standingOfRefusal(new ApiError(502, "internal", "m", undefined, { coded: false }))).toBeNull();
    expect(standingOfRefusal(new TypeError("Failed to fetch"))).toBeNull();
    expect(standingOfStop("out_of_credits")).toBe("no_budget");
    expect(standingOfStop("spend_unavailable")).toBe("spend_unavailable");
    expect(standingOfStop("over_quote")).toBeNull();
    expect(standingOfStop(undefined)).toBeNull();
  });
});

describe("absorbStanding — a host control's refusal reaches the shell's rows", () => {
  it("the shell's hook reads a standing put in from outside, and does not publish it back", async () => {
    const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
    const { CLOUD_WIRE } = await import("../app/(product)/mailbox/suggest-wire.js");
    const published: unknown[] = [];
    let api: { standing: unknown; absorbStanding: (s: "no_budget" | null) => void } | null = null;
    function Probe(): null {
      const s = useScreenerSuggestions({
        text: useSuggestText(),
      wire: CLOUD_WIRE,
        active: false, toast: (() => {}) as never, publishStanding: (x) => { published.push(x); },
      });
      api = s as never;
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }));
    });
    expect(api!.standing).toBeNull();
    await act(async () => { api!.absorbStanding("no_budget"); });
    expect(api!.standing).toBe("no_budget");
    // A sink that echoed it back would loop between two hooks that both publish.
    expect(published).toEqual([]);
  });
});

/**
 * A WHOLE-DOMAIN CARD NAMES WHAT ELSE IT FILES before the press: the other waiting senders at the
 * domain and how many of their letters move (`state.reachOf`), the set the press moves. Nothing is
 * said at sender scope.
 */
describe("the whole-domain card names the other senders before the press", () => {
  it("says nothing at sender scope, then names the other sender and the count at domain scope", async () => {
    // Checked at ingest and clean (`senderCheck: null`), as production rows are: the press moves them.
    const checked = (m: EngineMessage): EngineMessage => ({ ...m, senderCheck: null });
    await mountView(await engineWith([checked(msg("da", "a@letters.example", 22)), checked(msg("db", "b@letters.example", 21))]));
    expect(document.querySelector("[data-domain-reach]")).toBeNull();
    await press("whole domain");
    expect(document.querySelector("[data-domain-reach]")?.textContent)
      .toBe("Also files 1 letter from others at this domain: b@letters.example (1).");
  });
});

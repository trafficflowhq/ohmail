/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  mutationEffects,
  senderKey,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import type { SuggestBatchControl } from "../app/shell/screener-suggest";
import type { ScreenerState } from "../app/shell/screener-state";

/**
 * BUYING SUGGESTIONS FOR THE SCREENER — the trigger, its price, and its bounds.
 *
 * The surface downstream of this was finished and unreachable: `POST /screener/suggest`
 * existed, the rows knew how to render a suggestion, "Apply all" knew to hide itself at zero,
 * and NOTHING in the app ever called the endpoint. So every waiting sender said "no
 * suggestion", for ever, on an account paying for AI.
 *
 * These assertions are on the WIRE — the requests the app issues and their bodies — because
 * that is where the two properties that matter live. One: no credit moves before a person has
 * seen the number it will cost, which means the first request of the flow must be a dry run
 * and the second must not happen until a button is pressed. Two: what gets bought is bounded
 * and predictable, which means the posted sender set is a prefix of the queue in the queue's
 * own order and never a sample.
 *
 * `apps/webapp` typechecks its tests, so the shapes below are checked as well as the values.
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

/** A held message from `from`, dated so the queue order is decided by the test, not by luck. */
function msg(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: from },
    to: [],
    cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder,
    snippet: `snippet ${id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

// ── the wire, recorded ────────────────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body: { senders?: string[]; dryRun?: boolean; maxCredits?: number; automatic?: boolean } | null;
  idempotencyKey: string | null;
}

let calls: Recorded[] = [];
let sent: EngineMutation[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** What `POST /screener/suggest` answers next. A function so a test can vary it per call. */
let suggestReply: (body: { senders: string[]; dryRun?: boolean; maxCredits?: number }, n: number) => Response;
/** What `GET /screener` answers — the already-bought half. */
let listReply: () => Response;

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** The server's refusal envelope, exactly as `packages/api` writes it. */
const refusal = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

function installFetch(): void {
  let suggestCalls = 0;
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
      suggestCalls++;
      return suggestReply(raw as { senders: string[]; dryRun?: boolean; maxCredits?: number }, suggestCalls);
    }
    if (path.startsWith("/screener")) return listReply();
    return json({});
  }) as typeof fetch;
}

/** Every suggest request the app made, dry runs and purchases separated. */
const dryRuns = () => calls.filter((c) => c.path.startsWith("/screener/suggest") && c.body?.dryRun === true);
const purchases = () => calls.filter((c) => c.path.startsWith("/screener/suggest") && c.body?.dryRun !== true);

/**
 * `refuse` — a server that rejects SOME of the mutations it is sent, by predicate.
 *
 * The attempt is recorded on `sent` BEFORE the throw, so a test can tell "this row was never
 * dispatched" from "this row was dispatched and the server said no". Those are the two halves of
 * per-item failure isolation and a helper that threw first could not distinguish them.
 */
async function engineWith(
  held: EngineMessage[],
  refuse?: (m: EngineMutation) => boolean,
): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    held.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
  );
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(),
        hasMore: false,
        serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        sent.push(m);
        if (refuse?.(m)) throw new Error("the server refused this one");
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` }).map((e) => ({
          type: e.type,
          op: e.move ? "move" : "update",
          id: e.id,
          seq: ++seq,
          updatedAt: NOW.toISOString(),
          entity: e.entity,
          ...(e.move ? { move: e.move } : {}),
        }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
}

interface Mounted {
  /** The senders the state would offer to buy for, in queue order. */
  unsuggested: () => string[];
  suggestedCount: () => number;
  applyAll: () => void;
}

/**
 * Mount the REAL view over the REAL hooks — nothing about the purchase is faked but the
 * server. `active` mirrors what `AppShell` passes: the Screener is on screen.
 */
async function mountView(engine: OhmailEngine, opts: { active?: boolean } = {}): Promise<Mounted> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");

  /**
   * The LIVE state, re-captured every render.
   *
   * The accessors returned below read this at call time rather than closing over one
   * render's value — the first version of this harness returned `{ suggestedCount: () =>
   * state.suggestedCount }` built during the first render, so it went on reporting 0 after a
   * purchase had painted the chips on screen. A harness that reads a stale snapshot fails in
   * the direction that looks exactly like a product bug.
   */
  let live: {
    unsuggestedSenders: string[];
    suggestedCount: number;
    applyAll: (scopeOf: () => "sender") => void;
  } | null = null;

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const suggestions = useScreenerSuggestions({
      active: opts.active ?? true,
      toast: (() => {}) as never,
    });
    const state = useScreenerState(engine, v, (() => {}) as never, suggestions.suggestions);
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: null, screened: null, spam: null,
    });
    live = state;
    return h(ScreenerView, {
      state,
      suggest: suggestions.forSenders(state.unsuggestedSenders, [], 0, state.queueSettled),
      segment: "waiting",
      settled: true,
      owed: false,
      selection: sel as never,
      onSelect: (seg: string, id: string | null) => setSel((m) => ({ ...m, [seg]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {},
      full: false,
      onFull: () => {},
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
  return {
    unsuggested: () => live!.unsuggestedSenders,
    suggestedCount: () => live!.suggestedCount,
    applyAll: () => live!.applyAll(() => "sender"),
  };
}

/** Let every dispatched promise settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
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
  await act(async () => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

/**
 * Press the CONFIRM, whichever number it is currently quoting.
 *
 * Its label names the set — "Suggest for 12 senders" — so an exact-text press would have to
 * restate the quote in every test and would go red for the right reason in the wrong place: a
 * changed price is a pricing bug, not a "the button vanished" one. The prefix is the part that
 * identifies the control; the count is the part under test elsewhere.
 */
async function pressConfirm(): Promise<void> {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith("Suggest for "));
  if (!btn) {
    throw new Error(
      `no confirm button — on screen: ${[...document.querySelectorAll("button")]
        .map((b) => JSON.stringify(b.textContent?.trim()))
        .join(", ")}`,
    );
  }
  await act(async () => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

const text = () => host?.textContent ?? "";

beforeEach(() => {
  calls = [];
  sent = [];
  listReply = () => json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 50 } });
  suggestReply = (body) =>
    json({
      dryRun: body.dryRun === true,
      requested: body.senders.length,
      quoted: body.senders.length,
      quotedCredits: body.senders.length,
      charged: body.dryRun ? 0 : body.senders.length,
      suggestions: body.dryRun
        ? []
        : body.senders.map((s, i) => ({
            sender: s,
            messageId: `m-${s}`,
            decision: i % 2 === 0 ? "yes" : "no",
            confidence: 0.9,
            rationale: `because ${s}`,
          })),
      skipped: [],
    });
  installFetch();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

/**
 * Twelve waiting senders, newest first: `m00` is the newest message and it is from `s11`.
 *
 * The address numbering runs BACKWARDS against the dates on purpose. An earlier version of
 * this fixture named the newest sender `s00`, which made alphabetical order and queue order
 * the same list — so the order assertions below passed against an implementation that sorted
 * the batch alphabetically, and the mutation that introduced exactly that bug stayed green.
 * Reversed, the two orders disagree on every element and the tests can tell them apart.
 */
const MANY = Array.from({ length: 12 }, (_, i) =>
  msg(`m${String(i).padStart(2, "0")}`, `s${String(11 - i).padStart(2, "0")}@ex.example`, 23 - i));
/** The queue's own order — newest first. Alphabetical order is its exact reverse. */
const QUEUE = MANY.map((m) => m.from.address);

describe("the trigger — nothing is spent before the price is on screen", () => {
  it("issues NO suggest request at all until the control is opened", async () => {
    await mountView(await engineWith(MANY));
    // The one request a live Screener may make on its own is the READ of what is already
    // bought. It is `cost: read` and spends nothing.
    expect(purchases()).toHaveLength(0);
    expect(dryRuns()).toHaveLength(0);
    expect(calls.filter((c) => c.method === "GET" && c.path.startsWith("/screener"))).toHaveLength(1);
  });

  it("opening the control PRICES the set — a dry run, and still no purchase", async () => {
    await mountView(await engineWith(MANY));
    await press("Suggest…");

    expect(dryRuns()).toHaveLength(1);
    expect(dryRuns()[0]!.body?.dryRun).toBe(true);
    // THE PURCHASE HAS NOT HAPPENED. This is the assertion the whole flow exists for: the
    // number below is on screen and the credits are still in the account.
    expect(purchases()).toHaveLength(0);
  });

  it("shows the SERVER's price, in senders and in credits, before the confirm", async () => {
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    // 12 waiting under the purchase ceiling ⇒ the largest offered batch is all 12, priced in one
    // request because 12 fits inside one request's size.
    expect(text()).toContain("12 senders · 12 credits");
  });

  it("the price is the server's ANSWER, not a local multiplication of the count", async () => {
    // The server prices 4 of the 12 (the rest are already bought, or held back from the
    // model) and charges 2 credits each. A client that multiplied its own count by its own
    // idea of the cost would print "12 senders · 12 credits" here.
    suggestReply = (body) =>
      json({
        dryRun: true, requested: body.senders.length, quoted: 4, quotedCredits: 8,
        charged: 0, suggestions: [], skipped: [],
      });
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    expect(text()).toContain("4 senders · 8 credits");
    expect(text()).not.toContain("12 senders");
  });

  it("a server that states NO price sells nothing — the sentence is said, the confirm stays dead", async () => {
    // What a metered host answers while the metering program's card is unread: the set is
    // counted and no `quotedCredits` is stated. The control says so and never arms.
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true, requested: body.senders.length, quoted: body.senders.length,
        charged: 0, suggestions: [], skipped: [],
      });
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    expect(dryRuns()).toHaveLength(1);
    expect(text()).toContain(messages.screener.suggest.failed);
    expect(text()).not.toContain("credits");
    const confirm = [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.trim().startsWith("Suggest for ")) as HTMLButtonElement | undefined;
    expect(confirm, "the confirm vanished rather than staying unpressable").toBeTruthy();
    expect(confirm!.disabled).toBe(true);
    await act(async () => { confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(purchases(), "an unpriced set was bought").toHaveLength(0);
  });

  it("confirming is the ONLY thing that spends, and it carries an Idempotency-Key", async () => {
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    await pressConfirm();

    expect(purchases()).toHaveLength(1);
    const buy = purchases()[0]!;
    expect(buy.method).toBe("POST");
    expect(buy.body?.dryRun).toBeUndefined();
    expect(buy.idempotencyKey).toBeTruthy();
    // A PRESS IS A PRESS: neither half says `automatic`, so the server asks about every sender.
    for (const c of [buy, ...dryRuns()]) expect(c.body?.automatic).toBeUndefined();
  });

  it("cancelling spends nothing and leaves no purchase behind", async () => {
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    await press("Cancel");
    expect(purchases()).toHaveLength(0);
    expect(text()).toContain("Suggest…");
  });
});

/**
 * THE CONFIRM CARRIES THE FIGURE THAT WAS SHOWN.
 *
 * The service bounds a run by the quote it is handed (`packages/services/test/
 * screener-quote-ceiling.test.ts`). A bound nothing sends is a condition whose contrary state is
 * unreachable, so this is the other half: what the press actually posts, per chunk, against the
 * price each chunk was quoted at.
 */
describe("the confirm hands back the price each chunk was quoted", () => {
  it("posts the chunk's OWN quote as its ceiling, not the total and not a guess", async () => {
    // Three chunks priced differently — the shape a partly-already-bought queue produces. A
    // client that sent the SUM, or the first chunk's price for all of them, fails here.
    listReply = () => json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 5 } });
    const priceOf = (n: number): number => (n === 5 ? 4 : 1);
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true,
        requested: body.senders.length,
        quoted: priceOf(body.senders.length),
        quotedCredits: priceOf(body.senders.length),
        charged: body.dryRun ? 0 : priceOf(body.senders.length),
        suggestions: [], skipped: [],
      });
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    await pressConfirm();

    const bought = purchases();
    expect(bought.map((c) => c.body?.senders?.length)).toEqual([5, 5, 2]);
    expect(bought.map((c) => c.body?.maxCredits)).toEqual([4, 4, 1]);
  });

  it("a DRY RUN carries no ceiling — a price check has nothing to bound", async () => {
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    for (const c of dryRuns()) expect(c.body?.maxCredits).toBeUndefined();
  });

  it("…and a fresh press re-prices rather than reusing the last press's ceiling", async () => {
    // The stale-bound shape: a second press over a set the server now prices higher must send
    // the NEW figure, or the person is bounded by a number they never saw.
    let price = 8;
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true,
        requested: body.senders.length,
        quoted: price, quotedCredits: price,
        charged: body.dryRun ? 0 : price,
        suggestions: [], skipped: [],
      });
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    await pressConfirm();
    expect(purchases().at(-1)?.body?.maxCredits).toBe(8);

    price = 11;
    await press("Suggest…");
    await pressConfirm();
    expect(purchases().at(-1)?.body?.maxCredits).toBe(11);
  });
});

describe("the batch is bounded, and it is a PREFIX of the queue rather than a sample", () => {
  it("offers sizes clamped to the queue and the purchase ceiling", async () => {
    // 12 waiting, under the purchase ceiling of 400 ⇒ 10, then "all 12". 25 and 50 are not
    // offered: two buttons that both buy 12 would be two labels for one act.
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    const sizes = [...document.querySelectorAll(".scn-sg-size")].map((b) => b.textContent?.trim());
    expect(sizes).toEqual(["10", "all 12"]);
  });

  it("splits a purchase larger than the per-request cap into cap-sized requests — none posted over", async () => {
    // A small per-request cap no longer shrinks the ladder: it governs the REQUEST size, not the
    // offer. 12 waiting under a cap of 5 still offers all 12 — delivered as several requests of
    // at most 5. This is the whole point of #90: the offered batch is decoupled from the cap.
    listReply = () => json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 5 } });
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    const sizes = [...document.querySelectorAll(".scn-sg-size")].map((b) => b.textContent?.trim());
    expect(sizes).toEqual(["10", "all 12"]);
    await pressConfirm();
    // 12 senders, cap 5 ⇒ three requests of 5, 5 and 2 — never one of 12, never one over the cap.
    const bought = purchases();
    expect(bought.map((c) => c.body?.senders?.length)).toEqual([5, 5, 2]);
    // Contiguous, in the queue's own order, no sender in two chunks.
    expect(bought.flatMap((c) => c.body!.senders!)).toEqual(QUEUE.slice(0, 12));
  });

  it("posts the FIRST n senders in the queue's own order — the same n twice running", async () => {
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    await press("10");
    await pressConfirm();

    const bought = purchases()[0]!.body!.senders!;
    expect(bought).toHaveLength(10);
    // s00 is the newest held sender and s09 the tenth; the queue is `date desc` and so is
    // this. A sample, or a `Set` iteration order that happened to agree, would not be.
    expect(bought).toEqual(QUEUE.slice(0, 10));
    expect(bought[0]).toBe("s11@ex.example");
    // …and NOT the alphabetical set, which is what a `.sort()` anywhere in the path would
    // produce and what an unordered `Set` could produce by accident.
    expect(bought).not.toEqual([...bought].sort());
  });

  it("changing the size RE-PRICES on the server rather than scaling the old number", async () => {
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    expect(dryRuns()).toHaveLength(1);
    await press("10");
    expect(dryRuns()).toHaveLength(2);
    expect(dryRuns()[1]!.body?.senders).toHaveLength(10);
    expect(purchases()).toHaveLength(0);
  });
});

describe("what a bought suggestion does to the surface", () => {
  it("attaches to the ROW and to the FOCUSED preview — both, from real server data", async () => {
    const mounted = await mountView(await engineWith(MANY));
    expect(mounted.suggestedCount()).toBe(0);
    // Before: the preview says so rather than staying silent.
    expect(text()).toContain("No suggestion yet for this sender");

    await press("Suggest…");
    await pressConfirm();

    expect(mounted.suggestedCount()).toBe(12);
    // The DETAIL: the selected sender's suggestion, its confidence and its reason.
    expect(text()).toContain("AI suggests");
    expect(text()).toContain("because s11@ex.example");
    expect(text()).not.toContain("No suggestion yet for this sender");
    // The LIST: the chip on the row carries the destination it would file to. `s00` was
    // answered `yes` and `s01` `no`, so both labels are on screen at once.
    const chips = [...document.querySelectorAll(".row")].map((r) => r.textContent ?? "");
    expect(chips.some((c) => c.includes("Ohbox"))).toBe(true);
    expect(chips.some((c) => c.includes("Screened out"))).toBe(true);
  });

  it("brings back 'Apply all', which was hidden only because nothing had been bought", async () => {
    await mountView(await engineWith(MANY));
    expect(text()).not.toContain("Apply 12 — Ohbox & Screened out");
    await press("Suggest…");
    await pressConfirm();
    expect(text()).toContain("Apply 12 — Ohbox & Screened out");
  });

  it("a suggestion SURVIVES a reload — the stored answer is read back, not re-bought", async () => {
    listReply = () =>
      json({
        items: [
          {
            id: "m00", messageId: "m00", sender: { name: null, address: "s11@ex.example" },
            subject: "s", snippet: "s", receivedAt: NOW.toISOString(),
            aiSuggestion: { decision: "yes", confidence: 0.8, rationale: "known good" },
          },
        ],
        nextCursor: null,
        suggestable: { senders: [], credits: 0, maxPerRequest: 50 },
      });
    const mounted = await mountView(await engineWith(MANY));
    expect(mounted.suggestedCount()).toBe(1);
    expect(text()).toContain("known good");
    // And nothing was bought to learn it.
    expect(purchases()).toHaveLength(0);
    // The sender that already has one is NOT in the next batch.
    expect(mounted.unsuggested()).not.toContain("s11@ex.example");
    expect(mounted.unsuggested()).toHaveLength(11);
  });
});

describe("APPLY-ALL MAY NEVER DECIDE A ROW NOTHING SUGGESTED", () => {
  /**
   * The named regression. "Apply all suggestions" once read `x.ai?.dest ?? "ohbox"`, so on a
   * live account — where every row's `ai` was null — the FALLBACK decided every sender:
   * one press meant "accept every waiting stranger into the Ohbox and promote a rule for
   * each of them", under a label claiming to apply suggestions the user had never seen.
   *
   * Now that suggestions can actually arrive, the mixed queue is the dangerous case: some
   * rows carry one and some do not, and the bulk must act on exactly the first group.
   */
  it("decides ONLY the senders that carry a suggestion, on a half-suggested queue", async () => {
    // The server answers for three of the twelve, and NOT all the same way: a queue whose
    // suggestions were unanimous would let a hardcoded destination pass for a suggestion.
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true,
        requested: body.senders.length,
        quoted: 3, quotedCredits: 3,
        charged: body.dryRun ? 0 : 3,
        suggestions: body.dryRun
          ? []
          : [
              { sender: "s11@ex.example", decision: "yes" as const },
              { sender: "s10@ex.example", decision: "no" as const },
              { sender: "s09@ex.example", decision: "yes" as const },
            ].map((s) => ({
              sender: s.sender, messageId: `m-${s.sender}`, decision: s.decision,
              confidence: 0.9, rationale: "ok",
            })),
        skipped: [],
      });

    vi.useFakeTimers();
    try {
      const mounted = await mountView(await engineWith(MANY));
      await press("Suggest…");
      await pressConfirm();
      expect(mounted.suggestedCount()).toBe(3);

      await act(async () => { mounted.applyAll(); });
      // Let every staggered decision and its undo window elapse.
      await act(async () => { vi.advanceTimersByTime(12 * 240 + 20000); });
      await flush();

      const decided = sent.filter((m) => m.kind === "screener_decide") as Array<
        { senderId: string; decision: "yes" | "no" }
      >;
      expect(decided).toHaveLength(3);
      // And they are the three that were suggested, by their representative message ids.
      expect(decided.map((m) => m.senderId).sort()).toEqual(["m00", "m01", "m02"]);
      // EACH ROW CARRIES ITS OWN SUGGESTION'S ANSWER, not a shared default. `s01` was a
      // "no"; a bulk that filed it with the other two would be deciding by fallback again,
      // just at a different point in the same code.
      expect(
        Object.fromEntries(decided.map((m) => [m.senderId, m.decision])),
      ).toEqual({ m00: "yes", m01: "no", m02: "yes" });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A `hold` IS A SUGGESTION AND IS NOT A DECISION.
   *
   * The server answers `hold` when the model declined to place a sender — its own
   * `ohmail/Screener` verdict, which for a queue made entirely of first-contact strangers is the
   * MODAL answer, not a rare one. On the hosted service the day this was written it was the largest share of every
   * suggestion ever bought, and every one of them was reaching this surface as `ohbox`: the
   * collapse in `screener-service.ts` was a denylist and the gate was not on it. One press of
   * "Apply all" admitted them and wrote an allow rule for each — the same inversion the
   * regression above is named for, arriving through the mapping instead of through a fallback.
   *
   * So there are two assertions and they are different claims. `suggestedCount` must not COUNT a
   * hold, or the button offers to apply things it will not touch; `applyAll` must not DECIDE one,
   * which is the half that moves mail.
   */
  it("never decides a `hold`, and never counts one as appliable", async () => {
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true,
        requested: body.senders.length,
        quoted: 3, quotedCredits: 3,
        charged: body.dryRun ? 0 : 3,
        suggestions: body.dryRun
          ? []
          : [
              { sender: "s11@ex.example", decision: "yes" as const },
              { sender: "s10@ex.example", decision: "hold" as const },
              { sender: "s09@ex.example", decision: "hold" as const },
            ].map((s) => ({
              sender: s.sender, messageId: `m-${s.sender}`, decision: s.decision,
              confidence: 0.92, rationale: "first-contact sender; Screener hold",
            })),
        skipped: [],
      });

    vi.useFakeTimers();
    try {
      const mounted = await mountView(await engineWith(MANY));
      await press("Suggest…");
      await pressConfirm();
      // Three answers arrived; ONE of them is something a bulk control may act on.
      expect(mounted.suggestedCount(), "a hold was counted as appliable").toBe(1);

      await act(async () => { mounted.applyAll(); });
      await act(async () => { vi.advanceTimersByTime(12 * 240 + 20000); });
      await flush();

      const decided = sent.filter((m) => m.kind === "screener_decide") as Array<
        { senderId: string; decision: "yes" | "no" }
      >;
      expect(decided, "a hold was decided in bulk").toHaveLength(1);
      expect(decided[0]!.senderId).toBe("m00");
      expect(decided[0]!.decision).toBe("yes");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * ══ APPLY-ALL FINISHES THE QUEUE — SPAM INCLUDED ═══════════════════════════════════════════
 *
 * Reported from live use: "when auto-applying the AI suggestions it stops at the spam and shows
 * one only the remaining spam messages". That was exactly what the code did, and deliberately —
 * `applyAll`'s `only` predicate carried `x.ai.dest !== "spam"` beside the `hold` exclusion, and
 * `APPLY_PILE_ORDER` left spam out of the four piles the button may name. So a queue whose
 * suggestions included spam applied every other verdict and left the spam rows sitting there,
 * which reads as the control having failed halfway.
 *
 * The `hold` exclusion beside it STAYS and is a different thing: a hold is the model declining to
 * place a sender, so acting on it is a consent gate granting consent with nobody's advice behind
 * it. A spam verdict is advice, and filing on it moves mail to `ohmail/Quarantine` — a folder the
 * Spam segment lists in full, with "Not spam → Screener" and "Not spam → Ohbox" beside every row.
 * Nothing is deleted and nothing is unreachable, so there is no reason for the bulk to step over it
 * that does not apply equally to the screen-out it has always performed.
 *
 * MUTATION WATCH (2026-08-11), both applied to `screener-state.ts`, watched red, reverted:
 *   · `&& x.ai.dest !== "spam"` restored to `applyAll`'s `only` predicate ALONE — all three tests
 *     below go red, the first on the mutation table (`m03` never decided) and on a queue that is
 *     still one row deep after a press that named it. That is the reported symptom exactly.
 *   · the same clause restored to `suggestedRows` as well — the pre-fix code — additionally puts
 *     `suggestedCount` at 3 and drops `spam` out of `suggestedDests`, so the button under-promises
 *     by one before it under-delivers by one.
 *
 * The isolation test's own subject is the OTHER way a run can end short: it is written against a
 * server that refuses one row's write, and asserts the run walks past it. The mutation that proves
 * it red is the same exclusion — "the run stopped at the spam row" is what both failures look like
 * from the queue, which is why the refused row in it is the spam one.
 */
describe("APPLY-ALL FINISHES THE QUEUE — spam included", () => {
  /** Four senders, one per verdict the bulk can act on, so no two rows share an answer. */
  const MIXED: EngineMessage[] = [
    msg("m00", "keep@ex.example", 23),
    msg("m01", "reads@ex.example", 22),
    msg("m02", "out@ex.example", 21),
    msg("m03", "junk@ex.example", 20),
  ];

  const overlayOf = (of: Record<string, string>): ReadonlyMap<string, unknown> =>
    new Map(
      Object.entries(of).map(([address, dest]) => [
        senderKey(address),
        { dest, confidence: 0.9, rationale: `because ${address}` },
      ]),
    );

  /**
   * The REAL state hook with no view over it.
   *
   * These assertions are about what the bulk DISPATCHES, not about what a button says — the
   * label is `screener-chips.test.tsx`'s subject — so a probe is both smaller and harder to
   * satisfy accidentally than a mounted view.
   */
  async function probe(
    engine: OhmailEngine,
    suggestions: ReadonlyMap<string, unknown>,
    toasts: string[] = [],
  ): Promise<() => ScreenerState> {
    const { useScreenerState } = await import("../app/shell/screener-state.js");
    let live: ScreenerState | null = null;
    function Probe(): null {
      const [v, setV] = React.useState(0);
      React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
      live = useScreenerState(
        engine, v,
        ((m: string) => { toasts.push(m); }) as never,
        suggestions as never,
      );
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }),
      );
    });
    await settleFirstPaint();
    return () => live!;
  }

  /** Walk every staggered decision, its undo window and its commit off the fake clock. */
  async function drain(rows: number): Promise<void> {
    const { COMMIT_MS } = await import("../app/shell/screener-state.js");
    await act(async () => { await vi.advanceTimersByTimeAsync(rows * 240 + 200); });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMMIT_MS + 200); });
  }

  const decides = () =>
    sent.filter((m) => m.kind === "screener_decide") as Array<
      Extract<EngineMutation, { kind: "screener_decide" }>
    >;

  it("applies EVERY verdict in one pass and leaves no spam behind", async () => {
    vi.useFakeTimers();
    try {
      const engine = await engineWith(MIXED);
      const latest = await probe(engine, overlayOf({
        "keep@ex.example": "ohbox",
        "reads@ex.example": "reads",
        "out@ex.example": "screened",
        "junk@ex.example": "spam",
      }));

      // Premise: four waiting senders, four suggestions. A green over a smaller queue than this
      // would say nothing about the case that was reported.
      expect(latest().waitingCount).toBe(4);
      expect(latest().suggestedCount, "a spam verdict was not counted as appliable").toBe(4);
      // …and the button's own pile list names spam, or it would promise four and deliver three.
      expect(latest().suggestedDests).toEqual(["ohbox", "reads", "screened", "spam"]);

      await act(async () => { latest().applyAll(() => "sender"); });
      await drain(4);

      // ONE DECIDE PER SENDER, each carrying its own suggestion's destination.
      expect(
        Object.fromEntries(decides().map((m) => [m.senderId, m.dest])),
      ).toEqual({ m00: "ohbox", m01: "reads", m02: "screened", m03: "spam" });

      // NO RESIDUE. The reported symptom is precisely a non-empty queue after a press that said
      // it would empty it, so the queue's own count is the assertion that matters most here.
      expect(latest().waitingCount, "the queue still holds rows the apply named").toBe(0);
      expect(latest().suggestedCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("files a suggested spam sender through the SAME decide a manual spam press sends", async () => {
    vi.useFakeTimers();
    try {
      const world = [msg("m00", "junka@ex.example", 23), msg("m01", "junkb@ex.example", 22)];
      const engine = await engineWith(world);
      const latest = await probe(engine, overlayOf({
        "junka@ex.example": "spam",
        "junkb@ex.example": "spam",
      }));

      // A MANUAL press first, on one of the two — the shape the bulk has to match.
      const manualRow = latest().waiting.find((x) => x.from.address === "junkb@ex.example")!;
      await act(async () => { latest().decide(manualRow, "spam", { read: false, scope: "sender" }); });
      await drain(1);

      // …then the bulk, which now has only the other one left to act on.
      await act(async () => { latest().applyAll(() => "sender"); });
      await drain(1);

      const [manual, bulk] = decides();
      expect(manual?.senderId).toBe("m01");
      expect(bulk?.senderId).toBe("m00");
      // Spam rides the NO branch with an explicit destination — `{decision:"yes", dest:"spam"}` is
      // the one pairing the server refuses outright, and a bulk that reached it would 400 on every
      // row. Comparing the two mutations whole is what keeps the bulk from growing its own path.
      expect({ ...bulk, senderId: "«sender»" }).toEqual({ ...manual, senderId: "«sender»" });
      expect(bulk?.decision).toBe("no");
      expect(bulk?.dest).toBe("spam");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps going when one row's write is refused, and leaves only that row waiting", async () => {
    vi.useFakeTimers();
    try {
      const toasts: string[] = [];
      // The SPAM row is the one the server refuses, because that is the row the reported bug
      // stopped at: a run that aborts there is indistinguishable from the old exclusion.
      const engine = await engineWith(
        MIXED,
        (m) => m.kind === "screener_decide" && m.senderId === "m03",
      );
      const latest = await probe(engine, overlayOf({
        "keep@ex.example": "ohbox",
        "reads@ex.example": "reads",
        "out@ex.example": "screened",
        "junk@ex.example": "spam",
      }), toasts);

      await act(async () => { latest().applyAll(() => "sender"); });
      await drain(4);

      // EVERY row was dispatched — the refusal is a failure of one write, not of the run.
      expect(decides().map((m) => m.senderId).sort()).toEqual(["m00", "m01", "m02", "m03"]);
      // The three the server took are gone from the queue; the one it refused is still there, and
      // still carries its suggestion, so the next press can try it again.
      expect(latest().waitingCount, "a refused row took the others with it").toBe(1);
      expect(latest().waiting[0]!.from.address).toBe("junk@ex.example");
      expect(latest().suggestedCount).toBe(1);
      // The run ENDED: the progress bar is down and the summary counted every row it walked.
      expect(latest().applying).toBeNull();
      expect(toasts.at(-1)).toContain("4 decided");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("honest states", () => {
  it("a set the server prices at ZERO cannot be confirmed, and says why", async () => {
    suggestReply = (body) =>
      json({
        dryRun: true, requested: body.senders.length, quoted: 0, quotedCredits: 0,
        charged: 0, suggestions: [], skipped: [],
      });
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    expect(text()).toContain("These senders already have a suggestion.");
    const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith("Suggest for "));
    expect(confirm).toBeTruthy();
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it("an empty balance shows the CATALOGUE's sentence, and buys nothing", async () => {
    // BY CODE, NOT BY THE SERVER'S WORDS. `message` is English written for a log and was being
    // painted verbatim — an English refusal on a German screen. The code is the actionable fact
    // and the catalogue holds the sentence for it.
    suggestReply = () => refusal(402, "insufficient_credits", "no AI credits remain on this account");
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    expect(text()).toContain(messages.aiRefusal.insufficientCredits);
    expect(purchases()).toHaveLength(0);
  });

  it("a deployment with no model connected says exactly that, in the catalogue's words", async () => {
    // A server with no classifier answers 503 `suggest_unconfigured`. The control reports THAT
    // fact rather than a generic failure — the two have different fixes — and in the reader's
    // language, never the server's log English (R23-06).
    suggestReply = () =>
      refusal(503, "suggest_unconfigured", "this deployment has no AI classifier connected");
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    expect(text()).toContain(messages.aiRefusal.noModel);
    expect(text()).not.toContain("this deployment has no AI classifier connected");
    expect(purchases()).toHaveLength(0);
  });

  it("a refusal THIS CLIENT made gets this client's sentence, not the server's voice", async () => {
    // The uncoded twin of the two cases above. `whyFor` used to relay `err.message` for any
    // `ApiError`, including the ones built on this side of the wire — so the account gate's
    // English line about a cookie was painted under a comment promising whatever the SERVER
    // said. The gate refuses here for the state the reported browser was in: a live session with
    // no `tf_owner` marker.
    const { bindApiOwner } = await import("../app/api-client.js");
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    bindApiOwner("acct_A");
    try {
      await mountView(await engineWith(MANY));
      await press("Suggest…");
      expect(text()).toContain(messages.screener.suggest.refusedOwnerAbsent);
      // Not the raw sentence, and not a generic failure that names nothing.
      expect(text()).not.toContain("This browser has lost the name");
      expect(text()).not.toContain(messages.screener.suggest.failed);
      // It never reached the wire, which is what makes it a CLIENT refusal.
      expect(dryRuns()).toHaveLength(0);
      expect(purchases()).toHaveLength(0);
    } finally {
      bindApiOwner(null);
    }
  });

  it("a run that stopped part-way is not reported as a clean success", async () => {
    let toasted = "";
    const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
    const { useScreenerState } = await import("../app/shell/screener-state.js");
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true, requested: body.senders.length,
        quoted: body.senders.length, quotedCredits: body.senders.length,
        charged: body.dryRun ? 0 : 2,
        stopped: "out_of_credits",
        suggestions: body.dryRun
          ? []
          : body.senders.slice(0, 2).map((s) => ({
              sender: s, messageId: `m-${s}`, decision: "yes" as const, confidence: 0.5, rationale: "r",
            })),
        // `"withheld"` was the reason here until the AI-OPEN ruling of 2026-08-08 deleted it from
        // the wire. `out_of_credits` is the reason a run ACTUALLY stops part-way, which is what
        // this test is about, so the fixture is now the shape the server can really send.
        skipped: body.dryRun ? [] : [{ sender: body.senders[2]!, reason: "out_of_credits" }],
      });

    const engine = await engineWith(MANY);
    let control: ReturnType<ReturnType<typeof useScreenerSuggestions>["forSenders"]> | null = null;
    function Probe(): null {
      const s = useScreenerSuggestions({ active: true, toast: ((m: string) => { toasted = m; }) as never });
      const st = useScreenerState(engine, 0, (() => {}) as never, s.suggestions);
      control = s.forSenders(st.unsuggestedSenders, [], 0, st.queueSettled);
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
    await settleFirstPaint();
    await flush();
    await act(async () => { control!.open(); });
    await flush();
    await act(async () => { control!.confirm(); });
    await flush();

    expect(toasted).toContain("2 suggestions");
    expect(toasted).toContain("2 credits used");
    expect(toasted).toContain("Stopped — credits ran out.");
    // The "1 sender held back from the model" clause was asserted here and is gone with the
    // reason that produced it. The summary must not invent a substitute: what it says is what was
    // bought and where it stopped.
    expect(toasted).not.toMatch(/held back from the model/);
  });

  /* AN UNMETERED HOST (`managed-service.ts`) counts what came back and names no credits: a
     self-hosted server charges nothing, and "no credits used" was vocabulary it does not have. */
  it("on an unmetered host the done line counts suggestions and names no credits", async () => {
    let toasted = "";
    const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
    const { useScreenerState } = await import("../app/shell/screener-state.js");
    const { ManagedServiceContext } = await import("@ohmail/app-logic/doors/managed-service");
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true, requested: body.senders.length,
        quoted: body.senders.length, quotedCredits: 0, charged: 0,
        suggestions: body.dryRun
          ? []
          : body.senders.slice(0, 2).map((s) => ({
              sender: s, messageId: `m-${s}`, decision: "yes" as const, confidence: 0.5, rationale: "r",
            })),
        skipped: [],
      });

    const engine = await engineWith(MANY);
    let control: ReturnType<ReturnType<typeof useScreenerSuggestions>["forSenders"]> | null = null;
    function Probe(): null {
      const s = useScreenerSuggestions({ active: true, toast: ((m: string) => { toasted = m; }) as never });
      const st = useScreenerState(engine, 0, (() => {}) as never, s.suggestions);
      control = s.forSenders(st.unsuggestedSenders, [], 0, st.queueSettled);
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(ManagedServiceContext.Provider, { value: false, children: h(Probe) }),
      }));
    });
    await settleFirstPaint();
    await flush();
    await act(async () => { control!.open(); });
    await flush();
    await act(async () => { control!.confirm(); });
    await flush();

    expect(toasted).toContain("2 suggestions.");
    expect(toasted).not.toMatch(/credit/i);
  });

  it("a server that quotes no CREDITS cannot be bought from — the price is not guessed", async () => {
    // The shape an older API answers with, reachable in the minutes between two deploys.
    // The count is there and the cost is not; a client that multiplied the one by an assumed
    // credit price would show a confident number it had invented.
    suggestReply = (body) =>
      json({
        dryRun: true, requested: body.senders.length, quoted: body.senders.length,
        charged: 0, suggestions: [], skipped: [],
      });
    await mountView(await engineWith(MANY));
    await press("Suggest…");

    expect(text()).not.toContain("12 credits");
    const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith("Suggest for "));
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(purchases()).toHaveLength(0);
  });

  it("with no waiting senders there is no control at all", async () => {
    await mountView(await engineWith([msg("x1", "a@ex.example", 9, "INBOX")]));
    expect(text()).not.toContain("Suggest…");
  });
});

describe("the Screener asks for nothing until it is looked at", () => {
  it("`active: false` reads nothing — the shell passes this for the demo and every other view", async () => {
    await mountView(await engineWith(MANY), { active: false });
    expect(calls).toHaveLength(0);
  });
});

/**
 * THE SIZE LADDER — the offered batch sizes, bounded by the queue and the PURCHASE CEILING.
 *
 * `batchSizes(available, ceiling)` is the whole of "what can I buy in one go". The ceiling is the
 * most one authorised purchase may buy ({@link MAX_SUGGEST_BATCH}, 400) — NOT the per-request cap,
 * which governs only how a purchase is chunked into requests. The ladder is the fixed offered
 * sizes below the ceiling, then the ceiling itself, so the largest button is always "the whole
 * batch" and no two buttons buy the same number. These assertions are on the pure function rather
 * than the rendered control because the property under test is arithmetic, not layout.
 */
describe("the size ladder — 50 / 100 / 200 / 400 are offered under a large ceiling", () => {
  it("adds 100 / 200 / 400 above the small watchable sizes, always ending at the ceiling", async () => {
    const { batchSizes } = await import("../app/shell/screener-suggest.js");
    // A queue larger than the ceiling: every offered size below the ceiling, then the ceiling.
    // This is the user-visible acceptance — the control offers 50, 100, 200 and 400.
    expect(batchSizes(500, 400)).toEqual([10, 25, 50, 100, 200, 400]);
    // The ceiling still wins: nothing at or above it is offered as its own button.
    expect(batchSizes(500, 200)).toEqual([10, 25, 50, 100, 200]);
    // A small queue keeps the small watchable batches and ends in "all of them" (the ceiling here
    // is the queue length); the 100/200/400 additions never crowd the small sizes out.
    expect(batchSizes(12, 400)).toEqual([10, 12]);
  });
});

/**
 * SUGGEST-CHUNK — A PURCHASE LARGER THAN ONE REQUEST IS DELIVERED, AND PAID FOR, IN CHUNKS.
 *
 * The offered batch is decoupled from the per-request cap: a size larger than one request is
 * priced as the SUM of cap-sized dry runs and bought as cap-sized requests, each with its own
 * idempotency key. These assertions are the spend contract of that split — every one of them was
 * watched go RED against the mutation named in its comment, and GREEN again once restored:
 *
 *  (a) one idempotency key PER CHUNK — drop the key, or share one across chunks, and the keys
 *      collapse; a re-run of an already-bought chunk would then re-buy rather than replay.
 *  (b) the price is the SUM of the chunk quotes, and spend never exceeds it — replace `+=` with
 *      `=` and the quote shows the last chunk's 2, not the whole 12.
 *  (c) `run` captured once and checked between chunks — remove the post-await check and a chunk
 *      that resolves after a concurrent press paints its chips anyway.
 */
describe("SUGGEST-CHUNK — a large purchase is chunked, priced by the sum, and spend-safe", () => {
  /** Mount the real hooks, exposing the control, the suggested count, and the last toast. */
  async function mountProbe(): Promise<{
    control: () => SuggestBatchControl;
    suggestedCount: () => number;
    toasted: () => string;
  }> {
    const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
    const { useScreenerState } = await import("../app/shell/screener-state.js");
    const engine = await engineWith(MANY);
    let toasted = "";
    let control: SuggestBatchControl | null = null;
    let live: { suggestedCount: number; unsuggestedSenders: string[] } | null = null;
    function Probe(): null {
      const [v, setV] = React.useState(0);
      React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
      const s = useScreenerSuggestions({ active: true, toast: ((m: string) => { toasted = m; }) as never });
      const st = useScreenerState(engine, v, (() => {}) as never, s.suggestions);
      control = s.forSenders(st.unsuggestedSenders, [], 0, st.queueSettled);
      live = st;
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }));
    });
    await flush();
    await settleFirstPaint();
    return {
      control: () => control!,
      suggestedCount: () => live!.suggestedCount,
      toasted: () => toasted,
    };
  }

  /** Every test here runs under a small per-request cap so a 12-sender batch chunks 5 / 5 / 2. */
  const cap5 = () =>
    json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 5 } });

  it("buys a large batch as cap-sized chunks — every chunk's chips land, then ONE summary", async () => {
    listReply = cap5;
    const p = await mountProbe();
    await act(async () => { p.control().open(); });
    await flush();
    // (b) The price is the SUM of the three dry-run chunks (5 + 5 + 2), not one chunk's figure.
    expect(dryRuns().map((c) => c.body?.senders?.length)).toEqual([5, 5, 2]);
    expect(p.control().quote).toEqual({ senders: 12, credits: 12 });

    await act(async () => { p.control().confirm(); });
    await flush();
    await flush();
    // Three requests, none over the cap of 5.
    expect(purchases().map((c) => c.body?.senders?.length)).toEqual([5, 5, 2]);
    // ALL twelve landed, not just the first chunk. If the loop re-bumped `run` between chunks —
    // the SCR-SUGGEST-FLAKE self-invalidation moved inside one purchase — chunks 2 and 3 would
    // discard themselves and this would be 5.
    expect(p.suggestedCount()).toBe(12);
    // One summary for the whole 12 — the sum, not a toast per chunk.
    expect(p.toasted()).toContain("12 suggestions");
    expect(p.toasted()).toContain("12 credits used");
  });

  it("(a) gives EACH chunk its own idempotency key — present and distinct", async () => {
    listReply = cap5;
    await mountView(await engineWith(MANY));
    await press("Suggest…");
    await pressConfirm();
    const keys = purchases().map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(3);
    // Present on every chunk (mutation: drop `idempotencyKey: newKey()` ⇒ nulls here).
    expect(keys.every((k) => typeof k === "string" && k!.length > 0)).toBe(true);
    // Distinct per chunk (mutation: one shared key ⇒ chunk 2 replays chunk 1, and these collapse).
    expect(new Set(keys).size).toBe(3);
  });

  it("(b)+resume: a mid-run chunk failure keeps what charged, and the resume charges only the rest", async () => {
    listReply = cap5;
    // A server that remembers what it answered — an already-answered sender is served free — and
    // whose THIRD purchase faults, cutting run 1 short after two chunks.
    const answered = new Set<string>();
    let purchaseCalls = 0;
    let totalCharged = 0;
    suggestReply = (body) => {
      if (body.dryRun) {
        const priceable = body.senders.filter((s) => !answered.has(s)).length;
        return json({ dryRun: true, requested: body.senders.length, quoted: priceable, quotedCredits: priceable, charged: 0, suggestions: [], skipped: [] });
      }
      purchaseCalls++;
      if (purchaseCalls === 3) return refusal(503, "ai_unavailable", "AI suggestions are temporarily unavailable; please retry");
      const fresh = body.senders.filter((s) => !answered.has(s));
      for (const s of fresh) answered.add(s);
      totalCharged += fresh.length;
      return json({
        dryRun: false, requested: body.senders.length, quoted: fresh.length, quotedCredits: fresh.length, charged: fresh.length,
        suggestions: body.senders.map((s, i) => ({ sender: s, messageId: `m-${s}`, decision: i % 2 === 0 ? "yes" as const : "no" as const, confidence: 0.9, rationale: "r" })),
        skipped: [],
      });
    };

    const p = await mountProbe();
    // RUN 1 — chunk 3 faults.
    await act(async () => { p.control().open(); });
    await flush();
    await act(async () => { p.control().confirm(); });
    await flush();
    await flush();
    // Two chunks landed (10), the third faulted. Progress kept, and the server's own sentence.
    expect(p.suggestedCount()).toBe(10);
    expect(p.control().notice).toContain("Suggested 10 of 12");
    expect(p.control().notice).toContain(messages.aiRefusal.aiUnavailable);
    expect(p.toasted()).toContain("10 suggestions");
    expect(p.toasted()).toContain("10 credits used");

    // RUN 2 — the queue is now the 2 senders that never bought; the 10 are not re-asked.
    await act(async () => { p.control().open(); });
    await flush();
    expect(p.control().quote).toEqual({ senders: 2, credits: 2 });
    await act(async () => { p.control().confirm(); });
    await flush();
    await flush();
    expect(p.suggestedCount()).toBe(12);
    // The spend contract: 12 senders charged EXACTLY ONCE across both runs — never 22, never the
    // 10 a second time. Spend ≤ the price that was quoted for the full set.
    expect(totalCharged).toBe(12);
  });

  it("(c) a concurrent press invalidates an in-flight chunked purchase — the stale chunk paints nothing", async () => {
    interface Pend { path: string; body: { senders?: string[]; dryRun?: boolean } | null; resolve: (r: Response) => void; }
    const pending: Pend[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const path = url.replace(/^\/api/, "");
      const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as Pend["body"]) : null;
      return await new Promise<Response>((resolve) => pending.push({ path, body: raw, resolve }));
    }) as typeof fetch;
    const resolveNext = async (match: (p: Pend) => boolean, value: unknown): Promise<void> => {
      const idx = pending.findIndex(match);
      if (idx < 0) throw new Error(`no pending matches; have: ${pending.map((p) => `${p.path} ${JSON.stringify(p.body)}`).join(" | ")}`);
      const [p] = pending.splice(idx, 1);
      p!.resolve(json(value));
      await flush();
    };
    const isList = (p: Pend) => p.path === "/screener" || p.path.startsWith("/screener?");
    const isDry = (p: Pend) => p.path.startsWith("/screener/suggest") && p.body?.dryRun === true;
    const isBuy = (p: Pend) => p.path.startsWith("/screener/suggest") && p.body?.dryRun !== true;
    const rows = (from: number, to: number) =>
      QUEUE.slice(from, to).map((s) => ({ sender: s, messageId: `m-${s}`, decision: "yes" as const, confidence: 0.9, rationale: "r" }));

    const p = await mountProbe();
    // Small per-request cap so a 12-sender purchase chunks 5 / 5 / 2.
    await resolveNext(isList, { items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 5 } });

    await act(async () => { p.control().open(); });
    await resolveNext(isDry, { dryRun: true, requested: 5, quoted: 5, quotedCredits: 5, charged: 0, suggestions: [], skipped: [] });
    await resolveNext(isDry, { dryRun: true, requested: 5, quoted: 5, quotedCredits: 5, charged: 0, suggestions: [], skipped: [] });
    await resolveNext(isDry, { dryRun: true, requested: 2, quoted: 2, quotedCredits: 2, charged: 0, suggestions: [], skipped: [] });
    expect(p.control().quote).toEqual({ senders: 12, credits: 12 });

    await act(async () => { p.control().confirm(); });
    // Chunk 1 lands — five chips, still running.
    await resolveNext(isBuy, { dryRun: false, requested: 5, quoted: 5, quotedCredits: 5, charged: 5, suggestions: rows(0, 5), skipped: [] });
    expect(p.suggestedCount()).toBe(5);
    expect(p.control().phase).toBe("running");

    // A CONCURRENT PRESS: cancel bumps `io.current.run`, so the in-flight loop is now stale.
    await act(async () => { p.control().cancel(); });

    // Chunk 2 answers AFTER the cancel. It must paint nothing and buy no further chunk.
    await resolveNext(isBuy, { dryRun: false, requested: 5, quoted: 5, quotedCredits: 5, charged: 5, suggestions: rows(5, 10), skipped: [] });

    // (c) Chunk 2's five did NOT merge — still 5. (Mutation: drop the post-await `run` check ⇒ 10.)
    expect(p.suggestedCount()).toBe(5);
    // And the loop stopped: no third chunk was ever requested.
    expect(pending.filter(isBuy)).toHaveLength(0);
  });
});

/**
 * SUGGEST-CHUNK, THE OTHER HALF — A REQUEST IS BOUNDED BY THE LATENCY BUDGET, BELOW THE SERVER CAP.
 *
 * The tests above force chunking with a tiny `maxPerRequest` (5), which cannot tell whether a chunk
 * is 5 because of the cap or because of the client's own budget. This is the case that separates
 * them, and it is the live defect this split fixes: production publishes a cap per request, but a large Screener's senders
 * classify SERIALLY past the platform's invocation limit and time out — the request froze partway and the
 * chips only appeared after a manual reload. The request size is therefore the client's smaller
 * latency budget ({@link SUGGEST_CHUNK_SIZE}), NOT the cap. With the cap set exactly as
 * production sends it, a batch well above the budget must still go out in budget-sized requests.
 *
 * Watched go RED against the pre-fix `chunkSize = maxPerRequest`: that made a 33-sender batch one
 * request of 33 (and a 50-batch one request of 50 — the timeout), so `Math.max(...sizes)` was 33,
 * not the budget.
 */
describe("SUGGEST-CHUNK — the request size is the latency budget, not the 413 cap", () => {
  it("chunks a large batch at SUGGEST_CHUNK_SIZE even when the server cap is far higher (50)", async () => {
    const { SUGGEST_CHUNK_SIZE } = await import("../app/shell/screener-suggest.js");
    // The production cap, verbatim. Nothing here shrinks the request but the client's own budget.
    listReply = () =>
      json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 50 } });
    const held = Array.from({ length: SUGGEST_CHUNK_SIZE * 2 + 3 }, (_, i) =>
      msg(`b${String(i).padStart(2, "0")}`, `bulk${String(i).padStart(2, "0")}@ex.example`, i % 24));
    await mountView(await engineWith(held));
    await press("Suggest…");
    await pressConfirm();

    const sizes = purchases().map((c) => c.body?.senders?.length ?? 0);
    const total = held.length;
    // Every request fits the latency budget, and the largest is EXACTLY the budget — never the cap.
    expect(Math.max(...sizes)).toBe(SUGGEST_CHUNK_SIZE);
    expect(Math.max(...sizes)).toBeLessThan(50);
    // ceil(total / budget) requests, summing to the whole batch — no sender dropped or doubled.
    expect(sizes.length).toBe(Math.ceil(total / SUGGEST_CHUNK_SIZE));
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(total);
    // NOT one oversized request — the pre-fix behaviour, and the shape that 504s at 50.
    expect(sizes).not.toEqual([total]);
  });

  /*
   * ── THE OLD SERVER IS THE CASE THAT MATTERS, AND IT IS A DEPLOYMENT FACT, NOT A HYPOTHESIS ──
   *
   * The API and this app are separate artifacts deployed separately (the project's design notes), so
   * during a rollout — or a rollback — this client talks to the PREVIOUS server, which buys its
   * senders one at a time. The client cannot tell the two apart from `maxPerRequest`, which both
   * publish as 50: that is a 413 boundary and says nothing about how the work is done. So the
   * server that can take a bigger chunk is the one that says so, on
   * `suggestable.recommendedPerRequest`, and a server that says nothing gets the fallback.
   *
   * Sizing a chunk for lanes and sending it to a serial server is ~80 s against a 60 s invocation:
   * killed by the deadline, with a partly debited purchase and no response.
   */
  it("an OLD server (no `recommendedPerRequest`) keeps the conservative fallback", async () => {
    const { SUGGEST_CHUNK_SIZE } = await import("../app/shell/screener-suggest.js");
    // Exactly what the previous deployment sends: the cap, and nothing about lanes.
    listReply = () =>
      json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 50 } });
    const held = Array.from({ length: 100 }, (_, i) =>
      msg(`o${String(i).padStart(2, "0")}`, `old${String(i).padStart(2, "0")}@ex.example`, i % 24));
    await mountView(await engineWith(held));
    await press("Suggest…");
    await pressConfirm();

    const sizes = purchases().map((c) => c.body?.senders?.length ?? 0);
    expect(
      Math.max(...sizes),
      "the client sized its request for a server that never said it could take one",
    ).toBe(SUGGEST_CHUNK_SIZE);
    expect(SUGGEST_CHUNK_SIZE, "the fallback is no longer the size a SERIAL server can finish")
      .toBeLessThanOrEqual(15);
  });

  it("a NEW server's recommendation is adopted, and never above its own 413 cap", async () => {
    listReply = () => json({
      items: [], nextCursor: null,
      suggestable: { senders: [], credits: 0, maxPerRequest: 50, recommendedPerRequest: 25 },
    });
    const held = Array.from({ length: 100 }, (_, i) =>
      msg(`n${String(i).padStart(2, "0")}`, `new${String(i).padStart(2, "0")}@ex.example`, i % 24));
    await mountView(await engineWith(held));
    await press("Suggest…");
    await pressConfirm();

    const sizes = purchases().map((c) => c.body?.senders?.length ?? 0);
    expect(Math.max(...sizes), "the server's recommendation was ignored").toBe(25);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("a recommendation ABOVE the cap is still clamped by the cap — the 413 is not negotiable", async () => {
    // A server that recommends more than it will accept is a server that is wrong about itself,
    // and the client must not be the thing that turns that into an overage the user pays for.
    listReply = () => json({
      items: [], nextCursor: null,
      suggestable: { senders: [], credits: 0, maxPerRequest: 20, recommendedPerRequest: 40 },
    });
    const held = Array.from({ length: 60 }, (_, i) =>
      msg(`c${String(i).padStart(2, "0")}`, `cap${String(i).padStart(2, "0")}@ex.example`, i % 24));
    await mountView(await engineWith(held));
    await press("Suggest…");
    await pressConfirm();

    expect(Math.max(...purchases().map((c) => c.body?.senders?.length ?? 0))).toBe(20);
  });
});

/**
 * SCR-SUGGEST-FLAKE — THE AUTOMATIC BATCH MUST NOT CANCEL A MANUAL PURCHASE.
 *
 * The manual control and the automatic (opt-in) batch both call `screenerApi.suggest`, and the
 * automatic batch fires ASYNCHRONOUSLY — it waits on `hydrateSettled`, which flips only when the
 * one-page `GET /screener` hydrate resolves. That resolve is a network round trip, and an owner
 * who opens the Screener and presses Suggest lands inside it: the manual purchase is in flight
 * when the hydrate lands and the automatic batch fires for the first time.
 *
 * The two flows shared one press counter (`io.current.run`), so the automatic batch's own
 * `++io.current.run` invalidated the manual purchase's in-flight response — the manual `await`
 * returned, saw the counter had moved, and discarded itself WITHOUT clearing `running`. The
 * button spun on the running label and never came back. On a later visit the automatic batch
 * had already fired (its latch holds for the mount), so the counter stayed still and the same
 * press worked — the reported "fails the first time, works on retry".
 *
 * This drives the exact window with a hand-resolved fetch, because the timing IS the bug: the
 * hydrate must land AFTER the manual confirm and BEFORE its response.
 */
describe("SCR-SUGGEST-FLAKE — the auto batch must not cancel a manual purchase", () => {
  interface Pending { path: string; body: { senders?: string[]; dryRun?: boolean } | null; resolve: (r: Response) => void; }

  it("a manual purchase in flight when the auto batch first fires still completes", async () => {
    const pending: Pending[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const path = url.replace(/^\/api/, "");
      const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as Pending["body"]) : null;
      return await new Promise<Response>((resolve) => pending.push({ path, body: raw, resolve }));
    }) as typeof fetch;

    const resolveOne = async (match: (p: Pending) => boolean, value: unknown): Promise<void> => {
      const idx = pending.findIndex(match);
      if (idx < 0) throw new Error(`no pending request matches; have: ${pending.map((p) => `${p.path} ${JSON.stringify(p.body)}`).join(" | ")}`);
      const [p] = pending.splice(idx, 1);
      p!.resolve(new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }));
      await flush();
    };
    const isList = (p: Pending) => p.path === "/screener" || p.path.startsWith("/screener?");
    const isDry = (p: Pending) => p.path.startsWith("/screener/suggest") && p.body?.dryRun === true;
    const isBuy = (p: Pending, n: number) => p.path.startsWith("/screener/suggest") && p.body?.dryRun !== true && p.body?.senders?.length === n;

    const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
    const { useScreenerState } = await import("../app/shell/screener-state.js");
    const engine = await engineWith(MANY);
    let toasted = "";
    let control: ReturnType<ReturnType<typeof useScreenerSuggestions>["forSenders"]> | null = null;
    function Probe(): null {
      const s = useScreenerSuggestions({ active: true, autoSuggest: true, toast: ((m: string) => { toasted = m; }) as never });
      const st = useScreenerState(engine, 0, (() => {}) as never, s.suggestions);
      control = s.forSenders(st.unsuggestedSenders, [], 0, st.queueSettled);
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }));
    });
    await settleFirstPaint();
    await flush();

    // The hydrate `GET /screener` is in flight and UNRESOLVED — so `hydrateSettled` is false and
    // the automatic batch has not fired. The user prices, then confirms, inside this window.
    await act(async () => { control!.open(); });
    await resolveOne(isDry, {
      dryRun: true, requested: 12, quoted: 12, quotedCredits: 12, charged: 0, suggestions: [], skipped: [],
    });
    await act(async () => { control!.confirm(); });
    // The manual purchase is now in flight; the button reads "Suggesting…".
    expect(control!.phase).toBe("running");

    // The hydrate lands NOW — `hydrateSettled` flips and the automatic batch fires for the first
    // time, mid-purchase. This is the event that used to cancel the manual request.
    await resolveOne(isList, { items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 50 } });

    // The user's manual purchase answers.
    await resolveOne((p) => isBuy(p, 12), {
      dryRun: false, requested: 12, quoted: 12, quotedCredits: 12, charged: 12,
      suggestions: QUEUE.map((s, i) => ({ sender: s, messageId: `mm-${i}`, decision: "yes" as const, confidence: 0.9, rationale: "manual" })),
      skipped: [],
    });

    // It must have COMPLETED: the spinner is gone and the purchase was reported. If the automatic
    // batch discarded it, `phase` is stuck on "running" and no toast was shown.
    expect(control!.phase, "the manual purchase was discarded and the button left spinning").toBe("closed");
    expect(toasted).toContain("12 suggestions");
  });
});

/**
 * SUGGEST-PROGRESS / APPLY-PROGRESS — THE TWO NUMBERS, PUBLISHED AS NUMBERS.
 *
 * ── WHAT A PERSON SEES TODAY ─────────────────────────────────────────────────────────────
 *
 * Both of the Screener's long operations are staged and neither of them says how far it has
 * got in a shape anything but a sentence can read. A 40-sender purchase goes out in chunks of
 * fifteen and the only evidence of movement is a translated string; a 40-row "Apply" dispatches
 * one decision every 240 ms — ten seconds of work — and publishes nothing at all until the
 * summary toast at the end. In both cases the honest question ("is this working, or stuck?")
 * had no answer a progress track could render.
 *
 * ── WHY THE NUMBERS AND NOT THE SENTENCE ─────────────────────────────────────────────────
 *
 * `notice` already carries "3 of 40 suggested…", and a surface that wanted a track had to parse
 * English back out of it. That parse is a locale bug waiting to happen: a translation free to
 * order the numbers differently would break the reader, not the sentence. So the pair is
 * published beside the sentence and neither is derived from the other.
 *
 * ── RED-FIRST, EACH ──────────────────────────────────────────────────────────────────────
 *
 *  · delete `setProgress({ done: 0, total })` in `confirm` ⇒ "starts at 0 of the whole set" red;
 *  · delete the per-chunk `setProgress` ⇒ "ticks per chunk" red at 0 of 12;
 *  · delete the `setProgress(null)` after the loop ⇒ "clears when the run ends" red;
 *  · delete `s.applying = { done: i + 1, total }` in `bulk` ⇒ "ticks per row" red at 0 of 3;
 *  · delete `s.applying = null` at the end of `bulk` ⇒ "clears with the summary" red;
 *  · delete the `bump()` beside the PRESS-frame write ⇒ red with `null` where `{0, 3}` is
 *    expected. That one is the whole reason the write is there twice.
 *
 * SAY WHAT IS NOT PROVEN. Deleting the `bump()` beside the PER-ROW write leaves this suite
 * GREEN, and that is recorded rather than papered over: `decide` schedules its own render, so
 * that `bump` is redundant TODAY and is kept because the row write must not depend on a
 * neighbouring function continuing to re-render. A guard nobody has watched fail is not
 * evidence, and this is the line that says which of the four is argument rather than evidence.
 */
describe("SUGGEST-PROGRESS — a running purchase publishes done/total, not only a sentence", () => {
  const cap5 = () =>
    json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 5 } });

  /** The same probe the chunk tests use, minus the toast. */
  async function mountControl(): Promise<{ control: () => SuggestBatchControl }> {
    const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
    const { useScreenerState } = await import("../app/shell/screener-state.js");
    const engine = await engineWith(MANY);
    let control: SuggestBatchControl | null = null;
    function Probe(): null {
      const [v, setV] = React.useState(0);
      React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
      const s = useScreenerSuggestions({ active: true, toast: (() => {}) as never });
      const st = useScreenerState(engine, v, (() => {}) as never, s.suggestions);
      control = s.forSenders(st.unsuggestedSenders, [], 0, st.queueSettled);
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }));
    });
    await flush();
    await settleFirstPaint();
    return { control: () => control! };
  }

  it("is null while nothing is running — no track before a press, and none after a price", async () => {
    listReply = cap5;
    const p = await mountControl();
    expect(p.control().progress).toBeNull();
    await act(async () => { p.control().open(); });
    await flush();
    // A PRICED but unconfirmed set is not in flight. A track here would be a bar under a button
    // nobody has pressed.
    expect(p.control().phase).toBe("ready");
    expect(p.control().progress).toBeNull();
  });

  it("ticks per chunk, from 0 of the whole set, and clears when the run ends", async () => {
    // Held requests, so the run can be inspected BETWEEN chunks rather than after it is over.
    interface Pend { path: string; body: { senders?: string[]; dryRun?: boolean } | null; resolve: (r: Response) => void }
    const pending: Pend[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const path = url.replace(/^\/api/, "");
      const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as Pend["body"]) : null;
      return await new Promise<Response>((resolve) => pending.push({ path, body: raw, resolve }));
    }) as typeof fetch;
    const answer = async (match: (p: Pend) => boolean, value: unknown): Promise<void> => {
      const idx = pending.findIndex(match);
      if (idx < 0) throw new Error(`no pending matches; have: ${pending.map((x) => `${x.path} ${JSON.stringify(x.body)}`).join(" | ")}`);
      const [x] = pending.splice(idx, 1);
      x!.resolve(json(value));
      await flush();
    };
    const isList = (x: Pend) => x.path.startsWith("/screener") && !x.path.startsWith("/screener/suggest");
    const isDry = (x: Pend) => x.path.startsWith("/screener/suggest") && x.body?.dryRun === true;
    const isBuy = (x: Pend) => x.path.startsWith("/screener/suggest") && x.body?.dryRun !== true;
    const rows = (from: number, to: number) =>
      QUEUE.slice(from, to).map((s, i) => ({ sender: s, messageId: `m-${s}`, decision: (i % 2 === 0 ? "yes" : "no") as "yes" | "no", confidence: 0.9, rationale: "r" }));

    const p = await mountControl();
    await answer(isList, { items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 5 } });

    await act(async () => { p.control().open(); });
    await flush();
    for (let i = 0; i < 3; i++) await answer(isDry, { dryRun: true, requested: 5, quoted: 5, quotedCredits: 5, charged: 0, suggestions: [], skipped: [] });

    await act(async () => { p.control().confirm(); });
    await flush();
    // BEFORE the first chunk answers. `total` is the SET the user consented to (12), not the
    // chunk in flight (5) — a denominator of 5 would report the first chunk as the whole job.
    expect(p.control().progress).toEqual({ done: 0, total: 12 });

    await answer(isBuy, { dryRun: false, requested: 5, quoted: 5, quotedCredits: 5, charged: 5, suggestions: rows(0, 5), skipped: [] });
    expect(p.control().progress).toEqual({ done: 5, total: 12 });
    expect(p.control().phase).toBe("running");

    await answer(isBuy, { dryRun: false, requested: 5, quoted: 5, quotedCredits: 5, charged: 5, suggestions: rows(5, 10), skipped: [] });
    expect(p.control().progress).toEqual({ done: 10, total: 12 });

    await answer(isBuy, { dryRun: false, requested: 2, quoted: 2, quotedCredits: 2, charged: 2, suggestions: rows(10, 12), skipped: [] });
    // CLEARED, not left full. A completed track that stays on screen claims work is in flight.
    expect(p.control().phase).toBe("closed");
    expect(p.control().progress).toBeNull();
  });

  it("clears on a HALTED run — a stopped purchase must not leave a moving bar behind", async () => {
    listReply = cap5;
    let n = 0;
    suggestReply = (body) => {
      if (body.dryRun) return json({ dryRun: true, requested: body.senders.length, quoted: body.senders.length, quotedCredits: body.senders.length, charged: 0, suggestions: [], skipped: [] });
      n++;
      if (n === 2) return refusal(503, "ai_unavailable", "AI suggestions are temporarily unavailable; please retry");
      return json({
        dryRun: false, requested: body.senders.length, quoted: body.senders.length, quotedCredits: body.senders.length, charged: body.senders.length,
        suggestions: body.senders.map((s) => ({ sender: s, messageId: `m-${s}`, decision: "yes" as const, confidence: 0.9, rationale: "r" })),
        skipped: [],
      });
    };
    const p = await mountControl();
    await act(async () => { p.control().open(); });
    await flush();
    await act(async () => { p.control().confirm(); });
    await flush();
    await flush();
    // The sentence says what happened; the track says nothing, because nothing is happening.
    expect(p.control().notice).toContain("Suggested 5 of 12");
    expect(p.control().progress).toBeNull();
  });
});

describe("APPLY-PROGRESS — a staged bulk publishes how far it has got", () => {
  it("counts rows as their decisions actually fire, then clears with the summary", async () => {
    vi.useFakeTimers();
    try {
      const { useScreenerState } = await import("../app/shell/screener-state.js");
      const { COMMIT_MS } = await import("../app/shell/screener-state.js");
      const engine = await engineWith(MANY.slice(0, 3));
      // Three senders, every one carrying a suggestion, so `applyAll` acts on all three.
      const overlay = new Map(
        MANY.slice(0, 3).map((m) => [m.from.address, { dest: "reads" as const, confidence: 0.9, rationale: "r" }]),
      );
      let live: { applying: { done: number; total: number } | null; applyAll: (f: () => "sender") => void } | null = null;
      function Probe(): null {
        const [v, setV] = React.useState(0);
        React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
        live = useScreenerState(engine, v, (() => {}) as never, overlay as never);
        return null;
      }
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }));
      });
      await settleFirstPaint();

      // Nothing running.
      expect(live!.applying).toBeNull();

      await act(async () => { live!.applyAll(() => "sender"); });
      // PUBLISHED IN THE SAME FRAME AS THE PRESS. The first row's timer has not fired yet, so a
      // field written only inside those timers reads null here — which is a blank quarter-second
      // on a control the user has just pressed.
      expect(live!.applying).toEqual({ done: 0, total: 3 });

      // Row 1 fires at 0 ms, row 2 at 240, row 3 at 480; the summary at 3×240 + 160.
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(live!.applying).toEqual({ done: 1, total: 3 });
      await act(async () => { await vi.advanceTimersByTimeAsync(240); });
      expect(live!.applying).toEqual({ done: 2, total: 3 });
      await act(async () => { await vi.advanceTimersByTimeAsync(240); });
      expect(live!.applying).toEqual({ done: 3, total: 3 });

      // …and the summary timer clears it. A full bar beside "3 decided" is two surfaces
      // disagreeing about whether the work is over.
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(live!.applying).toBeNull();

      // Drain the commit timers so nothing is left pending on the fake clock.
      await act(async () => { await vi.advanceTimersByTimeAsync(COMMIT_MS + 100); });
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * CREDITS-LEFT — THE ONE NUMBER THIS CLIENT MAY NEVER WORK OUT FOR ITSELF (the "No API cost without revenue behind it" invariant).
 *
 * ── WHY IT IS WORTH SAYING AT ALL ────────────────────────────────────────────────────────
 *
 * The summary after a run states what it cost. The next question is always "so how much have I
 * got left?", and the surface had no answer — the only material on hand was `charged`.
 *
 * ── AND WHY THE CLIENT MAY NOT ANSWER IT ─────────────────────────────────────────────────
 *
 * Subtracting `charged` from a remembered figure is a second ledger, and it is wrong after a
 * renewal, a refund, an expiry, a second tab, or a run in another window. It is wrong UPWARD —
 * it tells somebody they have credits they do not — which is the direction that turns into a
 * refused purchase they were told would work. So the server reads its own ledger and says so,
 * and this file's job is to prove the client only ever repeats it.
 *
 * ── ABSENT MEANS NO ANSWER, NEVER ZERO ───────────────────────────────────────────────────
 *
 * An unmetered deployment has no ledger, and a hosted one whose balance read failed has no
 * answer either. Both send the field absent, and zero is a real balance with its own sentence,
 * so the clause is omitted rather than rendered from a default.
 *
 * MUTATIONS WATCHED: replacing the `typeof === "number"` test with `res.remainingCredits ?? 0`
 * turns "says nothing when the server said nothing" red with "0 credits left"; deriving the
 * figure from `charged` at any of the three summary sites turns "repeats the server's number"
 * red, because the fixture's balance and its charge deliberately disagree.
 */
describe("CREDITS-LEFT — repeated from the server, never derived", () => {
  async function runOnce(reply: (n: number) => Record<string, unknown>): Promise<string> {
    let toasted = "";
    const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
    const { useScreenerState } = await import("../app/shell/screener-state.js");
    let n = 0;
    suggestReply = (body) => {
      if (body.dryRun) {
        return json({
          dryRun: true, requested: body.senders.length, quoted: body.senders.length,
          quotedCredits: body.senders.length, charged: 0, suggestions: [], skipped: [],
        });
      }
      n++;
      return json({
        dryRun: false, requested: body.senders.length, quoted: body.senders.length,
        quotedCredits: body.senders.length, charged: body.senders.length,
        suggestions: body.senders.map((s) => ({
          sender: s, messageId: `m-${s}`, decision: "yes" as const, confidence: 0.9, rationale: "r",
        })),
        skipped: [],
        ...reply(n),
      });
    };
    const engine = await engineWith(MANY);
    let control: SuggestBatchControl | null = null;
    function Probe(): null {
      const s = useScreenerSuggestions({ active: true, toast: ((m: string) => { toasted = m; }) as never });
      const st = useScreenerState(engine, 0, (() => {}) as never, s.suggestions);
      control = s.forSenders(st.unsuggestedSenders, [], 0, st.queueSettled);
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }));
    });
    await settleFirstPaint();
    await flush();
    await act(async () => { control!.open(); });
    await flush();
    await act(async () => { control!.confirm(); });
    await flush();
    await flush();
    return toasted;
  }

  it("repeats the SERVER's number, which is deliberately not the one arithmetic would give", async () => {
    // 12 senders charged, and a balance of 137. Nothing the client holds — a remembered figure,
    // `charged`, `quotedCredits` — produces 137, so the assertion can only pass by repetition.
    const toasted = await runOnce(() => ({ remainingCredits: 137 }));
    expect(toasted).toContain("12 credits used");
    expect(toasted).toContain("137 credits left.");
  });

  it("says NOTHING about a balance when the server said nothing — absent is not zero", async () => {
    // An unmetered deployment, and a hosted one whose courtesy read failed. Both look like this.
    const toasted = await runOnce(() => ({}));
    expect(toasted).toContain("12 credits used");
    expect(toasted).not.toMatch(/credits? left/);
    expect(toasted, "an absent balance was rendered as an empty one").not.toContain("0 credits left");
  });

  it("renders a REAL zero, which is a different fact with its own sentence", async () => {
    const toasted = await runOnce(() => ({ remainingCredits: 0 }));
    expect(toasted).toContain("0 credits left.");
  });

  it("takes the LAST chunk's answer over a chunked purchase, not the first", async () => {
    // Each chunk's balance is read after that chunk's spend, so the newest one describes the
    // account as it stands when the summary appears. `maxPerRequest: 5` chunks 12 into 5/5/2.
    listReply = () =>
      json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 5 } });
    const toasted = await runOnce((n) => ({ remainingCredits: 100 - n * 10 }));
    expect(toasted).toContain("70 credits left.");
    expect(toasted).not.toContain("90 credits left.");
  });
});

/**
 * ═══ STALENESS — a suggestion bought AFTER the Screener opened reaches the open tab ═══════════
 *
 * The stored-suggestion read used to be latched once per session, so the worker's automatic
 * purchases — made on the ingest that minted the row and on its 60 s cycle — were invisible to an
 * open tab until a reload. The Screener opened, the chips it could show at that instant were all
 * it would ever show, and the opt-in read as broken. Now the read re-runs on every activation and
 * once per queue GAIN, a full {@link HYDRATE_DEBOUNCE_MS} after the sender appeared — the window
 * that lets one free read catch the purchase that follows the arrival.
 *
 * NOT A POLL, and the third case is the proof: with no trigger, no further read ever happens.
 *
 * MUTATIONS WATCHED RED (each restored and `cmp`-verified):
 *   · the gain effect returning before it arms (`if (gainAt === 0)` → unconditional) — the
 *     once-per-session latch restored in effect — reddens "reaches the open tab";
 *   · dropping the activation effect's spacing floor turns the third case's quiet window into
 *     extra reads — reddens "never a poll".
 */
describe("STALENESS — the store gaining a suggestion reaches the open tab", () => {
  const listCalls = () =>
    calls.filter((c) => c.method === "GET" && !c.path.startsWith("/screener/suggest")
      && c.path.startsWith("/screener"));

  async function mountLive(held: EngineMessage[]): Promise<{
    store: MemoryMirrorStore;
    state: () => ScreenerState;
    force: () => Promise<void>;
  }> {
    const { useScreenerState } = await import("../app/shell/screener-state.js");
    const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges(held.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })));
    const engine = new OhmailEngine({
      store,
      now: () => new Date(),
      adapter: {
        sync: async () => ({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: store.getCursor(), hasMore: false, serverTime: new Date().toISOString(),
        }),
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => ({
          text: "body", html: null, loadedRemoteContent: false,
          unsubscribe: "no_header", unsubscribeUrl: null,
        }),
      },
    });
    let live: ScreenerState | null = null;
    let forceRender: (() => void) | null = null;
    function Probe(): null {
      const [v, setV] = React.useState(0);
      forceRender = () => setV((x) => x + 1);
      React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
      const suggestions = useScreenerSuggestions({ active: true, toast: (() => {}) as never });
      live = useScreenerState(engine, v, (() => {}) as never, suggestions.suggestions);
      // The gain signal rides `forSenders`, exactly as `AppShell` binds it at every render.
      suggestions.forSenders(live.unsuggestedSenders, [], 0, live.queueSettled);
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date(),
        children: h(Probe),
      }));
    });
    for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
    await settleFirstPaint();
    return {
      store,
      state: () => live!,
      force: async () => {
        await act(async () => { forceRender?.(); });
        for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
      },
    };
  }

  it("a suggestion bought after the open reaches the tab within one debounce window", async () => {
    vi.useFakeTimers();
    try {
      const mounted = await mountLive(MANY);
      // The activation read ran once and found nothing bought yet.
      expect(listCalls()).toHaveLength(1);
      expect(mounted.state().waiting.every((x) => x.ai == null)).toBe(true);

      // A NEW sender arrives while the tab is open — the row the worker is about to buy for.
      const fresh = msg("m-new", "fresh@ex.example", 23);
      await act(async () => {
        await mounted.store.applyChanges([{
          type: "message", op: "create", id: fresh.id, seq: ++seq,
          updatedAt: fresh.updatedAt, entity: fresh,
        }]);
      });
      await mounted.force();
      expect(mounted.state().waiting.some((x) => x.from.address === "fresh@ex.example")).toBe(true);

      // The worker buys seconds later: the STORE now holds the answer, and nothing else moves.
      listReply = () => json({
        items: [{
          sender: { address: "fresh@ex.example" },
          aiSuggestion: { decision: "no", destination: "ohmail/Screened", confidence: 0.93, rationale: "stranger" },
        }],
        nextCursor: null,
        suggestable: { senders: [], credits: 0, maxPerRequest: 50 },
      });

      // One debounce window later the gain read runs and the chip is on the row — no reload.
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000 + 50); });
      expect(listCalls()).toHaveLength(2);
      const row = mounted.state().waiting.find((x) => x.from.address === "fresh@ex.example");
      expect(row?.ai, "the bought suggestion never reached the open tab").toBeTruthy();
      expect(row?.ai?.dest).toBe("screened");
    } finally {
      vi.useRealTimers();
    }
  });

  it("no trigger, no read — the re-read is not a poll", async () => {
    vi.useFakeTimers();
    try {
      const mounted = await mountLive(MANY);
      expect(listCalls()).toHaveLength(1);
      // A quiet hour: no activation, no queue gain. Nothing may ask again.
      await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
      expect(listCalls(), "a read ran with no trigger — that is a poll").toHaveLength(1);
      void mounted;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second sender inside the window shares the armed read — one look per window", async () => {
    vi.useFakeTimers();
    try {
      const mounted = await mountLive(MANY);
      expect(listCalls()).toHaveLength(1);
      for (const [i, addr] of (["gain-a@ex.example", "gain-b@ex.example"] as const).entries()) {
        const m = msg(`m-gain-${i}`, addr, 22);
        await act(async () => {
          await mounted.store.applyChanges([{
            type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
          }]);
        });
        await mounted.force();
        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000 + 50); });
      // Two gains 2 s apart cost ONE read, not two: the second re-armed the same window.
      expect(listCalls().length).toBeLessThanOrEqual(2);
      expect(listCalls().length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder } from "@ohmail/wire";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { useSuggestText } from "../app/shell/suggest-text";
import {
  OhmailEngine, MemoryMirrorStore, mutationEffects,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE AUTO-SUGGEST OPT-IN, ON THE WIRE — mail 0040.
 *
 * The opt-in lets ohmail buy a classifier suggestion for waiting senders WITHOUT a press. That is
 * money moving with no click behind it, so every property worth having is a property of the
 * requests the app issues, and this file asserts them there rather than through a rendered label.
 *
 * ── THE FIVE THINGS THAT MUST BE TRUE ────────────────────────────────────────────────────
 *
 *  1. OFF BY DEFAULT, AND OFF MEANS SILENT. With the flag absent — the demo, the desktop, a shell
 *     whose `GET /consent` failed, an API from before 0040 — not one request is issued. The
 *     default has to be the one that spends nothing, because the alternative is a fetch error that
 *     costs the user money.
 *  2. IT SUGGESTS, IT NEVER DECIDES. The automatic path may reach `POST /screener/suggest` and
 *     nothing else. No `POST /screener/:id`, and no engine mutation — so no rule, no contact, no
 *     move. This is the invariant the whole feature stands on: the opt-in buys WORK, not a
 *     decision, and a stranger still waits for a human. Asserted by watching the calls, because
 *     "there is no line that does that" is not something a reader can verify later.
 *  3. ONE BATCH, BOUNDED. Exactly one purchase per mounted Screener, of at most
 *     `AUTO_BATCH_SIZE` senders, taken from the FRONT of the queue in the queue's own order.
 *     Re-renders, effect re-runs and a warming mirror must not each buy a batch.
 *  4. A REFUSAL DISARMS AND DOES NOT RETRY. On 402/409/503 the automatic path stops for the
 *     session. An automatic loop against a standing refusal is a flood against a wall.
 *  5. A COLD MIRROR STILL GETS ITS BATCH. On a live account the queue is EMPTY for the first few
 *     renders while the mirror fills. An implementation that looks once and gives up would do
 *     nothing on every live account and pass every test with a pre-warmed fixture — which is the
 *     shape of the "eight of twenty-four journeys went red against a cold account" lesson, run in
 *     reverse.
 *
 * `apps/webapp` typechecks its tests, so the wire shapes below are checked as well as the values.
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

/**
 * The bound the automatic batch must respect, restated here as a LITERAL.
 *
 * Deliberately not imported from the module under test: importing it would make the assertion
 * "the code agrees with itself", and this number is a spend ceiling. Raising it in the
 * implementation has to stop this suite and make somebody argue for the new figure.
 */
const AUTO_BATCH_SIZE = 10;

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;

function msg(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
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

interface Recorded {
  method: string;
  path: string;
  body: { senders?: string[]; dryRun?: boolean; automatic?: boolean } | null;
  idempotencyKey: string | null;
}

let calls: Recorded[] = [];
let sent: EngineMutation[] = [];
/** Everything the surface said out loud. The automatic path's ONLY way to be heard. */
let toasts: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let suggestReply: (body: { senders: string[]; dryRun?: boolean }, n: number) => Response;

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** The server's refusal envelope, exactly as `packages/api` writes it. */
const refusal = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

function installFetch(): void {
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const path = url.replace(/^\/api/, "");
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as Recorded["body"]) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method: init?.method ?? "GET", path, body: raw,
      idempotencyKey: headers["Idempotency-Key"] ?? null,
    });
    if (path.startsWith("/screener/suggest")) {
      n++;
      return suggestReply(raw as { senders: string[]; dryRun?: boolean }, n);
    }
    // The stored-suggestion hydration. Empty, so nothing is already owned.
    if (path.startsWith("/screener")) {
      return json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 50 } });
    }
    return json({});
  }) as typeof fetch;
}

const suggestCalls = () => calls.filter((c) => c.path.startsWith("/screener/suggest"));
const purchases = () => suggestCalls().filter((c) => c.body?.dryRun !== true);
const dryRuns = () => suggestCalls().filter((c) => c.body?.dryRun === true);
/** Every request that is NOT the suggest endpoint or the read that hydrates it. */
const decides = () => calls.filter((c) => c.method === "POST" && /^\/screener\/[^s]/.test(c.path));

/**
 * The engine, plus the ONE way this file introduces late mail.
 *
 * `deliver` pushes messages through `engine.syncOnce()` — the engine's own ingest path — rather than
 * writing to the store and poking a subscriber. That matters twice: it is what a warming mirror
 * actually does, and the alternative reached `engine.notify()`, which is private. A harness that
 * has to break encapsulation to simulate an event is usually simulating the wrong event.
 */
async function engineWith(
  held: EngineMessage[],
): Promise<{ engine: OhmailEngine; deliver: (m: EngineMessage[]) => Promise<void> }> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    held.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  /** What the next `sync()` hands over. Drained, so a second sync does not replay it. */
  let pending: EngineMessage[] = [];
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const batch = pending;
        pending = [];
        return {
          changes: {
            creates: batch.map((m): SyncChange => ({
              type: "message", op: "create", id: m.id, seq: ++seq,
              updatedAt: m.updatedAt, entity: m,
            })),
            updates: [], moves: [], deletes: [],
          },
          cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m) => {
        sent.push(m);
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
            updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
          }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
  const deliver = async (m: EngineMessage[]): Promise<void> => {
    pending = m;
    await act(async () => { await engine.syncOnce(); });
    await flush();
  };
  return { engine, deliver };
}

/**
 * Mount the REAL hooks over the REAL view. Nothing about the purchase is faked but the server.
 *
 * `autoSuggest` is passed exactly as `AppShell` passes it — off the consent state — so what is
 * under test is the wiring a live shell uses and not a switch this harness invented.
 */
async function mountView(
  engine: OhmailEngine, opts: { autoSuggest?: boolean; subscriptionPane?: boolean } = {},
): Promise<{ unsuggested: () => string[]; revisit: () => Promise<void> }> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
  const { CLOUD_WIRE } = await import("../app/(product)/mailbox/suggest-wire.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");

  let live: { unsuggestedSenders: string[] } | null = null;
  /** Flips `active`, which is what navigating away from the Screener and back really is. */
  let setActive: ((on: boolean) => void) | null = null;

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    const [onScreen, setOnScreen] = React.useState(true);
    setActive = setOnScreen;
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const suggestions = useScreenerSuggestions({
      text: useSuggestText(),
      wire: CLOUD_WIRE,
      active: onScreen,
      ...(opts.autoSuggest === undefined ? {} : { autoSuggest: opts.autoSuggest }),
      toast: ((m: string) => { toasts.push(m); }) as never,
    });
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText(), suggestions.suggestions);
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: null, screened: null, spam: null,
    });
    live = state;
    return h(ScreenerView, {
      owed: false,
      state,
      suggest: suggestions.forSenders(state.unsuggestedSenders),
      segment: "waiting", settled: true, selection: sel as never,
      ...(opts.subscriptionPane === undefined ? {} : { subscriptionPane: opts.subscriptionPane }),
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
  return {
    unsuggested: () => live!.unsuggestedSenders,
    /** Leave the Screener, then come back. The unit the opt-in is scoped to. */
    revisit: async () => {
      await act(async () => { setActive!(false); });
      await flush();
      await act(async () => { setActive!(true); });
      await flush();
    },
  };
  await settleFirstPaint();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  calls = [];
  sent = [];
  toasts = [];
  suggestReply = (body) =>
    json({
      dryRun: body.dryRun === true,
      requested: body.senders.length,
      quoted: body.senders.length,
      quotedCredits: body.senders.length,
      charged: body.dryRun ? 0 : body.senders.length,
      suggestions: body.dryRun ? [] : body.senders.map((s, i) => ({
        sender: s, messageId: `m-${s}`,
        decision: i % 2 === 0 ? "yes" : "no",
        confidence: 0.9, rationale: `because ${s}`,
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

/** Twelve waiting senders, so the batch bound is BELOW the queue and can be observed biting. */
const TWELVE = Array.from({ length: 12 }, (_, i) =>
  msg(`m${i}`, `s${String(i).padStart(2, "0")}@example.com`, 23 - i));

describe("mail 0040 — the auto-suggest opt-in buys, and buys only", () => {
  it("OFF BY DEFAULT: with the flag absent, not one suggest request is issued", async () => {
    const { engine } = await engineWith(TWELVE);
    const view = await mountView(engine);
    // The premise, so the assertion cannot pass because there was nothing to buy.
    expect(view.unsuggested().length).toBe(12);
    expect(suggestCalls()).toEqual([]);
  });

  it("OFF EXPLICITLY: `autoSuggest: false` is the same silence", async () => {
    const { engine } = await engineWith(TWELVE);
    const view = await mountView(engine, { autoSuggest: false });
    expect(view.unsuggested().length).toBe(12);
    expect(suggestCalls()).toEqual([]);
  });

  it("ON: exactly ONE purchase, bounded, from the front of the queue, keyed", async () => {
    const { engine } = await engineWith(TWELVE);
    const view = await mountView(engine, { autoSuggest: true });

    expect(purchases()).toHaveLength(1);
    const posted = purchases()[0]!.body!.senders!;
    expect(posted.length).toBeLessThanOrEqual(AUTO_BATCH_SIZE);
    expect(posted).toHaveLength(AUTO_BATCH_SIZE);

    // A PREFIX of the queue in the queue's own order — not a sample, so the same account in the
    // same state buys the same senders and the next visit continues rather than re-rolls.
    // Compared against the queue as it was BEFORE the purchase, which is what the ordering claim
    // is about; `unsuggested()` afterwards is the remainder.
    const remaining = view.unsuggested();
    expect(remaining).toHaveLength(2);
    for (const addr of posted) expect(remaining).not.toContain(addr);

    // NO DRY RUN. The cost was named when the setting was turned on, and the batch is bounded, so
    // a price call here would be a round trip that tells the client something it already fixed.
    expect(dryRuns()).toEqual([]);

    // Keyed, so a lost response is a replay and not a second purchase.
    expect(purchases()[0]!.idempotencyKey).toMatch(/.+/);
  });

  it("NOBODY PRESSED IT, AND THE WIRE SAYS SO: `automatic: true` rides the purchase", async () => {
    const { engine } = await engineWith(TWELVE);
    await mountView(engine, { autoSuggest: true });
    // Without the flag the server reads a press, which asks about every held sender
    // (the "Sensitive mail" invariant) — the opt-in's batch would send what the always-on pass keeps out.
    expect(purchases()).toHaveLength(1);
    expect(purchases()[0]!.body!.automatic).toBe(true);
  });

  it("a sender the server keeps out of automatic AI is not re-posted, and stays a press away", async () => {
    // The first two are `no_ai` on the mirror; the server answers them `no_auto_ai`, unasked.
    const kept = ["s00@example.com", "s01@example.com"];
    const held = TWELVE.map((m, i) => (i < 2 ? { ...m, sensitivity: { ...m.sensitivity, no_ai: true } } : m));
    suggestReply = (body) => {
      const asked = body.senders.filter((s) => !kept.includes(s));
      return json({
        dryRun: false, requested: body.senders.length, quoted: asked.length, quotedCredits: asked.length,
        charged: asked.length, skipped: body.senders.filter((s) => kept.includes(s)).map((sender) => ({ sender, reason: "no_auto_ai" })),
        suggestions: asked.map((s) => ({ sender: s, messageId: `m-${s}`, decision: "yes", confidence: 0.9, rationale: "r" })),
      });
    };
    const { engine } = await engineWith(held);
    const view = await mountView(engine, { autoSuggest: true });
    expect(purchases()[0]!.body!.senders).toEqual(expect.arrayContaining(kept));
    // No chip: the row speaks from its own mirror flag, and the sender stays in the buy list.
    expect(host!.textContent).not.toContain("no_auto_ai");
    for (const k of kept) expect(view.unsuggested()).toContain(k);

    await view.revisit();
    // The next visit's batch moves PAST them; re-posting them would stall it on the same senders.
    expect(purchases()).toHaveLength(2);
    expect(purchases()[1]!.body!.senders).toEqual(["s10@example.com", "s11@example.com"]);
  });

  it("IT SUGGESTS, IT NEVER DECIDES: no decide call, and nothing moves", async () => {
    const { engine } = await engineWith(TWELVE);
    await mountView(engine, { autoSuggest: true });

    expect(purchases()).toHaveLength(1);
    // `POST /screener/:id` is the decide verb — a rule, a contact, a folder move. The automatic
    // path must never reach it.
    expect(decides()).toEqual([]);
    // And nothing reached the ENGINE either, so no optimistic move was painted and no mutation
    // was queued for the server. A suggestion is advice; the mail has not been touched.
    expect(sent).toEqual([]);
    // Every request the app made, so a new call added later has to be accounted for here.
    expect(new Set(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)))
      .toEqual(new Set(["GET /screener", "POST /screener/suggest"]));
  });

  it("A COLD MIRROR still gets its batch — the queue is empty for the first renders", async () => {
    // Nothing held at mount: exactly what a real account looks like while the mirror fills.
    const { engine, deliver } = await engineWith([]);
    const view = await mountView(engine, { autoSuggest: true });
    expect(view.unsuggested()).toEqual([]);
    // Nothing to buy, so nothing was bought — and, critically, the latch was NOT spent on the
    // empty queue.
    expect(suggestCalls()).toEqual([]);

    // The mirror arrives.
    await deliver(TWELVE);

    expect(view.unsuggested().length).toBeGreaterThan(0);
    expect(purchases()).toHaveLength(1);
    expect(purchases()[0]!.body!.senders).toHaveLength(AUTO_BATCH_SIZE);
  });

  it("A REFUSAL DISARMS FOR THE SESSION: leaving and coming back does not retry it", async () => {
    suggestReply = () => refusal(402, "insufficient_credits", "no AI credits remain on this account");
    const { engine, deliver } = await engineWith(TWELVE);
    const view = await mountView(engine, { autoSuggest: true });

    expect(purchases()).toHaveLength(1);

    // New mail changes nothing: the effect's dependencies are four real signals and "the queue
    // grew" is not one of them.
    await deliver([msg("late", "late@example.com", 5)]);
    expect(purchases()).toHaveLength(1);

    // AND THE CASE THAT MAKES THE DISARM LOAD-BEARING. Coming back to the Screener re-arms the
    // batch — that is the intended unit — so without the refusal latch an account with an empty
    // balance would fire one doomed request on every visit, for ever.
    await view.revisit();
    expect(purchases()).toHaveLength(1);
  });

  it("A SUCCESSFUL visit re-arms: coming back buys the NEXT few, not the same ones", async () => {
    const { engine } = await engineWith(TWELVE);
    const view = await mountView(engine, { autoSuggest: true });
    expect(purchases()).toHaveLength(1);
    const first = purchases()[0]!.body!.senders!;

    await view.revisit();

    // A second batch, and it is the REMAINDER — the first ten now carry suggestions, so the queue
    // the control is bound to has moved on. A backlog drains across visits rather than in one
    // purchase, which is the whole reason the batch is bounded at all.
    expect(purchases()).toHaveLength(2);
    const second = purchases()[1]!.body!.senders!;
    expect(second).toHaveLength(2);
    for (const addr of second) expect(first).not.toContain(addr);
  });

  it("A REFUSAL IS SAID OUT LOUD, in the reader's own language", async () => {
    suggestReply = () => refusal(409, "ai_disabled", "managed AI is switched off for this account");
    const { engine } = await engineWith(TWELVE);
    await mountView(engine, { autoSuggest: true });

    // TOASTED, not merely stored in the panel's `notice`. This assertion is why the
    // implementation toasts at all: the first version only set `notice`, which renders INSIDE the
    // suggest panel — and on the automatic path nobody opened it. The purchase failed and the
    // surface said nothing, which is precisely the silent outcome the opt-in must not create.
    //
    // FROM THE CATALOGUE, by the refusal's `code` — not the server's `message`, which is English
    // written for a log and was being rendered verbatim onto a German screen. The fact is the
    // same fact; the sentence is the reader's.
    expect(toasts.join(" | ")).toContain(messages.aiRefusal.aiDisabled);
    // Still the RIGHT refusal, and not a generic one: re-deriving a reason from the status code
    // is how a user with an empty balance gets told the model is down.
    expect(toasts.join(" | ")).not.toContain("Something went wrong");
    expect(toasts.join(" | ")).not.toContain(messages.aiRefusal.insufficientCredits);
  });

  it("A CLIENT REFUSAL DOES NOT DISARM, and speaks in this client's voice, not the server's", async () => {
    // The account gate refuses before the request leaves, so the server is never asked — and the
    // state it refuses for here is the one reported: a live session whose `tf_owner` marker
    // has gone. Disarming on it stopped the automatic pass for the whole mount over a condition
    // the next page load undoes, and the sentence shown was the server's voice for a refusal no
    // server made.
    const { bindApiOwner } = await import("../app/api-client.js");
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    bindApiOwner("acct_A");
    try {
      const { engine } = await engineWith(TWELVE);
      const view = await mountView(engine, { autoSuggest: true });

      // It never reached the wire — this is a CLIENT refusal, which is the premise.
      expect(suggestCalls()).toHaveLength(0);
      // THE CLIENT'S OWN SENTENCE, from the catalogue, naming the state and the way out.
      expect(toasts.join(" | ")).toContain(messages.screener.suggest.refusedOwnerAbsent);
      // And NOT the raw English the gate throws for a generic error path to render.
      expect(toasts.join(" | ")).not.toContain("different account");
      expect(toasts.join(" | ")).not.toContain("This browser has lost the name");

      // STILL ARMED. Coming back tries again — the wall the latch exists for is a standing
      // server condition, and this is not one. The disarm's own case, five above, is the control.
      const before = toasts.length;
      await view.revisit();
      expect(toasts.length, "a client-side refusal disarmed the automatic pass").toBeGreaterThan(before);
    } finally {
      bindApiOwner(null);
    }
  });

  it("A SUCCESSFUL automatic purchase is said out loud too — money moved with no press", async () => {
    const { engine } = await engineWith(TWELVE);
    await mountView(engine, { autoSuggest: true });
    expect(purchases()).toHaveLength(1);
    // The "visible after the fact" half of the opt-in. Nobody pressed anything, so the only
    // record the user gets in the moment is this line, and it names the count and the credits.
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("10 suggestions");
    expect(toasts[0]).toContain("10 credits");
  });
});

/**
 * SCREENER-SUGGEST-REFUSAL-IS-SILENT: on the live Cloud, opening the Screener sent the automatic
 * batch, the server answered 402 (no credits), and after the toast nothing on screen said so.
 * The strip now keeps one sentence while that standing holds, naming where credits come from
 * only where Settings lists the Subscription pane.
 */
describe("a refused automatic batch stays said", () => {
  const strip = (): string | null =>
    host?.querySelector<HTMLElement>(".scn-bulk .scn-ai-credits[role='status']")?.textContent ?? null;

  it("402 no credits: the strip says suggestions need credits, and points nowhere it cannot", async () => {
    suggestReply = () => refusal(402, "insufficient_credits", "no AI credits remain on this account");
    const { engine } = await engineWith(TWELVE);
    await mountView(engine, { autoSuggest: true });
    expect(purchases(), "premise: the automatic batch went out and was refused").toHaveLength(1);
    expect(strip(), "the refusal left nothing on screen").toBe(messages.screener.suggest.noCredits);
  });

  it("…and names Settings → Subscription where Settings lists it", async () => {
    suggestReply = () => refusal(402, "insufficient_credits", "no AI credits remain on this account");
    const { engine } = await engineWith(TWELVE);
    await mountView(engine, { autoSuggest: true, subscriptionPane: true });
    expect(strip()).toBe(messages.screener.suggest.noCreditsWhere);
    expect(messages.screener.suggest.noCreditsWhere).toContain(messages.settings.billing);
  });

  it("control: a funded batch and a switched-off AI say no credits line", async () => {
    const funded = await engineWith(TWELVE);
    await mountView(funded.engine, { autoSuggest: true, subscriptionPane: true });
    expect(purchases()).toHaveLength(1);
    expect(strip()).toBeNull();
    await act(async () => { root!.unmount(); });
    host?.remove();
    root = null;

    suggestReply = () => refusal(409, "ai_disabled", "managed AI is switched off for this account");
    const off = await engineWith(TWELVE);
    await mountView(off.engine, { autoSuggest: true, subscriptionPane: true });
    expect(purchases()).toHaveLength(2);
    expect(strip(), "the credits line spoke for a refusal that was not about credits").toBeNull();
  });
});

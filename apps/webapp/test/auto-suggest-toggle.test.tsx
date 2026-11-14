/** @vitest-environment jsdom */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore, mutationEffects,
  type EngineMessage, type EngineMutation, type Folder, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE AUTO-WORK OPT-IN'S SWITCH — the writer that mail 0040 shipped without.
 *
 * `screener-auto-suggest.test.tsx` covers what the flag DOES once it is on. This file covers the
 * only way a human can turn it on, which until now did not exist: the column, the route, the
 * service and the spender were all live and tested, and nothing in the UI wrote the flag, so the
 * feature was reachable only by a raw API call. That is the same shape as `dormancy_days`, which
 * has had zero writers since its own migration, and the point of this suite is that the second
 * instance does not become permanent the way the first did.
 *
 * ── THE SIX THINGS THAT MUST BE TRUE ─────────────────────────────────────────────────────
 *
 *  1. OFF BY DEFAULT, AND THE SWITCH SAYS SO. `autoSuggestAt: null` renders `autoOff` with the
 *     switch unchecked. A failed `GET /consent` renders the same thing — there is no path from
 *     "I do not know" to a control that looks armed.
 *  2. THE PRICE COMES FROM THE SERVER, AND NO PRICE MEANS NO CONSENT. Arming the switch issues a
 *     `dryRun` and leaves the confirm DISABLED until a `quotedCredits` lands. A server that
 *     answers without that field leaves it disabled for good, because an unknown cost is not one
 *     a person can consent to. The alternative — count × an assumed credit cost — is the guess
 *     the field exists to remove.
 *  3. THE QUOTE PRICES THE SET THE BATCH WILL ACTUALLY TAKE. The dry run's senders are the first
 *     `AUTO_BATCH_SIZE` of the SAME unsuggested queue the automatic path slices, in the queue's
 *     own order. This is the assertion that bites the plausible implementation: reading the queue
 *     the Screener's own control captures gives an EMPTY list on a tab that went straight to
 *     Settings, and a confirm reading "0 senders · 0 credits" over a batch about to buy ten is a
 *     lie in the direction of spending.
 *  4. IT ARMS THE WORK AND NEVER A DECISION. Across the whole flow the only requests are the
 *     consent read, the dry run and the consent write. No `POST /screener/:id`, no non-dry
 *     purchase, and no engine mutation — so no rule, no contact, no folder change, nothing moved.
 *     Undo is vacuous because nothing moved; credits are the only thing spent, which is why it is
 *     worth asking about at all.
 *  5. TURNING IT OFF DISARMS THIS TAB, NOT JUST THE DATABASE. Off, then open the Screener in the
 *     SAME tab without a reload, and nothing is bought. This is the criterion that fails if the
 *     switch ever writes through `api-client` directly instead of through the `useConsentState`
 *     the spender reads: the flag would be off on the server and still true in this tab, and the
 *     next Screener open would spend money the user had just revoked.
 *  6. THE WRITE CARRIES ONE FIELD. The PATCH body is `{ autoSuggest }` and nothing else, so a
 *     toggle cannot reset the dormancy window or the seed state on its way past.
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
 * The batch ceiling, restated as a LITERAL for the reason `screener-auto-suggest.test.tsx` gives:
 * importing it from the module under test would make the assertion "the code agrees with itself",
 * and this number is a spend ceiling. Raising it has to stop this suite.
 */
const AUTO_BATCH_SIZE = 10;

const NOW = new Date("2026-08-02T12:00:00.000Z");
const TURNED_ON_AT = "2026-08-02T12:00:00.000Z";
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
  body: { senders?: string[]; dryRun?: boolean; autoSuggest?: boolean; automatic?: boolean } | null;
}

let calls: Recorded[] = [];
let sent: EngineMutation[] = [];
let toasts: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** What the server currently holds for this account. The PATCH moves it; the GET reads it. */
let storedAt: string | null = null;
/** How `GET /consent` behaves. `fail` is the network blip that must still read as OFF. */
let consentMode: "ok" | "fail" = "ok";
/** How the dry run answers. `noPrice` is a deployment from before `quotedCredits` existed. */
let quoteMode: "ok" | "noPrice" | "refuse" = "ok";
/**
 * How the PATCH answers.
 *
 * `storesOff` is a 200 that did NOT store what was asked — the server accepted the request and
 * the row still reads off. It is the only state that can tell "the switch shows what the database
 * holds" apart from "the switch shows what the click asked for", because on a REFUSAL both
 * implementations look identical: the await throws and neither reaches its state write.
 */
let writeMode: "ok" | "refuse" | "storesOff" = "ok";

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** The server's refusal envelope, exactly as `packages/api` writes it. */
const refusal = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const path = url.replace(/^\/api/, "");
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as Recorded["body"]) : null;
    calls.push({ method: init?.method ?? "GET", path, body: raw });

    if (path === "/consent/settings") {
      if (writeMode === "refuse") return refusal(500, "internal", "nope");
      if (writeMode === "storesOff") return json({ autoSuggestAt: null });
      storedAt = raw?.autoSuggest === true ? TURNED_ON_AT : null;
      return json({ autoSuggestAt: storedAt });
    }
    if (path === "/consent") {
      if (consentMode === "fail") return refusal(500, "internal", "nope");
      return json({
        seedConfirmedAt: "2026-07-01T00:00:00.000Z",
        screeningResetAt: null,
        dormancyDays: 60,
        autoSuggestAt: storedAt,
        counts: { activeUndecidedSenders: 12 },
      });
    }
    if (path.startsWith("/screener/suggest")) {
      const senders = raw?.senders ?? [];
      if (quoteMode === "refuse") {
        return refusal(402, "out_of_credits", "no AI credits remain on this account");
      }
      const base = {
        dryRun: raw?.dryRun === true, requested: senders.length,
        quoted: senders.length, charged: 0,
        suggestions: raw?.dryRun === true
          ? []
          : senders.map((s) => ({
              sender: s, messageId: `m-${s}`, decision: "yes" as const,
              confidence: 0.9, rationale: "looks like a person",
            })),
        skipped: [] as Array<{ sender: string; reason: string }>,
      };
      // The field the confirm depends on, WITHHELD in `noPrice` — a deployment from the minutes
      // between two releases, which is a real state and not a hypothetical one.
      return json(quoteMode === "noPrice" ? base : { ...base, quotedCredits: senders.length });
    }
    if (path.startsWith("/screener")) {
      return json({ items: [], nextCursor: null, suggestable: { senders: [], credits: 0, maxPerRequest: 50 } });
    }
    return json({});
  }) as typeof fetch;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

const suggestCalls = () => calls.filter((c) => c.path.startsWith("/screener/suggest"));
const dryRuns = () => suggestCalls().filter((c) => c.body?.dryRun === true);
const purchases = () => suggestCalls().filter((c) => c.body?.dryRun !== true);
const patches = () => calls.filter((c) => c.path === "/consent/settings");
/** Any POST to a per-sender screener decision — `POST /screener/:id`. */
const decides = () => calls.filter((c) => c.method === "POST" && /^\/screener\/[^s]/.test(c.path));

async function engineWith(held: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    held.map((m): SyncChange => ({
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
}

/**
 * Mount the REAL row over the REAL hooks, wired exactly as `AppShell` wires them.
 *
 * The Screener's own surface is mounted in the same tree and behind the same `useScreenerSuggestions`
 * instance, because assertion 5 is a statement about ONE tab: the switch and the spender have to be
 * looking at the same consent state for the test to be able to catch them disagreeing. `screener`
 * flips which of the two is on screen, which is what navigating between Settings and the Screener is.
 */
async function mountShell(engine: OhmailEngine): Promise<{
  unsuggested: () => string[];
  openScreener: () => Promise<void>;
  openSettings: () => Promise<void>;
  row: () => HTMLElement;
}> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { useScreenerSuggestions } = await import("../app/shell/screener-suggest.js");
  const { useConsentState } = await import("../app/shell/consent-state.js");
  const { AutoSuggestRow } = await import("../app/shell/AutoSuggestRow.js");

  let live: { unsuggestedSenders: string[] } | null = null;
  let setOnScreener: ((on: boolean) => void) | null = null;

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    const [onScreener, setScreener] = React.useState(false);
    setOnScreener = setScreener;
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const consent = useConsentState(true);
    const suggestions = useScreenerSuggestions({
      active: onScreener,
      autoSuggest: consent.autoSuggest,
      toast: ((m: string) => { toasts.push(m); }) as never,
    });
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText(), suggestions.suggestions);
    live = state;
    // Bound unconditionally, exactly as `AppShell` binds it — and NOT via `forSenders`, which the
    // shell binds only inside the Screener branch. That asymmetry is assertion 3.
    const autoOptIn = suggestions.autoOptIn(state.unsuggestedSenders);
    // The Screener's own capture, present only while the Screener is on screen — the real shell's
    // shape. Its absence on the Settings pane is what makes assertion 3 able to fail.
    if (onScreener) suggestions.forSenders(state.unsuggestedSenders);
    return h("div", { id: "probe" },
      onScreener ? null : h("div", { id: "row" },
        h(AutoSuggestRow, {
          on: consent.autoSuggest,
          since: consent.autoSuggestAt,
          control: autoOptIn,
          setAutoSuggest: consent.setAutoSuggest,
        })),
    );
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, { storageKey: null, children: h(Probe) }),
      }),
    );
  });
  await flush();
  await settleFirstPaint();
  return {
    unsuggested: () => live!.unsuggestedSenders,
    openScreener: async () => { await act(async () => { setOnScreener!(true); }); await flush(); },
    openSettings: async () => { await act(async () => { setOnScreener!(false); }); await flush(); },
    row: () => host!.querySelector("#row") as HTMLElement,
  };
}

const q = (sel: string): HTMLElement | null => host!.querySelector(sel);
const text = (): string => host!.textContent ?? "";
const switchEl = (): HTMLButtonElement => q('[role="switch"]') as HTMLButtonElement;
const buttonNamed = (label: string): HTMLButtonElement | undefined =>
  Array.from(host!.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;
const click = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
};

/** Twelve waiting senders, so `AUTO_BATCH_SIZE` is a real slice and not the whole list. */
const HELD = Array.from({ length: 12 }, (_, i) =>
  msg(`h${i}`, `s${String(i).padStart(2, "0")}@ex.example`, 8),
);

beforeEach(() => {
  calls = []; sent = []; toasts = []; seq = 0;
  storedAt = null; consentMode = "ok"; quoteMode = "ok"; writeMode = "ok";
  installFetch();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

describe("the auto-work opt-in's switch", () => {
  it("1 — is OFF by default and says so, and a failed consent read reads the same", async () => {
    const engine = await engineWith(HELD);
    await mountShell(engine);

    expect(switchEl().getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain(messages.screener.suggest.autoOff);
    // Nothing was priced and nothing was written just by looking at the pane.
    expect(dryRuns()).toHaveLength(0);
    expect(patches()).toHaveLength(0);

    await act(async () => { root!.unmount(); });
    root = null; host?.remove();
    consentMode = "fail";
    const e2 = await engineWith(HELD);
    await mountShell(e2);
    expect(switchEl().getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain(messages.screener.suggest.autoOff);
  });

  it("2 — prices on the SERVER, and without `quotedCredits` the confirm never arms", async () => {
    quoteMode = "noPrice";
    const engine = await engineWith(HELD);
    await mountShell(engine);

    await click(switchEl());
    expect(dryRuns()).toHaveLength(1);
    const confirm = buttonNamed(messages.screener.suggest.autoTurnOn)!;
    expect(confirm).toBeTruthy();
    // NO PRICE, NO CONSENT. The server answered 200 and the button stays dead.
    expect(confirm.disabled).toBe(true);
    // And it never becomes armed by pressing it.
    await click(confirm);
    expect(patches()).toHaveLength(0);
    expect(storedAt).toBeNull();
  });

  it("2b — the armed confirm shows the SERVER's figure, not a count times an assumed cost", async () => {
    const engine = await engineWith(HELD);
    await mountShell(engine);
    await click(switchEl());

    const confirm = buttonNamed(messages.screener.suggest.autoTurnOn)!;
    expect(confirm.disabled).toBe(false);
    // `suggest.price` renders "10 senders · 10 credits" from the server's `quoted`/`quotedCredits`.
    expect(q(".scn-sg-price")!.textContent).toContain(String(AUTO_BATCH_SIZE));
    expect(text()).toContain("credits");
    // The batch ceiling is stated from the constant the spender slices by, not from a literal.
    expect(text()).toContain(String(AUTO_BATCH_SIZE));
  });

  it("3 — prices the FIRST AUTO_BATCH_SIZE of the same queue the batch will take", async () => {
    const engine = await engineWith(HELD);
    const shell = await mountShell(engine);

    const queue = shell.unsuggested();
    expect(queue.length).toBeGreaterThan(AUTO_BATCH_SIZE);

    // Priced from the SETTINGS pane, having never visited the Screener — the tab whose
    // `forSenders` capture is still empty.
    await click(switchEl());
    expect(dryRuns()).toHaveLength(1);
    expect(dryRuns()[0]!.body!.senders).toEqual(queue.slice(0, AUTO_BATCH_SIZE));
    // Not zero, which is what a quote read from the unbound capture would have said.
    expect(dryRuns()[0]!.body!.senders).toHaveLength(AUTO_BATCH_SIZE);
    // Priced under the batch's own rule, so a sender the batch will not ask about is not quoted.
    expect(dryRuns()[0]!.body!.automatic, "the opt-in's quote priced the batch as a press").toBe(true);
  });

  it("4 — arms the work and decides nothing: three requests, no mutation, no purchase", async () => {
    const engine = await engineWith(HELD);
    await mountShell(engine);

    await click(switchEl());
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);

    expect(storedAt).toBe(TURNED_ON_AT);
    expect(patches()).toHaveLength(1);
    // ONE FIELD ON THE WIRE — assertion 6. A toggle may not carry the dormancy window past.
    expect(patches()[0]!.body).toEqual({ autoSuggest: true });
    expect(patches()[0]!.method).toBe("PATCH");

    // NOTHING DECIDED. No per-sender decision, no real purchase, no engine mutation at all.
    expect(decides()).toHaveLength(0);
    expect(purchases()).toHaveLength(0);
    expect(sent).toHaveLength(0);
    // And the only paths touched are the three this flow is allowed to touch.
    expect([...new Set(calls.map((c) => c.path))].sort()).toEqual(
      ["/consent", "/consent/settings", "/screener/suggest"],
    );

    // The row now states when, from the server's echo.
    expect(switchEl().getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("On since");
    expect(text()).not.toContain(messages.screener.suggest.autoOff);
  });

  it("4b — a refused write leaves the switch showing the stored value and says so", async () => {
    writeMode = "refuse";
    const engine = await engineWith(HELD);
    await mountShell(engine);

    await click(switchEl());
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);

    expect(storedAt).toBeNull();
    // NOT OPTIMISTIC. The switch renders the database, so a refusal cannot leave it looking armed.
    expect(switchEl().getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain(messages.screener.suggest.autoFailed);
  });

  it("4d — the switch shows what the DATABASE stored, never what the click asked for", async () => {
    writeMode = "storesOff";
    const engine = await engineWith(HELD);
    const shell = await mountShell(engine);

    await click(switchEl());
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);

    // A 200 that stored nothing. Asking for `true` and being told `null` must read as OFF — the
    // switch is the user's only record of whether their money is committed, so it renders the
    // echo. An implementation that set its state from `enabled` would show this armed.
    expect(patches()[0]!.body).toEqual({ autoSuggest: true });
    expect(switchEl().getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain(messages.screener.suggest.autoOff);
    expect(text()).not.toContain("On since");

    // And the spender in the same tab is not armed either — the flag that authorises spending
    // came from the same echo.
    await shell.openScreener();
    expect(purchases()).toHaveLength(0);
  });

  it("4c — a refused QUOTE shows the server's own sentence, not a generic one", async () => {
    quoteMode = "refuse";
    const engine = await engineWith(HELD);
    await mountShell(engine);

    await click(switchEl());
    expect(text()).toContain("no AI credits remain on this account");
    expect(buttonNamed(messages.screener.suggest.autoTurnOn)!.disabled).toBe(true);
  });

  it("5 — turning it OFF disarms THIS TAB, not just the database", async () => {
    const engine = await engineWith(HELD);
    const shell = await mountShell(engine);

    // On, confirmed.
    await click(switchEl());
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);
    expect(storedAt).toBe(TURNED_ON_AT);

    // Off — no confirm and no quote: removing an authorisation spends nothing.
    const before = dryRuns().length;
    await click(switchEl());
    expect(storedAt).toBeNull();
    expect(patches()).toHaveLength(2);
    expect(patches()[1]!.body).toEqual({ autoSuggest: false });
    expect(dryRuns()).toHaveLength(before);
    expect(switchEl().getAttribute("aria-checked")).toBe("false");

    // NOW OPEN THE SCREENER IN THE SAME TAB, no reload. Nothing may be bought.
    await shell.openScreener();
    expect(purchases()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("5b — the same tab, left ON, DOES buy: the negative in 5 is not vacuous", async () => {
    const engine = await engineWith(HELD);
    const shell = await mountShell(engine);

    await click(switchEl());
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);
    await shell.openScreener();

    // One batch, bounded, from the front of the same queue — and it happened because the switch
    // and the spender share one consent state. Without this, assertion 5 would pass on a tab
    // where the automatic path never worked at all.
    expect(purchases()).toHaveLength(1);
    expect(purchases()[0]!.body!.senders).toHaveLength(AUTO_BATCH_SIZE);
    expect(purchases()[0]!.body!.automatic, "the batch the switch armed went out as a press").toBe(true);
    // Still no decision: it bought work, not an outcome.
    expect(decides()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("6 — re-confirming is idempotent: same body, same stored state", async () => {
    const engine = await engineWith(HELD);
    const shell = await mountShell(engine);

    await click(switchEl());
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);
    expect(storedAt).toBe(TURNED_ON_AT);

    // Arm it again from a fresh confirm. The route is deliberately not idempotency-keyed, so the
    // property under test is that a replay is the SAME STATE rather than a second effect.
    await shell.openScreener();
    await shell.openSettings();
    expect(switchEl().getAttribute("aria-checked")).toBe("true");
    // Pressing an already-on switch turns it OFF (it is a switch, not a button) — so the replay
    // worth asserting is the write itself, issued twice with the same argument.
    const { consent } = await import("../app/api-client.js");
    await act(async () => { await consent.setAutoSuggest(true); });
    await act(async () => { await consent.setAutoSuggest(true); });
    expect(storedAt).toBe(TURNED_ON_AT);
    expect(patches().every((p) => p.body!.autoSuggest === true)).toBe(true);
  });
});

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, OhmailEngine, consentPartition, mutationEffects, presentationReader, senderKey,
  type EngineMessage, type EngineMutation, type Folder, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import type { ScreenerState } from "../app/shell/screener-state.js";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * QUICK-ADJUST — filing a waiting sender from its own row.
 *
 * The Screener's decisions have always lived in the bar above the PREVIEW, so every sender cost a
 * selection before it cost a decision. The row already names the destination; this is the same
 * decision taken where it is already legible.
 *
 * ── WHAT IS ACTUALLY UNDER TEST, AND WHY IT IS THIS ─────────────────────────────────────────
 *
 * Not "the button files the mail" — that is easy to make true and easy to make true WRONGLY. A
 * row control that reached for `engine.mutate` directly would look identical on screen, pass any
 * assertion about mail moving, and silently drop all six of the things `ScreenerState.decide`
 * does: the undo window, the delayed commit, the read clamp, the scope, the rule promotion, and
 * the past-the-gate branch that files with a rule and capped moves because a decide cannot reach
 * mail that is physically in the INBOX (#116).
 *
 * So the two assertions are the two that a bypass cannot fake:
 *
 *  1. NOTHING IS SENT AT PRESS TIME. The row goes pending and the wire stays silent until the
 *     undo window closes. A direct mutate is on the wire in the same tick.
 *  2. A PAST-THE-GATE SENDER GETS A RULE AND MOVES, NOT A DECIDE. That branch exists only inside
 *     `decide`. Anything that files by any other route emits a `screener_decide` the server
 *     would resolve against no held mail, and this goes red.
 *
 * MUTATION WATCH — each of these was applied to `ScreenerView.tsx`, watched go red, and reverted
 * (2026-08-09):
 *   · the row's `onFile` made a no-op → the funnel, the past-the-gate and the menu tests.
 *   · `state.flush()` added straight after the `decide`, which is what filing without an undo
 *     window looks like from here → the funnel test, on the "nothing sent yet" assertion.
 *   · `acceptDestOf` returning `ai.dest` unconditionally, so a hold gets an accept → the
 *     no-accept test.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
// jsdom has no `CSS`; j/k and `s` look a row up by `CSS.escape`d id.
(globalThis as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s };
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;
let sent: EngineMutation[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Mail the next `engine.syncOnce()` delivers. */
let arrivals: EngineMessage[] = [];

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

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

/**
 * An engine over a mirror already holding `mail`, with every mutation it issues recorded.
 * `queued`: the server queues each decision for the organizer, as for a pending reader; nothing moves.
 */
async function engineWith(mail: EngineMessage[], queued = false): Promise<OhmailEngine> {
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
      sync: async () => {
        const creates = arrivals.map((m): SyncChange => ({
          type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
        }));
        arrivals = [];
        return {
          changes: { creates, updates: [], moves: [], deletes: [] },
          cursor: creates.length ? `c${seq}` : store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m) => {
        sent.push(m);
        if (queued && m.kind === "screener_decide") return { changes: [], seq: null, pendingWith: { name: "Office Mac" } };
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
            updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
          }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
}

const suggestion = (dest: string, extra: Record<string, unknown> = {}) => ({
  dest, confidence: 0.88, rationale: "because", ...extra,
});

beforeEach(() => {
  sent = [];
  arrivals = [];
  // The decide journal replays across mounts: a decision left by one test would hold its sender in the next.
  window.localStorage.clear();
  globalThis.fetch = (async () => json({})) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

/**
 * Mount the REAL waiting Screener over the REAL state hook.
 *
 * `pastTheGate` composes the queue the way the shell does — the projection for the rows, the raw
 * mirror for the mutations — which is the only composition that mints a `gatePhysical:false` row.
 */
async function mount(opts: {
  mail: EngineMessage[];
  suggestions: Record<string, unknown>;
  pastTheGate?: boolean;
  /** The install's role and the decisions the server holds outstanding (`pending` mode). */
  role?: unknown;
  outstanding?: unknown[];
  queued?: boolean;
}): Promise<{
  latest: () => ScreenerState;
  arrive: (mail: EngineMessage[]) => Promise<void>;
  /** Replace the suggestions, as a purchase landing does. */
  suggest: (suggestions: Record<string, unknown>) => Promise<void>;
}> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const engine = await engineWith(opts.mail, opts.queued);
  const overlayOf = (s: Record<string, unknown>) =>
    new Map(Object.entries(s).map(([addr, x]) => [senderKey(addr), x]));
  const outstanding = opts.outstanding ?? [];

  let live: ScreenerState | null = null;
  let setOverlay: ((m: Map<string, unknown>) => void) | null = null;

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    const [overlay, so] = React.useState(() => overlayOf(opts.suggestions));
    setOverlay = so;
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const reader = engine.read();
    const presented = opts.pastTheGate
      ? presentationReader(reader, consentPartition(reader, { now: NOW }))
      : undefined;
    const state = useScreenerState(
      engine, v, (() => {}) as never, overlay as never, presented as never,
      true, opts.role as never, outstanding as never,
    );
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
  return {
    latest: () => live!,
    arrive: async (mail) => {
      arrivals.push(...mail);
      await act(async () => { await engine.syncOnce(); });
      await flush();
    },
    suggest: async (s) => {
      await act(async () => { setOverlay!(overlayOf(s)); });
      await flush();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

/** The action slot beside the row whose sender is `address`. */
function slot(address: string): HTMLElement {
  const found = [...host!.querySelectorAll<HTMLElement>(".row-slot")].find((s) =>
    (s.querySelector(".row")?.textContent ?? "").includes(address),
  );
  if (!found) throw new Error(`no row for ${address} — on screen: ${host!.textContent}`);
  const actions = found.querySelector<HTMLElement>(".row-actions");
  if (!actions) throw new Error(`the row for ${address} has no action slot`);
  return actions;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

describe("quick-adjust — the decision on the row", () => {
  it("presses through the decide funnel: pending first, the wire only when the undo window closes", async () => {
    const { latest } = await mount({
      mail: [msg("m1", "news@example.test", 9)],
      suggestions: { "news@example.test": suggestion("reads") },
    });
    const before = latest();
    const id = before.waiting[0]!.id;
    // Premise: the row carries the suggestion, or the accept under test is not the one shipping.
    expect(before.waiting[0]!.ai?.dest).toBe("reads");

    const accept = slot("news@example.test").querySelector(".scn-act-yes");
    expect(accept, "the row offers no accept for a sender that has a suggestion").not.toBeNull();
    // The pile is in the accessible name: a reader arriving on this button hears it alone.
    expect(accept!.getAttribute("aria-label")).toBe(
      "Accept the suggestion — file this sender to News",
    );

    await click(accept!);

    // ── 1. NOTHING ON THE WIRE YET ─────────────────────────────────────────────────────────
    // The row is pending and reversible. A control that called `engine.mutate` itself would
    // already have sent, and there would be nothing left for the undo capsule to undo.
    expect(latest().isExiting(id), "the accept did not open an undo window").toBe(true);
    expect(sent.filter((m) => m.kind === "screener_decide")).toHaveLength(0);

    // ── 2. AND THEN EXACTLY THE DECIDE THE SUGGESTION NAMED ────────────────────────────────
    await act(async () => { latest().flush(); });
    await flush();
    const decides = sent.filter((m) => m.kind === "screener_decide");
    expect(decides).toHaveLength(1);
    expect(decides[0]).toMatchObject({
      senderId: id, decision: "yes", dest: "reads", scope: "sender",
      // Filing from the row does not mark the held mail read — that is the ⇧ twin's job, and a
      // one-press control must not take the decision the keyboard makes people ask for.
      read: false,
    });
    // No second path fired alongside it.
    expect(sent.filter((m) => m.kind === "mark_seen")).toHaveLength(0);
  });

  it("past the gate, the row files with a RULE and moves the letter it showed — never a decide", async () => {
    // `stray@` has mail only in the INBOX. The cutline presents them at the gate because a
    // decision about them is genuinely wanted, but the decide endpoint resolves `:id` against
    // held mail and would find none. `decide` routes them past the gate instead — and that
    // branch lives nowhere else, so this is the assertion a bypass cannot survive.
    //
    // The suggestion is Reads and not Ohbox on purpose: an Ohbox rule targets the INBOX, which
    // is where this sender's mail already is, so a correct run would move nothing and the
    // second half of the assertion would pass over an empty plan.
    const { latest } = await mount({
      mail: [msg("stray1", "stray@example.test", 9, "INBOX")],
      suggestions: { "stray@example.test": suggestion("reads") },
      pastTheGate: true,
    });
    const st = latest();
    expect(st.waiting).toHaveLength(1);
    expect(st.waiting[0]!.gatePhysical, "premise: this row is not at the gate").toBe(false);

    await click(slot("stray@example.test").querySelector(".scn-act-yes")!);
    await act(async () => { latest().flush(); });
    await flush();

    expect(sent.filter((m) => m.kind === "screener_decide")).toHaveLength(0);
    const rules = sent.filter((m) => m.kind === "rule_create");
    expect(rules, "the past-the-gate branch did not run — no rule was written").toHaveLength(1);
    // …and, ruled, the row files what it shows: the rule asks no past-mail answer and the letter
    // the row listed moves by id — the pass is not asked for mail the row never showed.
    expect(rules[0]).toMatchObject({ destination: "ohmail/News", applyRetro: false });
    expect(sent.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "stray1", folder: "ohmail/News", from: "INBOX" }]);
  });

  it("a held sender gets no accept — only the five destinations", async () => {
    // `dest: "screener"` is the model DECLINING to place this sender. There is no suggestion to
    // take, and a ✓ over one would be the row claiming an answer the model refused to give.
    await mount({
      mail: [msg("m1", "hold@example.test", 9), msg("m2", "none@example.test", 10)],
      suggestions: { "hold@example.test": suggestion("screener") },
    });

    for (const who of ["hold@example.test", "none@example.test"]) {
      const actions = slot(who);
      expect(actions.querySelector(".scn-act-yes"), `${who} was offered an accept`).toBeNull();
      const more = actions.querySelector(".scn-act-more");
      expect(more, `${who} has no way to file at all`).not.toBeNull();
      await click(more!);
      const dests = [...slot(who).querySelectorAll(".scn-act-dest")].map((b) =>
        (b.textContent ?? "").replace(/[orcnx]$/, "").trim(),
      );
      expect(dests).toEqual(["Ohbox", "News", "Receipts", "Screened out", "Spam"]);
      await click(slot(who).querySelector(".scn-act-more")!);
    }
  });

  it("the destination menu files through the same funnel as the accept", async () => {
    const { latest } = await mount({
      mail: [msg("m1", "none@example.test", 9)],
      suggestions: {},
    });
    const id = latest().waiting[0]!.id;

    await click(slot("none@example.test").querySelector(".scn-act-more")!);
    const receipts = [...slot("none@example.test").querySelectorAll<HTMLElement>(".scn-act-dest")]
      .find((b) => (b.textContent ?? "").startsWith("Receipts"))!;
    await click(receipts);

    // The same ceremony: reversible first, on the wire second.
    expect(latest().isExiting(id)).toBe(true);
    expect(sent.filter((m) => m.kind === "screener_decide")).toHaveLength(0);
    await act(async () => { latest().flush(); });
    await flush();
    expect(sent.filter((m) => m.kind === "screener_decide")[0]).toMatchObject({
      senderId: id, dest: "receipts", scope: "sender", read: false,
    });
    // One menu at a time, and it closes behind the press.
    expect(host!.querySelector(".scn-act-menu")).toBeNull();
  });
});

const selId = (): string | null => host!.querySelector(".view-screener .row.sel")?.getAttribute("data-id") ?? null;
const decided = (): string[] =>
  sent.filter((m) => m.kind === "screener_decide").map((m) => (m as { senderId: string }).senderId);
async function press(key: string): Promise<void> {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  await flush();
}
async function commit(latest: () => ScreenerState): Promise<void> {
  await act(async () => { latest().flush(); });
  await flush();
}
const rowOf = (id: string): HTMLElement => host!.querySelector<HTMLElement>(`.view-screener .row[data-id="${id}"]`)!;
const rowIds = (): Array<string | null> =>
  [...host!.querySelectorAll(".view-screener .row")].map((r) => r.getAttribute("data-id"));
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const markAll = (): HTMLButtonElement =>
  [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Mark all spam")!;
const askNow = (): HTMLElement | null => host!.querySelector<HTMLElement>("[role=alertdialog]");
/** A pending reader: dora's decision waits on the organizer, so she is listed under it as decided. */
const pending = {
  role: { mode: "pending", name: "Office Mac", reason: null, oauthOnly: false },
  outstanding: [{
    subject: "dora@example.test", scope: "sender", decidedAt: "2026-08-02T08:00:00.000Z",
    holder: "Office Mac", state: "pending",
  }],
  queued: true,
};

describe("the selection is the person's, not the arrival's", () => {
  it("a stranger arriving above the shown sender leaves the selection where it was, and o decides the shown sender", async () => {
    const { latest, arrive } = await mount({ mail: [msg("a1", "anna@example.test", 9)], suggestions: {} });
    expect(selId()).toBe("a1");
    await arrive([msg("b1", "bert@example.test", 11)]);
    expect(selId()).toBe("a1");
    await press("o");
    await commit(latest);
    expect(decided()).toEqual(["a1"]);
  });

  it("a newer letter from the clicked sender keeps them selected", async () => {
    const { latest, arrive } = await mount({
      mail: [msg("b1", "bert@example.test", 11), msg("a1", "anna@example.test", 9)], suggestions: {},
    });
    await click(rowOf("a1"));
    await arrive([msg("a2", "anna@example.test", 10)]);
    // The row is re-minted under the newer letter's id; the selection follows the sender.
    expect(selId()).toBe("a2");
    await press("o");
    await commit(latest);
    expect(decided()).toEqual(["a2"]);
  });

  it("after o the selection takes the row below, so a second o never decides an arrival above", async () => {
    const { latest, arrive } = await mount({
      mail: [msg("a1", "anna@example.test", 10), msg("b1", "bert@example.test", 9)], suggestions: {},
    });
    await arrive([msg("x1", "xena@example.test", 11)]);
    await press("o");
    expect(selId()).toBe("b1");
    await press("o");
    await commit(latest);
    expect(decided().sort()).toEqual(["a1", "b1"]);
  });

  it("filing the selected row from its own menu advances the same way", async () => {
    const { arrive } = await mount({
      mail: [msg("a1", "anna@example.test", 10), msg("b1", "bert@example.test", 9)], suggestions: {},
    });
    await click(rowOf("a1"));
    await arrive([msg("x1", "xena@example.test", 11)]);
    await click(slot("anna@example.test").querySelector(".scn-act-more")!);
    const spam = [...slot("anna@example.test").querySelectorAll<HTMLElement>(".scn-act-dest")]
      .find((b) => (b.textContent ?? "").startsWith("Spam"))!;
    await click(spam);
    expect(selId()).toBe("b1");
  });

  it("control: j then o decides the sender j moved to", async () => {
    const { latest } = await mount({
      mail: [msg("a1", "anna@example.test", 10), msg("b1", "bert@example.test", 9)], suggestions: {},
    });
    expect(selId()).toBe("a1");
    await press("j");
    expect(selId()).toBe("b1");
    await press("o");
    await commit(latest);
    expect(decided()).toEqual(["b1"]);
  });

  it("pending: deciding the bottom queue row moves to the row above, never onto a decided sender", async () => {
    const { latest } = await mount({
      mail: [msg("q1", "quinn@example.test", 11), msg("d1", "dora@example.test", 10), msg("r1", "rita@example.test", 9)],
      suggestions: {}, ...pending,
    });
    expect(latest().decided.map((d) => d.sender.id)).toEqual(["d1"]);
    await click(rowOf("r1"));
    await press("x");
    expect(selId()).toBe("q1");
    await press("o");
    await commit(latest);
    expect(decided().sort()).toEqual(["q1", "r1"]);
  });

  it("pending: deciding the last queue row selects nobody, so the next key decides nobody", async () => {
    const { latest } = await mount({
      mail: [msg("d1", "dora@example.test", 10), msg("r1", "rita@example.test", 9)],
      suggestions: {}, ...pending,
    });
    expect(selId()).toBe("r1");
    await press("x");
    expect(selId()).toBeNull();
    await press("o");
    await commit(latest);
    expect(decided()).toEqual(["r1"]);
    // Sent, rita joins the decided rows: the selection does not follow her there.
    expect(latest().decided.map((d) => d.sender.id)).toEqual(["d1", "r1"]);
    expect(selId()).toBeNull();
    // The person picks again: j takes the first row.
    await press("j");
    expect(selId()).toBe("d1");
  });

  it("under a chip, a suggestion landing on the selected sender keeps them selected and shown; c files them", async () => {
    const { latest, suggest, arrive } = await mount({
      mail: [msg("a1", "anna@example.test", 11), msg("b1", "bert@example.test", 10), msg("c1", "cleo@example.test", 8)],
      suggestions: { "anna@example.test": suggestion("reads") },
    });
    // anna is selected and is not in the chip's group: the chip shows its group alone.
    await click([...host!.querySelectorAll(".scn-chip")].find((c) => (c.textContent ?? "").startsWith("No suggestion"))!);
    expect(rowIds()).toEqual(["b1", "c1"]);
    await click(rowOf("c1"));
    await suggest({ "anna@example.test": suggestion("reads"), "cleo@example.test": suggestion("receipts") });
    expect(rowIds()).toEqual(["b1", "c1"]);
    expect(selId()).toBe("c1");
    // A newer letter from cleo re-mints her row: she stays the one kept and selected.
    await arrive([msg("c2", "cleo@example.test", 9)]);
    expect(rowIds()).toEqual(["b1", "c2"]);
    expect(selId()).toBe("c2");
    await press("c");
    await commit(latest);
    expect(sent.filter((m) => m.kind === "screener_decide")).toMatchObject([{ senderId: "c2", dest: "receipts" }]);
  });
});

describe("s is this sender, and Mark all spam asks first", () => {
  it("s opens the selected row's menu and moves nobody; x then files only that sender", async () => {
    const { latest } = await mount({
      mail: [msg("a1", "anna@example.test", 9), msg("b1", "bert@example.test", 10), msg("c1", "cleo@example.test", 11)],
      suggestions: {},
    });
    const shown = selId()!;
    await press("s");
    await wait(800);
    expect(["a1", "b1", "c1"].filter((id) => latest().isExiting(id))).toEqual([]);
    expect(host!.querySelector(".scn-act-menu")?.closest(".row-slot")?.querySelector(".row")?.getAttribute("data-id")).toBe(shown);
    await press("x");
    await wait(300);
    expect(["a1", "b1", "c1"].filter((id) => latest().isExiting(id))).toEqual([shown]);
  });

  it("Mark all spam states the number and moves nobody until it is confirmed", async () => {
    const { latest } = await mount({
      mail: [msg("a1", "anna@example.test", 9), msg("b1", "bert@example.test", 10)], suggestions: {},
    });
    const open = async () => {
      const btn = [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Mark all spam")!;
      await click(btn);
      return host!.querySelector<HTMLElement>("[role=alertdialog]");
    };
    const exiting = () => ["a1", "b1"].filter((id) => latest().isExiting(id));

    let ask = await open();
    expect(ask?.textContent).toContain("Mark all 2 waiting senders as spam?");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await wait(600);
    expect(exiting()).toEqual([]);
    await click([...ask!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
    expect(host!.querySelector("[role=alertdialog]")).toBeNull();

    ask = await open();
    await press("Escape");
    expect(host!.querySelector("[role=alertdialog]")).toBeNull();
    await wait(600);
    expect(exiting()).toEqual([]);

    ask = await open();
    await click([...ask!.querySelectorAll("button")].find((b) => b.textContent === "Mark 2 as spam")!);
    await wait(900);
    expect(exiting()).toEqual(["a1", "b1"]);
    await commit(latest);
    expect(decided().sort()).toEqual(["a1", "b1"]);
  });

  it("a sender arriving while the question is open is not in it: the number stays, the confirm moves only those named", async () => {
    const { latest, arrive } = await mount({
      mail: [msg("a1", "anna@example.test", 9), msg("b1", "bert@example.test", 10)], suggestions: {},
    });
    await click(markAll());
    await arrive([msg("c1", "cleo@example.test", 11)]);
    expect(askNow()?.textContent).toContain("Mark all 2 waiting senders as spam?");
    await click([...askNow()!.querySelectorAll("button")].find((b) => b.textContent === "Mark 2 as spam")!);
    await wait(900);
    await commit(latest);
    expect(decided().sort()).toEqual(["a1", "b1"]);
  });

  it("the question follows the senders it named: o lowers the number, the last closes it, and nothing reopens it", async () => {
    const { latest, arrive } = await mount({
      mail: [msg("a1", "anna@example.test", 9), msg("b1", "bert@example.test", 10)], suggestions: {},
    });
    await click(markAll());
    (document.activeElement as HTMLElement | null)?.blur();
    await press("o");
    expect(askNow()?.textContent).toContain("Mark the 1 waiting sender as spam?");
    await press("o");
    expect(askNow()).toBeNull();
    await commit(latest);
    expect(decided().sort()).toEqual(["a1", "b1"]);
    // A newer letter from a sender it named, and a stranger: neither brings it back.
    await arrive([msg("a2", "anna@example.test", 11), msg("c1", "cleo@example.test", 12)]);
    expect(rowIds()).toEqual(expect.arrayContaining(["a2", "c1"]));
    expect(askNow()).toBeNull();
  });
});

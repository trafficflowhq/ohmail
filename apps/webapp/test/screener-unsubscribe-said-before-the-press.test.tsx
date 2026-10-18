/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, OhmailEngine, autoUnsubscribeConfirms, consentPartition, mutationEffects, presentationReader, senderKey,
  type EngineMessage, type EngineMutation, type Folder, type SyncChange, type UnsubscribeHeaderState,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import type { ScreenerState } from "../app/shell/screener-state.js";
import { autoUnsubscribeDoor } from "../app/shell/sender-screening.js";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * the real Screener over the real state hook, at 1280 and 390: the card's bar, the row's
 * menu and Accept, and the bulk strip say the one-click unsubscribe before Screen out or Spam is
 * pressed — the sender-level condition (now and their later mail) for every decide at the gate, a
 * fact where a held letter offers one-click, nothing with the switch off or a row past the gate. The
 * toast states Undo's reach: it stops the request with the decision, sent when the window closes.
 *
 * TO WATCH IT FAIL: in `unsubscribe-claim.ts#unsubscribeClaim`, return `"sends"` for every armed
 * press — the conditional cases go red; return `"none"` — every armed case goes red.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

/** 1280: nothing narrow matches. 390: every max-width query does, as a phone's browser answers. */
function setWidth(px: 1280 | 390): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((query: string) => ({
    matches: px === 390 && /max-width/.test(query), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;
}

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;
let sent: EngineMutation[] = [];
let toasts: Array<{ message: string; onAction?: () => void; undo?: boolean }> = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function msg(id: string, from: string, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-08-02T09:00:00.000Z", folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

/**
 * A held letter with its body read: the posture the server stated on it, and what its provider said
 * about its author (`authVerdict`; absent is nobody asked).
 */
interface Held {
  id: string; from: string; posture: UnsubscribeHeaderState | "unread"; folder?: Folder;
  verdict?: EngineMessage["authVerdict"];
}

async function engineWith(held: Held[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...held.map((x): SyncChange => {
      const m = { ...msg(x.id, x.from, x.folder), ...(x.verdict === undefined ? {} : { authVerdict: x.verdict }) };
      return { type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m };
    }),
    ...held.filter((x) => x.posture !== "unread").map((x): SyncChange => ({
      type: "message_body", op: "create", id: x.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: {
        messageId: x.id, state: "ready", text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: x.posture, unsubscribeUrl: null, withheld: null,
      },
    })),
  ]);
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
      fetchBody: async () => null,
    },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

/** The real waiting Screener, the first sender selected so its card is on screen. */
async function mount(opts: {
  held: Held[]; width: 1280 | 390; autoUnsubscribe?: boolean; suggestions?: Record<string, string>;
  /** Compose the queue as the shell does, so an INBOX sender is presented at the gate (`gatePhysical:false`). */
  pastTheGate?: boolean;
}): Promise<{ latest: () => ScreenerState }> {
  setWidth(opts.width);
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const engine = await engineWith(opts.held);
  const overlay = new Map(Object.entries(opts.suggestions ?? {}).map(([a, dest]) => [
    senderKey(a), { dest, confidence: 0.9, rationale: "because" },
  ]));
  let live: ScreenerState | null = null;

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(
      engine, v,
      ((message: string, o?: { onAction?: () => void; undo?: boolean }) => {
        toasts.push({ message, ...(o?.onAction ? { onAction: o.onAction } : {}), ...(o?.undo ? { undo: true } : {}) });
      }) as never,
      overlay as never,
      (opts.pastTheGate ? presentationReader(engine.read(), consentPartition(engine.read(), { now: NOW })) : undefined) as never,
      opts.autoUnsubscribe,
    );
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: state.waiting[0]?.id ?? null, screened: null, spam: null,
    });
    live = state;
    return h(ScreenerView, {
      owed: false, state, segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: opts.width === 390, onFull: () => {},
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { storageKey: null, children: h(KeymapProvider, { children: h(Probe) }) }),
    }));
  });
  await flush();
  await settleFirstPaint();
  return { latest: () => live! };
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

/** The card's own line under the bar, or `null` where it says nothing. */
const cardLine = (): string | null => host!.querySelector(".decide .d-unsub")?.textContent ?? null;

/** The card's capsule whose label is `label` — its key cap stripped. */
function capsule(label: string): HTMLElement {
  const b = [...host!.querySelectorAll<HTMLElement>(".decide .d-main")].find((x) => (x.textContent ?? "").replace(/[orcnxy]$/, "").trim() === label);
  if (!b) throw new Error(`no "${label}" on the card — on screen: ${host!.textContent}`);
  return b;
}

const ONE_CLICK = "news@list.example";
const NO_OFFER = "person@plain.example";

beforeEach(() => {
  sent = [];
  toasts = [];
  window.localStorage.clear();
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

describe.each([1280, 390] as const)("the Screener card at %i says the unsubscribe before the press", (width) => {
  it("a sender whose held letter offers one-click: the card says it as a fact", async () => {
    await mount({ held: [{ id: "a1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width });
    expect(cardLine()).toBe(`Screen out and Spam also send ${ONE_CLICK} a one-click unsubscribe request, and ask again for their later mail that offers one.`);
  });

  it("a one-click letter its provider did not confirm: the condition, never the fact — the pass sends only for a confirmed sender", async () => {
    await mount({ held: [{ id: "a2", from: ONE_CLICK, posture: "one_click", verdict: "unavailable" }], width });
    expect(cardLine()).toBe(`Where ${ONE_CLICK} offers one-click unsubscribe, Screen out and Spam also ask to unsubscribe you, now and for their later mail.`);
  });

  it("every held letter read and none offering it: the condition still stands — later mail and past mail may offer one", async () => {
    await mount({ held: [{ id: "b1", from: NO_OFFER, posture: "no_header" }, { id: "b2", from: NO_OFFER, posture: "not_one_click" }], width });
    expect(cardLine()).toBe(`Where ${NO_OFFER} offers one-click unsubscribe, Screen out and Spam also ask to unsubscribe you, now and for their later mail.`);
  });

  it("a held letter still unread: the card says it as a condition, never as a promise", async () => {
    await mount({ held: [{ id: "c1", from: NO_OFFER, posture: "no_header" }, { id: "c2", from: NO_OFFER, posture: "unread" }], width });
    expect(cardLine()).toBe(`Where ${NO_OFFER} offers one-click unsubscribe, Screen out and Spam also ask to unsubscribe you, now and for their later mail.`);
  });

  it("the account's switch off: nothing is said, whatever the sender offers", async () => {
    await mount({ held: [{ id: "d1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width, autoUnsubscribe: false });
    expect(cardLine()).toBeNull();
    expect(capsule("Screen out")).toBeTruthy();
  });

  it("a row past the gate takes the rule path, which asks nothing: no line, and no request named", async () => {
    await mount({ held: [{ id: "p1", from: ONE_CLICK, posture: "one_click", folder: "INBOX" }], width, pastTheGate: true });
    expect(capsule("Screen out"), "premise: the card is on screen").toBeTruthy();
    expect(cardLine()).toBeNull();
    await click(capsule("Screen out"));
    expect(toasts.at(-1)!.message).not.toContain("unsubscrib");
  });
});

describe("the press, and how far its Undo reaches", () => {
  it("Undo inside the window stops the decision and the request: nothing reaches the wire", async () => {
    const { latest } = await mount({ held: [{ id: "e1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width: 1280 });
    await click(capsule("Screen out"));
    const said = toasts.at(-1)!;
    expect(said.message).toContain("Undo also stops their one-click unsubscribe request");
    expect(said.message).toContain("cannot be taken back");
    expect(said.undo, "the toast carries no Undo").toBe(true);
    await act(async () => { said.onAction!(); });
    await act(async () => { latest().flush(); });
    await flush();
    expect(sent.filter((m) => m.kind === "screener_decide")).toHaveLength(0);
  });

  it("left alone, the window closes and the screen-out is sent once — the request the server then makes", async () => {
    const { latest } = await mount({ held: [{ id: "f1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width: 1280 });
    await click(capsule("Screen out"));
    await act(async () => { latest().flush(); });
    await flush();
    const decides = sent.filter((m) => m.kind === "screener_decide");
    expect(decides).toHaveLength(1);
    expect(decides[0]).toMatchObject({ decision: "no" });
  });

  it("a sender whose held letter offers none: the toast still names the request as the sender-level condition", async () => {
    await mount({ held: [{ id: "g1", from: NO_OFFER, posture: "no_header" }], width: 390 });
    await click(capsule("Screen out"));
    expect(toasts.at(-1)!.message).toContain("Screened out");
    expect(toasts.at(-1)!.message).toContain("Where they offer one-click unsubscribe, ohmail asks to unsubscribe you once Undo is gone, and again for their later mail");
  });
});

/**
 * WHERE NO MAILBOX'S PROVIDER CAN CONFIRM A SENDER (every host but Gmail's and Microsoft's), the
 * server refuses every automatic request, so the card, the bulk strip and the toast promise none —
 * the shell's own door over the account's mailbox rows (`autoUnsubscribeDoor`, `autoUnsubscribeConfirms`).
 */
describe("an account whose mailboxes' providers ohmail cannot read says no unsubscribe before or after the press", () => {
  const discloses = (providerConfirms: boolean): boolean => autoUnsubscribeDoor({
    demo: false, known: true, on: true, standalone: false,
    confirms: autoUnsubscribeConfirms([{ status: "connected", providerConfirms }]),
  }).discloses;

  it("nothing on the card, the bulk strip or the toast, over a one-click letter", async () => {
    await mount({ held: [{ id: "m1", from: ONE_CLICK, posture: "one_click", verdict: "unavailable" }], width: 1280, autoUnsubscribe: discloses(false) });
    expect(capsule("Screen out"), "premise: the card is on screen").toBeTruthy();
    expect(cardLine()).toBeNull();
    expect(host!.querySelector(".scn-bulk-unsub")).toBeNull();
    await click(capsule("Screen out"));
    expect(toasts.at(-1)!.message).toContain("Screened out");
    expect(toasts.at(-1)!.message).not.toContain("unsubscrib");
  });

  it("the control: a Gmail mailbox's confirmed one-click letter is said as a fact", async () => {
    await mount({ held: [{ id: "m2", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width: 1280, autoUnsubscribe: discloses(true) });
    expect(cardLine()).toBe(`Screen out and Spam also send ${ONE_CLICK} a one-click unsubscribe request, and ask again for their later mail that offers one.`);
  });
});

describe("the row's menu, its Accept and the bulk strip say it before the press too", () => {
  const slot = (address: string): HTMLElement => {
    const found = [...host!.querySelectorAll<HTMLElement>(".row-slot")].find((s) =>
      (s.querySelector(".row")?.textContent ?? "").includes(address));
    if (!found) throw new Error(`no row for ${address}`);
    return found.querySelector<HTMLElement>(".row-actions")!;
  };

  it("the menu that offers Screen out and Spam names the request: a fact for a one-click sender, the condition for one offering none", async () => {
    await mount({
      held: [{ id: "h1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }, { id: "h2", from: NO_OFFER, posture: "no_header" }],
      width: 1280,
    });
    await click(slot(ONE_CLICK).querySelector(".scn-act-more")!);
    expect(slot(ONE_CLICK).querySelector(".scn-act-unsub")?.textContent)
      .toBe(`Screen out and Spam also send ${ONE_CLICK} a one-click unsubscribe request, and ask again for their later mail that offers one.`);
    await click(slot(ONE_CLICK).querySelector(".scn-act-more")!);
    await click(slot(NO_OFFER).querySelector(".scn-act-more")!);
    expect(slot(NO_OFFER).querySelector(".scn-act-dest"), "positive control: the menu is open").not.toBeNull();
    expect(slot(NO_OFFER).querySelector(".scn-act-unsub")?.textContent).toBe(`Where ${NO_OFFER} offers one-click unsubscribe, Screen out and Spam also ask to unsubscribe you, now and for their later mail.`);
  });

  it("an Accept that screens out says it unsubscribes; an Accept that keeps says nothing", async () => {
    await mount({
      held: [{ id: "i1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }, { id: "i2", from: "keep@shop.example", posture: "one_click", verdict: "pass" }],
      width: 1280,
      suggestions: { [ONE_CLICK]: "screened", "keep@shop.example": "receipts" },
    });
    expect(slot(ONE_CLICK).querySelector(".scn-act-yes")?.textContent).toBe("Accept and unsubscribe");
    expect(slot("keep@shop.example").querySelector(".scn-act-yes")?.textContent).toBe("Accept");
  });

  it("the bulk strip says it for any waiting sender, and not with the switch off", async () => {
    await mount({ held: [{ id: "j1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width: 1280 });
    expect(host!.querySelector(".scn-bulk-unsub")?.textContent)
      .toBe("Where a sender offers one-click unsubscribe, Spam and Screen out here also ask to unsubscribe you, now and for their later mail.");
    await act(async () => { root!.unmount(); });
    host!.remove();
    root = null;
    await mount({ held: [{ id: "k1", from: NO_OFFER, posture: "no_header" }], width: 1280, autoUnsubscribe: false });
    expect(host!.textContent, "positive control: the bulk strip is on screen").toContain("Mark all spam");
    expect(host!.querySelector(".scn-bulk-unsub")).toBeNull();
  });
});

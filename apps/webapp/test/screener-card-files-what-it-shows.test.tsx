/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder, MessageBodyWire, RuleEntity as RuleDTO, ScreenerSenderDTO } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { fireEvent, within } from "@testing-library/react";
import {
  OhmailEngine,
  MemoryMirrorStore,
  MutationRejectedError,
  consentPartition,
  mutationEffects,
  presentationReader,
  pressRules,
  screenerSegments,
  senderKey,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import { TextProvider } from "@ohmail/app/text";
import { Frame } from "@ohmail/app/frame";
import { NONE } from "@ohmail/app/host";
import { ScreenerAbove, screenerPlace, type ScreenerBeside } from "@ohmail/app/screener";
import { ThemeProvider } from "@ohmail/ui";
import { useScreenerWords } from "../../../packages/app/src/screener/words.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { COMMIT_MS, type ScreenerState } from "@ohmail/app-logic/screener/screener-state";
import type { SuggestionOverlay } from "@ohmail/app-logic/screener/suggestion-overlay";

/**
 * Ruled: the Screener card's decision files what the card shows. It used to arm the
 * server's past-mail pass, which moved 42 of the sender's earlier letters out of News while the
 * card said "1 held message". The card's press now asks no past-mail answer and moves the INBOX
 * letters it listed by id; the sender sheet keeps its own answer.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-09T11:22:00.000Z");
let seq = 0;
let sent: EngineMutation[] = [];
let said: string[] = [];
/** The server's refusal, where a case asks for one: a 422 for the kinds it names. */
let refusing: ReadonlySet<string> = new Set();

function msg(id: string, folder: Folder, from = "s@letters.example", over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    ...over,
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-10-09T09:00:00.000Z", folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-09T09:00:00.000Z", senderCheck: null,
  };
}

async function mirror(ms: EngineMessage[] = [msg("h1", "ohmail/Screener"), msg("i1", "INBOX")], more: SyncChange[] = []): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([...ms.map((m): SyncChange => (
    { type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })), ...more]);
  return store;
}

function engineOver(
  store: MirrorStore,
  takeChanges: () => SyncChange[] = () => [],
  fetchBody: (id: string) => Promise<MessageBodyWire> = async () => ({
    text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
  }),
): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const changes = takeChanges();
        return {
          changes: {
            creates: changes.filter((change) => change.op === "create"),
            updates: [],
            moves: [],
            deletes: changes.filter((change) => change.op === "delete"),
          },
          cursor: changes.length > 0 ? `c${seq}` : store.getCursor(),
          hasMore: false,
          serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m) => {
        sent.push(m);
        if (refusing.has(m.kind)) throw new MutationRejectedError("refused", { status: 422, code: "validation_failed", retryable: false });
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
            updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
          }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody,
    },
  });
}

interface StateLike {
  waiting: Array<{ id: string; from: { address: string }; held: Array<{ id: string }> }>;
  decide: (sender: unknown, dest: string, opts: { read: boolean; scope: string; applyRetro?: boolean }) => void;
  reachOf: (sender: unknown, scope: string) => { others: Array<{ address: string; count: number }>; inboxIds: string[] };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mountState(engine: OhmailEngine): Promise<() => StateLike> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  let latest: StateLike | null = null;
  function Probe(): null {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    // The production shape: the queue built from the mirror as it is PRESENTED (the cutline known).
    const raw = engine.read();
    latest = useScreenerState(
      engine, null, v, ((m: string) => { said.push(m); }) as never, useScreenerWords(), undefined, presentationReader(raw, consentPartition(raw, { now: NOW })),
    ) as unknown as StateLike;
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages: en as never, timeZone: "UTC", now: NOW, children: h(TextProvider, { locale: "en", messages: en as never, timeZone: "UTC", children: h(Probe) }) }));
  });
  await settleFirstPaint();
  return () => latest!;
}

async function press(get: () => StateLike, opts: { applyRetro?: boolean } = {}): Promise<void> {
  await act(async () => { get().decide(get().waiting[0], "reads", { read: false, scope: "sender", ...opts }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(COMMIT_MS + 50); });
  await act(async () => { await Promise.resolve(); });
}

async function mountWaitingRows(engine: OhmailEngine, suggestions?: SuggestionOverlay) {
  vi.stubGlobal("fetch", async () => new Response("{}", { headers: { "content-type": "application/json" } }));
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { host: frame } = fakeHost({
    engine, service: "self", scope: "acct", places: { screener: screenerPlace },
    address: fakeAddress("#/screener"), window: fakeWindow("desktop"),
  });
  const beside: ScreenerBeside = {
    letters: NONE, junk: NONE, unsubscribe: NONE, mailboxWord: () => null, suggest: NONE, invitation: NONE,
    facts: { settled: true, owed: false, storeImportOpen: false, notOrganizingYet: null },
    undo: () => false,
  };
  let latest: ScreenerState | null = null;
  function World(): React.ReactElement {
    const [version, setVersion] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setVersion((v) => v + 1)), []);
    const raw = engine.read();
    const presented = presentationReader(raw, consentPartition(raw, { now: NOW }));
    const state = useScreenerState(engine, "acct", version, () => {}, useScreenerWords(), suggestions, presented);
    latest = state;
    return h(ScreenerAbove, { model: state, beside, children: h(Frame, { host: frame }) });
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(ThemeProvider, {
      storageKey: null,
      children: h(TextProvider, { locale: "en", messages: en, timeZone: "UTC", children: h(World) }),
    }));
  });
  await settleFirstPaint();
  return () => latest!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  seq = 0;
  sent = [];
  said = [];
  refusing = new Set();
  window.localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null; host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("quick-adjust — the decision on the row", () => {
  it("past the gate, the row files with a RULE and moves the letter it showed — never a decide", async () => {
    // The presentation wants a decision for this sender, but the decide endpoint cannot find held mail for them.
    const from = "stray@letters.example";
    const engine = engineOver(await mirror([msg("stray1", "INBOX", from)]));
    const latest = await mountWaitingRows(engine, new Map([
      [senderKey(from), { dest: "reads", confidence: 0.88, rationale: "because" }],
    ]));
    const st = latest();
    expect(st.waiting).toHaveLength(1);
    expect(st.waiting[0]!.gatePhysical, "premise: this row is not at the gate").toBe(false);

    const list = within(host!).getByRole("listbox", { name: "Screener" });
    const accept = within(list).getByRole("button", { name: "News" });
    await act(async () => { accept.click(); });
    expect(latest().isExiting(st.waiting[0]!.id)).toBe(true);
    expect(sent).toEqual([]);
    await act(async () => { latest().flush(); });
    await settleFirstPaint();

    expect(sent.filter((m) => m.kind === "screener_decide")).toHaveLength(0);
    const rules = sent.filter((m) => m.kind === "rule_create");
    expect(rules, "the past-the-gate branch did not run — no rule was written").toHaveLength(1);
    // Only the letter the row listed moves by id. The rule asks for no past-mail pass.
    expect(rules[0]).toMatchObject({ destination: "ohmail/News", applyRetro: false });
    expect(sent.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "stray1", folder: "ohmail/News", from: "INBOX", pressRule: true }]);
  });

  it("a held sender gets no accept — only the five destinations", async () => {
    // A hold is the model declining to recommend a place. The second sender has no recommendation at all.
    const first = "first@letters.example";
    const second = "second@letters.example";
    const engine = engineOver(await mirror([
      msg("m1", "ohmail/Screener", first),
      msg("m2", "ohmail/Screener", second),
    ]));
    const latest = await mountWaitingRows(engine, new Map([
      [senderKey(first), { dest: "screener", confidence: 0.88, rationale: "because" }],
    ]));
    expect(latest().waiting.find((sender) => sender.id === "m1")?.ai?.dest).toBe("screener");

    const list = within(host!).getByRole("listbox", { name: "Screener" });
    for (const [who, id] of [[first, "m1"], [second, "m2"]]) {
      const option = within(list).getByRole("option", { name: `${who}: Subject ${id}` });
      const row = within(option.closest<HTMLElement>(".oh-row-slot")!);
      const choose = row.getByRole("button", { name: "Choose a place" });
      expect(row.getAllByRole("button"), `${who} was offered an accept`).toEqual([choose]);
      await act(async () => { choose.click(); });
      const menu = within(document.body).getByRole("menu", { name: "Choose where this sender's mail goes" });
      const items = within(menu).getAllByRole("menuitem");
      const labels = items.map((item) => item.querySelector(".oh-menu-word")?.textContent);
      expect(labels.pop()).toBe("Change this sender's screening");
      expect(labels).toEqual(["Ohbox", "News", "Receipts", "Screened out", "Spam"]);
      await act(async () => { fireEvent.keyDown(menu, { key: "Escape" }); });
      expect(menu.isConnected).toBe(false);
    }
  });

  it("the destination menu files through the same funnel as the accept", async () => {
    const engine = engineOver(await mirror([msg("m1", "ohmail/Screener")]));
    const latest = await mountWaitingRows(engine);
    const id = latest().waiting[0]!.id;
    const list = within(host!).getByRole("listbox", { name: "Screener" });
    await act(async () => { within(list).getByRole("button", { name: "Choose a place" }).click(); });
    const menu = within(document.body).getByRole("menu", { name: "Choose where this sender's mail goes" });
    await act(async () => { within(menu).getByRole("menuitem", { name: "Receipts" }).click(); });

    // The same ceremony: reversible first, on the wire second.
    expect(latest().isExiting(id)).toBe(true);
    expect(sent.filter((m) => m.kind === "screener_decide")).toHaveLength(0);
    await act(async () => { latest().flush(); });
    await settleFirstPaint();
    expect(sent.filter((m) => m.kind === "screener_decide")[0]).toMatchObject({
      senderId: id, dest: "receipts", scope: "sender", read: false,
    });
    expect(within(document.body).queryByRole("menu", { name: "Choose where this sender's mail goes" })).toBeNull();
  });
});

function heldLetter(id: string, sender: string, hour: number): EngineMessage {
  const mail = msg(id, "ohmail/Screener", sender);
  return { ...mail, date: `2026-10-09T${String(hour).padStart(2, "0")}:00:00.000Z` };
}

async function mountKeyboardRows(mail: EngineMessage[], fixtures?: SyncChange[]) {
  const changes: SyncChange[] = [];
  const engine = engineOver(await mirror(mail, fixtures), () => changes.splice(0));
  const latest = await mountWaitingRows(engine);
  const list = () => within(within(host!).getByRole("listbox", { name: "Screener" }));
  const sync = async (change: SyncChange) => {
    changes.push(change);
    await act(async () => { await engine.syncOnce(); });
    await settleFirstPaint();
  };
  return {
    engine,
    latest,
    pick: async (name: string) => {
      await act(async () => { list().getByRole("option", { name }).click(); });
    },
    selected: () => list().queryByRole("option", { selected: true })?.getAttribute("data-id") ?? null,
    order: () => list().getAllByRole("option").map((option) => option.getAttribute("data-id")),
    arrive: (letter: EngineMessage) => sync({
      type: "message", op: "create", id: letter.id, seq: ++seq, updatedAt: letter.updatedAt, entity: letter,
    }),
    remove: (id: string) => sync({
      type: "message", op: "delete", id, seq: ++seq, updatedAt: NOW.toISOString(),
    }),
    key: async (key: string, shiftKey = false) => {
      await act(async () => { fireEvent.keyDown(document, { key, shiftKey }); });
    },
    commit: async () => {
      await act(async () => { latest().flush(); });
      await settleFirstPaint();
    },
  };
}

const decidedSenders = () => sent.filter((m) => m.kind === "screener_decide").map((m) => m.senderId);

describe("a derived Screener row decides over the real wire vocabulary", () => {
  const lena = "lena@atelier.example";
  const jackpot = "win@jackpot.example";
  const held = () => [heldLetter("m1", lena, 8), heldLetter("m2", lena, 9), heldLetter("m3", jackpot, 10)];

  async function file(sender: string, representative: string, key: string, shiftKey = false) {
    const rows = await mountKeyboardRows(held());
    await rows.pick(`${sender}: Subject ${representative}`);
    expect(rows.selected()).toBe(representative);
    expect(rows.latest().waiting.find((row) => row.id === representative)).toMatchObject({
      derived: true, gatePhysical: true,
    });
    expect(sent).toEqual([]);
    await rows.key(key, shiftKey);
    if (key === "x") {
      const confirmation = within(document.body).getByRole("dialog", { name: en.screener.place.unsub.spam });
      expect(confirmation.textContent).toContain(sender);
      expect(rows.latest().isExiting(representative)).toBe(false);
      expect(sent).toEqual([]);
      await act(async () => {
        within(confirmation).getByRole("button", { name: en.screening.unsubCommitMaybe }).click();
      });
    }
    expect(rows.latest().isExiting(representative)).toBe(true);
    expect(sent).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(COMMIT_MS + 50); });
    await settleFirstPaint();
    return rows.engine;
  }

  it("the queue is there at all — 2 senders, 3 held, from the mirror alone", async () => {
    const { latest, order } = await mountKeyboardRows(held());
    expect(within(host!).getByRole("option", { name: `${lena}: Subject m2` })).toBeTruthy();
    expect(within(host!).getByRole("option", { name: `${jackpot}: Subject m3` })).toBeTruthy();
    expect(order()).toEqual(["m3", "m2"]);
    expect(latest().waitingCount).toBe(2);
    expect(latest().waiting.every((sender) => sender.derived)).toBe(true);
    expect(latest().waiting.flatMap((sender) => sender.held).map((letter) => letter.id).sort()).toEqual(["m1", "m2", "m3"]);
    expect(sent).toEqual([]);
  });

  async function bodyFixture() {
    const fetched: string[] = [];
    let release!: () => void;
    const remaining = new Promise<void>((resolve) => { release = resolve; });
    const body = "FULL BODY of m1\nsecond paragraph";
    const engine = engineOver(await mirror(held()), undefined, async (id) => {
      fetched.push(id);
      if (id !== "m1") await remaining;
      return {
        text: id === "m1" ? body : `FULL BODY of ${id}`,
        html: null,
        loadedRemoteContent: false,
        unsubscribe: "no_header",
        unsubscribeUrl: null,
      };
    });
    return { body, engine, fetched, release };
  }

  async function openLena(engine: OhmailEngine) {
    const latest = await mountWaitingRows(engine);
    await act(async () => {
      within(host!).getByRole("option", { name: `${lena}: Subject m2` }).click();
    });
    await settleFirstPaint();
    return latest;
  }

  it("hydrating one held message makes it FULL, and touches no other row", async () => {
    const { body, engine, fetched, release } = await bodyFixture();
    await engine.hydrateBody("m1");
    const rows = screenerSegments(engine.read(), NOW).waiting.flatMap((sender) => sender.held);
    expect(fetched).toEqual(["m1"]);
    expect(rows.find((letter) => letter.id === "m1")).toMatchObject({ body, bodyState: "full" });
    expect(rows.find((letter) => letter.id === "m2")).toMatchObject({ body: "snippet m2", bodyState: "snippet" });
    expect(rows.find((letter) => letter.id === "m3")).toMatchObject({ body: "snippet m3", bodyState: "snippet" });

    await openLena(engine);
    expect(document.getElementById("sc-held-m1")?.textContent).toContain(body);
    expect(document.getElementById("sc-held-m2")?.textContent).toContain("snippet m2");
    expect(fetched.filter((id) => id === "m1")).toEqual(["m1"]);
    await act(async () => { release(); });
    expect(sent).toEqual([]);
  });

  it("A DELTA FOR THE SAME MESSAGE DOES NOT WIPE THE HYDRATED BODY (Risk 1)", async () => {
    const { body, engine, fetched, release } = await bodyFixture();
    await engine.hydrateBody("m1");
    const first = engine.read().get<EngineMessage>("message", "m1")!;
    await engine.store.applyChanges([{
      type: "message", op: "update", id: "m1", seq: ++seq,
      updatedAt: NOW.toISOString(), entity: { ...first, unread: false },
    }]);
    const latest = await openLena(engine);
    const hydrated = latest().waiting.flatMap((sender) => sender.held).find((letter) => letter.id === "m1");
    expect(hydrated).toMatchObject({ body, bodyState: "full" });
    expect(document.getElementById("sc-held-m1")?.textContent).toContain(body);
    expect(engine.read().get<EngineMessage>("message", "m1")?.unread).toBe(false);
    expect(fetched.filter((id) => id === "m1")).toEqual(["m1"]);
    await act(async () => { release(); });
    expect(sent).toEqual([]);
  });

  it("Ohbox is one call: the endpoint's own yes, no follow-up move", async () => {
    const engine = await file(lena, "m2", "o");
    expect(sent).toEqual([expect.objectContaining({
      kind: "screener_decide", senderId: "m2", decision: "yes", dest: "ohbox", scope: "sender", read: false,
    })]);
    for (const id of ["m1", "m2"]) {
      expect(engine.store.get<EngineMessage>("message", id)).toMatchObject({ folder: "INBOX", unread: true });
    }
    expect(engine.store.get<EngineMessage>("message", "m3")?.folder).toBe("ohmail/Screener");
  });

  it("Reads is ONE call: the destination rides the decide, with no follow-up move", async () => {
    const engine = await file(lena, "m2", "r");
    expect(sent).toEqual([expect.objectContaining({
      kind: "screener_decide", senderId: "m2", decision: "yes", dest: "reads", scope: "sender", read: false,
    })]);
    for (const id of ["m1", "m2"]) {
      expect(engine.store.get<EngineMessage>("message", id)?.folder).toBe("ohmail/News");
    }
  });

  it("SPAM RIDES THE NO BRANCH — a yes would file spam into the Ohbox", async () => {
    const engine = await file(jackpot, "m3", "x");
    expect(sent).toEqual([expect.objectContaining({
      kind: "screener_decide", senderId: "m3", decision: "no", dest: "spam", scope: "sender",
    })]);
    expect(sent[0]).not.toHaveProperty("read");
    expect(engine.store.get<EngineMessage>("message", "m3")?.folder).toBe("ohmail/Quarantine");
  });

  it("a spam-pinned sender is listed ONCE, not beside their own derived row", async () => {
    const engine = await file(jackpot, "m3", "x");
    expect(engine.store.get<EngineMessage>("message", "m3")?.folder).toBe("ohmail/Quarantine");
    const section = within(within(host!).getByRole("group", { name: "Screener sections" }));
    await act(async () => { section.getByRole("button", { name: /^Spam/ }).click(); });
    const options = within(within(host!).getByRole("listbox", { name: "Screener" })).getAllByRole("option");
    expect(options.map((row) => row.getAttribute("data-id"))).toEqual(["m3"]);
    expect(options[0]?.textContent).toContain(jackpot);
    expect(decidedSenders()).toEqual(["m3"]);
  });

  it("'& read' is its own mark_seen — the decide endpoint has no read field", async () => {
    const engine = await file(lena, "m2", "O", true);
    expect(sent).toEqual([
      expect.objectContaining({ kind: "screener_decide", senderId: "m2", decision: "yes", dest: "ohbox", scope: "sender", read: true }),
      expect.objectContaining({ kind: "mark_seen", messageIds: ["m1", "m2"], unread: false }),
    ]);
    for (const id of ["m1", "m2"]) {
      expect(engine.store.get<EngineMessage>("message", id)).toMatchObject({ folder: "INBOX", unread: false });
    }
    expect(engine.store.get<EngineMessage>("message", "m3")).toMatchObject({ folder: "ohmail/Screener", unread: true });
  });
});

describe("the selection is the person's, not the arrival's", () => {
  const anna = "anna@letters.example";
  const bert = "bert@letters.example";
  const extra = "extra@letters.example";
  const scopeButton = () => within(host!).getByRole("button", { name: "Decision scope" });

  async function chooseDomain() {
    await act(async () => { scopeButton().click(); });
    const menu = within(within(document.body).getByRole("menu", { name: "Decision scope" }));
    await act(async () => { menu.getByRole("menuitemradio", { name: "whole domain" }).click(); });
    expect(scopeButton().textContent).toBe("whole domain");
  }

  async function mountDuplicateRows() {
    const spam: ScreenerSenderDTO = {
      id: "local-spam", segment: "spam", from: { name: null, address: "Anna@letters.example" },
      initial: "A", time: "08:00", scope: "sender", ai: null,
      held: [{ id: "spam-letter", subject: "Local spam representative", time: "08:00", body: "Fixture" }],
      updatedAt: NOW.toISOString(),
    };
    const rows = await mountKeyboardRows([
      heldLetter("b1", bert, 11), heldLetter("a1", anna, 9),
    ], [
      { type: "screener_sender", op: "create", id: spam.id, seq: ++seq, updatedAt: spam.updatedAt, entity: spam },
    ]);
    async function returnFromSpam() {
      const sections = within(within(host!).getByRole("group", { name: "Screener sections" }));
      await act(async () => { sections.getByRole("button", { name: /^Spam/ }).click(); });
      const actions = within(within(host!).getByRole("toolbar", { name: "Actions" }));
      await act(async () => { actions.getByRole("button", { name: "Screener" }).click(); });
      await act(async () => { sections.getByRole("button", { name: /^Waiting/ }).click(); });
    }
    return { ...rows, returnFromSpam, duplicateId: spam.id };
  }

  it("keeps the clicked representative when two visible rows have the same sender", async () => {
    const { pick, selected, order, arrive, key, commit, returnFromSpam, duplicateId } = await mountDuplicateRows();
    await pick(`${anna}: Subject a1`);
    await arrive(heldLetter("a2", anna, 10));
    expect(selected()).toBe("a2");
    await returnFromSpam();
    expect(order()).toEqual(["b1", "a2", duplicateId]);
    expect(selected()).toBe("a2");
    await chooseDomain();
    await pick("Anna@letters.example: Local spam representative");
    expect(selected()).toBe(duplicateId);
    expect(scopeButton().textContent).toBe("this sender");
    expect(sent).toEqual([]);
    await key("o");
    expect(sent).toEqual([]);
    await commit();
    expect(sent.filter((m) => m.kind === "screener_decide")).toMatchObject([
      { senderId: duplicateId, dest: "ohbox", scope: "sender", read: false },
    ]);
  });

  it("falls back to the first waiting row when the clicked representative disappears beside its duplicate", async () => {
    const { pick, selected, order, remove, key, commit, returnFromSpam, duplicateId } = await mountDuplicateRows();
    await pick(`${anna}: Subject a1`);
    await returnFromSpam();
    expect(order()).toEqual(["b1", "a1", duplicateId]);
    expect(selected()).toBe("a1");
    await chooseDomain();

    await remove("a1");
    expect(order()).toEqual(["b1", duplicateId]);
    expect.soft(selected()).toBe("b1");
    expect(scopeButton().textContent).toBe("this sender");
    expect(sent).toEqual([]);
    await key("o");
    expect(sent).toEqual([]);
    await commit();
    expect(sent.filter((m) => m.kind === "screener_decide")).toMatchObject([
      { senderId: "b1", dest: "ohbox", scope: "sender", read: false },
    ]);
  });

  it("keeps an explicit whole-domain choice through a waiting row refresh", async () => {
    const { pick, selected, order, arrive, key, commit } = await mountKeyboardRows([
      heldLetter("b1", bert, 11), heldLetter("a1", anna, 9),
    ]);
    await pick(`${anna}: Subject a1`);
    await chooseDomain();

    await arrive(heldLetter("a2", "Anna@letters.example", 10));
    expect(order()).toEqual(["b1", "a2"]);
    expect(selected()).toBe("a2");
    expect(scopeButton().textContent).toBe("whole domain");
    await pick(`${bert}: Subject b1`);
    expect(scopeButton().textContent).toBe("this sender");
    await pick("Anna@letters.example: Subject a2");
    expect(scopeButton().textContent).toBe("whole domain");
    expect(sent).toEqual([]);
    await key("o");
    expect(sent).toEqual([]);
    await commit();
    expect(sent.filter((m) => m.kind === "screener_decide")).toMatchObject([
      { senderId: "a2", dest: "ohbox", scope: "domain", read: false },
    ]);
  });

  it("a newer letter from the clicked sender keeps them selected", async () => {
    const { pick, selected, order, arrive, key, commit } = await mountKeyboardRows([
      heldLetter("b1", bert, 11), heldLetter("a1", anna, 9),
    ]);
    await pick(`${anna}: Subject a1`);
    expect(selected()).toBe("a1");
    await arrive(heldLetter("a2", "Anna@letters.example", 10));
    expect(order()).toEqual(["b1", "a2"]);
    expect(selected()).toBe("a2");
    expect(sent).toEqual([]);
    await key("o");
    expect(sent).toEqual([]);
    await commit();
    expect(decidedSenders()).toEqual(["a2"]);
    expect(sent.filter((m) => m.kind === "screener_decide")).toMatchObject([
      { senderId: "a2", dest: "ohbox", scope: "sender", read: false },
    ]);
  });

  it("when a sender leaves the queue, the remaining row gets the selection without filing it", async () => {
    const { pick, selected, order, remove, arrive, key, commit } = await mountKeyboardRows([
      heldLetter("b1", bert, 11), heldLetter("a1", anna, 9),
    ]);
    await pick(`${anna}: Subject a1`);
    expect(selected()).toBe("a1");
    await chooseDomain();
    await remove("a1");
    expect(order()).toEqual(["b1"]);
    expect(selected()).toBe("b1");
    expect(scopeButton().textContent).toBe("this sender");
    await arrive(heldLetter("a2", anna, 10));
    await pick(`${anna}: Subject a2`);
    expect(scopeButton().textContent).toBe("this sender");
    await pick(`${bert}: Subject b1`);
    expect(sent).toEqual([]);
    await key("o");
    await commit();
    expect(decidedSenders()).toEqual(["b1"]);
  });

  it("a stranger arriving above the shown sender leaves the selection where it was, and o decides the shown sender", async () => {
    const { selected, order, arrive, key, commit } = await mountKeyboardRows([heldLetter("a1", anna, 9)]);
    expect(selected()).toBe("a1");
    await arrive(heldLetter("b1", bert, 11));
    expect(order()).toEqual(["b1", "a1"]);
    expect(selected()).toBe("a1");
    await key("o");
    expect(sent).toEqual([]);
    await commit();
    expect(decidedSenders()).toEqual(["a1"]);
  });

  it("after o the selection takes the row below, so a second o never decides an arrival above", async () => {
    const { selected, order, arrive, key, commit } = await mountKeyboardRows([
      heldLetter("a1", anna, 10), heldLetter("b1", bert, 9),
    ]);
    await arrive(heldLetter("x1", extra, 11));
    expect(order()).toEqual(["x1", "a1", "b1"]);
    await key("o");
    expect(selected()).toBe("b1");
    await key("o");
    await commit();
    expect(decidedSenders().sort()).toEqual(["a1", "b1"]);
  });

  it("control: j then o decides the sender j moved to", async () => {
    const { selected, key, commit } = await mountKeyboardRows([
      heldLetter("a1", anna, 10), heldLetter("b1", bert, 9),
    ]);
    expect(selected()).toBe("a1");
    await key("j");
    expect(selected()).toBe("b1");
    await key("o");
    await commit();
    expect(decidedSenders()).toEqual(["b1"]);
  });
});

describe("the Screener card's decision files what the card shows", () => {
  it("the card lists the held letter and the INBOX letter, and its press moves exactly those", async () => {
    const get = await mountState(engineOver(await mirror()));
    expect(get().waiting[0]?.held.map((x) => x.id).sort()).toEqual(["h1", "i1"]);
    await press(get);
    const decide = sent.find((m) => m.kind === "screener_decide");
    expect(decide).toMatchObject({ senderId: "h1", dest: "reads", applyRetro: false });
    expect(sent.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "i1", folder: "ohmail/News", from: "INBOX", pressRule: true }]);
  });

  it("a representative past the gate: the rule asks no past-mail answer either, and the letter moves", async () => {
    const get = await mountState(engineOver(await mirror([msg("i2", "INBOX")])));
    expect(get().waiting[0]?.held.map((x) => x.id)).toEqual(["i2"]);
    await press(get);
    expect(sent.find((m) => m.kind === "rule_create")).toMatchObject({ applyRetro: false });
    expect(sent.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "i2", folder: "ohmail/News", from: "INBOX", pressRule: true }]);
  });

  it("a refused decision moves no letter by id, and says it was not saved", async () => {
    refusing = new Set(["screener_decide"]);
    const get = await mountState(engineOver(await mirror()));
    await press(get);
    expect(sent.filter((m) => m.kind === "screener_decide")).toHaveLength(1);
    expect(sent.filter((m) => m.kind === "move")).toEqual([]);
    expect(said.join(" | ")).toContain("could not be saved");
  });

  it("a refused rule past the gate moves no letter by id either", async () => {
    refusing = new Set(["rule_create"]);
    const get = await mountState(engineOver(await mirror([msg("i2", "INBOX")])));
    await press(get);
    expect(sent.filter((m) => m.kind === "rule_create")).toHaveLength(1);
    expect(sent.filter((m) => m.kind === "move")).toEqual([]);
  });

  it("CONTROL: the sender sheet's press keeps its own past-mail answer and moves nothing itself", async () => {
    const get = await mountState(engineOver(await mirror()));
    await press(get, { applyRetro: true });
    expect(sent.find((m) => m.kind === "screener_decide")).toMatchObject({ senderId: "h1", applyRetro: true });
    expect(sent.filter((m) => m.kind === "move")).toEqual([]);
  });
});

describe("a whole-domain card names and files every waiting letter at the domain", () => {
  const A = "a@letters.example";
  const B = "b@letters.example";
  const C = "c@letters.example";
  const domainMirror = () => mirror([
    msg("h1", "ohmail/Screener", A), msg("a1", "INBOX", A),
    msg("b1", "INBOX", B),
    // An answer the gate admitted from the same domain: decided for itself, never in the set.
    msg("c1", "INBOX", C, { placeDecided: true }),
  ]);

  it("names the other sender before the press, and a News decision moves both senders' INBOX letters", async () => {
    const get = await mountState(engineOver(await domainMirror()));
    const a = get().waiting.find((w) => w.from.address === A)!;
    expect(get().reachOf(a, "domain").others).toEqual([{ address: B, count: 1 }]);
    await act(async () => { get().decide(a, "reads", { read: false, scope: "domain" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMMIT_MS + 50); });
    await act(async () => { await Promise.resolve(); });
    expect(sent.find((m) => m.kind === "screener_decide")).toMatchObject({ senderId: "h1", scope: "domain", applyRetro: false });
    const moved = sent.filter((m) => m.kind === "move").map((m) => (m.kind === "move" ? `${m.messageId}>${m.folder}` : ""));
    expect(moved.sort()).toEqual(["a1>ohmail/News", "b1>ohmail/News"]);
  });

  it("a sender decided inside the domain decision's window keeps its own decision for its letter", async () => {
    const get = await mountState(engineOver(await domainMirror()));
    const a = get().waiting.find((w) => w.from.address === A)!;
    await act(async () => { get().decide(a, "reads", { read: false, scope: "domain" }); });
    const b = get().waiting.find((w) => w.from.address === B)!;
    await act(async () => { get().decide(b, "receipts", { read: false, scope: "sender" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMMIT_MS + 50); });
    await act(async () => { await Promise.resolve(); });
    const moved = sent.filter((m) => m.kind === "move").map((m) => (m.kind === "move" ? `${m.messageId}>${m.folder}` : ""));
    expect(moved.sort()).toEqual(["a1>ohmail/News", "b1>ohmail/Receipts"]);
  });

  it("a sender whose own decision is in flight is not named by the domain card", async () => {
    const get = await mountState(engineOver(await domainMirror()));
    const b = get().waiting.find((w) => w.from.address === B)!;
    await act(async () => { get().decide(b, "receipts", { read: false, scope: "sender" }); });
    const a = get().waiting.find((w) => w.from.address === A)!;
    expect(get().reachOf(a, "domain")).toEqual({ others: [], inboxIds: ["a1"] });
  });

  it("CONTROL: the admitted answer at that domain stays where it is, named nowhere", async () => {
    const get = await mountState(engineOver(await domainMirror()));
    const a = get().waiting.find((w) => w.from.address === A)!;
    expect(get().waiting.map((w) => w.from.address)).not.toContain(C);
    await act(async () => { get().decide(a, "reads", { read: false, scope: "domain" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(COMMIT_MS + 50); });
    await act(async () => { await Promise.resolve(); });
    expect(sent.filter((m) => m.kind === "move" && m.messageId === "c1")).toEqual([]);
  });
});

/* A READER-ONLY INSTALL: the card's press past the gate plans over the organizer's copy (`pressRules`),
   handed in by the shell's routing window as the sender sheet's presses read it. */
describe("the card's press past the gate where a rule change travels to the organizer", () => {
  const FROM = "s@letters.example";
  const AT = "2026-10-09T09:00:00.000Z";
  // This install's row, written long ago; the organizer has since removed the rule.
  const stale = {
    id: "r-stale", kind: "sender", match: FROM, destination: "ohmail/News", priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: AT, updatedAt: AT,
  } as RuleDTO;
  const readerMirror = () => mirror([msg("i2", "INBOX")], [
    { type: "rule", op: "create", id: "r-stale", seq: ++seq, updatedAt: AT, entity: stale },
    { type: "mailbox_profile", op: "create", id: "mb", seq: ++seq, updatedAt: AT, entity: {
      mailboxId: "mb", rules: [], asOf: AT, from: { kind: "local", name: "Laptop", since: null }, updatedAt: AT, applied: [],
    } },
  ] as SyncChange[]);

  async function mountShell(engine: OhmailEngine, travels: boolean): Promise<() => StateLike> {
    const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
    const { useShellDispatch } = await import("@ohmail/app-logic/press/shell-dispatch");
    const { placeLabel } = await import("@ohmail/app-logic/text/format");
    let latest: StateLike | null = null;
    function Probe(): null {
      const [v, setV] = React.useState(0);
      React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
      const raw = engine.read();
      const d = useShellDispatch({ engine, reader: raw, t: useTranslations(), placeLabel, demo: false, refreshFacts: () => {}, toast: () => {}, scope: null });
      // As the shell's verbs set it.
      d.routing.planOver.current = travels
        ? (read) => pressRules(read, { travels: true, queued: [], applied: [], unsettled: [], now: NOW }) : null;
      latest = useScreenerState(
        engine, null, v, ((m: string) => { said.push(m); }) as never, useScreenerWords(), undefined, presentationReader(raw, consentPartition(raw, { now: NOW })),
        true, undefined, [], [], undefined, d.screenerRelease,
      ) as unknown as StateLike;
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages: en as never, timeZone: "UTC", now: NOW, children: h(TextProvider, { locale: "en", messages: en as never, timeZone: "UTC", children: h(Probe) }) }));
    });
    await settleFirstPaint();
    return () => latest!;
  }

  it("over the copy the press writes the sender's rule; over this install's row, none", async () => {
    for (const travels of [false, true]) {
      sent = [];
      const get = await mountShell(engineOver(await readerMirror()), travels);
      expect(get().waiting.map((w) => w.from.address), "the sender is not waiting").toEqual([FROM]);
      await press(get);
      const rules = sent.filter((m) => m.kind.startsWith("rule_"));
      expect(rules, `travels ${travels}`).toEqual(travels
        ? [expect.objectContaining({ kind: "rule_create", ruleKind: "sender", match: FROM, destination: "ohmail/News", applyRetro: false })]
        : []);
      await act(async () => root!.unmount());
      host?.remove();
      root = null;
    }
  });
});

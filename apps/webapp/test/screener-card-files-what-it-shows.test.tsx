/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  MutationRejectedError,
  consentPartition,
  mutationEffects,
  presentationReader,
  pressRules,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MirrorStore,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { COMMIT_MS } from "../app/shell/screener-state";

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

function engineOver(store: MirrorStore): OhmailEngine {
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
      fetchBody: async () => ({ text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
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
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  let latest: StateLike | null = null;
  function Probe(): null {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    // The production shape: the queue built from the mirror as it is PRESENTED (the cutline known).
    const raw = engine.read();
    latest = useScreenerState(
      engine, v, ((m: string) => { said.push(m); }) as never, undefined, presentationReader(raw, consentPartition(raw, { now: NOW })),
    ) as unknown as StateLike;
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages: en as never, timeZone: "UTC", now: NOW, children: h(Probe) }));
  });
  await settleFirstPaint();
  return () => latest!;
}

async function press(get: () => StateLike, opts: { applyRetro?: boolean } = {}): Promise<void> {
  await act(async () => { get().decide(get().waiting[0], "reads", { read: false, scope: "sender", ...opts }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(COMMIT_MS + 50); });
  await act(async () => { await Promise.resolve(); });
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
    const { useScreenerState } = await import("../app/shell/screener-state.js");
    const { useShellDispatch } = await import("../app/shell/shell-dispatch.js");
    let latest: StateLike | null = null;
    function Probe(): null {
      const [v, setV] = React.useState(0);
      React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
      const raw = engine.read();
      const d = useShellDispatch({ engine, reader: raw, t: useTranslations(), demo: false, refreshFacts: () => {}, toast: () => {} });
      // As the shell's verbs set it.
      d.routing.planOver.current = travels
        ? (read) => pressRules(read, { travels: true, queued: [], applied: [], unsettled: [], now: NOW }) : null;
      latest = useScreenerState(
        engine, v, ((m: string) => { said.push(m); }) as never, undefined, presentationReader(raw, consentPartition(raw, { now: NOW })),
        true, undefined, [], [], undefined, d.screenerRelease,
      ) as unknown as StateLike;
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages: en as never, timeZone: "UTC", now: NOW, children: h(Probe) }));
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

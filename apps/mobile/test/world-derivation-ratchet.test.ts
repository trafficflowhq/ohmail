import type { EngineMessage, ScreenerWaitingWire } from "@ohmail/wire";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import { createProjector, listStamp, type ProjectionInputs, type Projected } from "../src/state/world-projection";
import { drainReads } from "../src/state/drain-reads";
import { foldersFlag, freshestRead } from "../src/state/folders-flag";
import { SCREENING_UNSUPPLIED, partitionRuns, type WorldActions } from "../src/state/live";

/**
 * THE WORLD DERIVES ONLY WHAT MOVED — the shipped projector (`world-projection.ts`, the one memo
 * body `WorldProvider` runs) over a real engine holding tens of thousands of synthetic rows across 90 days, the
 * shipped drain reads and flag machine answered by a fake server. There is no React Native renderer
 * in this workspace, so the provider's memo is modelled here as React runs it — a run when any
 * dependency's identity moved — and `world-memo-owner.test.ts` pins that the provider's memo body is
 * exactly `projector.project(`. Each ceiling only falls.
 */

const NOW = Date.UTC(2026, 8, 29, 9, 0, 0);
const DAY = 86_400_000;
const ROWS = 10_000;

function msg(i: number, over: Partial<EngineMessage> = {}): EngineMessage {
  const id = `m${i}`;
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: `t${i % 7000}`, messageIdHeader: null,
    subject: `Subject ${i}`, from: { name: `Sender ${i % 400}`, address: `s${i % 400}@example.test` },
    to: [{ name: null, address: "me@example.test" }], cc: [],
    date: new Date(NOW - (i % 90) * DAY - (i % 1440) * 60_000).toISOString(),
    folder: i % 10 === 0 ? "Archive" : "INBOX", snippet: `snippet ${i}`, unread: i % 3 === 0,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: new Date(NOW).toISOString(), ...over,
  } as EngineMessage;
}

const created = (ms: EngineMessage[], from: number): SyncChange[] =>
  ms.map((m, k) => ({ type: "message", op: "create", id: m.id, seq: from + k, updatedAt: new Date(NOW).toISOString(), entity: m } as SyncChange));

const queuePage: ScreenerWaitingWire = {
  items: [{ messageId: "m1", address: "s1@example.test", name: null, receivedAt: new Date(NOW).toISOString(), subject: "s", snippet: "s", mailboxId: "mb" }],
  nextCursor: null, total: 1, inFlight: [],
};

/** The fake server's REST answers, a fresh object per request, the way the network hands them over. */
const answers = {
  consent: () => ({ on: false, signatures: { mb: "— sig" }, resurfaceTime: null, screening: null, storable: true, autoAct: null, autoSuggestOn: false, autoUnsubscribe: true, themeFace: null }),
  mailboxes: () => [{ id: "mb", address: "me@example.test", organizedBy: null }],
  queue: () => [{ address: "s1@example.test", name: null }],
  relayed: () => [],
};

function rig() {
  const pages: SyncChange[][] = [created(Array.from({ length: ROWS }, (_, i) => msg(i)), 1)];
  let seq = ROWS + 1;
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: new Date(NOW).toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
    fetchBody: async () => ({ text: "the whole body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    screenerWaiting: async () => queuePage,
    unscreened: async () => ({ groups: [], total: 0, max: 200 }),
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => new Date(NOW), storePolicy: { mode: "full" } });
  let notifies = 0;
  engine.subscribe(() => { notifies += 1; });
  const arrive = (m: EngineMessage) => pages.push(created([m], seq++));

  /* THE PROVIDER'S STATE, set by the shipped reads exactly as world.tsx sets it. */
  const state: Pick<ProjectionInputs, "signatures" | "mailboxes" | "screenerServer" | "relayed"> = {
    signatures: null, mailboxes: null, screenerServer: null, relayed: null,
  };
  const set = <K extends keyof typeof state>(k: K) => (v: (typeof state)[K]) => { state[k] = v; };
  const sigRead = freshestRead<ReturnType<typeof answers.consent>>((a) => set("signatures")(a.signatures));
  const boxRead = freshestRead((a: ReturnType<typeof answers.mailboxes>) => set("mailboxes")(a as never));
  const queueRead = freshestRead((a: ReturnType<typeof answers.queue>) => set("screenerServer")(a as never));
  const relayRead = freshestRead((a: ReturnType<typeof answers.relayed>) => set("relayed")(a as never));
  const flag = foldersFlag({
    read: drainReads({
      rest: [
        () => void boxRead(async () => answers.mailboxes()),
        () => void queueRead(async () => answers.queue()),
        () => void relayRead(async () => answers.relayed()),
      ],
      consent: () => sigRead(async () => answers.consent()),
      engine,
    }),
    write: async (on) => ({ on }), apply: () => undefined, drain: () => undefined,
  });

  const projector = createProjector();
  const fixed = {
    scopes: {}, leavingWaiting: [], heldDeletes: new Set<string>(), heldPlaces: new Map() as never,
    ownAddresses: ["me@example.test"] as readonly string[], posture: SCREENING_UNSUPPLIED,
    actions: {} as WorldActions, onPresented: () => undefined, account: () => ({ name: "rig", email: "" }),
    setFoldersEnabled: async () => true, folderSummary: async () => null, rememberResurfaceTime: () => undefined,
  };
  /* React's memo: a run when a dependency's identity moved. */
  let last: unknown[] | null = null;
  let world: Projected | null = null;
  let runs = 0;
  const render = (): Projected => {
    const deps = [listStamp(engine), state.signatures, state.mailboxes, state.screenerServer, state.relayed];
    if (last === null || deps.some((d, i) => !Object.is(d, last![i]))) {
      last = deps;
      runs += 1;
      world = projector.project({
        engine, worldKey: "rig", standalone: false, bearer: null, images: "direct" as never,
        zone: "Europe/Zurich", locale: "en", now: new Date(NOW), foldersOn: false, foldersPending: false, foldersStorable: true,
        signatures: state.signatures, resurfaceTime: null, screenerServer: state.screenerServer,
        relayed: state.relayed, mailboxes: state.mailboxes, walker: null, searchWalker: null,
        openOffMirror: () => undefined, ...fixed,
      } as unknown as ProjectionInputs);
    }
    // What the Ohbox screen and the dock read on every render.
    void world!.ohbox.fresh; void world!.ohbox.unread; void world!.screener.waiting.length;
    void world!.reads.newCount; void world!.receipts.newCount;
    return world!;
  };
  const listRuns = () => Object.entries(projector.stats().lists)
    .filter(([k]) => k !== "view" && k !== "tags" && k !== "tagsRead")
    .reduce((n, [, c]) => n + c, 0);
  const drain = async () => { await engine.syncOnce(); await flag.refresh(); await new Promise((r) => setTimeout(r, 0)); };
  /* A provider input moving for a reason of its own — a fresh relay answer. */
  const touchRelayed = () => { state.relayed = []; };
  return { engine, flag, render, drain, arrive, listRuns, touchRelayed, runs: () => runs, notifies: () => notifies, stats: projector.stats };
}

describe("the world's derivation ratchet at a large row count", () => {
  let r: ReturnType<typeof rig>;
  let coldFormats = 0;
  let coldHistory: number | undefined;

  beforeAll(async () => {
    r = rig();
    await r.engine.start();
    await r.flag.refresh();
    await new Promise((res) => setTimeout(res, 0));
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      r.render();
      coldFormats = spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
    coldHistory = r.stats().lists.history;
  }, 60_000);

  it("(5) a cold run formats at most twice per hour bucket, and builds no History rows nobody read", () => {
    // 90 days of minute-spread dates touch at most 90 × 24 hour buckets; +8 for the reader's own clock.
    expect(coldFormats).toBeLessThanOrEqual(2 * 90 * 24 + 8);
    expect(coldHistory, "History's rows were built with no screen reading them").toBeUndefined();
    expect(r.render().ohbox.fresh.length + r.render().ohbox.seen.length, "the Ohbox is empty: the ratchet measures nothing").toBeGreaterThan(100);
  });

  it("(6) a list row carries no body — the surface that draws one reads it under the body stamp", () => {
    const w = r.render();
    const rows = [...w.ohbox.fresh, ...w.ohbox.seen];
    expect(rows.every((m) => m.body === "" && m.bodyState === undefined)).toBe(true);
  });

  it("(7) the open reader re-renders without partitioning the mirror again", () => {
    const w = r.render();
    const id = w.ohbox.fresh[0]!.id;
    const before = partitionRuns();
    for (let i = 0; i < 5; i++) expect(w.message(id)?.id).toBe(id);
    expect(partitionRuns() - before, "each reader render partitioned the whole mirror").toBe(0);
  });

  it("(1) an idle drain with equal answers derives nothing and formats nothing", async () => {
    r.render();
    const runs0 = r.runs(); const lists0 = r.listRuns();
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      for (let i = 0; i < 3; i++) { await r.drain(); r.render(); }
      expect(r.runs() - runs0, "a projection ran over an unchanged mailbox").toBe(0);
      expect(r.listRuns() - lists0).toBe(0);
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("(2) an equal queue answer re-derives nothing and notifies nobody", async () => {
    const runs0 = r.runs(); const n0 = r.notifies();
    await r.engine.refreshScreenerWaiting();
    r.render();
    expect(r.runs() - runs0).toBe(0);
    expect(r.notifies() - n0).toBe(0);
  });

  it("(3) one body write re-derives no list; the body stamp moves for the reader", async () => {
    const runs0 = r.runs(); const lists0 = r.listRuns();
    const body0 = r.engine.read().stampOf("message_body");
    await r.engine.hydrateBody("m3");
    r.render();
    expect(r.engine.read().stampOf("message_body"), "the body did not land").not.toBe(body0);
    expect(r.listRuns() - lists0, "a body write re-derived a list").toBe(0);
    expect(r.runs() - runs0).toBe(0);
    /* …and a later run for another reason keeps the presented reader: only the list that reads the
       moved input is derived again. */
    const before = r.stats().lists;
    r.touchRelayed();
    r.render();
    const after = r.stats().lists;
    const derived = Object.keys(after).filter((k) => (after[k] ?? 0) !== (before[k] ?? 0));
    expect(derived.sort(), "a relay answer re-derived more than the Screener").toEqual(["screener"]);
  });

  it("(4) one arrival runs once, formats little, and keeps every other row's identity", async () => {
    const before = r.render();
    const rowsBefore = new Map([...before.ohbox.fresh, ...before.ohbox.seen].map((m) => [m.id, m]));
    const runs0 = r.runs();
    r.arrive(msg(ROWS + 1, { date: new Date(NOW - 60_000).toISOString(), from: { name: "New", address: "s5@example.test" } }));
    await r.engine.syncOnce();
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    let after: Projected;
    try {
      after = r.render();
      expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      spy.mockRestore();
    }
    expect(r.runs() - runs0).toBe(1);
    const moved = [...after.ohbox.fresh, ...after.ohbox.seen].filter((m) => rowsBefore.get(m.id) !== m);
    expect(moved.length, `rows rebuilt: ${moved.map((m) => m.id).join(",")}`).toBeLessThanOrEqual(2);
  });

  it("(8) opening a row holds it without a projection; its read runs one", async () => {
    const w = r.render();
    const id = w.ohbox.fresh.find((m) => m.unread)!.id;
    const runs0 = r.runs(); const lists0 = r.listRuns();
    expect(r.engine.holdOpenRow(id)).toBe(true);
    r.render();
    expect(r.runs() - runs0, "the hold alone ran a projection").toBe(0);
    expect(r.listRuns() - lists0, "the hold alone re-derived a list").toBe(0);
    await r.engine.mutate({ kind: "mark_seen", messageIds: [id], unread: false, via: "glance" });
    const after = r.render();
    expect(r.runs() - runs0, "the read is one run").toBe(1);
    expect(after.ohbox.fresh.some((m) => (m.memberIds ?? [m.id]).includes(id)), "the open row's conversation keeps its place").toBe(true);
    r.engine.releaseOpenRow(id);
  });
});

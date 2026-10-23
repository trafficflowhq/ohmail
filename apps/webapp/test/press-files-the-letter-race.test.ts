import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  consentPartition,
  createRoutingWindow,
  inverseMutations,
  messagesIn,
  mutationEffects,
  ohboxView,
  planScreenCommit,
  presentAt,
  presentationReader,
  pressForecast,
  rulesList,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type Folder,
  type MessageBodyWire,
  type RuleDTO,
  type ScreenIntent,
  type SyncChange,
} from "@ohmail/client-engine";
import {
  movesAtLanding, planScreeningChange, ruleMatchOf, screeningPath, senderScreening,
} from "../app/shell/sender-screening";

/*
 * THE JUST-ARRIVED RACE (RULE-FILED-MESSAGE-SNAPS-BACK-TO-OHBOX): the sender sheet's rule press on
 * the letter being read, against an engine whose adapter answers like the server (a rule write
 * echoes a rule row only; a move echoes the message at its new folder) and can hold a move's answer
 * back, while /sync delivers the server's own update of the same just-arrived letter in between.
 * The press files the letter through the one door (`movesAtLanding` over the forecast's seed move)
 * and it never re-presents in the Ohbox: through the racing /sync update, the window's close, the
 * move's late echo and a stale replay.
 */

const NOW = new Date("2026-10-23T12:30:00.000Z");
const SENDER = "notice@host.example";
const RECEIPTS = "ohmail/Receipts" as Folder;
const SEED = "seed";
const ids = (l: readonly EngineMessage[]) => l.map((m) => m.id);
let seq = 0;

function msg(id: string, folder: Folder, date: string, unread = true): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Login notice ${id}`, from: { name: "Host", address: SENDER }, to: [], cc: [],
    date, folder, snippet: "a new sign-in", unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: true, category: "security_alert", no_ai: true, no_forward: true, no_kb: true, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  } as EngineMessage;
}

function rule(id: string, destination: Folder, provenance: string): RuleDTO {
  return {
    id, kind: "sender", match: SENDER, destination, priority: 0, provenance, enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 1, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    retro: { requestedAt: null, doneAt: null },
  } as unknown as RuleDTO;
}

interface Rig {
  engine: OhmailEngine;
  store: MemoryMirrorStore;
  sent: EngineMutation[];
  /** Queue one /sync page: the server's own update of a row, as the next pull delivers it. */
  queueSync: (c: SyncChange[]) => void;
  /** Hold move answers until released. */
  holdMoves: boolean;
  release: () => Promise<void>;
}

async function rig(standing: RuleDTO | null): Promise<Rig> {
  const store = new MemoryMirrorStore();
  await store.load();
  const seed: SyncChange[] = [
    { type: "message", op: "create", id: "older", seq: ++seq, updatedAt: "2026-10-01T08:00:00.000Z", entity: msg("older", "INBOX", "2026-10-01T08:00:00.000Z", false) },
  ];
  if (standing) seed.push({ type: "rule", op: "create", id: standing.id, seq: ++seq, updatedAt: standing.updatedAt, entity: standing });
  await store.applyChanges(seed);
  const pages: SyncChange[][] = [];
  const held: Array<() => Promise<void>> = [];
  const r: Rig = {
    engine: undefined as unknown as OhmailEngine, store, sent: [],
    queueSync: (c) => { pages.push(c); },
    holdMoves: false,
    release: async () => { for (const f of held.splice(0)) await f(); },
  };
  const echo = async (m: EngineMutation) => {
    const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `srv-${++seq}` }).map((e) => ({
      type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
      updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
    }));
    await store.applyChanges(changes);
    return { changes, seq: changes[changes.length - 1]?.seq ?? null };
  };
  r.engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const page = pages.shift() ?? [];
        return {
          changes: { creates: page.filter((c) => c.op === "create"), updates: page.filter((c) => c.op === "update"), moves: [], deletes: [] },
          cursor: String(seq), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m: EngineMutation) => {
        r.sent.push(m);
        if (m.kind === "move" && r.holdMoves) {
          return await new Promise((resolve) => { held.push(async () => { resolve(await echo(m)); }); });
        }
        return await echo(m);
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async (): Promise<MessageBodyWire> => ({
        text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    } as never,
  });
  await r.engine.start();
  return r;
}

const OPTS = { now: NOW };
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** The routing window exactly as `useRoutingUndo` builds it, with a hand-fired timer. */
function windowFor(r: Rig) {
  let places: ReadonlyMap<string, Folder> = new Map();
  const timers: Array<() => void> = [];
  const jar: Record<string, string> = {};
  const w = createRoutingWindow<ScreenIntent>({
    door: {
      get: (k) => jar[k] ?? null,
      set: (k, v) => { jar[k] = v; return "stored"; },
      remove: (k) => { delete jar[k]; return "stored"; },
    },
    key: "synth", windowMs: 8000, now: () => NOW.getTime(),
    setTimer: (fn) => { timers.push(fn); return timers.length as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => {},
    plan: (i) => planScreenCommit(r.engine.read(), i).writes,
    dispatch: async (mutations) => { for (const m of mutations) await r.engine.mutate(m); },
    onPending: (open) => {
      const next = new Map<string, Folder>();
      for (const i of open) for (const id of i.messageIds) next.set(id, RECEIPTS);
      places = next;
    },
  });
  /** `shell-derivations.ts`' `presented`: the partition, then the window's overlay. */
  const presented = (): EntityReader => {
    const rd = r.engine.read();
    return presentAt(presentationReader(rd, consentPartition(rd, OPTS as never)), places);
  };
  const box = () => ohboxView(presented(), r.engine.openRowHeld());
  const inOhbox = () => { const b = box(); return [...ids(b.newForYou), ...ids(b.previouslySeen)]; };
  const atReceipts = () => ids(messagesIn(presented(), RECEIPTS));
  return { w, timers, presented, box, inOhbox, atReceipts, places: () => places };
}

/** The letter arrives (a /sync create), and the person opens it: hold, then the glance read. */
async function arriveAndOpen(r: Rig) {
  r.queueSync([{ type: "message", op: "create", id: SEED, seq: ++seq, updatedAt: NOW.toISOString(), entity: msg(SEED, "INBOX", "2026-10-23T12:27:00.000Z") }]);
  await r.engine.syncOnce();
  expect(r.engine.read().get<EngineMessage>("message", SEED), "premise: the just-arrived letter is mirrored").toBeDefined();
  expect(r.engine.holdOpenRow(SEED), "premise: it stands in New and is held").toBe(true);
  await r.engine.mutate({ kind: "mark_seen", messageIds: [SEED], unread: false, via: "glance" } as EngineMutation);
}

/** What `holdScreenPress` computes before it opens the window. */
function pressPlan(r: Rig, applyRetro: boolean) {
  const sender = senderScreening(r.engine.verbRead(), SEED)!;
  const plan = planScreeningChange(sender, "receipts", "sender", true, applyRetro);
  const forecast = pressForecast({
    reader: r.engine.verbRead(), options: OPTS as never, subject: sender.scopes.sender.messages, scope: "sender",
    match: ruleMatchOf(sender, "sender"), wanted: RECEIPTS, makeRule: true, applyRetro, now: NOW, seedId: SEED,
  });
  return { sender, plan, forecast, path: screeningPath(sender, "sender", true) };
}

function intentOf(sender: { address: string }, landing: readonly string[], applyRetro: boolean): ScreenIntent {
  return {
    v: 2, verb: "screen", id: "press-1", seedId: SEED, address: sender.address, scope: "sender",
    dest: "receipts", messageIds: [...landing], makeRule: true, applyRetro, resolution: "keep",
    shown: [], at: NOW.getTime(),
  };
}

describe("the sender sheet's rule press on the letter being read", () => {
  it("the forecast lands the letter pressed on and moves it, on either switch position", async () => {
    for (const applyRetro of [true, false]) {
      const r = await rig(rule("r-allow", "INBOX" as Folder, "promoted"));
      await arriveAndOpen(r);
      const { plan, forecast, path } = pressPlan(r, applyRetro);
      expect(path).toBe("window");
      expect(plan.ruleState).toBe("retargeted");
      expect(forecast.keep.landing, `switch ${applyRetro}`).toContain(SEED);
      expect(movesAtLanding(plan, forecast, "keep")).toEqual([{ kind: "move", messageId: SEED, folder: RECEIPTS, pressRule: true }]);
      // The rest stays with the switch off; with it on it is the walk's, never the press's to move.
      expect(forecast.keep.landing.includes("older"), `switch ${applyRetro}`).toBe(applyRetro);
    }
  });

  it("a Receipts rule already stands (the lift put the letter in INBOX), switch off: the press moves the letter", async () => {
    const r = await rig(rule("r-rec", RECEIPTS, "manual"));
    await arriveAndOpen(r);
    const { plan, forecast } = pressPlan(r, false);
    expect(plan.ruleState).toBe("already");
    expect(plan.mutations, "the ladder writes nothing").toEqual([]);
    expect(movesAtLanding(plan, forecast, "keep").map((m) => m.messageId)).toEqual([SEED]);
  });

  it("the press moves the shown letter; it never re-presents in the Ohbox through the race", async () => {
    const r = await rig(rule("r-allow", "INBOX" as Folder, "promoted"));
    await arriveAndOpen(r);
    const v = windowFor(r);
    const { sender, plan, forecast } = pressPlan(r, true);
    const timeline: string[] = [];
    const look = (at: string) => { if (v.inOhbox().includes(SEED)) timeline.push(at); };

    // The press through the one door, the move's answer held back (a slow network).
    r.holdMoves = true;
    const [seedMove, ...rest] = movesAtLanding(plan, forecast, "keep");
    expect(seedMove, "the press moves the letter it was made on").toEqual({ kind: "move", messageId: SEED, folder: RECEIPTS, pressRule: true });
    expect(rest, "and nothing else").toEqual([]);
    const inverses = inverseMutations(r.engine.verbRead(), seedMove!);
    const moved = r.engine.mutate(seedMove!);
    v.w.open(intentOf(sender, forecast.keep.landing.filter((id) => id !== SEED), true));
    look("press");
    expect(r.engine.openRowHeld(), "the move named the held row, so the hold ended").toBeNull();

    // The server's own update of the just-arrived letter (its read flag) lands mid-flight, at INBOX.
    r.queueSync([{
      type: "message", op: "update", id: SEED, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: { ...msg(SEED, "INBOX", "2026-10-23T12:27:00.000Z", false) },
    }]);
    const staleSeq = seq;
    await r.engine.syncOnce();
    look("racing-sync");

    v.timers.shift()!();
    await tick();
    look("window-close");

    await r.release();
    await moved;
    await tick();
    look("move-echo");
    expect(r.sent.map((m) => m.kind)).toEqual(expect.arrayContaining(["move", "rule_update"]));
    expect(rulesList(r.engine.read()).find((x) => x.id === "r-allow")!.destination).toBe(RECEIPTS);

    // A stale replay of the older update (a retried /sync page) changes nothing.
    r.queueSync([{
      type: "message", op: "update", id: SEED, seq: staleSeq, updatedAt: NOW.toISOString(),
      entity: { ...msg(SEED, "INBOX", "2026-10-23T12:27:00.000Z", false) },
    }]);
    await r.engine.syncOnce();
    look("stale-replay");

    expect(timeline, "moments at which the filed letter stood in the Ohbox").toEqual([]);
    expect(v.atReceipts()).toContain(SEED);
    expect(inverses.map((m) => m.kind), "Undo has a wire inverse for the letter").toContain("move");
  });
});

import { describe, expect, it } from "vitest";
import {
  LANDING_HOLD_MS,
  MemoryMirrorStore,
  OhmailEngine,
  consentPartition,
  createLandingHold,
  presentAt,
  pressForecast,
  retroPassWouldMove,
  retroWalkWouldMove,
  type EngineAdapter,
  type EngineMessage,
  type EntityReader,
  type Folder,
  type MutationOutcome,
  type PressInput,
  type RuleDTO,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * THE PRESS FILES THE LETTER IT WAS MADE ON (RULE-FILED-MESSAGE-SNAPS-BACK-TO-OHBOX). A sheet press
 * that writes a rule moved nothing itself, so the letter being read was back in the Ohbox once the
 * routing window closed. The forecast now carries the seed's own move on either switch position,
 * unless the router files it elsewhere; the rest of a rule's backlog stays the walk's, read by the
 * walk's own predicate (a decided place is never a rule's to move).
 */
const NOW = new Date("2026-10-23T12:30:00.000Z");
const ADDR = "notice@host.example";
const RECEIPTS = "ohmail/Receipts" as Folder;

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T08:00:00.000Z", updatedAt: "2026-08-01T08:00:00.000Z", ...o,
  } as RuleDTO;
}

function mail(id: string, o: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "A new sign-in", from: { name: "Host", address: ADDR }, to: [], cc: [],
    date: "2026-10-23T12:27:00.000Z", folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-23T12:27:00.000Z", ...o,
  } as EngineMessage;
}

async function engineOf(rules: RuleDTO[], messages: EngineMessage[]): Promise<OhmailEngine> {
  let served = false;
  const adapter: EngineAdapter = {
    async sync(): Promise<SyncResponse> {
      let seq = 0;
      const creates = served ? [] : [
        ...rules.map((r) => ({ type: "rule" as const, op: "create" as const, id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
        ...messages.map((m) => ({ type: "message" as const, op: "create" as const, id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
      ];
      served = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "9", hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: () => new Promise<MutationOutcome>(() => {}),
    async withdrawSend() { return { outcome: "unsupported" as const }; },
    async fetchBody() { return null; },
  };
  const engine = new OhmailEngine({ adapter, now: () => NOW });
  await engine.start();
  return engine;
}

function inputOf(engine: OhmailEngine, o: Partial<PressInput> = {}): PressInput {
  const reader = engine.verbRead();
  return {
    reader, options: { now: NOW }, subject: reader.list<EngineMessage>("message").filter((m) => m.from.address === ADDR),
    scope: "sender", match: ADDR, wanted: RECEIPTS, makeRule: true, applyRetro: true, now: NOW, seedId: "seed", ...o,
  };
}

describe("the seed's own move", () => {
  it("is made on either switch position; with the switch off nothing else lands (D)", async () => {
    for (const applyRetro of [true, false]) {
      const engine = await engineOf([rule({ id: "allow", destination: "INBOX", provenance: "promoted" })], [mail("seed"), mail("older")]);
      const f = pressForecast(inputOf(engine, { applyRetro }));
      expect(f.keep.seedMove, `switch ${applyRetro}`).toEqual({ kind: "move", messageId: "seed", folder: RECEIPTS, pressRule: true });
      expect(f.keep.landing).toContain("seed");
      expect(f.keep.moves.map((m) => m.messageId), "the seed is not the walk's").not.toContain("seed");
      expect(f.keep.landing.includes("older"), `switch ${applyRetro}`).toBe(applyRetro);
      // CONTROL: without a seed the switch-off forecast lands nothing — the defect.
      if (!applyRetro) expect(pressForecast(inputOf(engine, { applyRetro, seedId: undefined })).keep.landing).toEqual([]);
    }
  });

  it("a kept term rule keeps it; removing the rule moves it", async () => {
    const term = rule({ id: "term", destination: "ohmail/News", subjectContains: "sign-in" });
    const engine = await engineOf([term], [mail("seed", { folder: "ohmail/News" })]);
    const f = pressForecast(inputOf(engine));
    expect(f.groups.map((g) => g.rule.id)).toEqual(["term"]);
    expect(f.keep.seedMove).toBeNull();
    expect(f.keep.landing).not.toContain("seed");
    expect(f.remove.seedMove).toEqual({ kind: "move", messageId: "seed", folder: RECEIPTS, pressRule: true });
  });

  it("a domain rule the address press does not outrank keeps it", async () => {
    const wide = rule({ id: "dom", kind: "domain", match: "host.example", destination: "ohmail/Screened", priority: 9 });
    const engine = await engineOf([wide], [mail("seed")]);
    // Lifted to the domain rule's priority, the address press outranks it: the seed moves.
    expect(pressForecast(inputOf(engine)).keep.seedMove?.messageId).toBe("seed");
  });

  it("is none for a recipient chip's subject, a seed already at the place, and a seed in the decide's bag", async () => {
    const engine = await engineOf([rule({ id: "allow", destination: "INBOX" })], [
      mail("seed"), mail("filed", { folder: RECEIPTS }), mail("held", { folder: "ohmail/Screener" }),
    ]);
    expect(pressForecast(inputOf(engine, { subject: [] })).keep.seedMove, "a chip's subject").toBeNull();
    expect(pressForecast(inputOf(engine, { seedId: "filed" })).keep.seedMove, "already there").toBeNull();
    const decide = { kind: "screener_decide", senderId: "held", decision: "yes", scope: "sender", dest: "receipts", applyRetro: true } as const;
    expect(pressForecast(inputOf(engine, { decide, seedId: "held" })).keep.seedMove, "the decide's bag").toBeNull();
  });

  it("under a decide, a letter outside its bag moves after the decision, from the folder it was pressed in", async () => {
    // The answer the gate admitted stands in the Ohbox, decided; a newer letter of theirs waits.
    const engine = await engineOf([], [mail("seed", { placeDecided: true }), mail("held", { folder: "ohmail/Screener" })]);
    const decide = { kind: "screener_decide", senderId: "held", decision: "yes", scope: "sender", dest: "receipts", applyRetro: false } as const;
    for (const makeRule of [true, false]) {
      const f = pressForecast(inputOf(engine, { decide, makeRule, applyRetro: false }));
      expect(f.keep.seedMove, `makeRule ${makeRule}`).toEqual({ kind: "move", messageId: "seed", folder: RECEIPTS, from: "INBOX", pressRule: true });
      expect(f.keep.landing).toContain("seed");
    }
  });

  it("a decided seed still moves; a decided backlog row is the walk's to leave", async () => {
    const engine = await engineOf([rule({ id: "allow", destination: "INBOX", provenance: "promoted" })], [
      mail("seed", { placeDecided: true }), mail("decided", { placeDecided: true }), mail("open"),
    ]);
    const f = pressForecast(inputOf(engine));
    expect(f.keep.seedMove?.messageId).toBe("seed");
    expect(f.keep.moves.map((m) => m.messageId)).toEqual(["open"]);
    expect(f.keep.landing.sort()).toEqual(["open", "seed"]);
  });

  it("a move-only press keeps the instruction's predicate: a decided row moves", async () => {
    const engine = await engineOf([], [mail("seed"), mail("decided", { placeDecided: true })]);
    const f = pressForecast(inputOf(engine, { makeRule: false, applyRetro: false }));
    expect(f.keep.moves.map((m) => m.messageId)).toEqual(["decided"]);
    // No rule is written, so the move is an ordinary one: it may teach the route.
    expect(f.keep.seedMove).toEqual({ kind: "move", messageId: "seed", folder: "ohmail/Receipts" });
  });
});

describe("the walk's predicate reads clause 7 the walk's way", () => {
  it("a decided INBOX row is out, a decided row at the gate is in; the pass predicate is unchanged", () => {
    expect(retroWalkWouldMove({ folder: "INBOX", placeDecided: true }, RECEIPTS)).toBe(false);
    expect(retroWalkWouldMove({ folder: "ohmail/Screener", placeDecided: true }, RECEIPTS)).toBe(true);
    expect(retroWalkWouldMove({ folder: "INBOX" }, RECEIPTS)).toBe(true);
    expect(retroPassWouldMove({ folder: "INBOX", placeDecided: true }, RECEIPTS)).toBe(true);
    expect(retroWalkWouldMove({ folder: "INBOX", triage: { state: "set_aside" } }, RECEIPTS)).toBe(false);
  });
});

async function readerOf(messages: EngineMessage[], rules: RuleDTO[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as unknown as SyncChange[]);
  return store;
}

const update = async (store: MemoryMirrorStore, type: string, id: string, entity: unknown, seq: number) =>
  store.applyChanges([{ type, op: "update", id, seq, updatedAt: NOW.toISOString(), entity }] as unknown as SyncChange[]);

describe("the landing hold", () => {
  const at = NOW.getTime();
  const entry = (pressId = "p1", subject = "s") => ({
    pressId, subject, place: RECEIPTS, at, rows: [{ id: "a", from: "INBOX" }, { id: "b", from: "INBOX" }],
  });
  const applying = rule({ id: "r1", destination: RECEIPTS, retro: { requestedAt: NOW.toISOString(), doneAt: null } } as never);

  it("holds its rows until each is filed or moved, and until the walk reads done", async () => {
    const store = await readerOf([mail("a"), mail("b")], [applying]);
    const hold = createLandingHold();
    hold.hold(entry());
    expect([...hold.placesFor(store, at).places.keys()].sort()).toEqual(["a", "b"]);
    hold.settle("p1", { worst: "confirmed", ruleIds: ["r1"] });
    expect(hold.placesFor(store, at + 1000).places.size, "the walk is still applying").toBe(2);
    await update(store, "message", "a", mail("a", { folder: RECEIPTS }), 50);
    expect([...hold.placesFor(store, at + 2000).places.keys()], "a row filed since leaves").toEqual(["b"]);
    await update(store, "rule", "r1", { ...applying, retro: { requestedAt: NOW.toISOString(), doneAt: NOW.toISOString() } }, 51);
    expect(hold.placesFor(store, at + 3000).places.size, "the walk read done").toBe(0);
    expect(hold.size()).toBe(0);
  });

  it("a refused, deferred or replaced write, Undo, a newer press and the TTL each end it", async () => {
    const store = await readerOf([mail("a"), mail("b")], [applying]);
    for (const worst of ["rolled_back", "awaiting_organizer", "superseded"] as const) {
      const hold = createLandingHold();
      hold.hold(entry());
      hold.settle("p1", { worst, ruleIds: ["r1"] });
      expect(hold.size(), worst).toBe(0);
    }
    const hold = createLandingHold();
    hold.hold(entry());
    hold.drop("s");
    expect(hold.size(), "undone").toBe(0);
    hold.hold(entry("p1"));
    hold.hold({ ...entry("p2"), rows: [{ id: "b", from: "INBOX" }] });
    expect([...hold.placesFor(store, at).places.keys()], "a newer press replaced it").toEqual(["b"]);
    hold.settle("p2", { worst: "queued", ruleIds: null });
    expect(hold.placesFor(store, at + LANDING_HOLD_MS - 1).places.size, "a queued write is kept").toBe(1);
    expect(hold.placesFor(store, at + LANDING_HOLD_MS + 1).places.size, "until the TTL").toBe(0);
  });

  it("a rule that went, or no longer files at the place, ends it; an older server's rule keeps it to the TTL", async () => {
    const elsewhere = rule({ id: "r1", destination: "ohmail/News", retro: { requestedAt: NOW.toISOString(), doneAt: null } } as never);
    const old = rule({ id: "r2", destination: RECEIPTS });
    const store = await readerOf([mail("a"), mail("b")], [elsewhere, old]);
    for (const [ids, size] of [[["r1"], 0], [["gone"], 0], [["r2"], 2], [[], 0]] as const) {
      const hold = createLandingHold();
      hold.hold(entry());
      hold.settle("p1", { worst: "confirmed", ruleIds: ids });
      expect(hold.placesFor(store, at).places.size, JSON.stringify(ids)).toBe(size);
    }
  });

  it("presentAt never re-places a row whose folder changed since the press", async () => {
    const store: EntityReader = await readerOf([mail("a"), mail("b", { folder: "ohmail/News" })]);
    const places = new Map<string, Folder>([["a", RECEIPTS], ["b", RECEIPTS]]);
    const from = new Map([["a", "INBOX"], ["b", "INBOX"]]);
    const shown = presentAt(store, places, from);
    expect(shown.get<EngineMessage>("message", "a")!.folder).toBe(RECEIPTS);
    expect(shown.get<EngineMessage>("message", "b")!.folder, "moved since: shown where it is").toBe("ohmail/News");
    expect(presentAt(store, places).get<EngineMessage>("message", "b")!.folder, "CONTROL: no from-guard").toBe(RECEIPTS);
    expect(consentPartition(shown, { now: NOW }).placeOf.get("a")).toBe(RECEIPTS);
  });
});

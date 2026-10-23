/**
 * A MOVE KILLED INSIDE ITS UNDO WINDOW IS MADE AT THE NEXT LAUNCH, AND THE LAUNCH SAYS SO — the
 * real press, engine and wire, the device sqlite outliving the process. Each launch is a fresh
 * module graph over the same disk, the kill is every timer cleared with nothing flushed, and the
 * session is opened as `world.tsx` opens it. A Move whose sender no rule places holds its press for
 * the window and no rule; its letter moved at the press, so its launch has nothing to finish.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, ROUTING_JOURNAL_TYPE, type RoutingIntent, type RuleDTO, type SyncChange } from "@ohmail/client-engine";
import { refuse, sayArg } from "../src/refusal";
import type { MobileEngineDeps } from "../src/engine/boot";
import { planHeldRouting, type WorldView } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const MARA = { name: "Mara Lindqvist", address: "mara@fake.test" };
const SAID = "Moved 1 message to News that was waiting when ohmail closed.";

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

/** Let sqlite writes and HTTP answers settle — `setImmediate` is not faked. */
const settle = async (n = 40): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

async function server(rules: RuleDTO[]) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  for (const r of rules) fake.addRule(r);
  fake.addMessage(dto("m1", { subject: "Plain note", from: MARA }));
  return { fake, origin };
}

let uuids = 0;

/** One launch of the app over `disk`: a fresh module graph, the engine booted, the session opened. */
async function launch(disk: ReturnType<typeof sqlWorld>, origin: string) {
  vi.resetModules();
  const { bootEngine } = await import("../src/engine/boot");
  const binding = await import("../src/state/held-routing");
  const live = await import("../src/state/live");
  const deps: MobileEngineDeps = {
    openExecutor: disk.open, deleteDatabase: disk.drop,
    uuid: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`,
  };
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  /* The launch's first sentence, as an event: the session says it once its dispatch has answered. */
  let heard: (s: string) => void = () => undefined;
  const firstSaid = new Promise<string>((resolve) => { heard = resolve; });
  const toast = (m: Parameters<typeof sayArg>[0]) => { said.push(sayArg(m)); heard(sayArg(m)); };
  const engine = boot.engine;
  /* `world.tsx`'s session, as the app opens it. */
  binding.openRoutingSession({
    windowMs: live.UNDO_MS,
    journal: boot.store,
    plan: (intent) => live.planHeldRouting(engine.read(), intent, (changed) => binding.noteScreenChanged(intent.id, changed)),
    dispatch: (mutations, intent) => live.dispatchHeldRouting(engine, mutations, intent, {
      answered: (answers) => binding.answerScreenPress(intent.id, mutations, answers),
      refused: () => toast(refuse("liveSaveFailed")),
    }),
    reverse: (mutations, intent) => (intent.v === 1 ? live.routingReversal(() => engine.read(), mutations) : null),
    onReplayed: (replay) => { for (const say of live.sayRoutingReplay(replay)) toast(say); },
  });
  const actions = live.liveActions({ engine, uuid: deps.uuid, zone: "UTC", toast: (m) => toast(m) });
  const row = () => {
    const m = live.liveMessage(engine, "m1", view);
    if (!m) throw new Error("no row for m1");
    return m;
  };
  const journal = () => boot.store.entries<{ value: string }>(ROUTING_JOURNAL_TYPE)
    .flatMap((e) => JSON.parse(e.entity.value) as unknown[]);
  return { actions, row, said, firstSaid, journal, close: () => { boot.store.close(); } };
}

/** The kill, then the next process: its own clock, real timers from here on. */
const kill = (): void => { vi.clearAllTimers(); vi.useRealTimers(); };

const writes = (fake: ReturnType<typeof mailServer>, prefix: string) =>
  fake.seen.filter((r) => r.url.startsWith(prefix) && r.method !== "GET").map((r) => `${r.method} ${r.url}`);

describe("a Move killed inside its window", () => {
  it("is made at the next launch, once, and the launch says so once", async () => {
    const { fake, origin } = await server([ruleDto("r-mara", "sender", MARA.address, "INBOX")]);
    const disk = sqlWorld();
    try {
      const first = await launch(disk, origin);
      expect(await first.actions.move(first.row(), "reads")).toBe(true);
      await settle();
      expect(writes(fake, "/rules"), "the rule left inside the undo window").toEqual([]);
      kill();

      const next = await launch(disk, origin);
      await next.firstSaid;
      expect(writes(fake, "/rules"), "the press was not made at the launch, or made twice").toEqual(["PATCH /rules/r-mara"]);
      expect(next.said, "the launch did not say it once").toEqual([SAID]);
      next.close();
    } finally { fake.server.close(); }
  }, 60_000);

  it("killed while the letter's move is still on the wire, keeps its rule and says so at the launch", async () => {
    const { fake, origin } = await server([ruleDto("r-mara", "sender", MARA.address, "INBOX")]);
    const disk = sqlWorld();
    try {
      const first = await launch(disk, origin);
      fake.holdNext("POST", "/messages/m1/move");
      void first.actions.move(first.row(), "reads");
      await settle();
      expect(first.said, "the press answered before its letter moved").toEqual([]);
      kill();

      const next = await launch(disk, origin);
      await next.firstSaid;
      expect(writes(fake, "/rules"), "the kill took the press's rule with it").toEqual(["PATCH /rules/r-mara"]);
      expect(next.said, "the launch did not say it once").toEqual([SAID]);
      next.close();
    } finally { fake.server.close(); }
  }, 60_000);

  it("from the sender sheet, its rule is made at the next launch; the letter moved at the press, so the launch is quiet", async () => {
    const { fake, origin } = await server([ruleDto("r-mara", "sender", MARA.address, "INBOX")]);
    const disk = sqlWorld();
    try {
      const first = await launch(disk, origin);
      expect(await first.actions.screenSender("m1", "reads", "sender")).toBe(true);
      await settle();
      expect(writes(fake, "/rules"), "the rule left inside the undo window").toEqual([]);
      expect(writes(fake, "/messages/m1/move"), "the letter did not move at the press").toEqual(["POST /messages/m1/move"]);
      kill();

      const next = await launch(disk, origin);
      for (let i = 0; i < 200 && writes(fake, "/rules").length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      await settle();
      expect(writes(fake, "/rules"), "the sheet's press was not made once").toHaveLength(1);
      expect(writes(fake, "/messages/m1/move"), "the launch moved the letter again").toHaveLength(1);
      expect(next.said, "the launch finished a press whose letter had already moved").toEqual([]);
      next.close();
    } finally { fake.server.close(); }
  }, 60_000);

  it("refused by the server at the launch says the refusal, never that it moved", async () => {
    const { fake, origin } = await server([ruleDto("r-mara", "sender", MARA.address, "INBOX")]);
    const disk = sqlWorld();
    try {
      const first = await launch(disk, origin);
      await first.actions.move(first.row(), "reads");
      await settle();
      kill();

      fake.failNext("PATCH", "/rules/");
      const next = await launch(disk, origin);
      await next.firstSaid;
      expect(next.said).toEqual(["That change could not be saved. Try it again."]);
      next.close();
    } finally { fake.server.close(); }
  }, 60_000);

  it("with no rule placing its sender, holds no rule: the letter moved at the press, the launch is quiet", async () => {
    const { fake, origin } = await server([]);
    const disk = sqlWorld();
    try {
      const first = await launch(disk, origin);
      expect(await first.actions.move(first.row(), "reads")).toBe(true);
      await settle();
      expect(first.said).toEqual(["Moved to News."]);
      expect(writes(fake, "/messages/m1/move"), "the letter did not move at the press").toEqual(["POST /messages/m1/move"]);
      kill();

      expect(first.journal(), "the press was not held for its window").toHaveLength(1);
      const next = await launch(disk, origin);
      await settle();
      expect(writes(fake, "/rules"), "a Move with no rule to decide wrote one").toEqual([]);
      expect(writes(fake, "/messages/m1/move"), "the launch moved the letter again").toHaveLength(1);
      expect(next.said, "the launch finished a press nothing held").toEqual([]);
      next.close();
    } finally { fake.server.close(); }
  }, 60_000);
});

describe("the launch's re-plan of a Move", () => {
  const ISO = "2026-08-19T08:00:00Z";
  async function mirror(folder: string) {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([
      { type: "message", op: "create", id: "m1", seq: 1, updatedAt: ISO, entity: dto("m1", { subject: "Plain note", from: MARA, folder }) },
      { type: "rule", op: "create", id: "r-mara", seq: 2, updatedAt: ISO, entity: ruleDto("r-mara", "sender", MARA.address, "INBOX") },
    ] as SyncChange[]);
    return store;
  }
  const intent: RoutingIntent = {
    v: 1, id: "p1", seedId: "m1", address: MARA.address, scope: "sender", dest: "reads",
    messageIds: ["m1"], from: "INBOX", at: 1,
  };

  it("moves the letter with its rule when a kill came before the letter was sent", async () => {
    expect(planHeldRouting(await mirror("INBOX"), intent).map((m) => m.kind)).toEqual(["rule_update", "move"]);
  });

  it("never moves a letter twice: one already at the place is left there", async () => {
    expect(planHeldRouting(await mirror("ohmail/News"), intent).map((m) => m.kind)).toEqual(["rule_update"]);
  });
});

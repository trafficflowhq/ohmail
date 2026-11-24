/**
 * A MOVE ON A PAIRED PHONE IS KEPT FROM THE FIRST FRAME THAT SHOWS IT — the paired composition (the
 * real engine, its HTTP adapter against a fake origin) over a device disk: the app's own serial
 * lane, one statement per turn, and a kill that rolls back what was open and answers nothing more.
 * The kill lands at the first frame that shows the Move; the next launch makes it once, under ONE
 * Idempotency-Key, and says so once. A replay the server refuses says the refusal.
 */
import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refuse, sayArg } from "../src/refusal";
import type { MobileEngineDeps } from "../src/engine/boot";
import type { ToastOpts, WorldView } from "../src/state/live";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { deviceDisk } from "./helpers/device-disk";

const view: WorldView = { now: new Date("2026-08-19T12:00:00Z"), zone: "UTC" };
const MARA = { name: "Mara Lindqvist", address: "mara@fake.test" };
const SAID = "Moved 1 message to News that was waiting when ohmail closed.";
const REFUSED = "That change could not be saved. Try it again.";
const MOVE = /^\/messages\/m1\/move$/;

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
/** The first process's clock stops once it has booted, so no window closes before the kill. */
const holdTheClock = (): void => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); };

const settle = async (n = 40): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

async function server(rules: RuleDTO[]) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  for (const r of rules) fake.addRule(r);
  fake.addMessage(dto("m1", { subject: "Plain note", from: MARA, unread: false }));
  return { fake, origin };
}
const MARA_RULE = () => [ruleDto("r-mara", "sender", MARA.address, "INBOX")];

let uuids = 0;

/** One launch over `disk`: a fresh module graph, a process whose wire dies with it, `world.tsx`'s session. */
async function launch(disk: ReturnType<typeof deviceDisk>, origin: string, opts: { unsentMove?: boolean } = {}) {
  vi.resetModules();
  const { bootEngine } = await import("../src/engine/boot");
  const { serialSqlExecutor } = await import("../src/engine/sql-queue");
  const binding = await import("../src/state/held-routing");
  const live = await import("../src/state/live");
  const log = await import("../src/engine/engine-log");
  let dead = false;
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    if (dead) return never();
    if (opts.unsentMove && init?.method === "POST" && /\/messages\/[^/]+\/move$/.test(url)) return never();
    return globalThis.fetch(url, init).then((r) => (dead ? never<Response>() : r));
  };
  const files = disk.opener(serialSqlExecutor);
  const deps: MobileEngineDeps = {
    openExecutor: files.open, deleteDatabase: files.drop, fetch,
    uuid: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`,
  };
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const engine = boot.engine;
  const said: string[] = [];
  const undos: Array<() => void> = [];
  const toast = (m: Parameters<typeof sayArg>[0], o?: ToastOpts) => {
    said.push(sayArg(m));
    if (o?.undo) undos.push(o.undo);
  };
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
  const actions = live.liveActions({ engine, uuid: deps.uuid, zone: "UTC", toast });
  /* `world.tsx`'s reconnect flush, as the app runs it once the session is up. */
  await live.flushQueued(engine, actions.releaseConfirmed).then((settled) => {
    for (const [, o] of settled) if (o.status === "rolled_back") toast(refuse("liveSaveFailed"));
  });
  const row = (id = "m1") => {
    const m = live.liveMessage(engine, id, view);
    if (!m) throw new Error(`no row for ${id}`);
    return m;
  };
  /** Did the held places ever show m1 — what only a press that holds a rule may do. */
  let placed = false;
  binding.subscribeRoutingPlaces(() => { if (binding.routingPlaces().has("m1")) placed = true; });
  /** Does any frame show m1 at News — its own row, or the held press's place? */
  const shown = () => engine.read().get<{ folder: string }>("message", "m1")?.folder === "ohmail/News"
    || binding.routingPlaces().get("m1") === "ohmail/News";
  /** Where the phone shows m1 now. */
  const shownIn = () => engine.read().get<{ folder: string }>("message", "m1")?.folder ?? null;
  /** The launch's own log line, as a device run reads it. */
  const replayLines = () => log.recentEngineLines().filter((l) => l.includes('"event":"launch_replay"'));
  return { actions, row, said, undos, shown, shownIn, placed: () => placed, replayLines, flushRouting: binding.flushRouting, die: () => { dead = true; } };
}

/** The process dies: its wire, its disk, its timers. The next process has its own clock. */
function kill(first: { die: () => void }, disk: ReturnType<typeof deviceDisk>): void {
  first.die(); disk.kill(); vi.clearAllTimers(); vi.useRealTimers();
}

const posts = (fake: ReturnType<typeof mailServer>, re: RegExp) =>
  fake.seen.filter((r) => re.test(r.url) && r.method !== "GET");

/**
 * THE WIRE HAS GONE QUIET: no write for `quietMs` of real time, bounded. A request can take seconds
 * to reach this fake while the clock is held, so an assertion that nothing more was sent waits here.
 */
async function wireQuiet(fake: ReturnType<typeof mailServer>, quietMs = 4500, boundMs = 15_000): Promise<void> {
  const start = Date.now();
  let seen = posts(fake, /./).length;
  let since = Date.now();
  while (Date.now() - start < boundMs && Date.now() - since < quietMs) {
    await settle(5);
    const now = posts(fake, /./).length;
    if (now !== seen) { seen = now; since = Date.now(); }
  }
}

/** The next launch has settled its replay and its flush — real timers, a real wire. */
async function landed(): Promise<void> {
  await settle();
  await new Promise((r) => setTimeout(r, 30));
  await settle();
}

describe("a paired Move killed at the first frame that shows it", () => {
  for (const shape of [
    { name: "that decides no rule", rules: () => [] as RuleDTO[], patches: [] as string[], place: false },
    { name: "that decides the sender's rule", rules: MARA_RULE, patches: ["PATCH /rules/r-mara"], place: true },
  ]) {
    it(`${shape.name} is made at the next launch once, and said once`, async () => {
      const { fake, origin } = await server(shape.rules());
      const disk = deviceDisk();
      try {
        const first = await launch(disk, origin);
      holdTheClock();
        holdTheClock();
        disk.slow();
        void first.actions.move(first.row(), "reads");
        await settle(10);
        for (let i = 0; i < 60 && !first.shown(); i++) { disk.step(); await settle(10); }
        expect(first.shown(), "the press never showed").toBe(true);
        expect(first.placed(), "the letter was drawn by the wrong door").toBe(shape.place);
        kill(first, disk);

        const next = await launch(disk, origin);
        await landed();
        expect(fake.message("m1")?.folder, "the Move shown before the kill was lost").toBe("ohmail/News");
        expect(posts(fake, /^\/rules/).map((r) => `${r.method} ${r.url}`)).toEqual(shape.patches);
        const keys = new Set(posts(fake, MOVE).map((r) => r.key));
        expect(keys.size, "the letter's move went under more than one key").toBe(1);
        expect(next.said, "the launch did not say it once").toEqual([SAID]);
        expect(next.replayLines().map((l) => JSON.parse(l) as object))
          .toEqual([{ service: "app", event: "launch_replay", made: 1, refused: 0, expired: 0, said: 1 }]);
      } finally { fake.server.close(); }
    }, 60_000);
  }
});

describe("a paired Move whose letter's move never left before the kill", () => {
  it("is made at the next launch under the press's own key, and said once", async () => {
    const { fake, origin } = await server([]);
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin, { unsentMove: true });
      holdTheClock();
      void first.actions.move(first.row(), "reads");
      await settle();
      kill(first, disk);

      const next = await launch(disk, origin);
      await landed();
      expect(fake.message("m1")?.folder).toBe("ohmail/News");
      expect(posts(fake, MOVE), "the launch made the letter's move other than once").toHaveLength(1);
      expect(next.said, "the launch made the Move and said nothing").toEqual([SAID]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("refused by the server at the launch, says the refusal and never that it moved", async () => {
    const { fake, origin } = await server([]);
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin, { unsentMove: true });
      holdTheClock();
      void first.actions.move(first.row(), "reads");
      await settle();
      kill(first, disk);

      fake.failNext("POST", "/messages/m1/move");
      const next = await launch(disk, origin);
      await landed();
      expect(fake.message("m1")?.folder).toBe("INBOX");
      expect(next.said).toEqual([REFUSED]);
    } finally { fake.server.close(); }
  }, 60_000);
});

describe("a paired Move that was already made", () => {
  it("killed inside its window after the letter moved, the launch is quiet and sends nothing", async () => {
    const { fake, origin } = await server([]);
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      holdTheClock();
      expect(await first.actions.move(first.row(), "reads")).toBe(true);
      await settle();
      expect(first.said).toEqual(["Moved to News."]);
      kill(first, disk);

      const next = await launch(disk, origin);
      await landed();
      await wireQuiet(fake);
      expect(posts(fake, MOVE), "a Move already made was sent again").toHaveLength(1);
      expect(next.said, "the launch spoke for a Move nothing was waiting on").toEqual([]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("that reached the server and lost its answer to the kill, is not sent again at the launch", async () => {
    const { fake, origin } = await server([]);
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      holdTheClock();
      fake.holdNext("POST", "/messages/m1/move");
      void first.actions.move(first.row(), "reads");
      const t0 = Date.now();
      while (posts(fake, MOVE).length === 0 && Date.now() - t0 < 10_000) await settle(5);
      expect(posts(fake, MOVE), "the letter's move never reached the server").toHaveLength(1);
      kill(first, disk);

      const next = await launch(disk, origin);
      await landed();
      await wireQuiet(fake);
      expect(fake.message("m1")?.folder).toBe("ohmail/News");
      expect(posts(fake, MOVE), "a Move the server had already made was sent again").toHaveLength(1);
      expect(next.said, "the launch spoke for a Move nothing was waiting on").toEqual([]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("sent from its window by the app leaving while its record landed, is sent once and said as moved", async () => {
    const { fake, origin } = await server([]);
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      holdTheClock();
      disk.slow();
      const pressed = first.actions.move(first.row(), "reads");
      await settle(10);
      first.flushRouting();
      disk.release();
      expect(await pressed).toBe(true);
      await wireQuiet(fake);
      expect(fake.message("m1")?.folder).toBe("ohmail/News");
      expect(posts(fake, MOVE), "the letter's move was sent twice").toHaveLength(1);
      expect(first.said, "the press refused a Move that was made").toEqual(["Moved to News."]);
    } finally { fake.server.close(); }
  }, 60_000);

  it("taken back inside its window, stays taken back when the window closes", async () => {
    const { fake, origin } = await server([]);
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      holdTheClock();
      await first.actions.move(first.row(), "reads");
      await settle();
      expect(first.undos).toHaveLength(1);
      first.undos[0]!();
      await wireQuiet(fake);
      await vi.advanceTimersByTimeAsync(20_000);
      await wireQuiet(fake);
      expect(first.shownIn(), "the window's close put the letter back where the Undo took it from").toBe("INBOX");
      expect(fake.message("m1")?.folder, "the window's close made the Move again").toBe("INBOX");
      expect(posts(fake, MOVE).map((r) => JSON.parse(r.body).folder)).toEqual(["ohmail/News", "INBOX"]);
    } finally { fake.server.close(); }
  }, 60_000);
});

describe("a paired Move that decides no rule", () => {
  it("pressed while the sender's rule waits in its window, leaves that rule to be made", async () => {
    const { fake, origin } = await server(MARA_RULE());
    fake.addMessage(dto("m2", { subject: "Old receipt", from: MARA, unread: false, folder: "ohmail/Receipts" }));
    const disk = deviceDisk();
    try {
      const first = await launch(disk, origin);
      holdTheClock();
      await first.actions.move(first.row(), "reads");
      await first.actions.move(first.row("m2"), "screened");
      await settle();
      expect(posts(fake, /^\/rules/), "the rule left inside its window").toEqual([]);
      await vi.advanceTimersByTimeAsync(20_000);
      await wireQuiet(fake);
      expect(posts(fake, /^\/rules/).map((r) => `${r.method} ${r.url}`), "the held rule was dropped by a Move that decided none")
        .toEqual(["PATCH /rules/r-mara"]);
    } finally { fake.server.close(); }
  }, 60_000);
});

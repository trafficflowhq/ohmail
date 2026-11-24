/**
 * A MOVE PRESSED INSIDE ITS UNDO WINDOW SURVIVES A KILL. The rule half of a Move is held for the
 * window; the journal holding it used to live in memory, so a force-stop lost the press while the
 * pill had said "Moved". Each launch below is a fresh module graph over the same device sqlite
 * (a new process), the kill is every timer cleared with nothing closed, and the reading is the
 * dispatch seam, the journal row on disk and the sentence the next launch says.
 */
import type { EngineMutation } from "@ohmail/wire";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROUTING_INTENT_TTL_MS,
  ROUTING_JOURNAL_TYPE,
  SqlMirrorStore,
  routingSubject,
  type DecideIntent,
  type RoutingIntent,
  type ScreenIntent,
  type SqlExecutor,
  type SqlRow,
  type SqlValue,
} from "@ohmail/client-engine";
import { sayRefusal } from "../src/refusal";
import { routingReplaySay } from "../src/state/live";
import type { RoutingJournal, RoutingReplay } from "../src/state/held-routing";

/* node:sqlite behind the statement-runner seam — `engine-boot.test.ts`'s own shape, duplicated because a
   test may not import across workspace test trees. */
const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function nodeSqlExecutor(db: DatabaseSync): SqlExecutor {
  return {
    async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    async batch(statements): Promise<void> {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

/** The device's disk: one sqlite database per name, outliving every process that opens it. */
function device() {
  const dbs = new Map<string, DatabaseSync>();
  return {
    open: (name: string): SqlExecutor => {
      let db = dbs.get(name);
      if (!db) { db = new sqlite.DatabaseSync(":memory:"); dbs.set(name, db); }
      return nodeSqlExecutor(db);
    },
  };
}

const OWNER = "http://sidecar::acct-kill";
const RULE: EngineMutation = { kind: "rule_update", ruleId: "r1", destination: "ohmail/News" };
const AT = 1_000_000;
const WINDOW_MS = 8000;

function intent(over: Partial<RoutingIntent> = {}): RoutingIntent {
  return {
    v: 1, id: "p1", seedId: "m1", address: "a@b.test", scope: "sender",
    dest: "reads", messageIds: ["m1", "m2", "m3"], from: "INBOX", at: AT, ...over,
  };
}

/** Let the queued sqlite writes and the dispatch answers settle — `setImmediate` is not faked. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** One launch of the app: a fresh binding (its window dies with the process) over the device. */
async function launch(disk: ReturnType<typeof device>, now: number, answer: boolean | void = true) {
  vi.resetModules();
  const binding = await import("../src/state/held-routing");
  const store = new SqlMirrorStore({ owner: OWNER, open: disk.open });
  await store.load();
  const sent: EngineMutation[][] = [];
  const replays: RoutingReplay[] = [];
  binding.openRoutingSession({
    windowMs: WINDOW_MS,
    journal: store,
    now: () => now,
    plan: () => [RULE],
    dispatch: async (m) => { sent.push([...m]); return answer; },
    onReplayed: (r) => replays.push(r),
  });
  return { binding, store, sent, replays };
}

/** What a next boot finds on disk under the journal's type. */
async function journalOnDisk(disk: ReturnType<typeof device>): Promise<unknown[]> {
  const store = new SqlMirrorStore({ owner: OWNER, open: disk.open });
  await store.load();
  const rows = store.entries<{ value: string }>(ROUTING_JOURNAL_TYPE)
    .flatMap((e) => JSON.parse(e.entity.value) as unknown[]);
  store.close();
  return rows;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

/** The kill: the window's timer never fires and nothing is flushed or closed. */
const kill = (): void => { vi.clearAllTimers(); };

describe("a routing press killed inside its window", () => {
  it("is on disk before the press answers, and the next launch commits it and says so", async () => {
    const disk = device();
    const first = await launch(disk, AT);
    expect((await first.binding.holdRouting(intent())).held).toBe(true);
    expect(first.sent, "a rule went out inside the undo window").toEqual([]);
    expect(await journalOnDisk(disk), "the Undo was offered over a press only memory held").toHaveLength(1);
    kill();

    const next = await launch(disk, AT + 20_000);
    expect(next.sent, "the press the person made was not made at the next launch").toEqual([[RULE]]);
    await settle();
    expect(next.replays).toHaveLength(1);
    const said = next.replays.flatMap(routingReplaySay).map(sayRefusal);
    expect(said).toEqual(["Moved 3 messages to News that were waiting when ohmail closed."]);
    expect(await journalOnDisk(disk), "the committed press stayed to be committed again").toEqual([]);

    kill();
    const third = await launch(disk, AT + 40_000);
    expect(third.sent, "a second launch wrote the same rule a second time").toEqual([]);
    await settle();
    expect(third.replays).toEqual([]);
  });

  it("with its window still open at the kill, is committed at the launch too: its Undo died with the toast", async () => {
    const disk = device();
    const first = await launch(disk, AT);
    await first.binding.holdRouting(intent({ messageIds: ["m1"] }));
    kill();

    const next = await launch(disk, AT + 3_000);
    expect(next.sent, "a press was left holding with no Undo on screen").toEqual([[RULE]]);
    await settle();
    expect(next.replays.flatMap(routingReplaySay).map(sayRefusal))
      .toEqual(["Moved 1 message to News that was waiting when ohmail closed."]);
  });

  it("with its Undo on screen at the kill (the window restarted from the pill), is committed once", async () => {
    const disk = device();
    const first = await launch(disk, AT);
    await first.binding.holdRouting(intent({ messageIds: ["m1"] }));
    expect(first.binding.restartRouting(routingSubject(intent())), "the pill's clock found no window").toBe(true);
    kill();

    const next = await launch(disk, AT + 5_000);
    expect(next.sent, "the restarted press was not made at the launch").toEqual([[RULE]]);
    kill();
    const third = await launch(disk, AT + 30_000);
    expect(third.sent, "a second launch made the restarted press again").toEqual([]);
  });

  it("a sender-sheet press rides the same journal and is made at the launch", async () => {
    const disk = device();
    const first = await launch(disk, AT);
    const sheet: ScreenIntent = {
      v: 2, verb: "screen", id: "s1", seedId: "m1", address: "a@b.test", scope: "sender",
      dest: "receipts", messageIds: ["m1", "m2"], makeRule: true, applyRetro: true,
      resolution: "keep", shown: [], at: AT,
    };
    expect((await first.binding.holdScreenRouting(sheet, () => undefined)).held).toBe(true);
    kill();

    const next = await launch(disk, AT + 20_000);
    expect(next.sent, "the sheet's press was lost with its process").toEqual([[RULE]]);
    await settle();
    expect(next.replays.flatMap(routingReplaySay).map(sayRefusal))
      .toEqual(["Moved 2 messages to Receipts that were waiting when ohmail closed."]);
  });

  it("a Screener decision rides the same journal, in its own jar, and is made at the launch", async () => {
    const disk = device();
    const first = await launch(disk, AT);
    const decision: DecideIntent = {
      v: 3, verb: "decide", id: "d1", seedId: "m1", address: "a@b.test", scope: "domain",
      dest: "screened", read: false, messageIds: ["m1"], at: AT,
    };
    expect((await first.binding.holdScreenRouting(decision, () => undefined)).held).toBe(true);
    expect(await journalOnDisk(disk), "the decision's Undo was offered over memory alone").toEqual([decision]);
    kill();

    const next = await launch(disk, AT + 20_000);
    expect(next.sent, "the decision was lost with its process").toEqual([[RULE]]);
    await settle();
    expect(await journalOnDisk(disk)).toEqual([]);
  });

  it("taken back before the kill leaves nothing for the launch to make or say", async () => {
    const disk = device();
    const first = await launch(disk, AT);
    await first.binding.holdRouting(intent());
    expect(first.binding.undoRouting(routingSubject(intent()))).toBe(true);
    await settle();
    kill();

    const next = await launch(disk, AT + 20_000);
    expect(next.sent, "the launch made a press the person had undone").toEqual([]);
    await settle();
    expect(next.replays).toEqual([]);
  });

  it("past the journal's horizon is not made, and the launch says it was not", async () => {
    const disk = device();
    const first = await launch(disk, AT);
    await first.binding.holdRouting(intent());
    kill();

    const next = await launch(disk, AT + ROUTING_INTENT_TTL_MS + 1);
    expect(next.sent, "a day-old rule was written into an account that has moved on").toEqual([]);
    await settle();
    expect(next.replays.flatMap(routingReplaySay).map(sayRefusal)).toEqual([
      "1 filing rule was never made — too much time passed since you asked. File that mail again if you still want the rule.",
    ]);
  });

  it("refused by the server at the launch is not counted as moved", async () => {
    const disk = device();
    const first = await launch(disk, AT);
    await first.binding.holdRouting(intent());
    kill();

    const next = await launch(disk, AT + 20_000, false);
    expect(next.sent).toEqual([[RULE]]);
    await settle();
    expect(next.replays.map((r) => r.moved), "a refused rule was reported as a move").toEqual([[]]);
    expect(next.replays.map((r) => r.refused.length), "the launch did not count the refusal").toEqual([1]);
  });
});

describe("the Undo is offered only over a record on disk", () => {
  /** A journal whose writes wait for the test, so the order of answer and landing is observable. */
  function gatedJournal(): RoutingJournal & { land: (ok: boolean) => void } {
    const waiting: Array<(ok: boolean) => void> = [];
    return {
      get: () => undefined,
      commitLocal: () => new Promise<void>((resolve, reject) => {
        waiting.push((ok) => (ok ? resolve() : reject(new Error("disk full"))));
      }),
      land: (ok) => { for (const w of waiting.splice(0)) w(ok); },
    };
  }

  async function withJournal(journal: RoutingJournal) {
    vi.resetModules();
    const binding = await import("../src/state/held-routing");
    const sent: EngineMutation[][] = [];
    binding.openRoutingSession({
      windowMs: WINDOW_MS, journal, now: () => AT,
      plan: () => [RULE], dispatch: async (m) => { sent.push([...m]); },
    });
    return { binding, sent };
  }

  it("the press answers only once its record has landed", async () => {
    const journal = gatedJournal();
    const { binding } = await withJournal(journal);
    let answered = false;
    const held = binding.holdRouting(intent()).then((out) => { answered = true; return out; });
    await settle();
    expect(answered, "the press answered before its record reached the disk").toBe(false);
    journal.land(true);
    expect(await held).toEqual({ held: true, superseded: false, sent: false });
  });

  it("a record the disk refused takes the Undo away, and the caller sends the rules itself", async () => {
    const journal = gatedJournal();
    const { binding, sent } = await withJournal(journal);
    const held = binding.holdRouting(intent());
    await settle();
    journal.land(false);
    expect(await held, "an Undo was offered over a press a kill would lose")
      .toEqual({ held: false, superseded: false, sent: false });
    expect(binding.routingPlaces().size, "the refused press kept its overlay").toBe(0);
    binding.flushRouting();
    expect(sent, "the window sent a press it had handed back to the caller").toEqual([]);
  });
});

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { and, eq } from "drizzle-orm";
import {
  accounts, idempotencyKeys, messages, screenerAttemptKey, claimIdempotencyKey,
  eraseIdempotentResponses, releasePendingIdempotencyKey, IDEMPOTENCY_PENDING_STATUS,
  IDEMPOTENCY_PENDING_BODY, type Tx,
} from "@trafficflow/db";
import type { ClassifierPort, ClassifierInput, ClassifierResult } from "@trafficflow/core";
import { ScreenerService, pendingKeyTtlMs } from "../src/index.js";
import { fakeSpendPort, type FakeSpendPort } from "./helpers/spend-port-fake.js";
import { PLANE_PRICES, PLANE_PRICING } from "./helpers/plane-pricing.js";
import { makeCtx, seedMessage, FakeAdapter } from "./helpers.js";

/*
 * the request's Idempotency-Key is claimed BEFORE the first credit is spent.
 * It used to be claimed after the purchase loop, so a key already bound to another body was
 * refused only once that body's senders had been charged, and a same-key twin arriving while the
 * first request was still buying ran a purchase of its own. Here the key is claimed first: another
 * body is refused with nothing asked of the gate, a same-body twin is told to replay, and a run
 * that ends without an answer hands the key back through one door.
 */

const NOW = new Date("2026-09-24T12:00:00Z");
const YES: ClassifierResult = { destination: "INBOX", confidence: 0.9, rationale: "a person", spam: false };

/** A classifier whose FIRST call waits until `open()` — the first request, caught mid-purchase. */
function heldClassifier() {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  const seen: string[] = [];
  const port: ClassifierPort = {
    async classify(i: ClassifierInput) {
      seen.push(i.from.address);
      if (seen.length === 1) { entered(); await gate; }
      return YES;
    },
  };
  return { port, seen, open, inside };
}

async function world(credits: FakeSpendPort = fakeSpendPort()) {
  const w = await makeCtx(NOW);
  await w.db.insert(accounts).values({ id: w.accountId, name: "key-before-spend" });
  await seedMessage(w.db, w.accountId, w.mailboxId, { from: "alice@ex.example" });
  await seedMessage(w.db, w.accountId, w.mailboxId, { from: "bob@ex.example" });
  const keyRow = async (key: string) => (await w.db.select().from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.accountId, w.accountId), eq(idempotencyKeys.key, key))))[0];
  return { ...w, credits, keyRow };
}

/** Credits CHARGED for one sender's representative, read off the port's own record. */
function spentOn(credits: FakeSpendPort, attemptKey: string): number {
  return credits.spends.filter((c) => c.attemptKey === attemptKey && c.outcome.verdict === "ok")
    .length * PLANE_PRICES.screener;
}

/** The thrown value's name, as one word — a matcher over a database handle can take the worker. */
async function thrownName(p: Promise<unknown>): Promise<string> {
  try { await p; return "resolved"; } catch (err) { return (err as Error).name ?? "unnamed"; }
}

describe("the suggestion request claims its key before the first spend", () => {
  it("a key bound to ANOTHER body is refused and nothing is spent", async () => {
    const w = await world();
    const classifier = new (class implements ClassifierPort {
      seen: string[] = [];
      async classify(i: ClassifierInput) { this.seen.push(i.from.address); return YES; }
    })();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier, credits: w.credits, pricing: PLANE_PRICING });
    await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k1", requestHash: "hA" } });
    const bob = screenerAttemptKey(await bobId(w));

    const second = svc.suggest(w.ctx, { senders: ["bob@ex.example"] }, { idempotency: { key: "k1", requestHash: "hB" } });
    expect(await thrownName(second)).toBe("IdempotencyRaceLost");
    expect(spentOn(w.credits, bob), "credit was spent on a body the key was never bound to").toBe(0);
    expect(classifier.seen, "the model was asked about the refused body").toEqual(["alice@ex.example"]);
  });

  it("a key bound to another body WHILE the first is still buying: refused, nothing spent", async () => {
    const w = await world();
    w.credits.exclusive();
    const held = heldClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: held.port, credits: w.credits, pricing: PLANE_PRICING });
    const first = svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k2", requestHash: "hA" } });
    await held.inside;

    const second = svc.suggest(w.ctx, { senders: ["bob@ex.example"] }, { idempotency: { key: "k2", requestHash: "hB" } });
    const verdict = await thrownName(second);
    held.open();
    await first.catch(() => undefined);
    expect(verdict, "the second body ran a purchase under a key the first request holds").toBe("IdempotencyRaceLost");
    expect(spentOn(w.credits, screenerAttemptKey(await bobId(w)))).toBe(0);
    expect(held.seen).toEqual(["alice@ex.example"]);
    expect((await w.keyRow("k2"))?.requestHash, "the key ended bound to the wrong body").toBe("hA");
  });

  it("the SAME body while the first is still buying is told to replay, asking nothing", async () => {
    const w = await world();
    w.credits.exclusive();
    const held = heldClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: held.port, credits: w.credits, pricing: PLANE_PRICING });
    const first = svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k3", requestHash: "hA" } });
    await held.inside;
    const asked = w.credits.spends.length;

    const twin = svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k3", requestHash: "hA" } });
    const verdict = await thrownName(twin);
    held.open();
    const answer = await first;
    expect(verdict).toBe("IdempotencyRaceLost");
    expect(w.credits.spends.length - asked, "the twin asked the gate").toBe(0);
    expect(answer.suggestions.map((s) => s.sender)).toEqual(["alice@ex.example"]);
    expect((await w.keyRow("k3"))?.responseJson, "the stored answer is not the first request's").toEqual(answer);
  });

  it("the same body after the first finished replays the stored answer, spending nothing", async () => {
    const w = await world();
    // Opened at once: this case is the finished-first order.
    const c = heldClassifier(); c.open();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: c.port, credits: w.credits, pricing: PLANE_PRICING });
    const answer = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k4", requestHash: "hA" } });
    const asked = w.credits.spends.length;
    expect(await thrownName(svc.suggest(w.ctx, { senders: ["alice@ex.example"] },
      { idempotency: { key: "k4", requestHash: "hA" } }))).toBe("IdempotencyRaceLost");
    expect(w.credits.spends.length - asked).toBe(0);
    expect((await w.keyRow("k4"))?.responseJson).toEqual(answer);
  });
});

describe("a run that ends without an answer hands its claims back through one door", () => {
  /** `store` refused on the first write — the fatal lane, after its charge. */
  function storeFaults(svc: ScreenerService): void {
    const s = svc as unknown as { store: (...a: unknown[]) => Promise<void> };
    s.store = async () => { throw new Error("store 08006"); };
  }

  it("a store fault: the pass error stands, the charge is reversed once, the key is free again", async () => {
    const w = await world();
    const c = heldClassifier(); c.open();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: c.port, credits: w.credits, pricing: PLANE_PRICING });
    storeFaults(svc);
    let thrown = "none";
    try {
      await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k5", requestHash: "hA" } });
    } catch (err) { thrown = (err as Error).message; }
    const alice = screenerAttemptKey(await aliceId(w));
    expect(thrown, "the pass error was replaced").toBe("store 08006");
    expect(w.credits.releases.map((r) => ({ key: r.attemptKey, refund: r.refund })))
      .toEqual([{ key: alice, refund: true }]);
    expect(await w.keyRow("k5"), "a run with no answer left its key bound").toBeUndefined();

    // The retry under the same key RUNS — the key was handed back, not left to its TTL.
    const retry = new ScreenerService({ adapter: new FakeAdapter(), classifier: c.port, credits: w.credits, pricing: PLANE_PRICING });
    const answer = await retry.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k5", requestHash: "hA" } });
    expect(answer.suggestions.map((s) => s.sender)).toEqual(["alice@ex.example"]);
  });

  it("a release that faults is logged and never replaces the pass error", async () => {
    const w = await world();
    const faulting: FakeSpendPort = {
      ...w.credits,
      release: async (accountId, r) => { await w.credits.release(accountId, r); throw new Error("gate 500"); },
    };
    const c = heldClassifier(); c.open();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: c.port, credits: faulting, pricing: PLANE_PRICING });
    storeFaults(svc);
    const said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let thrown = "none";
    try {
      await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k6", requestHash: "hA" } });
    } catch (err) { thrown = (err as Error).message; }
    const lines = said.mock.calls.filter((a) => String(a[0]).includes("\"event\":\"screener_suggest_release_failed\""));
    said.mockRestore();
    expect(thrown).toBe("store 08006");
    expect(w.credits.releases, "the release was retried").toHaveLength(1);
    expect(lines, "the release fault was not logged exactly once").toHaveLength(1);
  });

  it("a key release that faults is logged and never replaces the pass error", async () => {
    const w = await world();
    let failTx = false;
    const db = new Proxy(w.db as unknown as object, {
      get(target, prop) {
        if (prop === "transaction") {
          return async (fn: (tx: Tx) => Promise<unknown>) => {
            if (failTx) throw new Error("release 08006");
            return (target as { transaction: (f: typeof fn) => Promise<unknown> }).transaction(fn);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof w.db;
    const c = heldClassifier(); c.open();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: c.port, credits: w.credits, pricing: PLANE_PRICING });
    (svc as unknown as { store: () => Promise<void> }).store = async () => {
      failTx = true; throw new Error("store 08006");
    };
    const said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let thrown = "none";
    try {
      await svc.suggest({ ...w.ctx, db }, { senders: ["alice@ex.example"] }, { idempotency: { key: "k7", requestHash: "hA" } });
    } catch (err) { thrown = (err as Error).message; }
    const lines = said.mock.calls.filter((a) => String(a[0]).includes("\"event\":\"screener_suggest_key_release_failed\""));
    said.mockRestore();
    expect(thrown, "the key's release fault replaced the pass error").toBe("store 08006");
    expect(lines, "the release fault was not logged exactly once").toHaveLength(1);
    // Left to its short TTL — which the case below proves frees it.
    expect((await w.keyRow("k7"))?.responseStatus).toBe(IDEMPOTENCY_PENDING_STATUS);
  });

  it("a refusal that produced nothing hands the key back, so its retry runs", async () => {
    const w = await world(fakeSpendPort({ verdict: "insufficient", reason: "out_of_credits" }));
    const c = heldClassifier(); c.open();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: c.port, credits: w.credits, pricing: PLANE_PRICING });
    expect(await thrownName(svc.suggest(w.ctx, { senders: ["alice@ex.example"] },
      { idempotency: { key: "k8", requestHash: "hA" } }))).toBe("ServiceError");
    expect(await w.keyRow("k8"), "a refused run left its key bound").toBeUndefined();
  });

  it("a key a killed run left pending frees itself after the host's own ceiling, not after a day", async () => {
    const w = await world();
    const held = heldClassifier();
    const svc = new ScreenerService({
      adapter: new FakeAdapter(), classifier: held.port, credits: w.credits, pricing: PLANE_PRICING, invocationBudgetMs: 60_000,
    });
    const at = (ms: number) => ({ ...w.ctx, now: () => new Date(NOW.getTime() + ms) });
    const stuck = svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k9", requestHash: "hA" } });
    await held.inside;
    expect(await thrownName(svc.suggest(at(30_000), { senders: ["bob@ex.example"] },
      { idempotency: { key: "k9", requestHash: "hA" } })), "a live pending key was taken over").toBe("IdempotencyRaceLost");
    const retry = await svc.suggest(at(pendingKeyTtlMs(60_000) + 1_000), { senders: ["bob@ex.example"] },
      { idempotency: { key: "k9", requestHash: "hA" } });
    expect(retry.suggestions.map((x) => x.sender), "the retry past the ceiling did not run").toEqual(["bob@ex.example"]);
    held.open();
    expect(await thrownName(stuck), "the stuck run settled over the retry's answer").toBe("IdempotencyRaceLost");
  });

  it("a run that outlived its claim never settles over another body's claim on the key", async () => {
    const w = await world();
    const held = heldClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: held.port, credits: w.credits, pricing: PLANE_PRICING });
    const run = svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k12", requestHash: "hA" } });
    await held.inside;
    // Another body takes the key over on a clock past this run's pending TTL.
    const later = new Date(NOW.getTime() + pendingKeyTtlMs(undefined) + 1_000);
    expect(await w.db.transaction((tx) => claimIdempotencyKey(tx as Tx, {
      accountId: w.accountId, key: "k12", requestHash: "hB", responseStatus: IDEMPOTENCY_PENDING_STATUS,
      responseJson: IDEMPOTENCY_PENDING_BODY, seq: null, now: later, ttlMs: pendingKeyTtlMs(undefined),
    }))).toBe(true);
    held.open();
    expect(await thrownName(run)).toBe("IdempotencyRaceLost");
    const row = await w.keyRow("k12");
    expect({ hash: row?.requestHash, status: row?.responseStatus }, "the other body's claim was overwritten")
      .toEqual({ hash: "hB", status: IDEMPOTENCY_PENDING_STATUS });
  });

  it("the pending release never deletes a settled answer", async () => {
    const w = await world();
    const c = heldClassifier(); c.open();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: c.port, credits: w.credits, pricing: PLANE_PRICING });
    const answer = await svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k13", requestHash: "hA" } });
    expect(await w.db.transaction((tx) => releasePendingIdempotencyKey(tx as Tx, {
      accountId: w.accountId, key: "k13", requestHash: "hA",
    }))).toBe(false);
    expect((await w.keyRow("k13"))?.responseJson).toEqual(answer);
  });

  it("an erasure that stamps the pending key mid-run: the settle loses and writes no answer", async () => {
    const w = await world();
    const held = heldClassifier();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: held.port, credits: w.credits, pricing: PLANE_PRICING });
    const run = svc.suggest(w.ctx, { senders: ["alice@ex.example"] }, { idempotency: { key: "k11", requestHash: "hA" } });
    await held.inside;
    await eraseIdempotentResponses(w.db as unknown as Tx, w.accountId, NOW);
    held.open();
    expect(await thrownName(run)).toBe("IdempotencyRaceLost");
    expect((await w.keyRow("k11"))?.responseJson, "the answer was written into an erased row").toBe("erased");
  });

  it("a model fault keeps the charge and gives that claim back once", async () => {
    const w = await world();
    const failing: ClassifierPort = {
      async classify(i) { if (i.from.address === "alice@ex.example") throw new Error("model 529"); return YES; },
    };
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: failing, credits: w.credits, pricing: PLANE_PRICING });
    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example", "bob@ex.example"] });
    expect(res.skipped).toEqual([{ sender: "alice@ex.example", reason: "model_unavailable" }]);
    const alice = screenerAttemptKey(await aliceId(w));
    expect(w.credits.releases.filter((r) => r.attemptKey === alice).map((r) => r.refund)).toEqual([false]);
    expect(w.credits.releases, "one release per claim").toHaveLength(2);
  });

  it("an `inflight` claim is never given back — it belongs to the other caller", async () => {
    const w = await world();
    w.credits.exclusive();
    const alice = screenerAttemptKey(await aliceId(w));
    await w.credits.spend(w.accountId, "screener", alice, {});
    const c = heldClassifier(); c.open();
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: c.port, credits: w.credits, pricing: PLANE_PRICING });
    const res = await svc.suggest(w.ctx, { senders: ["alice@ex.example", "bob@ex.example"] });
    expect(res.skipped).toEqual([{ sender: "alice@ex.example", reason: "spend_unavailable" }]);
    expect(w.credits.releases.map((r) => r.attemptKey)).toEqual([screenerAttemptKey(await bobId(w))]);
    // It sits out the service's 2.5 s wait for the other caller's claim (INFLIGHT_WAIT_MS): 2.8 s on the
    // CI VMs, 22 s under 10% of a CPU.
  }, 60_000);
});

async function idOf(w: Awaited<ReturnType<typeof world>>, from: string): Promise<string> {
  const [m] = await w.db.select().from(messages).where(eq(messages.fromAddress, from));
  return m!.id;
}
const aliceId = (w: Awaited<ReturnType<typeof world>>) => idOf(w, "alice@ex.example");
const bobId = (w: Awaited<ReturnType<typeof world>>) => idOf(w, "bob@ex.example");

/* ── ONE DOOR, READ FROM THE SOURCE ─────────────────────────────────────────────────────────
 * Every exit of a purchase lane leaves through one `releaseClaim`, and every exit of the run
 * through one `releaseKey`, each the only call of its door and each in a `finally`. Counted from
 * CALL expressions, so a comment or a string can neither make a door nor hide one; the reading is
 * proved on two fixtures, because a scanner that matches nothing is green exactly when useless.
 */
interface DoorReading { finallies: number; inFinally: number; elsewhere: number }

function readTheDoor(src: string, holder: string, door: string): DoorReading {
  const sf = ts.createSourceFile("subject.ts", src, ts.ScriptTarget.Latest, true);
  const holders: ts.Node[] = [];
  const find = (n: ts.Node): void => {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name?.getText(sf) === holder) holders.push(n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === holder && n.initializer) holders.push(n.initializer);
    ts.forEachChild(n, find);
  };
  find(sf);
  if (holders.length !== 1) throw new Error(`${String(holders.length)} declarations named ${holder}, expected one`);
  const calls = (n: ts.Node | undefined): number => {
    let seen = 0;
    const walk = (x: ts.Node): void => {
      if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === door) seen++;
      ts.forEachChild(x, walk);
    };
    if (n) walk(n);
    return seen;
  };
  const tries: ts.TryStatement[] = [];
  const collect = (x: ts.Node): void => {
    if (ts.isTryStatement(x) && x.finallyBlock && calls(x.finallyBlock) > 0) tries.push(x);
    ts.forEachChild(x, collect);
  };
  collect(holders[0]!);
  const inFinally = tries.reduce((sum, t) => sum + calls(t.finallyBlock), 0);
  return { finallies: tries.length, inFinally, elsewhere: calls(holders[0]) - inFinally };
}

const SUBJECT = readFileSync(fileURLToPath(new URL("../src/screener-service.ts", import.meta.url)), "utf8");

describe("one door: each claim of the suggestion request goes back in a `finally`", () => {
  it("the purchase lane's claim: one `releaseClaim` call, in a `finally`", () => {
    expect(readTheDoor(SUBJECT, "buyAdmitted", "releaseClaim"))
      .toEqual({ finallies: 1, inFinally: 1, elsewhere: 0 });
  });

  it("the request key: one `releaseKey` call, in a `finally`", () => {
    expect(readTheDoor(SUBJECT, "suggest", "releaseKey"))
      .toEqual({ finallies: 1, inFinally: 1, elsewhere: 0 });
  });

  it("the reading sees releases on named exits, and not a comment or a string", () => {
    const namedExits = `
      const subject = async (c: number): Promise<void> => {
        const releaseClaim = async (): Promise<void> => {};
        // releaseClaim() used to live here
        const s = "releaseClaim()"; void s;
        if (c === 1) { await releaseClaim(); return; }
        try { void c; } catch (err) { await releaseClaim(); throw err; }
        await releaseClaim();
      };`;
    const oneDoor = `
      const subject = async (c: number): Promise<void> => {
        const releaseClaim = async (): Promise<void> => {};
        try {
          if (c === 1) return;
          try { void c; } catch (err) { throw err; }
        } finally {
          await releaseClaim();
        }
      };`;
    expect(readTheDoor(namedExits, "subject", "releaseClaim")).toEqual({ finallies: 0, inFinally: 0, elsewhere: 3 });
    expect(readTheDoor(oneDoor, "subject", "releaseClaim")).toEqual({ finallies: 1, inFinally: 1, elsewhere: 0 });
  });
});

/* ── THE GATE IS CALLED FROM THE DOOR AND NOWHERE ELSE ─────────────────────────────────────
 * Over the WHOLE file: every call that gives a claim back or writes its debt (`release`, `owe`,
 * `settle`, by property or by bracket, and the shared `reverseCharge` by name) sits inside a
 * `releaseClaim` closure. The draft's door is not a `finally` (its failure sentence needs the
 * receipt), so this is its census. One receiver is not the gate and is named: the Screener's lane
 * slot; an entry no call uses is refused.
 */
interface GateReading { inDoor: number; outside: string[]; exempt: number }

const NOT_THE_GATE: Readonly<Record<string, readonly string[]>> = {
  "screener-service.ts": ["laneGate"],
  "drafting-service.ts": [],
};

function readTheGateCalls(src: string, verbs: readonly string[], exempt: readonly string[] = []): GateReading {
  const sf = ts.createSourceFile("subject.ts", src, ts.ScriptTarget.Latest, true);
  const doors: ts.Node[] = [];
  const findDoors = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "releaseClaim" && n.initializer) {
      doors.push(n.initializer);
    }
    ts.forEachChild(n, findDoors);
  };
  findDoors(sf);
  const inADoor = (x: ts.Node): boolean => doors.some((d) => x.pos >= d.pos && x.end <= d.end);
  const reading: GateReading = { inDoor: 0, outside: [], exempt: 0 };
  const walk = (x: ts.Node): void => {
    if (ts.isCallExpression(x)) {
      const callee = x.expression;
      const named = ts.isPropertyAccessExpression(callee)
        ? { receiver: callee.expression.getText(sf), verb: callee.name.text }
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
          ? { receiver: callee.expression.getText(sf), verb: callee.argumentExpression.text }
          : ts.isIdentifier(callee)
            ? { receiver: "", verb: callee.text }
            : null;
      if (named && verbs.includes(named.verb)) {
        if (named.receiver !== "" && exempt.includes(named.receiver)) reading.exempt++;
        else if (inADoor(x)) reading.inDoor++;
        else reading.outside.push(`${String(sf.getLineAndCharacterOfPosition(x.getStart(sf)).line + 1)}: ${x.expression.getText(sf)}`);
      }
    }
    ts.forEachChild(x, walk);
  };
  walk(sf);
  return reading;
}

const DRAFTING = readFileSync(fileURLToPath(new URL("../src/drafting-service.ts", import.meta.url)), "utf8");
const GATE_VERBS = ["release", "owe", "settle", "reverseCharge"] as const;
/** The debt and its settlement: only `reverseCharge` writes them, so no door names either. */
const DEBT_VERBS = ["owe", "settle"] as const;

describe("one door: the gate is called from a `releaseClaim` and nowhere else in the file", () => {
  it("the Screener: its plain release and its one `reverseCharge` are inside the door; the lane slot is the one exemption, used", () => {
    expect(readTheGateCalls(SUBJECT, GATE_VERBS, NOT_THE_GATE["screener-service.ts"]))
      .toEqual({ inDoor: 2, outside: [], exempt: 1 });
    expect(readTheGateCalls(SUBJECT, ["reverseCharge"])).toEqual({ inDoor: 1, outside: [], exempt: 0 });
    expect(readTheGateCalls(SUBJECT, DEBT_VERBS), "the door writes a debt beside `reverseCharge`")
      .toEqual({ inDoor: 0, outside: [], exempt: 0 });
  });

  it("the draft: its plain release and its one `reverseCharge` are inside the door", () => {
    expect(readTheGateCalls(DRAFTING, GATE_VERBS, NOT_THE_GATE["drafting-service.ts"]))
      .toEqual({ inDoor: 2, outside: [], exempt: 0 });
    expect(readTheGateCalls(DRAFTING, ["reverseCharge"])).toEqual({ inDoor: 1, outside: [], exempt: 0 });
    expect(readTheGateCalls(DRAFTING, DEBT_VERBS), "the door writes a debt beside `reverseCharge`")
      .toEqual({ inDoor: 0, outside: [], exempt: 0 });
  });

  it("the reading sees the shared door called by name beside a `releaseClaim`, and not in a comment or a string", () => {
    const beside = `
      const run = async (): Promise<void> => {
        const releaseClaim = async (): Promise<void> => { await reverseCharge(); };
        // reverseCharge() used to live here
        const s = "reverseCharge()"; void s;
        await releaseClaim();
        await reverseCharge();
      };`;
    const inside = beside.replace("        await reverseCharge();\n", "");
    expect(inside).not.toBe(beside);
    expect(readTheGateCalls(beside, ["reverseCharge"])).toEqual({ inDoor: 1, outside: ["7: reverseCharge"], exempt: 0 });
    expect(readTheGateCalls(inside, ["reverseCharge"])).toEqual({ inDoor: 1, outside: [], exempt: 0 });
  });

  it("the reading sees a call anywhere beside the door, by bracket too, and not a comment or a string", () => {
    const beside = `
      class Subject {
        async run(deps: { credits: { release(): Promise<void> } }): Promise<void> {
          const releaseClaim = async (): Promise<void> => { await deps.credits.release(); };
          // deps.credits.release() used to live here
          const s = "deps.credits.release()"; void s;
          await releaseClaim();
        }
        async giveBack(deps: { credits: { release(): Promise<void> } }): Promise<void> {
          await deps.credits["release"]();
        }
      }`;
    const inside = beside.replace('await deps.credits["release"]();', "void deps;");
    expect(inside).not.toBe(beside);
    expect(readTheGateCalls(beside, GATE_VERBS)).toEqual({ inDoor: 1, outside: ['10: deps.credits["release"]'], exempt: 0 });
    expect(readTheGateCalls(inside, GATE_VERBS)).toEqual({ inDoor: 1, outside: [], exempt: 0 });
  });
});

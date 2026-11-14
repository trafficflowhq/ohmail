import type { WorkflowPattern } from "@ohmail/wire";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, UNMETERED_ACCESS, learningSignals, sourceFor, workflowProposals, workflows,
  type SpendAction, type SpendOutcome, type SpendPort, type Tx,
} from "@trafficflow/db";
import {
  makeOpusProposer, unconfiguredProposer, type AnthropicLike, type LogFields, type Logger,
  type WorkflowPort,
} from "@trafficflow/core";
import { proposalGeneratePass } from "../src/proposal-cron.js";

const NOW = new Date("2026-07-28T12:00:00Z");

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seedSignals(db: Db, accountId: string, sender: string, dest: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.insert(learningSignals).values({
      accountId, triggeringActionId: `sig:${sender}:${i}:${randomUUID()}`,
      kind: "external_move", senderAddress: sender, senderDomain: sender.split("@")[1] ?? null,
      destination: dest, label: "positive",
    });
  }
}

const port: WorkflowPort = {
  async propose(patterns: WorkflowPattern[]) {
    return patterns.map((p, i) => ({
      pattern: i, name: `File ${p.senderAddress}`, rationale: "recurring", steps: [{ tool: "file_message" }],
    }));
  },
};

describe("proposalGeneratePass", () => {
  it("generates + stores proposals for the account via the injected port; NEVER creates a workflow", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    // Below-default-threshold (3) needs enough signals — seed 4.
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);

    const res = await proposalGeneratePass(db as unknown as Tx, { accountId, port }, NOW);
    expect(res.generated).toBe(1);

    const proposals = await db.select().from(workflowProposals).where(eq(workflowProposals.accountId, accountId));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe("open");
    // INERT: no workflow was created.
    expect(await db.select().from(workflows).where(eq(workflows.accountId, accountId))).toHaveLength(0);
  });

  it("unconfiguredProposer (no live model) is a clean no-op — proposes nothing", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    const res = await proposalGeneratePass(db as unknown as Tx, { accountId, port: unconfiguredProposer }, NOW);
    expect(res.generated).toBe(0);
    expect(await db.select().from(workflowProposals).where(eq(workflowProposals.accountId, accountId))).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE EXCLUSIVE CLAIM ENDS WITH THE PASS, NOT WITH ITS TTL
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `propose` is exclusive per account: the pass that wins the claim is the only one that may
 * reach the model for its bucket, and the claim outlives a crash by a TTL. The claim was given
 * back on the THROW path only, so two costs stood:
 *
 *  · a pass that SUCCEEDED held its claim for the rest of the TTL, and the next pass over that
 *    account inside the window was answered `inflight` and skipped work that was already done —
 *    one wasted cycle per account per pass, self-healing and invisible;
 *  · a pass that never held the claim released it anyway — a loser of the race, a refusal, or a
 *    throw before the gate was reached — which takes the claim from whoever does hold it, in the
 *    middle of the model call it is paying for.
 *
 * So the claim is released on BOTH exits, exactly once, and only when this pass holds it.
 */

/** One holder per source, an idempotent charge per source, and a refund that reopens the bucket. */
interface ClaimingGate extends SpendPort {
  readonly spends: ReadonlyArray<{ action: SpendAction; attemptKey: string }>;
  readonly releases: ReadonlyArray<{ attemptKey: string; refund: boolean; attempt?: string }>;
  /** Another pass takes the claim, as a concurrent invocation of this cron would. */
  hold(action: SpendAction, attemptKey: string): void;
  held(action: SpendAction, attemptKey: string): boolean;
}

/**
 * The plane's exclusivity, modelled rather than stipulated: a double that answered `ok` twice for
 * one source could not tell a held claim from a free one, and every assertion below would pass
 * against the defect. `sourceFor` is the real composer, so a key this pass had already composed
 * would raise here instead of being quietly accepted.
 */
function claimingGate(opts: { releaseThrows?: boolean } = {}): ClaimingGate {
  const claims = new Set<string>();
  const charged = new Set<string>();
  const spends: Array<{ action: SpendAction; attemptKey: string }> = [];
  const releases: Array<{ attemptKey: string; refund: boolean; attempt?: string }> = [];
  return {
    spends, releases,
    hold(action, attemptKey) { claims.add(sourceFor(action, attemptKey)); },
    held(action, attemptKey) { return claims.has(sourceFor(action, attemptKey)); },
    async spend(_accountId, action, attemptKey): Promise<SpendOutcome> {
      spends.push({ action, attemptKey });
      const source = sourceFor(action, attemptKey);
      if (claims.has(source)) return { verdict: "inflight", source };
      claims.add(source);
      if (charged.has(source)) return { verdict: "duplicate", charged: false, attempt: source };
      charged.add(source);
      return { verdict: "ok", charged: true, attempt: source };
    },
    async release(_accountId, r): Promise<"settled"> {
      releases.push({
        attemptKey: r.attemptKey, refund: r.refund, ...(r.refund ? { attempt: r.attempt } : {}),
      });
      // Recorded BEFORE the fault, so a release that could not be delivered is still counted.
      if (opts.releaseThrows) throw new Error("the entitlements program did not answer");
      const source = sourceFor(r.action, r.attemptKey);
      claims.delete(source);
      if (r.refund) charged.delete(source);
      return "settled";
    },
  };
}

interface CapturedLine { level: string; event: string; fields: LogFields }

function capturingLogger(): { log: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const at = (level: string) => (event: string, fields: LogFields = {}) => {
    lines.push({ level, event, fields });
  };
  const log: Logger = {
    level: "debug",
    child() { return log; },
    debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"),
  };
  return { log, lines };
}

/** The same proposals the suite's `port` returns, and a count of how often the model was reached. */
function countingProposer(): WorkflowPort & { calls: () => number } {
  let calls = 0;
  return {
    async propose(patterns: WorkflowPattern[]) { calls++; return port.propose(patterns); },
    calls: () => calls,
  };
}

const throwingProposer: WorkflowPort = {
  async propose(): Promise<never> { throw new Error("opus 529 overloaded"); },
};

/**
 * The real assemble path over a store that fails — the one way to reach the pass's catch with the
 * gate never asked, which is the case that used to release a claim it did not hold.
 */
function dbWhoseStoreFails(db: Db): Tx {
  return new Proxy(db as object, {
    get(target, prop) {
      if (prop === "transaction") {
        return async (): Promise<never> => { throw new Error("the store failed"); };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Tx;
}

/** The pass's own bare key for {@link NOW} — `<accountId>:<UTC hour>`. */
function keyFor(accountId: string): string { return `${accountId}:2026-07-28T12`; }

describe("the exclusive propose claim ends with the pass", () => {
  it("a finished pass gives the claim back, once, and reverses nothing", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    const credits = claimingGate();

    const res = await proposalGeneratePass(db as unknown as Tx, { accountId, port, credits }, NOW);

    expect(res.generated).toBe(1);
    // The charge stands — the pass delivered. Only the claim goes back.
    expect(credits.releases).toEqual([{ attemptKey: keyFor(accountId), refund: false }]);
    expect(credits.held("propose", keyFor(accountId)), "the claim outlived the pass").toBe(false);
  });

  it("the NEXT pass inside the same window proceeds instead of being told `inflight`", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    const credits = claimingGate();
    const proposer = countingProposer();
    const { log, lines } = capturingLogger();

    const first = await proposalGeneratePass(
      db as unknown as Tx, { accountId, port: proposer, credits, log }, NOW);
    const second = await proposalGeneratePass(
      db as unknown as Tx, { accountId, port: proposer, credits, log }, NOW);

    expect(first.generated).toBe(1);
    expect(second.generated, "the second pass in the bucket was skipped").toBe(1);
    // Both reached the model, so neither was refused; the second paid nothing, because the
    // bucket's charge is the same source and answers `duplicate`.
    expect(proposer.calls()).toBe(2);
    expect(credits.spends.map((s) => s.attemptKey)).toEqual([keyFor(accountId), keyFor(accountId)]);
    expect(credits.releases.map((r) => r.refund)).toEqual([false, false]);
    expect(lines, "a pass that proceeded reported a skip").toEqual([]);
  });

  it("`inflight` skips the account for this pass: no model call, no release, one line", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    const credits = claimingGate();
    const proposer = countingProposer();
    const { log, lines } = capturingLogger();
    const key = keyFor(accountId);

    // One pass ran and left the account's open suggestions on record…
    await proposalGeneratePass(db as unknown as Tx, { accountId, port: proposer, credits, log }, NOW);
    // …and now somebody else holds the claim on the same bucket.
    credits.hold("propose", key);
    const res = await proposalGeneratePass(
      db as unknown as Tx, { accountId, port: proposer, credits, log }, NOW);

    expect(res.generated).toBe(0);
    expect(proposer.calls(), "the model was reached for work somebody else is buying").toBe(1);
    // The first pass's release, and nothing since: the loser holds no claim to give back, and
    // releasing here would take the holder's claim away mid-model-call.
    expect(credits.releases).toEqual([{ attemptKey: key, refund: false }]);
    expect(credits.held("propose", key), "the holder's claim was released by the loser").toBe(true);
    // Skipped, not failed: one line, the account named, and nothing raised.
    expect(lines).toEqual([
      { level: "info", event: "cron_proposals_inflight", fields: { accountId } },
    ]);
    // A pass that could not run does not wipe the suggestions the account already has.
    expect(await db.select().from(workflowProposals)
      .where(eq(workflowProposals.accountId, accountId))).toHaveLength(1);
  });

  it("a pass that never held the claim releases nothing — the holder keeps it", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const credits = claimingGate();
    const key = keyFor(accountId);
    // No signals: no patterns, so the gate is never asked and this pass claims nothing. Another
    // pass holds the claim; the store then fails, which is the path that used to release it.
    credits.hold("propose", key);

    await expect(proposalGeneratePass(dbWhoseStoreFails(db), { accountId, port, credits }, NOW))
      .rejects.toThrow(/the store failed/);

    expect(credits.spends, "a pass with no patterns asked the gate").toEqual([]);
    expect(credits.releases, "a claim this pass never held was released").toEqual([]);
    expect(credits.held("propose", key)).toBe(true);
  });

  it("a pass that threw after it charged refunds once, and the bucket pays afresh", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    const credits = claimingGate();
    const key = keyFor(accountId);

    await expect(proposalGeneratePass(
      db as unknown as Tx, { accountId, port: throwingProposer, credits }, NOW))
      .rejects.toThrow(/529/);

    expect(credits.releases).toEqual([
      { attemptKey: key, refund: true, attempt: `propose:${key}` },
    ]);
    expect(credits.held("propose", key)).toBe(false);

    // And the retry inside the same bucket reaches the model, because the refund closed the
    // attempt and the claim is free.
    const res = await proposalGeneratePass(db as unknown as Tx, { accountId, port, credits }, NOW);
    expect(res.generated).toBe(1);
    expect(credits.releases).toHaveLength(2);
    expect(credits.releases[1]!.refund).toBe(false);
  });

  /**
   * A DECLINE KEEPS THE OPEN SET AND REFUNDS. Anthropic's documented refusal, through the real
   * proposer, throws `ModelDeclinedError` before the open set is replaced, so the account keeps the
   * proposals it had; the pass refunds the charge at the door and says `declined` — it does not
   * fail. Mutation: delete the pass's `ModelDeclinedError` arm (it rethrows, reported as a
   * failure), or make the proposer answer `[]`.
   */
  it("a DECLINED pass keeps the open proposals, refunds once, and is a decline — not a failure", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    const credits = claimingGate();
    const { log, lines } = capturingLogger();
    // An earlier hour's pass left one open proposal on record.
    await proposalGeneratePass(db as unknown as Tx, { accountId, port, credits, log }, NOW);
    const LATER = new Date(NOW.getTime() + 60 * 60_000);
    const laterKey = `${accountId}:2026-07-28T13`;
    // Anthropic's refusals page, read 2026-10-12: HTTP 200, no content, the stop reason says why.
    const declining: WorkflowPort = makeOpusProposer({ messages: { create: async () => ({
      id: "msg_refusal", type: "message", role: "assistant", model: "claude-opus-5-5", content: [],
      stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation: "declined" },
      usage: { input_tokens: 900, output_tokens: 0 },
    }) } } as AnthropicLike);

    const res = await proposalGeneratePass(db as unknown as Tx, { accountId, port: declining, credits, log }, LATER);

    expect(res.generated).toBe(0);
    expect(credits.releases.at(-1)).toEqual({ attemptKey: laterKey, refund: true, attempt: `propose:${laterKey}` });
    expect(await db.select().from(workflowProposals)
      .where(eq(workflowProposals.accountId, accountId)), "the decline wiped the open set").toHaveLength(1);
    expect(lines).toContainEqual({
      level: "info", event: "cron_proposals_declined",
      fields: { accountId, stopReason: "refusal", refusalCategory: "general_harms" },
    });
    expect(lines.filter((l) => l.level === "error"), "a decline was reported as a failure").toEqual([]);
  });

  it("a release that faults is sent ONCE, reported once, and does not fail a pass that stored its work", async () => {
    // The port's contract is never-throws, so this is a contract violation rather than a state the
    // program produces. What must hold anyway: the suggestions are on record, so the pass reports
    // what it did instead of being counted as a failed account; the claim it could not hand back
    // is reported once and never retried; and it is never turned into a REFUND of the charge that
    // bought the pass.
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    const credits = claimingGate({ releaseThrows: true });
    const { log, lines } = capturingLogger();

    const res = await proposalGeneratePass(
      db as unknown as Tx, { accountId, port, credits, log }, NOW);

    expect(res.generated, "a pass whose proposals are stored was reported as a failure").toBe(1);
    expect(credits.releases).toHaveLength(1);
    expect(credits.releases[0]!.refund, "a faulted release came back as a reversal").toBe(false);
    expect(lines.map((l) => `${l.level}:${l.event}`))
      .toEqual(["error:cron_proposals_release_failed"]);
    expect(lines[0]!.fields.accountId).toBe(accountId);
  });

  it("a release that faults while the pass is failing is not the failure the cron reports", async () => {
    // Two faults at once. The pass's OWN error escapes — the operator is shown the model fault
    // they can act on, not the release fault behind it, which used to replace it — and the release
    // fault gets its own line rather than being retried or dropped.
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    const credits = claimingGate({ releaseThrows: true });
    const { log, lines } = capturingLogger();

    await expect(proposalGeneratePass(
      db as unknown as Tx, { accountId, port: throwingProposer, credits, log }, NOW))
      .rejects.toThrow(/529/);

    expect(credits.releases).toHaveLength(1);
    expect(credits.releases[0]!.refund, "the charge this pass made was not reversed").toBe(true);
    expect(lines.map((l) => `${l.level}:${l.event}`))
      .toEqual(["error:cron_proposals_release_failed"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  ONE DOOR — THE CLAIM GOES BACK IN A `finally`
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The release used to sit on the two exits somebody had written down: the store's return and the
 * catch. That is right for exactly those two and for no exit added after them — a guard clause or
 * an early return leaves the claim behind for the rest of its TTL, and the next pass over that
 * account is answered `inflight` and skips work nobody did. One release in a `finally` makes the
 * property hold for every exit by construction, which is a property of the pass's SHAPE, so it is
 * measured there. The reading is self-tested on two fixtures below, because a scanner that
 * matches nothing is green exactly when it is useless.
 */

interface DoorReading {
  /** `try` statements directly in the function's body — the door belongs to exactly one. */
  tries: number;
  hasFinally: boolean;
  inTry: number;
  inCatch: number;
  inFinally: number;
}

/**
 * Where `releaseClaim(...)` is CALLED inside `fnName`'s try statement, counted from the call
 * expression: a mention in a comment, a string or a type can neither manufacture a door nor hide
 * one.
 */
function readTheDoor(src: string, fnName: string): DoorReading {
  const sf = ts.createSourceFile("subject.ts", src, ts.ScriptTarget.Latest, true);
  let fn: ts.FunctionDeclaration | undefined;
  const findFn = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fnName) { fn = n; return; }
    ts.forEachChild(n, findFn);
  };
  ts.forEachChild(sf, findFn);
  const body = fn?.body;
  if (body === undefined) throw new Error(`the subject declares no function ${fnName}`);
  const tries = body.statements.filter(ts.isTryStatement);
  const first = tries[0];
  if (first === undefined) return { tries: 0, hasFinally: false, inTry: 0, inCatch: 0, inFinally: 0 };
  const calls = (n: ts.Node | undefined): number => {
    if (n === undefined) return 0;
    let seen = 0;
    const walk = (x: ts.Node): void => {
      if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "releaseClaim") {
        seen++;
      }
      ts.forEachChild(x, walk);
    };
    walk(n);
    return seen;
  };
  return {
    tries: tries.length,
    hasFinally: first.finallyBlock !== undefined,
    inTry: calls(first.tryBlock),
    inCatch: calls(first.catchClause),
    inFinally: calls(first.finallyBlock),
  };
}

/**
 * A BAD ANSWER COSTS THE ANSWER, NOT THE PASS. The derivation drops and counts; it never throws,
 * because a throw here takes the refund path and stores nothing — the two good proposals would go
 * with the bad one. Three answers, one naming a pattern that does not exist: two stored, the claim
 * released unrefunded, the drop logged by class and with no content.
 */
describe("one invalid answer among three", () => {
  it("stores two, releases the claim unrefunded, and logs the drop by class", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    await seedSignals(db, accountId, "bills@shop.test", "ohmail/Receipts", 4);
    const credits = claimingGate();
    const { log, lines } = capturingLogger();
    const threeAnswers: WorkflowPort = {
      async propose(patterns) {
        expect(patterns).toHaveLength(2);
        return [
          { pattern: 0, name: "a", rationale: "", steps: [{ tool: "file_message" }] },
          { pattern: 7, name: "b", rationale: "", steps: [{ tool: "file_message" }] },
          { pattern: 1, name: "c", rationale: "", steps: [{ tool: "draft_reply" }] },
        ];
      },
    };
    const res = await proposalGeneratePass(db as unknown as Tx, { accountId, port: threeAnswers, credits, log }, NOW);
    expect(res.generated).toBe(2);
    const rows = await db.select().from(workflowProposals).where(eq(workflowProposals.accountId, accountId));
    expect(rows.map((r) => r.name).sort()).toEqual(["a", "c"]);
    expect(credits.releases).toEqual([{ attemptKey: keyFor(accountId), refund: false }]);
    expect(lines).toEqual([
      { level: "info", event: "proposal_dropped", fields: { accountId, reason: "pattern_out_of_range", count: 1 } },
    ]);
  });
});

describe("the proposer's usage rides the pass's release", () => {
  /** A proposer that reports its one call through the call's hook, as the real client does. */
  function reportingProposer(inner: WorkflowPort, ok = true): WorkflowPort {
    return {
      async propose(patterns, call) {
        call?.onUsage?.({
          model: "claude-opus-5", ok, status: ok ? 200 : 529, latencyMs: 1, attempts: 1, requestId: "req_p",
          inputTokens: ok ? 900 : null, outputTokens: ok ? 300 : null, cacheReadTokens: ok ? 0 : null,
          cacheWriteTokens: ok ? 0 : null, thinkingTokens: null, costMicroUsd: ok ? 12_000 : null,
        });
        return inner.propose(patterns);
      },
    };
  }
  const passthrough = (fn: (r: never) => void) => fn as (r: unknown) => void;
  const lineShape = (accountId: string, ok: boolean) => expect.objectContaining({
    accountId, action: "propose", host: "worker", model: "claude-opus-5", ok,
  });

  it("a delivered pass releases once, carrying the call's one line, attributed to the account", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    const usages: unknown[] = [];
    const credits = claimingGate();
    const seen: SpendPort = { spend: credits.spend, async release(a, r) { usages.push(r.usage); return credits.release(a, r); } };
    await proposalGeneratePass(db as unknown as Tx, {
      accountId, port: reportingProposer(port), credits: seen, usageHook: passthrough as never,
    }, NOW);
    expect(usages).toEqual([[lineShape(accountId, true)]]);
  });

  it("a pass whose model threw still carries the failed call's line on its refund", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    const usages: unknown[] = [];
    const credits = claimingGate();
    const seen: SpendPort = { spend: credits.spend, async release(a, r) { usages.push([r.refund, r.usage]); return credits.release(a, r); } };
    await expect(proposalGeneratePass(db as unknown as Tx, {
      accountId, port: reportingProposer(throwingProposer, false), credits: seen, usageHook: passthrough as never,
    }, NOW)).rejects.toThrow(/529/);
    expect(usages).toEqual([[true, [lineShape(accountId, false)]]]);
  });

  it("with no hook the release carries no usage at all", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await seedSignals(db, accountId, "news@acme-com.example", "ohmail/News", 4);
    const usages: unknown[] = [];
    const credits = claimingGate();
    const seen: SpendPort = { spend: credits.spend, async release(a, r) { usages.push(r.usage); return credits.release(a, r); } };
    await proposalGeneratePass(db as unknown as Tx, { accountId, port: reportingProposer(port), credits: seen }, NOW);
    expect(usages).toEqual([undefined]);
  });
});

describe("one door: the propose claim is handed back in a `finally`", () => {
  it("the pass's release is in the `finally` and nowhere else, so every exit passes it", () => {
    const subject = readFileSync(new URL("../src/proposal-cron.ts", import.meta.url), "utf8");

    const door = readTheDoor(subject, "proposalGeneratePass");
    expect(door.tries, "the pass's body has one try statement").toBe(1);
    expect(door.hasFinally, "the pass's try has no `finally` for its exits to leave through").toBe(true);
    expect(door.inFinally, "the one release is not in the `finally`").toBe(1);
    // A release written on a named exit is a door the NEXT exit does not have.
    expect({ inTry: door.inTry, inCatch: door.inCatch }).toEqual({ inTry: 0, inCatch: 0 });
  });

  it("the reading sees releases on the named exits, and does not see a comment or a string", () => {
    // The shape this fix removed, with the two decoys that would make a symbol-counting scan
    // read four doors where there are two.
    const onTheNamedExits = `
      async function subject(): Promise<number> {
        const releaseClaim = async (refund: boolean): Promise<void> => { void refund; };
        try {
          // releaseClaim(false) used to live here
          const s = "releaseClaim(true)";
          void s;
          await releaseClaim(false);
          return 1;
        } catch (err) {
          await releaseClaim(true);
          throw err;
        }
      }
    `;
    // The shape it left, carrying the exit that is the whole reason for the door: an early return
    // inside the try, which no release of its own covers.
    const oneDoor = `
      async function subject(): Promise<number> {
        const releaseClaim = async (refund: boolean): Promise<void> => { void refund; };
        let refundOnRelease = false;
        try {
          if (Date.now() === 0) return 0;
          return 1;
        } catch (err) {
          refundOnRelease = true;
          throw err;
        } finally {
          await releaseClaim(refundOnRelease);
        }
      }
    `;

    expect(readTheDoor(onTheNamedExits, "subject"))
      .toEqual({ tries: 1, hasFinally: false, inTry: 1, inCatch: 1, inFinally: 0 });
    expect(readTheDoor(oneDoor, "subject"))
      .toEqual({ tries: 1, hasFinally: true, inTry: 0, inCatch: 0, inFinally: 1 });
  });
});

it("does not send or charge a metered proposal while the account's AI setting is Off", async () => {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "proposal account", aiEnabled: false });
  await seedSignals(db, accountId, "sender@example.invalid", "ohmail/News", 4);
  const credits = claimingGate();
  let calls = 0;
  await proposalGeneratePass(db as unknown as Tx, {
    accountId, credits,
    access: {
      access: async () => ({ ...UNMETERED_ACCESS }),
      accessOrFault: async () => ({ ...UNMETERED_ACCESS }),
    },
    port: { async propose() { calls++; return []; } },
  }, NOW);
  expect(calls).toBe(0);
  expect(credits.spends).toEqual([]);
});

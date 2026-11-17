import { describe, it, expect } from "vitest";
import {
  makeHaikuClassifier, SensitivePayloadRefusal,
  type AnthropicLike, type ClassifierPort, type ClassifierResult,
  type LogFields, type Logger,
} from "@trafficflow/core";
import { sourceFor } from "@trafficflow/db";
import type { SpendOutcome, SpendPort } from "@trafficflow/db";
import { makeClassifierCircuit, ClassifierFaultError } from "../src/ai-circuit.js";
import { classifyIngestFault, DeadLetterLedger } from "@ohmail/organizer/dead-letter";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A REFUSAL AT THE SINK IS NOT A MODEL FAULT — and the circuit used to count it as one.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `packages/core/src/ai/classify.ts` states the contract on {@link SensitivePayloadRefusal}
 * itself: *"a caller must never treat it as retryable, and the worker's circuit breaker must
 * never count it as an outage."* `ai-circuit.ts` caught EVERY throw from `inner.classify`,
 * incremented `consecutiveFaults` and tripped — so the sensitivity gate FIRING (the "Sensitive mail" invariant
 * failing closed, exactly as designed) was recorded as an Anthropic incident, and enough of them
 * withheld the classifier from the whole mailbox and flapped it through cooldown cycles.
 *
 * Nothing leaked: the payload is refused BEFORE `userPayload` exists. This is an availability
 * defect, and a comment stating the opposite of what the code did.
 *
 * ── WHAT A REFUSAL ACTUALLY MEANS, WHICH IS WHY IT MUST STAY LOUD ─────────────────────────
 *
 * `pipeline.ts` refuses sensitive mail BEFORE the credit gate and before the classifier is
 * touched (`!sensitivity.flags.no_ai && classifier && …`). So a refusal reaching the sink is
 * `classifySensitivity` and `screenOutboundText` DISAGREEING about the same bytes — the first
 * line of defence missed something the second caught. That is a defect report about our own
 * detector, not a fact about the model, and it must never be filed under `classifier_fault`
 * where an operator will read it as somebody else's outage.
 *
 * Every credential in this file is SYNTHETIC and matches the shapes already used by
 * `packages/core/test/ai/classify.test.ts`.
 */

const RESULT: ClassifierResult = {
  destination: "ohmail/News", confidence: 0.9, rationale: "bulk", spam: false,
};

/** Ordinary, unscreened mail — the `unclear` residue the AI branch exists for. */
const ORDINARY = {
  from: { address: "news@example.com", name: "News" },
  subject: "Digest", snippet: "stories", headersDigest: "precedence:bulk",
};

/**
 * The input that MUST be refused: recognised authentication vocabulary plus an unframed
 * credential shape. Synthetic — `482913` is the same placeholder the core suite uses.
 */
const SCREENED = {
  from: { address: "no-reply@accounts.invalid", name: null },
  subject: "Your verification code",
  snippet: "Code 482913",
  headersDigest: "",
};

/**
 * The REAL sink, over a client that fails the test if it is reached.
 *
 * Hand-throwing a `SensitivePayloadRefusal` would test the circuit against a mock of the thing
 * under discussion. This drives `buildClassifyParams` → `screenOutboundText` → the throw, so the
 * error the circuit sees is the one production produces, and the exploding client re-proves in
 * passing that nothing was serialised on the way out.
 */
function refusingPort(): ClassifierPort & { touched: () => boolean } {
  let touched = false;
  const client: AnthropicLike = {
    messages: {
      async create(): Promise<{ content: unknown }> {
        touched = true;
        throw new Error("UNREACHABLE: the outbound client was called with a screened payload");
      },
    },
  };
  const inner = makeHaikuClassifier({ client });
  return { classify: (i) => inner.classify(i), touched: () => touched };
}

function deadPort(): ClassifierPort {
  return { async classify(): Promise<never> { throw new Error("anthropic 529 overloaded"); } };
}

/**
 * A model error that merely CALLS ITSELF a refusal.
 *
 * `dead-letter.ts` states the rule this pins — "membership cannot be forged by a mail server; a
 * shape test can" — and the exemption is therefore by CLASS, like every other typed arm in the
 * worker (`ClassifierFaultError`, `LeaseUnavailableError`, `MimeParseError`).
 */
function impostorPort(): ClassifierPort {
  return {
    async classify(): Promise<never> {
      const err = new Error("upstream said something odd");
      err.name = "SensitivePayloadRefusal";
      throw err;
    },
  };
}

interface CapturedLine { level: string; event: string; fields: LogFields }

function capturingLogger(): { log: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const at = (level: string) => (event: string, fields: LogFields = {}) => { lines.push({ level, event, fields }); };
  const log: Logger = {
    level: "debug",
    child() { return log; },
    debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"),
  };
  return { log, lines };
}

interface FakeGate extends SpendPort {
  readonly refundedAttempts: string[];
  readonly releases: ReadonlyArray<{ attemptKey: string; refund: boolean }>;
}

/** The same gate shape `ai-circuit.test.ts` uses: `ok` once, `duplicate` on every retry. */
function fakeGate(): FakeGate {
  const charged = new Set<string>();
  const refundedAttempts: string[] = [];
  const releases: Array<{ attemptKey: string; refund: boolean }> = [];
  const gate: FakeGate = {
    refundedAttempts, releases,
    async spend(_accountId, action, attemptKey): Promise<SpendOutcome> {
      const source = sourceFor(action, attemptKey);
      if (charged.has(source)) return { verdict: "duplicate", charged: false, attempt: source };
      charged.add(source);
      return { verdict: "ok", charged: true, attempt: source };
    },
    async release(_accountId, r): Promise<"settled"> {
      releases.push({ attemptKey: r.attemptKey, refund: r.refund });
      if (r.refund) refundedAttempts.push(r.attempt);
      return "settled";
    },
  };
  return gate;
}

/** The BARE key the port is handed, and the source it composes from it. */
const KEY = "mbx-1:abc123";
const SOURCE = "classify:mbx-1:abc123";
const ACCOUNT = "acc-1";

describe("the circuit does not count a sensitivity refusal as a model fault", () => {
  it("REPRO — a refused payload must leave the circuit CLOSED and its fault count untouched", async () => {
    const port = refusingPort();
    const circuit = makeClassifierCircuit(port, { faultThreshold: 2 });

    // Four screened messages in a row — twice the threshold. The gate is working correctly on
    // every one of them, so none of it is evidence about the model.
    //
    // The throw is swallowed rather than asserted on HERE, deliberately: the type is pinned by
    // the next test, and letting an early type assertion fail first would hide the finding
    // itself behind it. What this test must say when it fails is "the circuit tripped".
    for (let i = 0; i < 4; i++) {
      const p = circuit.port();
      expect(p, `refusal ${i + 1}: the classifier was WITHHELD — the circuit had already opened`)
        .toBeDefined();
      await p!.classify(SCREENED).catch(() => undefined);
    }

    expect(port.touched(), "the outbound client must never have been reached").toBe(false);
    expect(circuit.state().consecutiveFaults, "a refusal is not a model fault").toBe(0);
    expect(circuit.state().open, "the sensitivity gate firing must not open the circuit").toBe(false);
    expect(circuit.state().opens).toBe(0);
    // The classifier is still being handed out, so the rest of the mailbox keeps its AI.
    expect(circuit.port()).toBeDefined();
  });

  it("rethrows the refusal ITSELF, never wrapped as a model fault", async () => {
    const circuit = makeClassifierCircuit(refusingPort(), { faultThreshold: 2 });
    const err = await circuit.port()!.classify(SCREENED).catch((e: unknown) => e);

    // `sync.ts` rethrows `ClassifierFaultError` immediately and by class, and `index.ts` exempts
    // it from `maxSyncFailures`. Wrapping a refusal in it is what routed a defect in OUR detector
    // into the arm reserved for somebody else's outage.
    expect(err).toBeInstanceOf(SensitivePayloadRefusal);
    expect(err).not.toBeInstanceOf(ClassifierFaultError);
    expect((err as SensitivePayloadRefusal).screen.safe).toBe(false);
  });

  it("is LOUD — a refusal is reported at error level, naming the rule and no content", async () => {
    const { log, lines } = capturingLogger();
    const circuit = makeClassifierCircuit(refusingPort(), { faultThreshold: 2, log });
    await circuit.port()!.classify(SCREENED).catch(() => undefined);

    const refusals = lines.filter((l) => l.event === "classifier_sensitive_refusal");
    expect(refusals).toHaveLength(1);
    // Error level, not warn: an upstream check that should have withheld this message did not.
    expect(refusals[0]!.level).toBe("error");
    expect(refusals[0]!.fields.reason).toBeDefined();
    // ...and it is NOT filed as a model fault, which is the misreport this whole slice is about.
    expect(lines.some((l) => l.event === "classifier_fault")).toBe(false);
    expect(lines.some((l) => l.event === "classifier_circuit_open")).toBe(false);

    // The log line may name the RULE and never the mail. `screen` carries `reason`/`category`
    // only, by construction — this pins that the circuit does not add anything richer.
    const serialised = JSON.stringify(refusals[0]!.fields);
    expect(serialised).not.toContain("482913");
    expect(serialised).not.toContain("verification code");
    expect(serialised).not.toContain("accounts.invalid");
  });

  it("is NEUTRAL, not a success — it neither counts nor clears a genuine fault", async () => {
    let mode: "fault" | "refuse" = "fault";
    const refusing = refusingPort();
    const port: ClassifierPort = {
      async classify() {
        if (mode === "refuse") return refusing.classify(SCREENED);
        throw new Error("anthropic 529");
      },
    };
    const circuit = makeClassifierCircuit(port, { faultThreshold: 2 });

    await circuit.port()!.classify(ORDINARY).catch(() => undefined);      // genuine fault 1
    expect(circuit.state().consecutiveFaults).toBe(1);

    mode = "refuse";
    await circuit.port()!.classify(SCREENED).catch(() => undefined);      // neutral
    expect(circuit.state().consecutiveFaults).toBe(1);
    expect(circuit.state().open).toBe(false);

    mode = "fault";
    await circuit.port()!.classify(ORDINARY).catch(() => undefined);      // genuine fault 2
    expect(circuit.state().open).toBe(true);
  });

  it("CONTROL — an ordinary model error still trips the circuit", async () => {
    const circuit = makeClassifierCircuit(deadPort(), { faultThreshold: 2 });
    await circuit.port()!.classify(ORDINARY).catch(() => undefined);
    await circuit.port()!.classify(ORDINARY).catch(() => undefined);
    expect(circuit.state().open).toBe(true);
    expect(circuit.port()).toBeUndefined();
  });

  it("CONTROL — the exemption is by CLASS: an error merely NAMED like a refusal still counts", async () => {
    const circuit = makeClassifierCircuit(impostorPort(), { faultThreshold: 2 });
    const err = await circuit.port()!.classify(ORDINARY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClassifierFaultError);
    await circuit.port()!.classify(ORDINARY).catch(() => undefined);
    expect(circuit.state().open).toBe(true);
  });

  it("hands the money back — the charge this refusal abandoned can never be honoured", async () => {
    const gate = fakeGate();
    const circuit = makeClassifierCircuit(refusingPort(), { faultThreshold: 2 });
    const metered = circuit.meter("mbx-1", gate);

    // `pipeline.ts` charges BEFORE it classifies, so a refusal always follows a debit. The port
    // names the SAME mailbox the meter does, as `aiFor` composes the pair in production.
    expect(await metered.spend(ACCOUNT, "classify_ingest", KEY))
      .toMatchObject({ verdict: "ok", charged: true });
    await circuit.port("mbx-1")!.classify(SCREENED).catch(() => undefined);

    // `pipeline.ts`'s no-refund argument is "the retry is FREE and honours the charge". That
    // argument does not hold here: `screenOutboundText` is deterministic in the bytes, so every
    // retry refuses again and the charge buys nothing, ever.
    expect(gate.refundedAttempts).toEqual([SOURCE]);
    // ...and not through `refund(source)`, whose marker the retry's `duplicate` has cleared.
    // Every release names the KEY, and only the abandoned one carries `refund: true`.
    expect(gate.releases).toEqual([{ attemptKey: KEY, refund: true }]);
  });

  it("refunds ONLY the refusing mailbox — another mailbox's call is still in flight", async () => {
    /* The screen is deterministic in the bytes of ONE message, so it is evidence about that
       message and about nothing else. Reversing every open charge here would hand back a credit
       for a classification another mailbox is about to be given — the refusal path's half of the
       defect the per-mailbox record closes. */
    const gate = fakeGate();
    const refusing = refusingPort();
    let refuse = true;
    const circuit = makeClassifierCircuit({
      async classify() {
        if (refuse) return refusing.classify(SCREENED);
        return RESULT;
      },
    }, { faultThreshold: 2 });

    await circuit.meter("mbx-a", gate).spend(ACCOUNT, "classify_ingest", "mbx-a:m1");
    await circuit.meter("mbx-b", gate).spend(ACCOUNT, "classify_ingest", "mbx-b:m1");

    // A's payload is refused at the sink.
    await circuit.port("mbx-a")!.classify(SCREENED).catch(() => undefined);
    expect(gate.refundedAttempts).toEqual([sourceFor("classify_ingest", "mbx-a:m1")]);

    // B's classification then lands, and its charge stands: it bought what it paid for.
    refuse = false;
    await expect(circuit.port("mbx-b")!.classify(ORDINARY)).resolves.toEqual(RESULT);
    expect(gate.refundedAttempts).toEqual([sourceFor("classify_ingest", "mbx-a:m1")]);
    expect(circuit.state().open).toBe(false);
  });

  it("refunds NOBODY through a wrapper with no mailbox — it charged nothing through this circuit", async () => {
    /* The auto-suggest pass's shape: `port()` bare, its own charge refunded at its own door. An
       absent mailbox used to read as every mailbox, so one refused sender there handed back an
       ingest charge another mailbox's message was still owed a classification for. */
    const gate = fakeGate();
    const circuit = makeClassifierCircuit(refusingPort(), { faultThreshold: 2 });
    await circuit.meter("mbx-a", gate).spend(ACCOUNT, "classify_ingest", "mbx-a:m1");

    const err = await circuit.port()!.classify(SCREENED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SensitivePayloadRefusal);
    expect(gate.refundedAttempts, "a refusal with no mailbox refunded another mailbox's charge").toEqual([]);
    expect(gate.releases).toEqual([]);
  });

  it("does not disturb an ordinary classification that follows it", async () => {
    let refuse = true;
    const refusing = refusingPort();
    const circuit = makeClassifierCircuit({
      async classify() {
        if (refuse) return refusing.classify(SCREENED);
        return RESULT;
      },
    }, { faultThreshold: 2 });

    await circuit.port()!.classify(SCREENED).catch(() => undefined);
    refuse = false;
    await expect(circuit.port()!.classify(ORDINARY)).resolves.toEqual(RESULT);
    expect(circuit.state().open).toBe(false);
    expect(circuit.state().consecutiveFaults).toBe(0);
  });
});

/**
 * ── WHAT THE RETHROW COSTS DOWNSTREAM, PINNED RATHER THAN ASSUMED ──────────────────────────
 *
 * With the refusal no longer wrapped, `sync.ts#attempt` stops rethrowing it immediately by class
 * and hands it to the dead-letter boundary instead. That is a behaviour change and these
 * two tests are the evidence for exactly what it is, because the difference between "loud" and
 * "catastrophic" is decided here and not in `ai-circuit.ts`.
 */
describe("the coupling — where an unwrapped refusal lands in the ingest boundary", () => {
  const refusal = new SensitivePayloadRefusal({ safe: false, category: "otp", reason: "vocabulary" });

  it("is MESSAGE-scoped, not infrastructure — so it never aborts the cycle mid-batch", () => {
    // The infrastructure arm rethrows out of `runSyncCycle` and holds EVERY folder's cursor.
    // Landing there is the poison-batch shape: one message stopping all later mail.
    expect(classifyIngestFault(refusal)).toEqual({
      domain: "message", code: "unclassified", deterministic: false,
    });
  });

  it("is retried once and then WRITTEN OFF — the message is never ingested", () => {
    const ledger = new DeadLetterLedger();
    const locator = { folder: "INBOX", ref: "9:41" };          // `${uidValidity}:${uid}`
    const fault = { code: "unclassified" as const, deterministic: false };

    ledger.beginCycle();
    // Cycle 1: the folder's cursor is HELD and the cycle fails — one countable sync failure.
    expect(ledger.record(locator, fault)).toBe("retry");

    ledger.beginCycle();
    // Cycle 2: consumed. The batch continues, the cursor crosses it, and the UID joins the
    // known-set so its body is never fetched again — i.e. the message never reaches the database.
    expect(ledger.record(locator, fault)).toBe("skip");
    expect(ledger.skipped).toBe(1);
    expect(ledger.knownFor("INBOX", "9")).toEqual([{ uid: 41, messageId: null }]);
  });
});

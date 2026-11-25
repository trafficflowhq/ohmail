import { describe, it, expect } from "vitest";
import { sourceFor } from "@trafficflow/db";
import type { SpendOutcome, SpendPort } from "@trafficflow/db";
import { ModelDeclinedError, type ClassifierPort, type ClassifierResult } from "@trafficflow/core";
import { makeClassifierCircuit, ClassifierFaultError } from "../src/ai-circuit.js";

/**
 * THE CLASSIFIER CIRCUIT BREAKER, on a fake clock.
 *
 * Two properties are being defended here and they are worth naming separately, because a test
 * that only shows the first looks complete and is not:
 *
 *  1. **Mail keeps moving through a model outage.** After N faults `port()` answers `undefined`,
 *     which is what makes `pipeline.ts`'s `classifier &&` chain short-circuit — no model call,
 *     and (because the gate is asked LAST in that chain) no debit either.
 *  2. **Nobody is charged for the classification the outage threw away.** That one is easy to
 *     get wrong in a way that passes review: see "the money" below.
 */

const RESULT: ClassifierResult = {
  destination: "ohmail/News", confidence: 0.9, rationale: "bulk", spam: false,
};

const INPUT = {
  from: { address: "news@example.com", name: "News" },
  subject: "Digest", snippet: "stories", headersDigest: "precedence:bulk",
};

function okPort(): ClassifierPort { return { async classify() { return RESULT; } }; }
function deadPort(): ClassifierPort {
  return { async classify(): Promise<never> { throw new Error("anthropic 529 overloaded"); } };
}
/** Fails `failures` times, then succeeds — the shape of a real incident ending. */
function flakyPort(failures: number): ClassifierPort {
  let n = 0;
  return {
    async classify(): Promise<ClassifierResult> {
      if (n++ < failures) throw new Error("anthropic 529");
      return RESULT;
    },
  };
}

/** A clock the test advances by hand. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

interface FakeGate extends SpendPort {
  readonly refundedAttempts: string[];
  readonly releases: ReadonlyArray<{ attemptKey: string; refund: boolean }>;
  readonly spends: string[];
}

/** The account every case here spends for. The port takes it per call, never per instance. */
const ACCOUNT = "acc-1";
/** The source the port composes from {@link KEY} — what the ledger would hold. */
const SOURCE = "classify:mbx-1:abc123";

/**
 * A PORT that behaves like the real local adapter: the first spend of a key charges and names its
 * attempt, and every later spend of the same key is a free duplicate naming the SAME attempt.
 *
 * `refundedAttempts` is what the circuit must produce, and it is a `release` with `refund: true`
 * naming the attempt the port said it charged — not the key. `releases` records every release so
 * a case can assert that a delivered classification gives its claim back and keeps its charge.
 */
function fakeGate(): FakeGate {
  const charged = new Map<string, string>();
  const refundedAttempts: string[] = [];
  const releases: Array<{ attemptKey: string; refund: boolean }> = [];
  const spends: string[] = [];
  const gate: FakeGate = {
    refundedAttempts, releases, spends,
    async spend(_accountId, action, attemptKey): Promise<SpendOutcome> {
      const source = sourceFor(action, attemptKey);
      spends.push(source);
      const held = charged.get(source);
      if (held !== undefined) return { verdict: "duplicate", charged: false, attempt: held };
      charged.set(source, source);
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

const KEY = "mbx-1:abc123";

describe("the circuit opens, and while open the classifier is WITHHELD", () => {
  it("stays closed and returns the live port while the model answers", async () => {
    const circuit = makeClassifierCircuit(okPort());
    const port = circuit.port();
    expect(port).toBeDefined();
    await expect(port!.classify(INPUT)).resolves.toEqual(RESULT);
    expect(circuit.state().open).toBe(false);
    expect(circuit.port()).toBeDefined();
  });

  it("opens after N consecutive faults and then answers `undefined` — the rules-only degrade", async () => {
    const c = clock();
    const circuit = makeClassifierCircuit(deadPort(), { faultThreshold: 2, now: c.now });

    // Fault 1 — still closed; the message is retried next cycle, which is the H2 contract.
    await expect(circuit.port()!.classify(INPUT)).rejects.toBeInstanceOf(ClassifierFaultError);
    expect(circuit.state().open).toBe(false);
    expect(circuit.port()).toBeDefined();

    // Fault 2 — trips.
    await expect(circuit.port()!.classify(INPUT)).rejects.toBeInstanceOf(ClassifierFaultError);
    expect(circuit.state().open).toBe(true);

    // THE DEGRADE: no classifier is handed out, so `pipeline.ts` never reaches the AI branch
    // and never reaches `tryDebit`. Mail is filed by the deterministic rules.
    expect(circuit.port()).toBeUndefined();
    expect(circuit.state().opens).toBe(1);
  });

  it("wraps the model's error rather than letting it pass as an ordinary sync failure", async () => {
    const circuit = makeClassifierCircuit(deadPort(), { faultThreshold: 5 });
    const err = await circuit.port()!.classify(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClassifierFaultError);
    // The original is preserved for the log line; the WRAPPER is what `cycle()` matches on to
    // keep a model outage from counting toward `maxSyncFailures`.
    expect((err as ClassifierFaultError).cause).toBeInstanceOf(Error);
  });

  it("a persistently dead model NEVER stops answering `undefined` — the outage cannot re-stall mail", async () => {
    const c = clock();
    const circuit = makeClassifierCircuit(deadPort(), { faultThreshold: 1, cooldownMs: 1_000, now: c.now });
    await expect(circuit.port()!.classify(INPUT)).rejects.toBeInstanceOf(ClassifierFaultError);

    // Ten cooldowns in a row: each probe fails and re-opens, and between probes the port is
    // withheld. At no point does a closed circuit persist against a dead model.
    for (let i = 0; i < 10; i++) {
      expect(circuit.port()).toBeUndefined();          // inside the cooldown
      c.advance(60 * 60_000);                          // well past any cooldown
      const probe = circuit.port();                    // half-open
      expect(probe).toBeDefined();
      await expect(probe!.classify(INPUT)).rejects.toBeInstanceOf(ClassifierFaultError);
    }
    expect(circuit.state().opens).toBe(11);
  });
});

describe("the call's usage hook rides through the circuit", () => {
  it("hands classify's and screen's hook to the inner port unchanged, and adds none when there is none", async () => {
    const seen: Array<{ method: string; hook: unknown; args: number }> = [];
    const inner: ClassifierPort = {
      async classify(...a: unknown[]) { seen.push({ method: "classify", hook: (a[1] as { onUsage?: unknown } | undefined)?.onUsage, args: a.length }); return RESULT; },
      async screen(...a: unknown[]) { seen.push({ method: "screen", hook: (a[1] as { onUsage?: unknown } | undefined)?.onUsage, args: a.length }); return RESULT; },
    };
    const port = makeClassifierCircuit(inner).port()!;
    const onUsage = (): void => {};
    await port.classify(INPUT, { onUsage });
    await port.screen!(INPUT, { onUsage });
    await port.classify(INPUT);
    expect(seen).toEqual([
      { method: "classify", hook: onUsage, args: 2 },
      { method: "screen", hook: onUsage, args: 2 },
      { method: "classify", hook: undefined, args: 1 },
    ]);
  });
});

describe("recovery is automatic", () => {
  it("half-opens after the cooldown and CLOSES on a successful probe", async () => {
    const c = clock();
    const circuit = makeClassifierCircuit(flakyPort(2), {
      faultThreshold: 2, cooldownMs: 60_000, now: c.now,
    });

    await expect(circuit.port()!.classify(INPUT)).rejects.toBeInstanceOf(ClassifierFaultError);
    await expect(circuit.port()!.classify(INPUT)).rejects.toBeInstanceOf(ClassifierFaultError);
    expect(circuit.port()).toBeUndefined();

    c.advance(59_000);
    expect(circuit.port()).toBeUndefined();            // not yet

    c.advance(2_000);
    const probe = circuit.port();                      // half-open
    expect(probe).toBeDefined();
    await expect(probe!.classify(INPUT)).resolves.toEqual(RESULT);

    // Closed, and the cooldown is back to its base for the next incident.
    expect(circuit.state().open).toBe(false);
    expect(circuit.state().consecutiveFaults).toBe(0);
    expect(circuit.state().cooldownMs).toBe(60_000);
    expect(circuit.port()).toBeDefined();
  });

  it("backs off exponentially while the outage lasts, and is capped", async () => {
    const c = clock();
    const circuit = makeClassifierCircuit(deadPort(), {
      faultThreshold: 1, cooldownMs: 1_000, maxCooldownMs: 4_000, now: c.now,
    });
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      await circuit.port()!.classify(INPUT).catch(() => undefined);
      seen.push(circuit.state().cooldownMs);
      c.advance(10 * 60_000);
      circuit.port();
    }
    expect(seen).toEqual([2_000, 4_000, 4_000, 4_000, 4_000]);
  });

  it("a single fault inside a healthy stretch does NOT open the circuit", async () => {
    const circuit = makeClassifierCircuit(flakyPort(1), { faultThreshold: 2 });
    await circuit.port()!.classify(INPUT).catch(() => undefined);
    await expect(circuit.port()!.classify(INPUT)).resolves.toEqual(RESULT);
    expect(circuit.state().open).toBe(false);
    expect(circuit.state().consecutiveFaults).toBe(0);
  });
});

describe("the money — a charge the circuit abandons must come back", () => {
  /**
   * THE SEQUENCE THAT BREAKS THE OBVIOUS IMPLEMENTATION.
   *
   * `pipeline.ts` charges before it classifies, and retries the same message next cycle. So the
   * gate sees `ok` (charged) on cycle 1 and `duplicate` (NOT charged) on cycle 2 — and the H4
   * fix deliberately CLEARS the refund marker on that `duplicate`. Calling `gate.refund(source)`
   * at trip time therefore does nothing at all, silently, and the customer keeps a credit that
   * bought a classification they never received.
   *
   * The circuit must instead refund the ATTEMPT it was told it charged. This test asserts both
   * halves: the right refund happens, and it does NOT go through the guard that is already gone.
   */
  it("refunds the abandoned attempt on trip — via `refundAttempt`, because `refund` is a no-op by then", async () => {
    const gate = fakeGate();
    const circuit = makeClassifierCircuit(deadPort(), { faultThreshold: 2 });
    const metered = circuit.meter("mbx-1", gate);

    // Cycle 1: charged, then the model faults.
    expect(await metered.spend(ACCOUNT, "classify_ingest", KEY)).toMatchObject({ verdict: "ok" });
    await circuit.port()!.classify(INPUT).catch(() => undefined);
    expect(circuit.state().open).toBe(false);
    expect(gate.refundedAttempts).toEqual([]);

    // Cycle 2: the SAME message. `duplicate` — proceeds, charges nothing, and names the FIRST
    // cycle's attempt. In the old gate this was the call that consumed the refund marker, which
    // is why the reversal below cannot depend on one.
    expect(await metered.spend(ACCOUNT, "classify_ingest", KEY))
      .toMatchObject({ verdict: "duplicate", charged: false });
    await circuit.port()!.classify(INPUT).catch(() => undefined);

    // Tripped, and the credit came back exactly once, naming the attempt that was charged.
    expect(circuit.state().open).toBe(true);
    expect(gate.refundedAttempts).toEqual([SOURCE]);
    // ...and NOT through the marker-guarded path, which by now would have refunded nothing.
    // Every release names the KEY; only an abandoned one carries `refund: true`.
    expect(gate.releases.every((r) => r.attemptKey === KEY)).toBe(true);
  });

  it("refunds NOTHING when the classification was delivered — a success clears the record", async () => {
    const gate = fakeGate();
    const circuit = makeClassifierCircuit(flakyPort(0), { faultThreshold: 1 });
    const metered = circuit.meter("mbx-1", gate);

    expect(await metered.spend(ACCOUNT, "classify_ingest", KEY)).toMatchObject({ verdict: "ok" });
    await expect(circuit.port()!.classify(INPUT)).resolves.toEqual(RESULT);

    // A LATER, unrelated outage must not hand back the credit for work already delivered — the
    // June-charge / July-reprocess leak, in circuit form.
    const later = makeClassifierCircuit(deadPort(), { faultThreshold: 1 });
    const laterMetered = later.meter("mbx-1", gate);
    await laterMetered.spend(ACCOUNT, "classify_ingest", "mbx-1:other");
    await later.port()!.classify(INPUT).catch(() => undefined);

    expect(gate.refundedAttempts).toEqual(["classify:mbx-1:other"]);
    expect(gate.refundedAttempts).not.toContain(SOURCE);
  });

  it("refunds at most ONE credit per trip, not one per faulted cycle", async () => {
    const gate = fakeGate();
    const circuit = makeClassifierCircuit(deadPort(), { faultThreshold: 4 });
    const metered = circuit.meter("mbx-1", gate);

    for (let i = 0; i < 4; i++) {
      await metered.spend(ACCOUNT, "classify_ingest", KEY);
      await circuit.port()!.classify(INPUT).catch(() => undefined);
    }

    expect(circuit.state().open).toBe(true);
    expect(gate.refundedAttempts).toEqual([SOURCE]);
  });

  it("refunds nothing when the gate never charged — a REFUSED spend has nothing to give back", async () => {
    const refusing: SpendPort = {
      async spend() { return { verdict: "insufficient", reason: "out_of_credits" }; },
      async release() { throw new Error("must not be called: nothing was charged"); },
    };
    const circuit = makeClassifierCircuit(deadPort(), { faultThreshold: 1 });
    const metered = circuit.meter("mbx-1", refusing);

    expect(await metered.spend(ACCOUNT, "classify_ingest", KEY))
      .toMatchObject({ verdict: "insufficient" });
    await circuit.port()!.classify(INPUT).catch(() => undefined);
    expect(circuit.state().open).toBe(true);     // the fault still counts; the money does not
  });

  it("the metered gate answers exactly what the underlying gate decided", async () => {
    const gate = fakeGate();
    const circuit = makeClassifierCircuit(okPort());
    const metered = circuit.meter("mbx-1", gate);
    expect(await metered.spend(ACCOUNT, "classify_ingest", KEY))
      .toMatchObject({ verdict: "ok", charged: true });
    // The wrapper FORWARDS the answer rather than collapsing it: a duplicate still proceeds, and
    // the caller can still tell it apart from a charge, which is what decides a later reversal.
    expect(await metered.spend(ACCOUNT, "classify_ingest", KEY))
      .toMatchObject({ verdict: "duplicate", charged: false });
    expect(gate.spends).toEqual([SOURCE, SOURCE]);
  });
});

describe("lastSuccessAt — the evidence a closed circuit cannot give on its own", () => {
  it("is NULL before the provider has ever answered, and stamped by the first success", async () => {
    // `firstOpenedAt: null` is two states in one value — the provider is fine, or this process
    // has not asked it yet — and a worker replacing another mid-outage is always the second. The
    // heartbeat writer needs to tell them apart to decide whether an inherited outage has ended,
    // so the breaker publishes the one event that means the provider responded.
    const circuit = makeClassifierCircuit(okPort());
    expect(circuit.state().lastSuccessAt, "nothing has been asked yet").toBeNull();

    const port = circuit.port();
    await port!.classify(INPUT);

    expect(circuit.state().lastSuccessAt, "the provider answered").toBeInstanceOf(Date);
    // ── AND IT IS THE INJECTED CLOCK, NOT THE MACHINE'S ──────────────────────────────
    //
    // `firstOpenedAt` is stamped from `now()` and this was stamped from `new Date()`, so the two
    // halves of one question — when did the outage start, when did it end — came from different
    // clocks. A test that advances its own clock got two incomparable times, and a host whose
    // clock steps could record a recovery that precedes the outage it ended.
    const c2 = clock(500_000);
    const circuit2 = makeClassifierCircuit(okPort(), { now: c2.now });
    await circuit2.port()!.classify(INPUT);
    expect(circuit2.state().lastSuccessAt!.getTime(), "the clock the circuit was given")
      .toBe(500_000);
    expect(circuit.state().firstOpenedAt, "and nothing is open").toBeNull();
  });
});

/**
 * ═══ THE OPEN-CHARGE RECORD IS PER MAILBOX ═══════════════════════════════════════════════════
 *
 * The defect these arms exist for, stated as a sequence. `cycle()` walks the rotation serially,
 * so:
 *
 *   1. mailbox A is charged, and its classify FAULTS — one fault, below the threshold, so the
 *      circuit stays closed and A's charge stays on record awaiting the free retry;
 *   2. mailbox B is charged, and its classify SUCCEEDS;
 *   3. the success cleared EVERY mailbox's record, A's included;
 *   4. A faults again, the circuit trips — and refunds nothing, because A's record is gone.
 *
 * A's customer has paid for a classification that was abandoned and will never be re-run.
 * Nothing throws, no suite goes red, and the ledger row looks exactly like a delivered one. The
 * fix is that the counting wrapper knows which mailbox it is classifying for, so step 3 clears
 * B and only B.
 */
describe("the open-charge record is per mailbox", () => {
  /** One classifier whose next answer the case chooses — the shared provider, as it really is. */
  function scriptedPort(): ClassifierPort & { next: "ok" | "fault" } {
    const p = {
      next: "ok" as "ok" | "fault",
      async classify(): Promise<ClassifierResult> {
        if (p.next === "fault") throw new Error("anthropic 529");
        return RESULT;
      },
    };
    return p;
  }

  it("a success for one mailbox leaves ANOTHER mailbox's charge refundable", async () => {
    const gate = fakeGate();
    const inner = scriptedPort();
    const circuit = makeClassifierCircuit(inner, { faultThreshold: 2 });

    // 1. A charges and faults. Below the threshold, so nothing is open yet.
    await circuit.meter("mbx-a", gate).spend(ACCOUNT, "classify_ingest", "mbx-a:m1");
    inner.next = "fault";
    await circuit.port("mbx-a")!.classify(INPUT).catch(() => undefined);
    expect(circuit.state().open).toBe(false);

    // 2. B charges and succeeds.
    await circuit.meter("mbx-b", gate).spend(ACCOUNT, "classify_ingest", "mbx-b:m1");
    inner.next = "ok";
    await circuit.port("mbx-b")!.classify(INPUT);

    // 3. The outage resumes and trips the circuit. A's charge is still owed back; B's is not,
    //    because B's classification was delivered.
    inner.next = "fault";
    await circuit.port("mbx-a")!.classify(INPUT).catch(() => undefined);
    await circuit.port("mbx-a")!.classify(INPUT).catch(() => undefined);
    expect(circuit.state().open).toBe(true);
    expect(gate.refundedAttempts).toEqual([sourceFor("classify_ingest", "mbx-a:m1")]);
  });

  it("a TRIP still abandons EVERY mailbox — the one scope that is deliberately not narrowed", async () => {
    const gate = fakeGate();
    const circuit = makeClassifierCircuit(deadPort(), { faultThreshold: 2 });
    await circuit.meter("mbx-a", gate).spend(ACCOUNT, "classify_ingest", "mbx-a:m1");
    await circuit.meter("mbx-b", gate).spend(ACCOUNT, "classify_ingest", "mbx-b:m1");

    await circuit.port("mbx-a")!.classify(INPUT).catch(() => undefined);
    await circuit.port("mbx-b")!.classify(INPUT).catch(() => undefined);

    // When the circuit opens the AI branch is abandoned for every message in flight, so both
    // charges are owed back. This is a property of the outage, not of a mailbox.
    expect(circuit.state().open).toBe(true);
    expect([...gate.refundedAttempts].sort()).toEqual([
      sourceFor("classify_ingest", "mbx-a:m1"),
      sourceFor("classify_ingest", "mbx-b:m1"),
    ].sort());
  });

  it("a wrapper with NO mailbox clears nobody's record — the caller that recorded nothing", async () => {
    // The account-scoped auto-suggest pass takes the raw spend port, so it never records an open
    // charge of its own. Its successes must therefore not be able to clear a mailbox cycle's.
    const gate = fakeGate();
    const inner = scriptedPort();
    const circuit = makeClassifierCircuit(inner, { faultThreshold: 2 });

    await circuit.meter("mbx-a", gate).spend(ACCOUNT, "classify_ingest", "mbx-a:m1");
    inner.next = "ok";
    await circuit.port()!.classify(INPUT);

    inner.next = "fault";
    await circuit.port()!.classify(INPUT).catch(() => undefined);
    await circuit.port()!.classify(INPUT).catch(() => undefined);
    expect(circuit.state().open).toBe(true);
    expect(gate.refundedAttempts).toEqual([sourceFor("classify_ingest", "mbx-a:m1")]);
  });

  it("a mailbox's own success still clears its OWN record — delivered work is never refunded", async () => {
    const gate = fakeGate();
    const inner = scriptedPort();
    const circuit = makeClassifierCircuit(inner, { faultThreshold: 2 });

    await circuit.meter("mbx-a", gate).spend(ACCOUNT, "classify_ingest", "mbx-a:m1");
    inner.next = "ok";
    await circuit.port("mbx-a")!.classify(INPUT);

    inner.next = "fault";
    await circuit.port("mbx-b")!.classify(INPUT).catch(() => undefined);
    await circuit.port("mbx-b")!.classify(INPUT).catch(() => undefined);
    expect(circuit.state().open).toBe(true);
    expect(gate.refundedAttempts, "A was delivered; nothing is owed").toEqual([]);
  });

  it("POSITIVE CONTROL — the state the heartbeat publishes is unchanged by the scoping", async () => {
    // `worker_heartbeats.ai_circuit_open_since` is the only evidence outside this process that
    // mail is being filed rules-only, and `alerts.ts` fires a rule on it. The scoping touches
    // the charge record and must not touch that: a fix that quietly stopped the one visible
    // state from firing would trade a money defect for a blind one.
    const c = clock();
    const circuit = makeClassifierCircuit(deadPort(), { faultThreshold: 2, now: c.now });
    expect(circuit.state().firstOpenedAt).toBeNull();
    expect(circuit.state().lastSuccessAt).toBeNull();

    await circuit.port("mbx-a")!.classify(INPUT).catch(() => undefined);
    await circuit.port("mbx-b")!.classify(INPUT).catch(() => undefined);
    expect(circuit.state().open, "two mailboxes' faults converge on ONE process-wide counter")
      .toBe(true);
    expect(circuit.state().firstOpenedAt!.getTime()).toBe(c.now());

    // And it clears on the first answer, whichever mailbox got it.
    const c2 = clock(500_000);
    const healthy = makeClassifierCircuit(okPort(), { now: c2.now });
    await healthy.port("mbx-z")!.classify(INPUT);
    expect(healthy.state().lastSuccessAt!.getTime()).toBe(500_000);
    expect(healthy.state().firstOpenedAt).toBeNull();
  });
});

/**
 * A DECLINE IS THE PROVIDER ANSWERING, NOT FAILING. A refusal or a cut-off answer speaks for one
 * message: neutral to the count, THIS mailbox's charge refunded, and rethrown UNWRAPPED so
 * `pipeline.ts` routes the message as with AI off. Counted, one declined message kept its mailbox
 * faulting while other mailboxes' successes kept the breaker shut, and the charge stood.
 * Mutation: delete the `ModelDeclinedError` arm in `ai-circuit.ts`'s guard.
 */
describe("a decline answers for one message — neutral, refunded, unwrapped", () => {
  function decliningPort(): ClassifierPort {
    return { async classify(): Promise<never> { throw new ModelDeclinedError("refusal", "cyber"); } };
  }

  it("passes through unwrapped, counts nothing, and refunds each declined message's charge", async () => {
    const gate = fakeGate();
    const circuit = makeClassifierCircuit(decliningPort(), { faultThreshold: 2 });
    const metered = circuit.meter("mbx-1", gate);
    for (let message = 0; message < 5; message++) {
      expect(await metered.spend(ACCOUNT, "classify_ingest", `${KEY}:${message}`)).toMatchObject({ verdict: "ok" });
      const err = await circuit.port("mbx-1")!.classify(INPUT).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelDeclinedError);
      expect(err).not.toBeInstanceOf(ClassifierFaultError);
    }
    expect(circuit.state()).toMatchObject({ open: false, consecutiveFaults: 0, opens: 0 });
    expect(gate.refundedAttempts).toEqual([0, 1, 2, 3, 4].map((m) => sourceFor("classify_ingest", `${KEY}:${m}`)));
  });

  it("refunds THIS mailbox's charge and leaves another mailbox's open charge alone", async () => {
    const gate = fakeGate();
    let decline = true;
    const port: ClassifierPort = {
      async classify(): Promise<ClassifierResult> {
        if (decline) throw new ModelDeclinedError("refusal", "cyber");
        return RESULT;
      },
    };
    const circuit = makeClassifierCircuit(port, { faultThreshold: 2 });
    await circuit.meter("mbx-2", gate).spend(ACCOUNT, "classify_ingest", `${KEY}:other`);
    await circuit.meter("mbx-1", gate).spend(ACCOUNT, "classify_ingest", `${KEY}:mine`);
    await circuit.port("mbx-1")!.classify(INPUT).catch(() => undefined);
    expect(gate.refundedAttempts).toEqual([sourceFor("classify_ingest", `${KEY}:mine`)]);
    decline = false;
    await circuit.port("mbx-2")!.classify(INPUT);
    expect(gate.refundedAttempts, "mbx-2's delivered work was refunded").toHaveLength(1);
  });

  /**
   * A WRAPPER WITH NO MAILBOX HAS NO CHARGE HERE TO RETURN. The auto-suggest pass takes `port()`
   * bare and refunds its own charge at its own door; its decline used to refund EVERY mailbox's
   * open charge under `classifier_declined`. Mutation: make `refundOwnCharge` scope an absent
   * mailbox to "every" — this case reads the other mailbox's refund.
   */
  it("a decline through a wrapper with NO mailbox refunds nobody — the open charge waits for its own outcome", async () => {
    const gate = fakeGate();
    let next: "decline" | "fault" = "decline";
    const port: ClassifierPort = {
      async classify(): Promise<never> {
        if (next === "decline") throw new ModelDeclinedError("refusal", "cyber");
        throw new Error("anthropic 529");
      },
    };
    const circuit = makeClassifierCircuit(port, { faultThreshold: 2 });
    await circuit.meter("mbx-a", gate).spend(ACCOUNT, "classify_ingest", `${KEY}:a`);

    const err = await circuit.port()!.classify(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDeclinedError);
    expect(gate.refundedAttempts, "a decline with no mailbox refunded another mailbox's charge").toEqual([]);

    // Still owed to its own outcome: mbx-a's outage trips the circuit and refunds it, once.
    next = "fault";
    for (let i = 0; i < 2; i++) await circuit.port("mbx-a")!.classify(INPUT).catch(() => undefined);
    expect(circuit.state().open).toBe(true);
    expect(gate.refundedAttempts).toEqual([sourceFor("classify_ingest", `${KEY}:a`)]);
  });

  it("CONTROL: an ordinary fault at the same place is still counted and trips", async () => {
    const circuit = makeClassifierCircuit(deadPort(), { faultThreshold: 2 });
    for (let i = 0; i < 2; i++) await circuit.port("mbx-1")!.classify(INPUT).catch(() => undefined);
    expect(circuit.state()).toMatchObject({ open: true, opens: 1 });
  });
});

it("counts background note rewrite failures against the worker's classifier breaker", async () => {
  const rewriteScreener: NonNullable<ClassifierPort["rewriteScreener"]> = async () => {
    throw new Error("Synthetic provider outage");
  };
  const circuit = makeClassifierCircuit({ ...okPort(), rewriteScreener }, { faultThreshold: 1 });
  const request = {
    system: "Rewrite the note",
    input: { language: "en", previous: "", choices: [], maxWords: 250, maxBytes: 2048 },
    schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
    maxTokens: 512,
  } as const;
  await expect(circuit.port()!.rewriteScreener!(request)).rejects.toBeInstanceOf(ClassifierFaultError);
  expect(circuit.port()).toBeUndefined();
});

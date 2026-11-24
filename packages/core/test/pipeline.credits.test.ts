import { describe, it, expect } from "vitest";
import { classifyAttemptKey, classifyLedgerSource, ledgerSources } from "@trafficflow/db";
import { sourceFor } from "@trafficflow/db";
import type { SpendAction, SpendOutcome, SpendRelease } from "@trafficflow/db";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import { FakeRepo, FakeRouting, dedupKeyFor } from "./fakes.js";
import type { Change, CreditGate } from "../src/ports.js";
import type { ClassifierPort, ClassifierInput, ClassifierResult } from "../src/ai/classify.js";

/**
 * THE DEGRADATION PROOF.
 *
 * The acceptance criterion is not "a flag was set" but "the OUTPUT is the same". So every
 * assertion below compares whole serialized plans and whole serialized repo states between
 * three runs of the identical message:
 *
 *   A. no classifier at all          — the Phase-0 rules-only path;
 *   B. classifier + a REFUSING gate  — the out-of-credits path;
 *   C. classifier + a PERMITTING gate — the metered AI path.
 *
 * A ≡ B is the requirement. A ≢ C is what makes A ≡ B mean anything: if the AI branch were
 * dead for some unrelated reason, A ≡ B would hold trivially and the test would pass while
 * proving nothing. Both directions are asserted.
 */

const FEED: ClassifierResult = {
  destination: "ohmail/News", confidence: 0.95, rationale: "newsletter", spam: false,
};

class SpyClassifier implements ClassifierPort {
  calls = 0;
  constructor(private readonly result: ClassifierResult | Error) {}
  async classify(_input: ClassifierInput): Promise<ClassifierResult> {
    this.calls++;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

/**
 * The smallest thing that satisfies the pipeline's one-method `{ spend }` shape.
 *
 * `asked` collects ATTEMPT KEYS, not sources: the pipeline hands the port a bare key and whoever
 * answers composes `<namespace>:<key>`. The cases below assert the key, and the one that cares
 * about the composed bytes asserts them through the composer.
 */
function gate(answer: boolean): CreditGate & { asked: string[] } {
  const g = {
    asked: [] as string[],
    async spend(_a: string, _action: SpendAction, key: string): Promise<SpendOutcome> {
      g.asked.push(key);
      return answer
        ? { verdict: "ok", charged: true, attempt: `classify:${key}` }
        : { verdict: "insufficient", reason: "out_of_credits" };
    },
  };
  return g;
}

/** A gate that also records releases, for the classifier-throw path. */
function recordingGate(answer: boolean): CreditGate & {
  asked: string[]; refunded: string[]; release(a: string, r: SpendRelease): Promise<"settled">;
} {
  const g = {
    asked: [] as string[],
    refunded: [] as string[],
    async spend(_a: string, _action: SpendAction, key: string): Promise<SpendOutcome> {
      g.asked.push(key);
      return answer
        ? { verdict: "ok", charged: true, attempt: `classify:${key}` }
        : { verdict: "insufficient", reason: "out_of_credits" };
    },
    async release(_a: string, r: SpendRelease): Promise<"settled"> {
      if (r.refund) g.refunded.push(r.attempt);
      return "settled";
    },
  };
  return g;
}

function eml(opts: { from?: string; subject?: string; body?: string; messageId?: string } = {}): Buffer {
  const {
    from = "friend@known.example", subject = "hey", body = "just a normal note about lunch",
    messageId = "s8-1@known.example",
  } = opts;
  return Buffer.from([
    `Message-ID: <${messageId}>`,
    `From: ${from}`,
    "To: mila@lichtgrat.example",
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "", body,
  ].join("\r\n"));
}

const createChange = (raw: Buffer, folder = "INBOX", ref = "1:10"): Change =>
  ({ type: "create", locator: { folder, ref }, raw });

const ACCOUNT = "acct-1";
const MAILBOX = "mb-1";

/** A fresh repo whose sender is KNOWN, so rules leave the message in the `unclear` residue. */
function freshRepo(): FakeRepo {
  const repo = new FakeRepo();
  repo.senders.add("friend@known.example");
  return repo;
}

interface RunResult {
  plan: string;          // the serialized ChangePlan — the byte-identical subject
  committed: string;     // the serialized repo state after commitChange
  classifierCalls: number;
}

async function run(
  change: Change,
  opts: { classifier?: SpyClassifier; credits?: CreditGate; readModelConsent?: () => Promise<boolean> } = {},
): Promise<RunResult> {
  const repo = freshRepo();
  const routing = new FakeRouting();
  const plan = await planChange(change, {
    repo, accountId: ACCOUNT, mailboxId: MAILBOX,
    classifier: opts.classifier,
    routing: opts.classifier ? routing : undefined,
    credits: opts.credits, readModelConsent: opts.readModelConsent,
  });
  const res = await commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
    repo, accountId: ACCOUNT, mailboxId: MAILBOX, routing: opts.classifier ? routing : undefined,
  });
  return {
    plan: JSON.stringify(plan),
    committed: JSON.stringify({
      result: res,
      rows: [...repo.rows.values()],
      folder: [...repo.folder.entries()],
      bodies: [...repo.bodies.entries()],
      changes: repo.changes.map((c) => ({ ...c, seq: String(c.seq) })),
      audits: repo.audits,
      decisions: routing.decisions,
      approvals: routing.approvals,
    }),
    classifierCalls: opts.classifier?.calls ?? 0,
  };
}

describe("a REFUSING credit gate degrades to rules-only, byte-identically", () => {
  it("produces output identical to the no-classifier path — plan AND every persisted row", async () => {
    const change = createChange(eml());

    const noClassifier = await run(change);
    const refused = await run(change, { classifier: new SpyClassifier(FEED), credits: gate(false) });

    // THE assertion: the serialized plan is character-for-character the same.
    expect(refused.plan).toBe(noClassifier.plan);
    // …and so is everything the commit wrote — rows, folder_state, change_log, audits, and
    // the routing_decisions/approvals the AI branch would otherwise have produced.
    expect(refused.committed).toBe(noClassifier.committed);
    // Supporting evidence, not the claim: the model was never reached.
    expect(refused.classifierCalls).toBe(0);
  });

  it("BITES: the permitting gate produces a DIFFERENT output, so the equality above is not vacuous", async () => {
    const change = createChange(eml());

    const noClassifier = await run(change);
    const permitted = await run(change, { classifier: new SpyClassifier(FEED), credits: gate(true) });

    expect(permitted.plan).not.toBe(noClassifier.plan);
    expect(permitted.committed).not.toBe(noClassifier.committed);
    expect(permitted.classifierCalls).toBe(1);
    // The AI plan really is there, with the classifier's verdict in it.
    expect(JSON.parse(permitted.plan).new.ai.result.destination).toBe("ohmail/News");
  });

  it("an ABSENT gate is unmetered, not refused — identical to the permitting gate", async () => {
    const change = createChange(eml());

    const unmetered = await run(change, { classifier: new SpyClassifier(FEED) });
    const permitted = await run(change, { classifier: new SpyClassifier(FEED), credits: gate(true) });

    expect(unmetered.plan).toBe(permitted.plan);
    expect(unmetered.committed).toBe(permitted.committed);
    expect(unmetered.classifierCalls).toBe(1);
  });

  it("asks for exactly one debit, under the classify source for this mailbox + dedup key", async () => {
    const g = gate(true);
    await run(createChange(eml()), { classifier: new SpyClassifier(FEED), credits: g });

    expect(g.asked).toEqual([classifyAttemptKey(MAILBOX, await dedupKeyFor(eml()))]);
    // The namespace the ledger's CHECK requires of a `debit_classify` row.
    // The namespace is the COMPOSER's to add, and adding it here as well is what charged an
    // already-paid attempt twice. The key must NOT carry it.
    expect(g.asked[0]!.startsWith("classify:")).toBe(false);
    expect(sourceFor("classify_ingest", g.asked[0]!)).toBe(
      classifyLedgerSource(MAILBOX, await dedupKeyFor(eml())));
  });
});

describe("the gate is asked LAST, so sensitivity decides before money does", () => {
  it("NEVER asks for a debit for a no_ai message — the short-circuit is the enforcement", async () => {
    const g = gate(true);
    const classifier = new SpyClassifier(FEED);
    const otp = eml({
      subject: "Your verification code", body: "Your one-time passcode is 448213.",
      messageId: "otp-1@bank.example",
    });

    const out = await run(createChange(otp), { classifier, credits: g });

    // No debit was even ASKED for, so no ledger row can exist. (The authoritative version of
    // this assertion ran against a real `credit_ledger` in
    // the services suite's metering test until metering left this journal — a spy proves the call did not happen,
    // the ledger proves no money moved.)
    expect(g.asked).toEqual([]);
    expect(classifier.calls).toBe(0);
    // And the message still routed: sensitive mail short-circuits to INBOX.
    expect(JSON.parse(out.plan).new.desired).toBe("INBOX");
    expect(JSON.parse(out.plan).new.sensitivity.flags.no_ai).toBe(true);
  });

  it("NEVER asks for a debit when a RULE already decided — no AI, so no charge", async () => {
    const g = gate(true);
    const repo = freshRepo();
    repo.rules = [{
      id: "r1", kind: "sender", match: "friend@known.example", destination: "ohmail/Receipts",
      effect: "allow", priority: 5, provenance: "manual", enabled: true,
    }];
    const routing = new FakeRouting();

    const plan = await planChange(createChange(eml()), {
      repo, accountId: ACCOUNT, mailboxId: MAILBOX,
      classifier: new SpyClassifier(FEED), routing, credits: g,
    });

    expect(g.asked).toEqual([]);
    expect(plan.new!.ai).toBeUndefined();
    expect(plan.new!.desired).toBe("ohmail/Receipts");
  });
});

describe("a classifier that throws NEVER refunds: the free retry is the compensation", () => {
  it("charges once, refunds NOTHING, and lets the original error propagate", async () => {
    // The composition this pins, and the money bug it replaces. `credit_ledger` is append-only
    // and the classify source is retry-stable, so a refunded charge left the debit row behind:
    // the next cycle's debit answered `duplicate → proceed` and the classification was
    // delivered for nothing. A model outage would have classified the whole retry backlog free.
    //
    // Exactly one of "the retry is free" and "the failure is refunded" may be true. The retry
    // is the one that is GUARANTEED here — the rethrow below leaves the message un-ingested and
    // the sync cursor unadvanced — so it is the one that keeps the charge honest.
    const g = recordingGate(true);
    const boom = new Error("anthropic 503");

    await expect(planChange(createChange(eml()), {
      repo: freshRepo(), accountId: ACCOUNT, mailboxId: MAILBOX,
      classifier: new SpyClassifier(boom), routing: new FakeRouting(), credits: g,
    })).rejects.toThrow("anthropic 503");

    const key = classifyAttemptKey(MAILBOX, await dedupKeyFor(eml()));
    expect(g.asked).toEqual([key]);
    expect(g.refunded).toEqual([]);
    // The shape a refund WOULD have taken, kept as documentation of what is not written here.
    const source = sourceFor("classify_ingest", key);
    expect(ledgerSources.refund(source)).toBe(`refund:${source}`);
  });

  it("does not refund when the classifier succeeds either — the pipeline never refunds", async () => {
    const g = recordingGate(true);
    await planChange(createChange(eml()), {
      repo: freshRepo(), accountId: ACCOUNT, mailboxId: MAILBOX,
      classifier: new SpyClassifier(FEED), routing: new FakeRouting(), credits: g,
    });
    expect(g.refunded).toEqual([]);
  });

  it("the RETRY is charged nothing: the same mail re-planned asks the same source", async () => {
    // Why the absent refund costs the customer nothing. The source is a pure function of
    // (mailbox, dedupKey), so the next cycle asks for the identical source — which the gate
    // answers `duplicate → proceed` against the surviving debit row. One charge, one delivered
    // classification, however many cycles the outage lasts.
    const g = recordingGate(true);
    const deps = {
      repo: freshRepo(), accountId: ACCOUNT, mailboxId: MAILBOX,
      routing: new FakeRouting(), credits: g,
    };
    await expect(planChange(createChange(eml()), {
      ...deps, classifier: new SpyClassifier(new Error("anthropic 503")),
    })).rejects.toThrow("anthropic 503");
    const plan = await planChange(createChange(eml()), { ...deps, classifier: new SpyClassifier(FEED) });

    const key = classifyAttemptKey(MAILBOX, await dedupKeyFor(eml()));
    expect(g.asked).toEqual([key, key]);            // same identity, so the second is free
    expect(g.refunded).toEqual([]);
    expect(plan.new!.ai).toBeDefined();             // and the retry DELIVERS
  });

  it("RETHROWS rather than degrading: a model OUTAGE must not permanently mis-file the message", async () => {
    // The distinction this pins: out-of-credits is a business state and degrades to rules;
    // a classifier FAULT is transient and must leave the message un-ingested so the next
    // cycle retries it. Degrading here would file by rules once and never look again.
    const g = recordingGate(true);
    await expect(planChange(createChange(eml()), {
      repo: freshRepo(), accountId: ACCOUNT, mailboxId: MAILBOX,
      classifier: new SpyClassifier(new Error("timeout")), routing: new FakeRouting(), credits: g,
    })).rejects.toThrow("timeout");
  });
});

/**
 * WHAT THE LEDGER IS ALLOWED TO REMEMBER.
 *
 * `credit_ledger` is APPEND-ONLY: there is no delete path, and a value written into it is in
 * backups for good. The pipeline used to charge a classification with
 * `tryDebit(source, { mailboxId, dedupKey: key })`, and `key` is `mid:${messageIdHeader}` —
 * the raw RFC822 Message-ID, chosen by the SENDING server, carrying the sender's domain and,
 * for most ESPs, the recipient's address. The "Account isolation is absolute, and it binds staff too" invariant names both.
 *
 * The first staff change closed the admin console's *render* path. That stopped staff SEEING it and removed
 * nothing from disk. This is the producer half.
 *
 * ── WHY THIS ASSERTS A CENSUS AND NOT A FIELD NAME ──────────────────────────────────────
 *
 * `expect(meta.dedupKey).toBeUndefined()` would pass the moment someone adds the same value
 * back under `messageKey`, `ref`, or inside a nested bag "for debugging" — which is exactly
 * how this arrived. So the assertion is over the SERIALIZED meta: no remote-controlled string
 * appears anywhere in it, under any key, at any depth. A new field carrying the sender's
 * identity fails this test without anyone having to predict its name.
 */
describe("the credit ledger never learns who wrote to you", () => {
  /** A gate that records the whole meta bag, which the other fakes in this file discard. */
  function metaGate(): CreditGate & { metas: unknown[]; sources: string[] } {
    const g = {
      metas: [] as unknown[],
      sources: [] as string[],
      async spend(
        _a: string, action: SpendAction, key: string, meta?: Record<string, unknown>,
      ): Promise<SpendOutcome> {
        // The SOURCE, composed the way whoever answers would compose it — so this census still
        // reads what the append-only ledger would hold, not the key on its way there.
        g.sources.push(sourceFor(action, key));
        g.metas.push(meta);
        return { verdict: "ok", charged: true, attempt: sourceFor(action, key) };
      },
    };
    return g;
  }

  // The sender must be one the rules leave UNCLEAR, or the deterministic layer routes the mail
  // and the AI branch — the only thing that charges — never runs. The sender here is the
  // known sender this file's `freshRepo()` is built around.
  //
  // The Message-ID is the realistic worst case rather than an invented one: ESP bounce
  // addresses routinely encode the RECIPIENT, so one Message-ID can carry both parties.
  //
  // A later change added a SECOND layer under this one — `dedup_key` is now `fp1:<sha256>` rather
  // than `mid:<the raw header>`, so the plaintext no longer travels even as far as the gate. That
  // makes the assertions below belt and braces, and they stay: the finding was `meta`, `meta` is
  // still hand-built at the call site, and a future field added there must fail here.
  const SENDER = "friend@known.example";
  const MID = "abc123.recipient=mila=40lichtgrat.example@bounce.marketing-vendor.invalid";

  it("charges the classification without putting the Message-ID, sender or recipient in meta", async () => {
    const credits = metaGate();
    await run(createChange(eml({ from: SENDER, messageId: MID })), {
      classifier: new SpyClassifier(FEED), credits,
    });

    expect(credits.metas).toHaveLength(1);              // the charge really happened
    const serialized = JSON.stringify(credits.metas[0] ?? {});

    for (const secret of [MID, "marketing-vendor.invalid", "mila", "mid:"]) {
      expect(serialized, `meta leaked "${secret}": ${serialized}`).not.toContain(secret);
    }
    // What it IS allowed to carry: our own identifiers, chosen by us.
    expect(JSON.parse(serialized)).toEqual({ mailboxId: MAILBOX });
  });

  it("the debit is still identified — `source` carries the hash, so nothing was lost", async () => {
    const credits = metaGate();
    await run(createChange(eml({ from: SENDER, messageId: MID })), {
      classifier: new SpyClassifier(FEED), credits,
    });

    // Identity survives the redaction: `source` is the hashed form and is what dedups a
    // charge, which is why the plaintext in `meta` was redundant as well as unsafe.
    expect(credits.sources[0]).toBe(classifyLedgerSource(MAILBOX, await dedupKeyFor(eml({ from: SENDER, messageId: MID }))));
    expect(credits.sources[0]).not.toContain(MID);
  });
});

it("drops live classification when consent is withdrawn after the debit", async () => {
  const credits = recordingGate(true);
  let reads = 0;
  const result = await run(createChange(eml()), {
    classifier: new SpyClassifier(FEED), credits,
    readModelConsent: async () => ++reads === 1,
  });
  expect(result.classifierCalls).toBe(0);
  expect(credits.refunded).toHaveLength(1);
});

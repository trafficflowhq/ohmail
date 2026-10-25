import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, contacts, folderState, mailboxes, messages, routingDecisions,
  rules, screenerLedgerSource, SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS,
  type Tx,
} from "@trafficflow/db";
import { creditRefundObligations, pendingRefundObligations, refundObligationsOn, schema } from "@trafficflow/db/cloud";
import { screenerAttemptKey } from "@trafficflow/db";
import type { RefundObligationPort, SpendPort } from "@trafficflow/db";
import { fakeSpendPort, type FakeSpendPort } from "./_spendport.js";
import ts from "typescript";
import { createLogger, makeHaikuClassifier, SensitivePayloadRefusal, type AnthropicLike } from "@trafficflow/core";
import type { ClassifierInput, ClassifierPort, ClassifierResult, LogFields, Logger }
  from "@trafficflow/core";
import {
  screenerAutoSuggestPass, AUTO_SUGGEST_BATCH, DECLINE_COOLDOWN_MS, makeDeclineMemory,
} from "../src/screener-auto-suggest.js";

/**
 * SCR-AUTOSUGGEST — the worker pass that buys the model's advice about INCOMING held senders,
 * against REAL POSTGRES.
 *
 * ## Why real Postgres and not PGlite
 *
 * Every assertion here is about MONEY, and the credit ledger's exactly-once guarantees are
 * database objects rather than application code: `UNIQUE (account_id, source)` is what makes a
 * second `spend` over one message a `duplicate` instead of a second charge, and a trigger is what
 * refuses a refund of a debit that does not exist. A PGlite green would say nothing about either,
 * and would say nothing about `storeScreenerSuggestion`'s per-message transaction under a pool.
 *
 * ## The four claims, and the mutation that turns each one red
 *
 *  1. the WATERMARK — drop the `created_at > auto_suggest_at` predicate in `selectCandidates` and
 *     the pre-opt-in sender is classified and charged for;
 *  2. the GATE — move the `spend()` call below `askScreeningQuestion` and an empty balance sends
 *     mail to a third party before finding out it may not;
 *  3. the CAP — raise `AUTO_SUGGEST_BATCH`, or loop pages, and one cycle buys the whole queue;
 *  4. the OPT-IN — remove the `if (!watermark) return EMPTY()` line and an account that never
 *     turned this on is charged;
 *  5. the SENSITIVITY EXCLUSION — drop `eq(reps.noAi, false)` / `isNull(reps.sensitivityCategory)`
 *     from `selectCandidates` and a passcode mail is charged for and shipped to the model with
 *     nobody having pressed anything. The spy is the claim, not the absence of a stored row.
 *  6. the PER-SENDER ENTITLEMENT — restore `selectCandidates`' second predicate to
 *     `rd.message_id = ${reps.messageId}` and a sender who simply sends again is bought a second
 *     time, then a third, ten a cycle, until the balance is gone (SEC3-MONEY-3). It is the only
 *     bound here that is not spent per MESSAGE, which is what makes the other four a rate limit
 *     rather than a ceiling: the party choosing how many messages exist is the sender.
 *
 * (The count in the heading above has been wrong since the sensitivity work added the fifth. Six.)
 */

const AVAILABLE = await realPgAvailable();
const SCREENER = "ohmail/Screener";
/** The instant every world's consent begins. Held mail is seeded either side of it. */
const OPTED_IN_AT = new Date("2026-08-01T00:00:00Z");
const BEFORE = new Date("2026-07-20T00:00:00Z");
const AFTER = new Date("2026-08-02T00:00:00Z");

/** A classifier that records every question and answers the same way. */
function spyClassifier(opts: { throws?: boolean } = {}): ClassifierPort & {
  screened: ClassifierInput[]; routed: ClassifierInput[];
} {
  const screened: ClassifierInput[] = [];
  const routed: ClassifierInput[] = [];
  const answer = async (input: ClassifierInput, into: ClassifierInput[]): Promise<ClassifierResult> => {
    into.push(input);
    if (opts.throws) throw new Error("model 503");
    return { destination: "ohmail/News", confidence: 0.8, rationale: "a newsletter", spam: false };
  };
  return {
    screened, routed,
    classify: (input) => answer(input, routed),
    screen: (input) => answer(input, screened),
  };
}

interface World { accountId: string; mailboxId: string; gate: FakeSpendPort }

describe.skipIf(!AVAILABLE)("SCR-AUTOSUGGEST — the worker's auto-suggest pass", () => {
  let db: Tx;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
  }, 120_000);

  /** An account with a spend budget and (optionally) the opt-in already on. */
  async function newWorld(o: { credits?: number; optedInAt?: Date | null } = {}): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `sug-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `sug-${accountId.slice(0, 8)}@example.test`,
    }).returning();

    const optedInAt = o.optedInAt === undefined ? OPTED_IN_AT : o.optedInAt;
    await db.insert(accountSettings).values({ accountId, autoSuggestAt: optedInAt });

    // THE PORT, RECORDING, with the account's budget as a counter — `credits` names how many
    // spends it will admit before it answers `insufficient`. Per world, so one account's budget
    // is not another's, exactly as a per-account balance was.
    const gate = fakeSpendPort();
    gate.exclusive();
    gate.budget(o.credits ?? 100);
    return { accountId, mailboxId: mb!.id, gate };
  }

  /** Turn the opt-in on or off, the way the Settings row does. */
  async function setOptIn(w: World, at: Date | null): Promise<void> {
    await db.update(accountSettings).set({ autoSuggestAt: at })
      .where(eq(accountSettings.accountId, w.accountId));
  }

  /** What the sender check reads beside the address, when a case has something to say about it. */
  interface HeldOpts { subject?: string; snippet?: string; fromName?: string; authVerdict?: string }

  /** One first-contact sender HELD at the gate, ingested at `at`. Returns its message id. */
  async function held(w: World, from: string, at: Date, o: HeldOpts = {}): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId,
      bodyHash: "h", dedupKey: `sug:${randomUUID()}`,
      subject: o.subject ?? `hello from ${from}`, fromAddress: from,
      snippet: o.snippet ?? "a first message",
      ...(o.fromName ? { fromName: o.fromName } : {}),
      ...(o.authVerdict ? { authVerdict: o.authVerdict } : {}),
      // The header date is DELIBERATELY older than the watermark on every row here: nothing in
      // the pass may read it, so a candidate that survives is a candidate the ingest stamp let
      // through. See `selectCandidates` — the sender does not get to hold our clock.
      date: BEFORE,
      createdAt: at,
      nativeLocator: { folder: SCREENER, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  async function suggestionsOf(w: World): Promise<Array<{ messageId: string; destination: string; status: string }>> {
    return db.select({
      messageId: routingDecisions.messageId,
      destination: routingDecisions.destination,
      status: routingDecisions.status,
    }).from(routingDecisions)
      .where(and(
        eq(routingDecisions.accountId, w.accountId),
        eq(routingDecisions.inputProvenance, SCREENER_SUGGESTION_PROVENANCE),
      ))
      .orderBy(asc(routingDecisions.createdAt), asc(routingDecisions.id));
  }

  /**
   * WHAT THE PASS WAS CHARGED FOR, in the order it asked — read off the port's own record.
   *
   * `delta: -1` is kept in the shape so every expectation below reads as it did: one screening
   * is one credit by the terms table (`SPEND_ACTIONS`), and the source is what a ledger row
   * would have been keyed on. An `ok` verdict is a charge; every other verdict is not.
   */
  async function debitsOf(w: World): Promise<Array<{ delta: number; source: string }>> {
    return w.gate.spends
      .filter((c) => c.accountId === w.accountId && c.action === "screener")
      .filter((c) => c.outcome.verdict === "ok")
      .map((c) => ({ delta: -1, source: c.source }));
  }

  /* ── 7. WHO THE SENDER REALLY IS ──────────────────────────────────────────────────────
   *
   * The measured defect, from a live Screener: two first-time senders at unrelated
   * domains, one "your domain expires in 2 days" subject between them, both suggested
   * `ohmail/News` at 0.95 as "an automated service notification from your hosting provider".
   * The model was asked to spot a forged sender with every fact about the sender withheld.
   * Mutations that turn these red: delete the `capSuggestion` call before `storeScreenerSuggestion`
   * (the stored row is the model's again); drop `senderFacts` from the request (the model is
   * asked blind); pass one candidate at a time to `senderCheckAll` (no campaign can ever be seen).
   */

  it("stores Quarantine over the model's answer when the address is not the company's", async () => {
    const w = await newWorld({ credits: 50 });
    const id = await held(w, "info@domain-renewals-ch.example", AFTER, {
      fromName: "Kundensupport",
      subject: "Metanet-Hosting: Ihre Domain läuft in den nächsten 2 Tagen ab",
      snippet: "Ihre bei metanet registrierte Domain läuft ab. Jetzt verlängern.",
    });
    const spy = spyClassifier();

    const res = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate as unknown as SpendPort,
    });

    expect(res.bought).toBe(1);
    const [row] = await db.select({
      destination: routingDecisions.destination, confidence: routingDecisions.confidence,
      spam: routingDecisions.spam, rationale: routingDecisions.rationale,
    }).from(routingDecisions).where(eq(routingDecisions.messageId, id));
    expect(row!.destination).toBe("ohmail/Quarantine");
    expect(row!.spam).toBe(true);
    expect(row!.confidence).toBeGreaterThanOrEqual(0.9);
    // The model's sentence explained the other verdict, so it is not stored under this one.
    expect(row!.rationale).toBe("");

    // …and it was TOLD, before it answered: the facts are ohmail's, the verdict is not.
    const asked = spy.screened[0] as ClassifierInput & { senderFacts?: string };
    expect(asked.senderFacts).toContain("domain-renewals-ch.example");
    expect(asked.senderFacts).toContain("metanet.ch");
    expect(asked.senderFacts).not.toMatch(/quarantine|spam/i);
    // ONE model call, ONE credit: the check is free and buys nothing.
    expect(spy.screened).toHaveLength(1);
    expect(await debitsOf(w)).toHaveLength(1);
  });

  it("sees one subject arriving from unrelated strangers — a fact no single message carries", async () => {
    const w = await newWorld({ credits: 50 });
    const subject = "Your parcel could not be delivered today";
    await held(w, "a@parcel-notice.example", AFTER, { subject, snippet: "Confirm your address." });
    await held(w, "b@delivery-update.example", AFTER, { subject, snippet: "Confirm your address." });
    const spy = spyClassifier();

    await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate as unknown as SpendPort,
    });

    const stored = await suggestionsOf(w);
    expect(stored).toHaveLength(2);
    expect(stored.every((r) => r.destination === "ohmail/Quarantine")).toBe(true);
    expect((spy.screened[0] as ClassifierInput & { senderFacts?: string }).senderFacts)
      .toContain("2 unrelated first-time senders");
  });

  it("no signal: the stored row is the model's own answer and the request carries no facts", async () => {
    const w = await newWorld({ credits: 50 });
    const id = await held(w, "anna@studio-nord.example", AFTER, {
      fromName: "Anna Brunner", subject: "Quick question about Thursday",
      snippet: "Are you free after four?",
    });
    const spy = spyClassifier();

    await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate as unknown as SpendPort,
    });

    const [row] = await db.select({
      destination: routingDecisions.destination, confidence: routingDecisions.confidence,
      spam: routingDecisions.spam, rationale: routingDecisions.rationale,
    }).from(routingDecisions).where(eq(routingDecisions.messageId, id));
    expect(row!.destination).toBe("ohmail/News");
    expect(row!.confidence).toBeCloseTo(0.8, 5);
    expect(row!.spam).toBe(false);
    expect(row!.rationale).toBe("a newsletter");
    expect((spy.screened[0] as ClassifierInput & { senderFacts?: string }).senderFacts)
      .toBeUndefined();
  });

  /* ── 1. THE WATERMARK ─────────────────────────────────────────────────────────────────── */

  it("buys for a sender held AFTER the opt-in, and never asks about one held BEFORE it", async () => {
    const w = await newWorld({ credits: 50 });
    const oldId = await held(w, "before@example.test", BEFORE);
    const newId = await held(w, "after@example.test", AFTER);
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(result.ran).toBe(true);
    expect(result.bought).toBe(1);
    expect(result.chargedAttempts).toBe(1);

    // THE SPY IS THE CLAIM. Not "the old sender has no row" — a row could be absent for a dozen
    // reasons — but "the old sender's subject was never sent anywhere".
    expect(spy.screened.map((i) => i.from.address)).toEqual(["after@example.test"]);
    expect(spy.routed, "the SCREENING question, not the routing one").toEqual([]);

    const stored = await suggestionsOf(w);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.messageId).toBe(newId);
    expect(stored[0]!.destination).toBe("ohmail/News");
    expect(stored[0]!.status).toBe(SCREENER_SUGGESTION_STATUS);
    expect(stored.some((r) => r.messageId === oldId)).toBe(false);

    // THE MONEY MOVED, once, under the shared Screener source — the same string the client's
    // on-open batch and the manual ladder use, which is what makes a double-buy a `duplicate`.
    expect(await debitsOf(w)).toEqual([{ delta: -1, source: screenerLedgerSource(newId) }]);
  });

  it("each candidate's release carries its own model call's line, as screener, success or fault", async () => {
    /** Reports through the call's hook, as the real client does, then answers or throws. */
    const reporting = (throws: boolean): ClassifierPort => ({
      classify: async () => { throw new Error("the ingest question is never asked here"); },
      screen: async (_input, call) => {
        call?.onUsage?.({
          model: "claude-haiku-4-5-20251001", ok: !throws, status: throws ? 503 : 200, latencyMs: 1, attempts: 1,
          requestId: "req_s", inputTokens: throws ? null : 700, outputTokens: throws ? null : 40,
          cacheReadTokens: throws ? null : 0, cacheWriteTokens: throws ? null : 0, thinkingTokens: null,
          costMicroUsd: throws ? null : 900,
        });
        if (throws) throw new Error("model 503");
        return { destination: "ohmail/News", confidence: 0.8, rationale: "a newsletter", spam: false };
      },
    });
    const passthrough = (fn: (r: never) => void) => fn;
    for (const throws of [false, true]) {
      const w = await newWorld({ credits: 50 });
      await held(w, `usage-${String(throws)}@example.test`, AFTER);
      await screenerAutoSuggestPass(db, {
        accountId: w.accountId, classifier: reporting(throws), credits: w.gate, usageHook: passthrough as never,
      });
      expect(w.gate.releases.map((r) => r.usage)).toEqual([[expect.objectContaining({
        accountId: w.accountId, action: "screener", host: "worker", ok: !throws,
      })]]);
    }
  });

  it("the payload carries the REDACTED subject and declares itself prescreened", async () => {
    // The credential-bearing case, on the path that spends without a press in the same minute.
    // `askScreeningQuestion` runs `redactForModel` at the caller, because a port has
    // implementations outside this repository that receive the input object directly.
    const w = await newWorld({ credits: 50 });
    const id = await held(w, "bank@example.test", AFTER);
    await db.update(messages).set({ subject: "Your code is 482913", snippet: "Your code is 482913" })
      .where(eq(messages.id, id));
    const spy = spyClassifier();

    await screenerAutoSuggestPass(db, { accountId: w.accountId, classifier: spy, credits: w.gate });

    expect(spy.screened).toHaveLength(1);
    const sent = spy.screened[0]!;
    expect(sent.outbound).toBe("prescreened");
    expect(sent.subject).not.toContain("482913");
    expect(sent.snippet).not.toContain("482913");
  });

  /* ── 1a. THE DECIDED SENDER — nothing is bought about somebody no surface asks about ───── */

  /**
   * THE MONEY ARGUMENT, and it is the one this query's cutline arm already makes.
   *
   * 0.19.0 stopped the Screener listing a sender this account has already decided on — an enabled
   * allow rule, or a `contacts` row. This pass builds its OWN candidate set, so without the same
   * predicate it would go on buying the model's advice about senders no surface shows: money spent
   * on a question nobody is being asked, at the choosing of anyone who can email the account.
   *
   * The spy is the claim, not the absence of a row.
   */
  it("buys nothing about a sender an allow rule or a contact has already decided", async () => {
    const w = await newWorld({ credits: 50 });
    await held(w, "ruled@example.test", AFTER);
    await held(w, "known@example.test", AFTER);
    const strangerId = await held(w, "stranger@example.test", AFTER);
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "ruled@example.test", destination: "INBOX",
      provenance: "seeded-from-sent", enabled: true, priority: 0,
    });
    await db.insert(contacts).values({ accountId: w.accountId, address: "known@example.test" });
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    // The STRANGER is the positive control: without one, a pass that buys nothing for any reason
    // of its own satisfies every assertion here.
    expect(spy.screened.map((i) => i.from.address)).toEqual(["stranger@example.test"]);
    expect(result.bought).toBe(1);
    expect(result.chargedAttempts).toBe(1);
    expect(await debitsOf(w)).toHaveLength(1);
    const stored = await suggestionsOf(w);
    expect(stored.map((r) => r.messageId)).toEqual([strangerId]);
  });

  /* ── 1b. THE SENSITIVITY EXCLUSION — flagged mail is not a candidate on an UNPRESSED path ─ */

  /**
   * THE INVARIANT THIS SECTION EXISTS FOR: nothing automatic sends flagged mail to a model.
   *
   * The user-pressed path deliberately does the opposite — `ScreenerService.suggest` asks about
   * every held sender and redacts at the sink, under the AI-OPEN ruling — and its guards in
   * `packages/services/test/screener-ai.test.ts` are untouched by everything below. The
   * distinguishing fact is the press: there, a person selected senders, saw a price and pressed;
   * here, a cron did. So the two paths are SUPPOSED to disagree, and each one's tests say so.
   *
   * Every assertion below is on the SPY, never on the absence of a stored row: a row can be
   * missing for a dozen reasons, and "the model was never asked" is the only claim worth making
   * about a privacy boundary.
   */
  it("a flagged representative is never asked about, never charged for, never stored", async () => {
    const w = await newWorld({ credits: 50 });
    const ordinary = await held(w, "shop@example.test", AFTER);
    const flagged = await held(w, "bank@example.test", new Date(AFTER.getTime() + 1000));
    await db.update(messages)
      .set({ subject: "Your sign-in code", snippet: "Use 482913 to sign in.", noAi: true, sensitivityCategory: "otp" })
      .where(eq(messages.id, flagged));
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    // THE PRIVACY CLAIM FIRST, so a regression is named by the leak rather than by a count that
    // happens to sit above it. Asserted three ways, because each is separately satisfiable by a
    // defect: the exact set of addresses the port was handed, no call carrying the flagged one,
    // and no digits of the passcode anywhere in the bytes.
    expect(spy.screened.map((i) => i.from.address)).toEqual(["shop@example.test"]);
    expect(
      spy.screened.some((i) => i.from.address === "bank@example.test"),
      "a flagged sender was sent to the model by a pass nobody pressed",
    ).toBe(false);
    const wire = spy.screened.map((i) => `${i.subject}\n${i.snippet}`).join("\n");
    expect(wire, "the passcode reached the port").not.toContain("482913");
    expect(spy.routed).toEqual([]);

    // The unflagged sender is unaffected — this pass still does its job.
    expect(result.ran).toBe(true);
    expect(result.bought).toBe(1);
    expect(result.chargedAttempts).toBe(1);

    const stored = await suggestionsOf(w);
    expect(stored.map((r) => r.messageId)).toEqual([ordinary]);
    expect(await debitsOf(w)).toEqual([{ delta: -1, source: screenerLedgerSource(ordinary) }]);
    // `examined` counts the page this pass actually held, so the flagged sender is not in it: the
    // exclusion is in the QUERY, not a skip inside the loop that a reordering could move below the
    // spend.
    expect(result.examined).toBe(1);
  });

  it("`no_ai` with a NULL category — the INDETERMINATE class — is excluded too", async () => {
    // The detector's third outcome, and the one an exclusion written as `sensitivity_category IS
    // NOT NULL` alone would miss: "I could not read this confidently" is routed into `no_ai` by
    // `sensitive.ts` precisely so a reader that fails open cannot exist. Mutation: delete the `noAi`
    // clause of `automaticAiAdmits` and keep the category one — this goes red, here and at the route.
    const w = await newWorld({ credits: 50 });
    const id = await held(w, "unknown@example.test", AFTER);
    await db.update(messages).set({ noAi: true, sensitivityCategory: null })
      .where(eq(messages.id, id));
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(spy.screened).toEqual([]);
    expect(result.bought).toBe(0);
    expect(await debitsOf(w)).toEqual([]);
  });

  it("a category with `no_ai` FALSE is excluded too — either flag is enough", async () => {
    // The other half of the pair, and it is a real state rather than a hypothetical: `no_ai` is a
    // column written at ingest and `sensitive-backfill.ts` exists because it is KNOWN-WRONG for
    // historical rows. A row whose category says `financial` while its boolean says false must not
    // be bought for by a pass nobody pressed. Mutation: delete `automaticAiAdmits`' category clause.
    const w = await newWorld({ credits: 50 });
    const id = await held(w, "statements@example.test", AFTER);
    await db.update(messages).set({ noAi: false, sensitivityCategory: "financial" })
      .where(eq(messages.id, id));
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(spy.screened).toEqual([]);
    expect(result.bought).toBe(0);
    expect(await debitsOf(w)).toEqual([]);
  });

  /**
   * THE FLAGGED-ONLY SENDER, PINNED — and the placement of the predicate is what this proves.
   *
   * The exclusion sits OUTSIDE the `DISTINCT ON`, so the representative is still chosen by the
   * rule the Screener surface uses (newest held, ties on id) and is THEN dropped for being
   * flagged. Written inside, this sender's older unflagged mail would be promoted to
   * representative and bought for — and the suggestion would be stored against a message that is
   * not the row on screen, which is the double-charge the composition exists to prevent.
   *
   * So: both messages, newest flagged, and the answer is that this sender is not suggested for at
   * all. Mutation: move either predicate into the inner query and `spy.screened` gains a call
   * carrying the OLDER message's subject.
   */
  it("a sender whose NEWEST held mail is flagged is not suggested — the older one is not promoted", async () => {
    const w = await newWorld({ credits: 50 });
    const older = await held(w, "mixed@example.test", AFTER);
    await db.update(messages).set({ subject: "last week's newsletter" }).where(eq(messages.id, older));
    const newer = await held(w, "mixed@example.test", new Date(AFTER.getTime() + 5000));
    await db.update(messages)
      .set({ subject: "Your sign-in code", date: new Date(AFTER.getTime() + 5000), noAi: true, sensitivityCategory: "otp" })
      .where(eq(messages.id, newer));
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(result.ran).toBe(true);
    expect(spy.screened, "an older message was promoted to representative and bought for").toEqual([]);
    expect(result.bought).toBe(0);
    expect(await suggestionsOf(w)).toEqual([]);
    expect(await debitsOf(w)).toEqual([]);
    // Stated as bytes as well as as a count, because this is the assertion that distinguishes
    // "excluded" from "promoted": `older` is the message a predicate pushed into the `DISTINCT ON`
    // would have sold instead.
    expect(
      spy.screened.some((i) => i.subject.includes("newsletter")),
      `the older message ${older} was promoted to representative and sold`,
    ).toBe(false);
  });

  it("a flagged sender does not consume a slot in the per-cycle page", async () => {
    // The exclusion is in the WHERE and not a `continue` inside the loop, so the cap still buys a
    // full page of eligible senders. A skip inside the loop would silently shrink the batch — and
    // would also mean the flagged row had already been selected, priced and reasoned about on the
    // spend side of the code, which is the shape this fix exists to remove.
    const w = await newWorld({ credits: 200 });
    for (let i = 0; i < AUTO_SUGGEST_BATCH; i++) {
      await held(w, `ok${String(i).padStart(2, "0")}@example.test`, new Date(AFTER.getTime() + i * 1000));
    }
    const flagged = await held(w, "bank@example.test", AFTER);
    await db.update(messages).set({ noAi: true, sensitivityCategory: "otp" })
      .where(eq(messages.id, flagged));
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(result.bought).toBe(AUTO_SUGGEST_BATCH);
    expect(spy.screened).toHaveLength(AUTO_SUGGEST_BATCH);
    expect(spy.screened.some((i) => i.from.address === "bank@example.test")).toBe(false);
  });

  /* ── 2. THE GATE ──────────────────────────────────────────────────────────────────────── */

  it("an EMPTY balance produces ZERO classifier invocations and ZERO stored rows", async () => {
    // Invariant #10, as control flow: the spend question is asked BEFORE the model question, so a
    // refusal cannot be preceded by a third party seeing a stranger's mail.
    const w = await newWorld({ credits: 0 });
    await held(w, "a@example.test", AFTER);
    await held(w, "b@example.test", AFTER);
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(result.ran).toBe(true);
    expect(result.bought).toBe(0);
    expect(result.chargedAttempts).toBe(0);
    expect(result.stopped).toBe("out_of_credits");
    expect(spy.screened, "nothing was sent to a model").toEqual([]);
    expect(spy.routed).toEqual([]);
    expect(await suggestionsOf(w)).toEqual([]);
    expect(await debitsOf(w)).toEqual([]);
  });

  it("ONE refused gate call per cycle — the refusal stops the account, it does not repeat", async () => {
    const w = await newWorld({ credits: 0 });
    for (let i = 0; i < 5; i++) await held(w, `s${i}@example.test`, AFTER);
    let spends = 0;
    const counting: SpendPort = {
      ...w.gate,
      spend: async (accountId, action, key, meta) => {
        spends++;
        return w.gate.spend(accountId, action, key, meta);
      },
    };

    await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spyClassifier(), credits: counting,
    });

    expect(spends, "five eligible senders, one gate call").toBe(1);
  });

  /**
   * AN ABSENT GATE IS NOT PERMISSION. A HOST HAS TO SAY IT METERS NOTHING.
   *
   * The desktop engine runs this same function against a tier that genuinely has no ledger, and
   * the way it does that is `unmetered: true` — a DECLARATION, never the mere absence of
   * `credits`. Which side of that line the code sits on is worth a test rather than a comment,
   * because the failure it prevents is silent in exactly one direction: infer "unmetered" from an
   * omission, and any future wiring mistake on THIS side (a `classifyGateFor` that answers
   * undefined for an account whose subscription row is missing, say) becomes a pass that spends an
   * allowance with no meter in front of it. Declared, the same mistake is a pass that does nothing.
   *
   * Mutation: change `if (!gate && !deps.unmetered)` to `if (!gate)` and the second case goes red;
   * change it to `if (false)` and the first does. Both were run.
   */
  it("no gate and no declaration ⇒ the pass does not run — an omission is never permission", async () => {
    const w = await newWorld({ credits: 50 });
    await held(w, "a@example.test", AFTER);
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, { accountId: w.accountId, classifier: spy });

    expect(result.ran).toBe(false);
    expect(spy.screened).toEqual([]);
    expect(await suggestionsOf(w)).toEqual([]);
  });

  it("a host that DECLARES it meters nothing runs, and moves not one credit", async () => {
    const w = await newWorld({ credits: 50 });
    await held(w, "a@example.test", AFTER);
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, unmetered: true,
    });

    expect(result.ran).toBe(true);
    expect(result.bought).toBe(1);
    expect(spy.screened).toHaveLength(1);
    expect(await suggestionsOf(w)).toHaveLength(1);
    // THE HALF THAT MATTERS ON THIS SIDE: no ledger row and no movement, even though this account
    // has a balance and a subscription. The declaration must skip the gate, never satisfy it with
    // a permissive stub — a second always-yes implementation of "may this account spend" is the
    // thing that would refuse nothing on the day somebody wired it here.
    expect(result.chargedAttempts).toBe(0);
    expect(await debitsOf(w)).toEqual([]);
  });

  /* ── 3. THE PER-CYCLE CAP, AND THE RESUME ─────────────────────────────────────────────── */

  it(`classifies exactly ${AUTO_SUGGEST_BATCH} of ${AUTO_SUGGEST_BATCH + 2} eligible senders, then resumes next cycle`, async () => {
    const w = await newWorld({ credits: 200 });
    const total = AUTO_SUGGEST_BATCH + 2;
    for (let i = 0; i < total; i++) {
      // Distinct ingest stamps, so "oldest first" is a real order and the resume is checkable.
      await held(w, `s${String(i).padStart(2, "0")}@example.test`, new Date(AFTER.getTime() + i * 1000));
    }

    const first = spyClassifier();
    const r1 = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: first, credits: w.gate,
    });
    expect(r1.bought).toBe(AUTO_SUGGEST_BATCH);
    expect(r1.capped).toBe(true);
    expect(first.screened).toHaveLength(AUTO_SUGGEST_BATCH);
    expect(first.screened.map((i) => i.from.address), "oldest first").toEqual(
      Array.from({ length: AUTO_SUGGEST_BATCH }, (_, i) => `s${String(i).padStart(2, "0")}@example.test`),
    );

    // THE CURSOR IS THE STORED SUGGESTION. No column, no cursor table: the second cycle finds the
    // first ten excluded by the `not exists` predicate and starts at the eleventh.
    const second = spyClassifier();
    const r2 = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: second, credits: w.gate,
    });
    expect(r2.bought).toBe(2);
    expect(r2.capped).toBe(false);
    expect(second.screened.map((i) => i.from.address)).toEqual([
      `s${String(AUTO_SUGGEST_BATCH).padStart(2, "0")}@example.test`,
      `s${String(AUTO_SUGGEST_BATCH + 1).padStart(2, "0")}@example.test`,
    ]);

    // A third cycle over a fully-bought queue asks nothing and charges nothing.
    const third = spyClassifier();
    const r3 = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: third, credits: w.gate,
    });
    expect(r3.bought).toBe(0);
    expect(third.screened).toEqual([]);
    expect(await debitsOf(w)).toHaveLength(total);
  });

  // The tail's clock: a pass whose clock has run buys the one sender it started and stops, charging
  // for that one only; the next call buys the next sender. Without the check all three go at once.
  it("stops at its clock after the first purchase, and the next call buys the next sender", async () => {
    const w = await newWorld({ credits: 200 });
    for (let i = 0; i < 3; i++) {
      await held(w, `clock${i}@example.test`, new Date(AFTER.getTime() + i * 1000));
    }
    const spy = spyClassifier();
    const r1 = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate, until: () => true,
    });
    expect(r1, "the clock did not stop the pass").toMatchObject({ bought: 1, capped: true });
    expect(await debitsOf(w), "a sender the clock stopped before was charged").toHaveLength(1);
    const r2 = await screenerAutoSuggestPass(db, { accountId: w.accountId, classifier: spyClassifier(), credits: w.gate });
    expect(r2.bought).toBe(2);
  });

  /* ── 4. THE OPT-IN, AND PULLING THE BRAKE ─────────────────────────────────────────────── */

  it("an account that never opted in is one PK read: no model call, no charge", async () => {
    const w = await newWorld({ credits: 50, optedInAt: null });
    await held(w, "a@example.test", AFTER);
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(result.ran).toBe(false);
    expect(spy.screened).toEqual([]);
    expect(await debitsOf(w)).toEqual([]);
  });

  it("turning it OFF stops the NEXT probe — the opt-in is re-read every cycle, never cached", async () => {
    const w = await newWorld({ credits: 50 });
    await held(w, "a@example.test", AFTER);
    const first = spyClassifier();
    expect((await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: first, credits: w.gate,
    })).bought).toBe(1);

    await setOptIn(w, null);
    await held(w, "b@example.test", AFTER);
    const second = spyClassifier();
    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: second, credits: w.gate,
    });

    expect(r.ran).toBe(false);
    expect(second.screened, "the brake works on the next cycle, not the next restart").toEqual([]);
    expect(await debitsOf(w)).toHaveLength(1);
  });

  /* ── A MODEL FAULT STOPS THE ACCOUNT, AND THE CHARGE BUYS THE RETRY ───────────────────── */

  it("a model fault stops this cycle after ONE charge, and the retry next cycle is free", async () => {
    const w = await newWorld({ credits: 50 });
    await held(w, "a@example.test", AFTER);
    await held(w, "b@example.test", new Date(AFTER.getTime() + 1000));

    const broken = spyClassifier({ throws: true });
    const r1 = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: broken, credits: w.gate,
    });
    expect(r1.stopped).toBe("model_unavailable");
    expect(r1.bought).toBe(0);
    expect(broken.screened, "the SECOND sender was never asked about").toHaveLength(1);
    expect(await debitsOf(w)).toHaveLength(1);

    // The ledger source is the MESSAGE, so the next attempt over it is a `duplicate`: the account
    // pays once for a suggestion it eventually receives, not once per outage.
    const working = spyClassifier();
    const r2 = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: working, credits: w.gate,
    });
    expect(r2.bought).toBe(2);
    expect(r2.chargedAttempts, "the first sender's retry cost nothing").toBe(1);
  });

  /* ── A DECLINE SKIPS ONE SENDER, AND THE BATCH GOES ON ─────────────────────────────────────
   *
   * Haiku 5.5's safety classifiers can refuse one sender's mail. Read as a fault, the pass STOPPED
   * at that sender every cycle — candidates run oldest first, so no other held sender was ever
   * asked — and kept a charge that bought nothing. Mutations: delete the pass's
   * `ModelDeclinedError` arm (the batch stops), its `declines.remember` (the decliner fills the
   * page again next cycle), or selection arm (7) (the held-out ids are selected anyway).
   */
  /** The real classifier over a client giving Anthropic's documented refusal (its refusals page,
   *  read 2026-10-12: HTTP 200, no content) for the named senders, and a screening answer otherwise. */
  function decliningClassifier(declines: ReadonlySet<string>): ClassifierPort & { asked: string[] } {
    const asked: string[] = [];
    const client = { messages: { create: async (params: unknown) => {
      const body = (params as { messages: { content: string }[] }).messages[0]!.content;
      const from = (JSON.parse(body) as { from: string }).from;
      asked.push(from);
      return declines.has(from)
        ? { content: [], stop_reason: "refusal", usage: { input_tokens: 900, output_tokens: 0 },
            stop_details: { type: "refusal", category: "cyber", explanation: "declined" } }
        : { content: [{ type: "text", text: JSON.stringify({ destination: "ohmail/News", confidence: 0.8, rationale: "a newsletter" }) }],
            stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 40 } };
    } } } as AnthropicLike;
    return Object.assign(makeHaikuClassifier({ client }), { asked });
  }
  const t0 = new Date("2026-08-03T00:00:00Z");

  it("a DECLINED sender is skipped and refunded, and the senders after it are still bought", async () => {
    const w = await newWorld({ credits: 50 });
    const a = await held(w, "a@example.test", AFTER);
    const b = await held(w, "b@example.test", new Date(AFTER.getTime() + 1000));
    const c = await held(w, "c@example.test", new Date(AFTER.getTime() + 2000));
    const classifier = decliningClassifier(new Set(["a@example.test"]));

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier, credits: w.gate, declines: makeDeclineMemory(), now: () => t0,
    });

    expect(r.stopped, "a decline stopped the batch").toBeUndefined();
    expect(r.bought).toBe(2);
    expect(r.chargedAttempts, "the refunded attempt was counted as a charge").toBe(2);
    expect(classifier.asked).toEqual(["a@example.test", "b@example.test", "c@example.test"]);
    expect((await suggestionsOf(w)).map((s) => s.messageId).sort()).toEqual([b, c].sort());
    const refunds = w.gate.releases.filter((x) => x.refund);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ action: "screener", attemptKey: screenerAttemptKey(a) });
  });

  it("a page full of decliners is held out for a day, so the sender behind them is reached", async () => {
    const w = await newWorld({ credits: 50 });
    await held(w, "a@example.test", AFTER);
    await held(w, "b@example.test", new Date(AFTER.getTime() + 1000));
    const c = await held(w, "c@example.test", new Date(AFTER.getTime() + 2000));
    const classifier = decliningClassifier(new Set(["a@example.test", "b@example.test"]));
    const declines = makeDeclineMemory();
    const pass = (at: Date) => screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier, credits: w.gate, declines, batch: 2, now: () => at,
    });

    expect((await pass(t0)).bought, "the page held only the two decliners").toBe(0);
    const r2 = await pass(t0);
    expect(r2.bought, "the decliners filled the page again").toBe(1);
    expect((await suggestionsOf(w)).map((s) => s.messageId)).toEqual([c]);
    expect(classifier.asked).toEqual(["a@example.test", "b@example.test", "c@example.test"]);

    // A day on, the model may answer differently: both are asked again, once.
    await pass(new Date(t0.getTime() + DECLINE_COOLDOWN_MS + 1));
    expect(classifier.asked.slice(3)).toEqual(["a@example.test", "b@example.test"]);
  });

  it("a declined sender who writes again is asked about the NEW message at once", async () => {
    const w = await newWorld({ credits: 50 });
    await resent(w, "a@example.test", 1);
    const classifier = decliningClassifier(new Set(["a@example.test"]));
    const declines = makeDeclineMemory();
    const pass = () => screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier, credits: w.gate, declines, now: () => t0,
    });
    await pass();
    await pass();
    expect(classifier.asked, "the declined representative was asked again inside its day").toHaveLength(1);
    await resent(w, "a@example.test", 2);
    await pass();
    expect(classifier.asked, "the sender's new message was held out with the old one").toHaveLength(2);
  });

  /* ── THE REFUND SURVIVES A FAILED DEBT WRITE; A SINK REFUSAL IS ONE SENDER'S ANSWER ──────────
   *
   * Real Postgres twins of `screener-auto-suggest-refund-door.test.ts`. The debt store is the REAL
   * one over this database, and a failing write or settle is a REAL failure: the same store over a
   * connection that has ended. Mutations: let the write's throw skip the release, or rethrow the
   * settle (`reverseCharge`); drop the pass's `SensitivePayloadRefusal` arm (the batch stops).
   */
  async function endedStore(): Promise<RefundObligationPort> {
    const ended = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    await ended.end();
    return refundObligationsOn(brandDialect(drizzle(ended, { schema }), "pg") as unknown as Tx);
  }

  function realLog(): { log: Logger; named: (event: string) => Array<Record<string, unknown>> } {
    const lines: Array<Record<string, unknown>> = [];
    const log = createLogger({ service: "worker", level: "debug", sink: (l) => { lines.push(JSON.parse(l) as Record<string, unknown>); } });
    return { log, named: (event) => lines.filter((l) => l.event === event) };
  }

  async function debtsOf(w: World): Promise<Array<{ attempt: string; reason: string; settled: boolean }>> {
    const rows = await db.select({
      attempt: creditRefundObligations.attempt, reason: creditRefundObligations.reason,
      settledAt: creditRefundObligations.settledAt,
    }).from(creditRefundObligations).where(eq(creditRefundObligations.accountId, w.accountId));
    return rows.map((r) => ({ attempt: r.attempt, reason: r.reason, settled: r.settledAt !== null }));
  }

  /** The attempt the gate said it charged for this message. */
  function chargedFor(w: World, messageId: string): string {
    const o = w.gate.spends.find((s) => s.attemptKey === screenerAttemptKey(messageId))!.outcome;
    return o.verdict === "ok" ? o.attempt : "";
  }

  it("a decline whose debt write FAILS on an ended connection: the refund is still released, and the batch goes on", async () => {
    const w = await newWorld({ credits: 50 });
    const a = await held(w, "a@example.test", AFTER);
    const b = await held(w, "b@example.test", new Date(AFTER.getTime() + 1000));
    const { log, named } = realLog();

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: decliningClassifier(new Set(["a@example.test"])), credits: w.gate,
      obligations: await endedStore(), log, declines: makeDeclineMemory(), now: () => t0,
    });

    expect(r.stopped).toBeUndefined();
    expect(r.bought).toBe(1);
    expect(w.gate.releases.filter((x) => x.refund), "the refund was skipped when its debt could not be written")
      .toEqual([expect.objectContaining({ attemptKey: screenerAttemptKey(a), attempt: chargedFor(w, a) })]);
    expect(await debtsOf(w)).toEqual([]);
    expect(named("screener_auto_suggest_refund_unrecorded"))
      .toEqual([expect.objectContaining({ accountId: w.accountId, attempt: chargedFor(w, a) })]);
    expect((await suggestionsOf(w)).map((s) => s.messageId)).toEqual([b]);
  });

  it("CONTROL: with the real store on this database the decline is owed, refunded and settled", async () => {
    const w = await newWorld({ credits: 50 });
    const a = await held(w, "a@example.test", AFTER);

    await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: decliningClassifier(new Set(["a@example.test"])), credits: w.gate,
      obligations: refundObligationsOn(db), declines: makeDeclineMemory(), now: () => t0,
    });

    expect(await debtsOf(w)).toEqual([{ attempt: chargedFor(w, a), reason: "drafter_failed", settled: true }]);
  });

  it("a settle that FAILS on an ended connection after a settled refund: the debt stays owed for the drain", async () => {
    const w = await newWorld({ credits: 50 });
    const a = await held(w, "a@example.test", AFTER);
    const live = refundObligationsOn(db);
    const ended = await endedStore();
    const { log, named } = realLog();

    await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: decliningClassifier(new Set(["a@example.test"])), credits: w.gate,
      obligations: { owe: (o) => live.owe(o), settle: (acct, att) => ended.settle(acct, att) }, log,
      declines: makeDeclineMemory(), now: () => t0,
    });

    expect(w.gate.releases.filter((x) => x.refund)).toHaveLength(1);
    expect(await pendingRefundObligations(db, w.accountId)).toEqual([
      expect.objectContaining({ attempt: chargedFor(w, a), reason: "drafter_failed" }),
    ]);
    expect(named("screener_auto_suggest_refund_settle_failed"))
      .toEqual([expect.objectContaining({ accountId: w.accountId, attempt: chargedFor(w, a) })]);
    expect(named("screener_auto_suggest_release_failed")).toEqual([]);
  });

  it("a refusal at the SINK is skipped, refunded through the real store and held out; the senders behind it are bought", async () => {
    const w = await newWorld({ credits: 50 });
    const a = await held(w, "a@example.test", AFTER);
    const b = await held(w, "b@example.test", new Date(AFTER.getTime() + 1000));
    const c = await held(w, "c@example.test", new Date(AFTER.getTime() + 2000));
    const asked: string[] = [];
    const answer = async (input: ClassifierInput): Promise<ClassifierResult> => {
      asked.push(input.from.address);
      if (input.from.address === "a@example.test") {
        throw new SensitivePayloadRefusal({ safe: false, category: null, reason: "credential_shape" });
      }
      return { destination: "ohmail/News", confidence: 0.8, rationale: "a newsletter", spam: false };
    };
    const classifier: ClassifierPort = { classify: answer, screen: answer };
    const declines = makeDeclineMemory();
    const pass = (at: Date) => screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier, credits: w.gate, obligations: refundObligationsOn(db), declines, now: () => at,
    });

    const r = await pass(t0);

    expect(r.stopped, "a refusal at the sink stopped the batch").toBeUndefined();
    expect(r).toMatchObject({ bought: 2, chargedAttempts: 2 });
    expect((await suggestionsOf(w)).map((s) => s.messageId).sort()).toEqual([b, c].sort());
    expect(w.gate.releases.filter((x) => x.refund))
      .toEqual([expect.objectContaining({ attemptKey: screenerAttemptKey(a), attempt: chargedFor(w, a) })]);
    expect(await debtsOf(w)).toEqual([{ attempt: chargedFor(w, a), reason: "drafter_failed", settled: true }]);

    await pass(t0);
    expect(asked, "the refused sender was asked again inside its day").toEqual(["a@example.test", "b@example.test", "c@example.test"]);
    await pass(new Date(t0.getTime() + DECLINE_COOLDOWN_MS + 1));
    expect(asked.slice(3)).toEqual(["a@example.test"]);
  });

  /* ── THE STORED-SKIP, ACROSS THE TWO BUYERS ───────────────────────────────────────────── */

  /* ── 5. THE PER-SENDER ENTITLEMENT (SEC3-MONEY-3) ──────────────────────────────────────────
   *
   * The pass bought one suggestion per SENDER and charged per MESSAGE. The representative is the
   * sender's NEWEST held message, so sending again promoted a message that carried no suggestion
   * row, satisfied the double-buy guard, satisfied the watermark, and was charged under a
   * brand-new ledger source — ten a cycle, until the balance was gone, at the choosing of anyone
   * who can email the account and with no user action after the opt-in.
   *
   * THE MUTATION for every test in this section: restore `selectCandidates`' second predicate to
   * `rd.message_id = ${reps.messageId}` (from `not ${screenerSuggestedSenderExists(...)}`). The
   * first test then reports TEN debits instead of one, and the rest go red with it. Run.
   */

  /** A newer held message for a sender, with a `Date:` that makes it their representative. */
  async function resent(w: World, from: string, nth: number): Promise<string> {
    const id = await held(w, from, new Date(AFTER.getTime() + nth * 60_000));
    // The REPRESENTATIVE is chosen on `coalesce(date, epoch) DESC, id DESC`, and `held` seeds every
    // row with one `Date:` on purpose (so nothing can pass by reading the sender's clock). A
    // re-send test needs the newest message to be identifiable, and `id DESC` cannot do it —
    // `messages.id` is `gen_random_uuid()`. So the header date is the ONLY thing moved here; the
    // watermark still reads `created_at`, which is `AFTER` for every row in this section.
    await db.update(messages).set({ date: new Date(AFTER.getTime() + nth * 60_000) })
      .where(eq(messages.id, id));
    return id;
  }

  it("a sender who sends TEN more times is bought for ONCE — the drain, closed", async () => {
    const w = await newWorld({ credits: 50 });
    const first = await resent(w, "stranger@example.test", 1);
    const spy = spyClassifier();

    const r1 = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });
    expect(r1.bought).toBe(1);
    expect(r1.chargedAttempts).toBe(1);

    // TEN more messages, each one becoming the representative, each followed by a cycle — which is
    // exactly what the finding describes: no aliases, no rotation, one sender pressing send.
    for (let n = 2; n <= 11; n++) {
      await resent(w, "stranger@example.test", n);
      const r = await screenerAutoSuggestPass(db, {
        accountId: w.accountId, classifier: spy, credits: w.gate,
      });
      expect(r.ran, `cycle ${n} did not run`).toBe(true);
      expect(r.bought, `cycle ${n} bought again`).toBe(0);
      expect(r.chargedAttempts, `cycle ${n} charged again`).toBe(0);
      expect(r.examined, `cycle ${n} still selected the sender as a candidate`).toBe(0);
    }

    // THE MODEL IS THE CLAIM, not the count: one question was asked about this sender, ever.
    expect(spy.screened.map((i) => i.from.address)).toEqual(["stranger@example.test"]);
    // ONE debit, under the FIRST representative's own source. The eleven later messages are not on
    // the ledger at all — not as duplicates, not as free retries. They were never priced.
    expect(await debitsOf(w)).toEqual([{ delta: -1, source: screenerLedgerSource(first) }]);
    // And the advice the account paid for is still the only row: the pass did not re-store it
    // against the newer mail either, so nothing here depends on a delete-then-insert winning.
    expect((await suggestionsOf(w)).map((r) => r.messageId)).toEqual([first]);
  });

  it("a re-sending sender is skipped while a genuinely NEW sender is still bought", async () => {
    // The other direction, and the one that makes the bound a fix rather than a switch-off: the
    // feature has to keep working. Same cycle, same page, two senders.
    const w = await newWorld({ credits: 50 });
    await resent(w, "known@example.test", 1);
    await screenerAutoSuggestPass(db, { accountId: w.accountId, classifier: spyClassifier(), credits: w.gate });

    await resent(w, "known@example.test", 2);          // re-send: already advised
    const fresh = await resent(w, "new@example.test", 3);  // first contact: unadvised
    const spy = spyClassifier();

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(r.bought).toBe(1);
    expect(r.chargedAttempts).toBe(1);
    expect(spy.screened.map((i) => i.from.address)).toEqual(["new@example.test"]);
    expect((await debitsOf(w)).map((d) => d.source)).toContain(screenerLedgerSource(fresh));
    expect(await debitsOf(w)).toHaveLength(2);
  });

  /**
   * THE UPGRADE, WHICH IS THE ONE THING A NEW IDENTITY COULD HAVE BROKEN.
   *
   * `UNIQUE (account_id, source)` is what stops a second charge for one economic event, and it can
   * only do that while the source STRING is the same. A fix that re-keyed the ledger source on the
   * sender would therefore have re-charged, on the first cycle after deploy, every sender the
   * account had already bought advice about under a `classify:screener:<message_id>` source — the
   * shape in the table today. That is the reason the source did not move and the entitlement did
   * (see `ledger-source.ts#screenerLedgerSource`), and it is worth a test rather than an argument.
   *
   * Seeded as the OLD shape end to end: the stored row against the old representative AND its real
   * ledger debit. Then the sender sends again.
   */
  it("an existing MESSAGE-keyed purchase is honoured — the upgrade re-charges nobody", async () => {
    const w = await newWorld({ credits: 50 });
    const bought = await resent(w, "legacy@example.test", 1);
    // The pre-existing purchase, exactly as a pass or a press left it before this change.
    await db.insert(routingDecisions).values({
      accountId: w.accountId, messageId: bought,
      inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination: "INBOX", confidence: 0.9, rationale: "bought under the message-keyed source",
      spam: false, status: SCREENER_SUGGESTION_STATUS,
    });
    // …and its money, under the source that shape produced. Spent through the gate rather than
    // inserted, so the ledger row is the real one and its dedup behaviour is the real one.
    const pre = await w.gate.spend(w.accountId, "screener", screenerAttemptKey(bought),
      { messageId: bought });
    expect(pre.verdict === "ok", "the seeded purchase did not charge").toBe(true);
    await w.gate.release(w.accountId,
      { action: "screener", attemptKey: screenerAttemptKey(bought), refund: false });

    await resent(w, "legacy@example.test", 2);
    const spy = spyClassifier();

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(r.ran).toBe(true);
    expect(r.bought).toBe(0);
    expect(r.chargedAttempts).toBe(0);
    expect(spy.screened, "a sender already advised under the old identity was re-asked").toEqual([]);
    expect(await debitsOf(w), "the upgrade charged for advice already bought")
      .toEqual([{ delta: -1, source: screenerLedgerSource(bought) }]);
  });

  /**
   * TWO PASSES, ONE RE-SENT SENDER — the SEC3-MONEY-1 claim and this bound, composed.
   *
   * Both hosts see the same state and therefore select the same representative, so they contend
   * on ONE source: the loser is answered `inflight`, skips the candidate and does not stop its
   * run. One model call, one charge. Both passes share ONE port — which is the production shape,
   * because both reach the same entitlements program, and a port each would give two holders of
   * one source and prove nothing.
   */
  it("concurrent passes over a re-sent sender make ONE model call and ONE charge", async () => {
    const w = await newWorld({ credits: 50 });
    await resent(w, "racer@example.test", 1);
    const rep = await resent(w, "racer@example.test", 2);
    const spy = spyClassifier();
    const [a, b] = await Promise.all([
      screenerAutoSuggestPass(db, { accountId: w.accountId, classifier: spy, credits: w.gate }),
      screenerAutoSuggestPass(db, { accountId: w.accountId, classifier: spy, credits: w.gate }),
    ]);

    expect(a.bought + b.bought, "both passes bought the same sender").toBe(1);
    expect(a.chargedAttempts + b.chargedAttempts).toBe(1);
    // THE SPY IS THE CLAIM. A `duplicate` read as "already paid for, proceed" is what SEC3-MONEY-1
    // was: honest ledger, two paid model calls.
    expect(spy.screened, "one credit bought two model calls").toHaveLength(1);
    expect(await debitsOf(w)).toEqual([{ delta: -1, source: screenerLedgerSource(rep) }]);
  });

  /**
   * THE WINDOW THE CLAIM CANNOT CLOSE, AND THE REFUND THAT CLOSES IT.
   *
   * Two hosts whose candidate queries ran either side of a new arrival hold DIFFERENT
   * representatives for one sender, so their ledger sources differ and neither is a duplicate of
   * the other: the claim serialises nothing and both would charge. The entitlement is therefore
   * re-asked INSIDE the exclusive region, per sender and on every outcome — including the one where
   * this caller is the one that charged, which is the case the old per-message re-check could not
   * see (it ran only on `charged: false`).
   *
   * Driven through the gate rather than by racing two passes, because the interleaving has to be
   * the one under test rather than one the scheduler happened to produce: the wrapper stores advice
   * about the sender's OTHER message in the instant after `spend` commits.
   */
  it("a sender advised between the candidate query and the claim is REFUNDED, not re-charged", async () => {
    const w = await newWorld({ credits: 50 });
    const older = await resent(w, "raced@example.test", 1);
    const rep = await resent(w, "raced@example.test", 2);
    const spy = spyClassifier();
    let planted = false;
    const racing: SpendPort = {
      ...w.gate,
      spend: async (accountId, action, key, meta) => {
        const out = await w.gate.spend(accountId, action, key, meta);
        if (!planted) {
          planted = true;
          // Another host finished first, against the OLDER representative — a different source, so
          // the debit above was not a duplicate of anything and really did charge.
          await db.insert(routingDecisions).values({
            accountId: w.accountId, messageId: older,
            inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
            destination: "INBOX", confidence: 0.7, rationale: "the other host's verdict",
            spam: false, status: SCREENER_SUGGESTION_STATUS,
          });
        }
        return out;
      },
    };

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: racing,
    });

    expect(planted, "the wrapper never ran — the test is asserting nothing").toBe(true);
    expect(r.bought).toBe(0);
    expect(spy.screened, "the model was asked about a sender that had just been advised").toEqual([]);
    // The debit is on record, because it really happened — and so is its reversal. The account is
    // whole, which is the claim; an append-only ledger showing both is how it stays auditable.
    expect(await debitsOf(w)).toEqual([{ delta: -1, source: screenerLedgerSource(rep) }]);
    // `chargedAttempts` reports what MOVED. A charge that came straight back moved nothing, and reporting
    // it would put a spend in the worker's log line that the balance contradicts.
    expect(r.chargedAttempts).toBe(0);
  });

  it("a DECIDED sender who comes back is not re-bought — the advice is still on record", async () => {
    // The window rule, stated as behaviour: entitlement lasts as long as the advice does. This
    // sender's held mail left the Screener (a decision files it), their `routing_decisions` row
    // stays, and their next message is held again as first contact.
    const w = await newWorld({ credits: 50 });
    const first = await resent(w, "returning@example.test", 1);
    await screenerAutoSuggestPass(db, { accountId: w.accountId, classifier: spyClassifier(), credits: w.gate });

    // Filed out of the Screener, the way a decision does it.
    await db.update(folderState).set({ desiredFolder: "ohmail/Screened", observedFolder: "ohmail/Screened" })
      .where(eq(folderState.messageId, first));
    await resent(w, "returning@example.test", 2);
    const spy = spyClassifier();

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(r.bought).toBe(0);
    expect(spy.screened).toEqual([]);
    expect(await debitsOf(w)).toHaveLength(1);
  });

  it("advice DELETED with the mail ⇒ the sender's next message is a new first contact, bought once", async () => {
    // The lifetime this entitlement inherits, pinned in the direction it is wrong in. The marker is
    // derived from the stored advice rather than from a table of its own, so deleting a sender's
    // held mail deletes it — the account owner's own action, re-bounded to ONE purchase, and the
    // honest answer once there is nothing on screen to explain a refusal to advise.
    const w = await newWorld({ credits: 50 });
    const first = await resent(w, "cleared@example.test", 1);
    await screenerAutoSuggestPass(db, { accountId: w.accountId, classifier: spyClassifier(), credits: w.gate });

    await db.delete(routingDecisions).where(eq(routingDecisions.messageId, first));
    await db.delete(folderState).where(eq(folderState.messageId, first));
    await db.delete(messages).where(eq(messages.id, first));
    const back = await resent(w, "cleared@example.test", 2);
    const spy = spyClassifier();

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(r.bought).toBe(1);
    expect(r.chargedAttempts, "one purchase, not a per-message drain").toBe(1);
    expect(spy.screened.map((i) => i.from.address)).toEqual(["cleared@example.test"]);
    expect((await debitsOf(w)).map((d) => d.source)).toEqual([
      screenerLedgerSource(first), screenerLedgerSource(back),
    ]);
  });

  it("a sender the CLIENT's batch already bought for is never re-asked or re-charged", async () => {
    const w = await newWorld({ credits: 50 });
    const id = await held(w, "a@example.test", AFTER);
    // Exactly what `POST /screener/suggest` leaves behind, written through the shared helper's
    // own vocabulary rather than a copy of it.
    await db.insert(routingDecisions).values({
      accountId: w.accountId, messageId: id,
      inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination: "INBOX", confidence: 0.9, rationale: "bought by the client",
      spam: false, status: SCREENER_SUGGESTION_STATUS,
    });
    const spy = spyClassifier();

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
    });

    expect(r.ran).toBe(true);
    expect(r.bought).toBe(0);
    expect(spy.screened).toEqual([]);
    expect(await debitsOf(w)).toEqual([]);
  });

  /* ── 5. THE CUTLINE — NO ADVICE IS BOUGHT ABOUT A SENDER NO SURFACE SHOWS ─────────────── */

  /**
   * The pass shared the Screener list's blindness to the cutline, so it could spend an account's
   * credits on a sender `GET /consent` had already stopped counting and the queue no longer shows
   * — measured on a managed account as a list far longer than the senders the cutline called active.
   * `senderIsActiveSql` is the same expression the count and the list now use.
   *
   * The fixture gives the account a BASELINE, which the worlds above deliberately do not: without
   * one there is no narrowing (unread outranks age), every case here would pass unchanged, and
   * this would be a control that cannot fire.
   *
   * MUTATIONS WATCHED: drop the cutline predicate from `selectCandidates` ⇒ the spy is asked about
   * BOTH senders and `bought` reads 2.
   */
  it("never asks the model about a sender the cutline has retired", async () => {
    const w = await newWorld({ credits: 50 });
    // A baseline of 2026-08-20 with the default 60-day window puts the cutline at 2026-06-21.
    await db.update(accountSettings)
      .set({ screeningBaselineAt: new Date("2026-08-20T00:00:00Z"), screeningScope: "window" })
      .where(eq(accountSettings.accountId, w.accountId));

    // BOTH are past the opt-in watermark, so the watermark cannot be what separates them: the
    // only difference is the header date the cutline reads.
    const retiredId = await heldDated(w, "retired@example.test", AFTER, new Date("2023-06-23T00:00:00Z"));
    await heldDated(w, "current@example.test", AFTER, new Date("2026-09-01T00:00:00Z"));
    const spy = spyClassifier();

    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate,
      now: () => new Date("2026-09-11T00:00:00Z"),
    });

    expect(result.ran).toBe(true);
    expect(spy.screened.map((i) => i.from.address)).toEqual(["current@example.test"]);
    expect(result.bought).toBe(1);
    expect(result.chargedAttempts, "a retired sender must cost nothing").toBe(1);
    const stored = await suggestionsOf(w);
    expect(stored.map((r) => r.messageId)).not.toContain(retiredId);
  });

  it("asks about a sender whose old-dated letter the server received inside the cutline, as the queue lists it", async () => {
    const w = await newWorld({ credits: 50 });
    await db.update(accountSettings)
      .set({ screeningBaselineAt: new Date("2026-08-20T00:00:00Z"), screeningScope: "window" })
      .where(eq(accountSettings.accountId, w.accountId));
    // Recorded after the first import: an imported letter waits by its Date alone.
    await db.update(mailboxes).set({ initialImportCompletedAt: new Date(AFTER.getTime() - 60_000) }).where(eq(mailboxes.id, w.mailboxId));
    // One June header each; only the server's receipt differs.
    const june = new Date("2026-05-02T09:00:00Z");
    await heldDated(w, "arrived@example.test", AFTER, june, new Date("2026-09-10T00:00:00Z"));
    await heldDated(w, "received-june@example.test", AFTER, june, june);
    const spy = spyClassifier();
    const result = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spy, credits: w.gate, now: () => new Date("2026-09-11T00:00:00Z"),
    });
    expect(spy.screened.map((i) => i.from.address)).toEqual(["arrived@example.test"]);
    expect(result.bought).toBe(1);
  });

  /** `held` with the header date under the caller's control — the cutline's only input. */
  async function heldDated(w: World, from: string, at: Date, date: Date, receivedAt?: Date): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId,
      bodyHash: "h", dedupKey: `sug:${randomUUID()}`,
      subject: `hello from ${from}`, fromAddress: from, snippet: "a first message",
      date, createdAt: at, ...(receivedAt === undefined ? {} : { arrivedAt: receivedAt }),
      nativeLocator: { folder: SCREENER, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  /* ── THE CLAIM LEAVES BY ONE DOOR ──────────────────────────────────────────────────────────
   *
   * The three releases used to sit on the exits somebody had written down: the already-advised
   * `continue`, the model fault's `break`, and the store's own return. A throw from the
   * entitlement re-check or from the store passed none of them, so that candidate's exclusive
   * claim was held until its TTL expired — and the next cycle over the same message is answered
   * `inflight` and SKIPS a sender nobody has worked on. One release in a `finally` per candidate.
   *
   * MUTATION WATCHED: delete the `finally` block from `screenerAutoSuggestPass` — the store case
   * below reports the leak as the product symptom (the next cycle buys nothing), and the shape
   * census at the bottom of this file goes red with it.
   */

  /** The same handle with `db.transaction` refused — `storeScreenerSuggestion`'s only door. */
  function storeFaults(real: Tx): Tx {
    return new Proxy(real as unknown as object, {
      get(target, prop) {
        if (prop === "transaction") {
          return async (): Promise<never> => { throw new Error("store 08006"); };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as unknown as Tx;
  }

  function capturingLogger(): { log: Logger; lines: Array<{ level: string; event: string }> } {
    const lines: Array<{ level: string; event: string }> = [];
    const at = (level: string) => (event: string, _fields: LogFields = {}) => {
      lines.push({ level, event });
    };
    const log: Logger = {
      level: "debug",
      child() { return log; },
      debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"),
    };
    return { log, lines };
  }

  it("a store that faults hands the claim back, and the next cycle is not answered `inflight`", async () => {
    const w = await newWorld({ credits: 50 });
    const id = await held(w, "storefault@example.test", AFTER);
    const spy = spyClassifier();

    // The thrown value is read as a one-word verdict rather than through `.rejects` on this
    // handle: what is under test is the release, and a matcher that formats a database client
    // takes the worker with it.
    let thrown = "none";
    try {
      await screenerAutoSuggestPass(storeFaults(db), {
        accountId: w.accountId, classifier: spy, credits: w.gate,
      });
    } catch (err) { thrown = (err as Error).message; }

    expect(thrown, "the store fault must still reach the pass's caller").toBe("store 08006");
    expect(spy.screened, "the model was asked, so the claim really was held").toHaveLength(1);
    expect(await suggestionsOf(w), "nothing was stored — that is the fault").toEqual([]);
    // ONE release for THIS message, and not a reversal: the charge stands and buys the free retry
    // next cycle, which is the claim this pass's caller already makes for a fault.
    expect(w.gate.releases.map((r) => ({ key: r.attemptKey, refund: r.refund })))
      .toEqual([{ key: screenerAttemptKey(id), refund: false }]);

    // THE SYMPTOM THE LEAK PRODUCED, driven: the same sender, the next cycle, a healthy model.
    const r2 = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spyClassifier(), credits: w.gate,
    });
    expect(r2.bought, "the next cycle was answered `inflight` on a claim nobody holds").toBe(1);
    expect(r2.chargedAttempts, "the retry over the same message was free").toBe(0);
  });

  it("an `inflight` candidate's claim is never handed back — it belongs to the other caller", async () => {
    // The latch, watched. `inflight` names the person pressing Suggest for that sender, and a
    // release on this path would give away THEIR claim and let the model be bought twice for one
    // credit. The door only fires where the gate handed this pass the claim.
    const w = await newWorld({ credits: 50 });
    await held(w, "theirs@example.test", AFTER);
    const mine = await held(w, "mine@example.test", new Date(AFTER.getTime() + 1000));
    w.gate.answerOnce({ verdict: "inflight", source: "held-by-the-press" });

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spyClassifier(), credits: w.gate,
    });

    expect(r.bought, "the second candidate was not worked on").toBe(1);
    expect(w.gate.releases.map((x) => x.attemptKey))
      .toEqual([screenerAttemptKey(mine)]);
  });

  it("a release that faults is reported once and is not the pass's failure", async () => {
    // The port's contract is never-throws, so this is a contract violation rather than a state the
    // program produces. What must hold anyway: the suggestion is on record, so the pass reports
    // what it did instead of being counted as a failed account, and the fault it cannot act on
    // gets one line rather than replacing the account's whole cycle.
    const w = await newWorld({ credits: 50 });
    await held(w, "relfault@example.test", AFTER);
    const { log, lines } = capturingLogger();
    const faulting: SpendPort = {
      ...w.gate,
      release: async (accountId, r) => {
        await w.gate.release(accountId, r);
        throw new Error("gate 500");
      },
    };

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier: spyClassifier(), credits: faulting, log,
    });

    expect(r.bought, "a pass whose suggestion is stored was reported as a failure").toBe(1);
    expect(w.gate.releases, "the release was retried").toHaveLength(1);
    expect(lines.filter((l) => l.event === "screener_auto_suggest_release_failed"))
      .toEqual([{ level: "warn", event: "screener_auto_suggest_release_failed" }]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE CROSS-BOUNDARY CLAIM — read as TEXT, because neither side can import the other
   ══════════════════════════════════════════════════════════════════════════════════════════

   `AUTO_SUGGEST_BATCH` here and `AUTO_BATCH_SIZE` in `apps/webapp/app/shell/screener-suggest.ts`
   are the same policy: how many senders one AUTOMATIC batch buys. They are two literals because
   there is no package both files may reach — this app may import core and db and nothing else
   from the workspace, and `apps/webapp` declares no `@trafficflow/*` dependency at all — so the
   equality is pinned here instead, with the technique `apps/webapp/test/mail-state.test.ts` uses
   for its own cross-boundary claims.

   The extractor asserts it FOUND the literal before comparing it. A probe that silently finds
   nothing is a claim about the probe, and this one would then agree with anything. */
describe("the automatic batch size is ONE number on both sides of the boundary", () => {
  it("matches `AUTO_BATCH_SIZE` in the webapp's Screener spender", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../webapp/app/shell/screener-suggest.ts", import.meta.url)), "utf8",
    );
    const m = /export const AUTO_BATCH_SIZE = (\d+);/.exec(src);
    expect(m, "AUTO_BATCH_SIZE was not found — the probe is stale, not the claim").not.toBeNull();
    expect(Number(m![1])).toBe(AUTO_SUGGEST_BATCH);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   ONE DOOR — THE PER-CANDIDATE CLAIM GOES BACK IN A `finally`
   ══════════════════════════════════════════════════════════════════════════════════════════

   Every exit leaving through one release is a property of the pass's SHAPE, not of any one run:
   the case above measures the exit that was leaking, and this measures that no future exit can.
   The reading is self-tested on two fixtures, because a scanner that matches nothing is green
   exactly when it is useless. No database, so it runs wherever the file does. */

interface DoorReading {
  /** `try` statements directly in the candidate loop's block — the door belongs to exactly one. */
  tries: number;
  hasFinally: boolean;
  inTry: number;
  inCatch: number;
  inFinally: number;
  /** Releases elsewhere in the loop's block — a door the try's exits never reach. */
  outsideTry: number;
}

/**
 * Where `releaseClaim(...)` is CALLED inside the candidate loop's try statement, counted from the
 * call expression: a mention in a comment, a string or a type can neither manufacture a door nor
 * hide one. `inTry` counts the nested model-fault catch as well, which is where one of the three
 * releases used to sit.
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
  // THE LOOP THIS CENSUS MEANS, IDENTIFIED BY WHAT MAKES IT THAT LOOP — the one whose body
  // declares `releaseClaim`, which is the door under test.
  //
  // It took `loops[0]`, and that premise held only while the candidate loop was the first `for…of`
  // in the function. A second loop added ahead of it (the per-mailbox eligibility read) made the
  // reading a fact about the WRONG loop — zero tries, zero releases, red for a reason that had
  // nothing to do with the door. A census that follows a neighbour can pass for the wrong subject
  // just as easily as it can fail for one, so it names its subject instead of counting to it.
  // Naming it by the ITERATED EXPRESSION was the other candidate and is worse: the real loop reads
  // `candidates.entries()` while both fixtures below iterate a literal, so the rule would have to
  // be written differently for the subject and for its own controls.
  const declaresTheDoor = (l: ts.ForOfStatement): boolean =>
    ts.isBlock(l.statement) && l.statement.statements.some((st) =>
      ts.isVariableStatement(st) && st.declarationList.declarations.some((d) =>
        ts.isIdentifier(d.name) && d.name.text === "releaseClaim"));
  const loops = body.statements.filter(ts.isForOfStatement);
  const named = loops.filter(declaresTheDoor);
  if (named.length !== 1) {
    throw new Error(
      `${fnName} has ${String(named.length)} loops declaring \`releaseClaim\`, expected exactly one`);
  }
  const loop = named[0]!;
  const block = loop.statement;
  if (!ts.isBlock(block)) throw new Error(`${fnName}'s loop body is not a block`);
  const tries = block.statements.filter(ts.isTryStatement);
  const first = tries[0];
  if (first === undefined) {
    return { tries: 0, hasFinally: false, inTry: 0, inCatch: 0, inFinally: 0, outsideTry: 0 };
  }
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
    outsideTry: calls(block) - calls(first),
  };
}

describe("one door: the auto-suggest claim is handed back in a `finally`", () => {
  it("the release is in the `finally` and nowhere else, so every exit passes it", () => {
    const subject = readFileSync(
      fileURLToPath(new URL("../src/screener-auto-suggest.ts", import.meta.url)), "utf8",
    );

    const door = readTheDoor(subject, "screenerAutoSuggestPass");
    expect(door.tries, "the candidate loop's body has one try statement").toBe(1);
    expect(door.hasFinally, "the candidate's try has no `finally` for its exits to leave through").toBe(true);
    expect(door.inFinally, "the one release is not in the `finally`").toBe(1);
    // A release written on a named exit is a door the NEXT exit does not have.
    expect({ inTry: door.inTry, inCatch: door.inCatch, outsideTry: door.outsideTry })
      .toEqual({ inTry: 0, inCatch: 0, outsideTry: 0 });
  });

  it("the reading sees releases on the named exits, and does not see a comment or a string", () => {
    // The shape this fix removed — three releases on the exits somebody had in mind, one of them
    // in the nested model-fault catch — with the two decoys that would make a symbol-counting
    // scan read five doors where there are three.
    const onTheNamedExits = `
      async function subject(): Promise<number> {
        let bought = 0;
        for (const c of [1, 2]) {
          const releaseClaim = async (refund: boolean): Promise<void> => { void refund; void c; };
          // releaseClaim(false) used to live here
          const s = "releaseClaim(true)";
          void s;
          if (c === 1) {
            await releaseClaim(true);
            continue;
          }
          try {
            void c;
          } catch (err) {
            await releaseClaim(false);
            throw err;
          }
          await releaseClaim(false);
          bought++;
        }
        return bought;
      }
    `;
    // The shape it left, carrying the exit that is the whole reason for the door: a throw from
    // the store, which no release of its own covers.
    const oneDoor = `
      async function subject(): Promise<number> {
        let bought = 0;
        for (const c of [1, 2]) {
          const releaseClaim = async (refund: boolean): Promise<void> => { void refund; void c; };
          let refundOnRelease = false;
          try {
            if (c === 1) { refundOnRelease = true; continue; }
            try {
              void c;
            } catch (err) {
              throw err;
            }
            bought++;
          } finally {
            await releaseClaim(refundOnRelease);
          }
        }
        return bought;
      }
    `;

    expect(readTheDoor(onTheNamedExits, "subject"))
      .toEqual({ tries: 1, hasFinally: false, inTry: 0, inCatch: 1, inFinally: 0, outsideTry: 2 });
    expect(readTheDoor(oneDoor, "subject"))
      .toEqual({ tries: 1, hasFinally: true, inTry: 0, inCatch: 0, inFinally: 1, outsideTry: 0 });
  });

  it("a DECOY loop ahead of the door does not become the subject", () => {
    // WHY THIS FIXTURE EXISTS. The reading used to take the first `for…of` in the function, and a
    // second loop added ahead of the candidate loop — the per-mailbox eligibility read — silently
    // made every number above a fact about the WRONG loop: zero tries, zero releases, a red with
    // nothing to do with the door.
    //
    // It is a FIXTURE and not the live subject on purpose. The pass has one `for…of` again (the
    // eligibility read moved into `appliableMailboxes`), so mutating the selector back to
    // `loops[0]` against the real file is GREEN — the two agree while there is only one loop to
    // disagree about. A control has to be chosen from a subject that HAS the property under test,
    // so the decoy is written here, where the selector can actually be watched fail.
    const withADecoy = `
      async function subject(): Promise<number> {
        let bought = 0;
        for (const m of ["a", "b"]) { void m; }
        for (const c of [1, 2]) {
          const releaseClaim = async (refund: boolean): Promise<void> => { void refund; void c; };
          let refundOnRelease = false;
          try {
            if (c === 1) { refundOnRelease = true; continue; }
            bought++;
          } finally {
            await releaseClaim(refundOnRelease);
          }
        }
        return bought;
      }
    `;
    expect(readTheDoor(withADecoy, "subject"))
      .toEqual({ tries: 1, hasFinally: true, inTry: 0, inCatch: 0, inFinally: 1, outsideTry: 0 });
  });
});

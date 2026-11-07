import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import {
  accounts, accountSettings, mailboxes, messageInstances, messages, folderState, routingDecisions,
  SCREENER_SUGGESTION_PROVENANCE, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { fakeSpendPort } from "./_spendport.js";
import { ledgerSources } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import type { ClassifierPort } from "@trafficflow/core";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";
import { screenerAutoSuggestPass } from "../src/screener-auto-suggest.js";
import { pgTestUrl } from "@trafficflow/db/testing";
import { PLANE_PRICES, PLANE_PRICING } from "../../../packages/services/test/helpers/plane-pricing.js";

/**
 * **SEC3-MONEY-1's third reaching: THE CRON AND THE PRESS, on one sender, at one moment.**
 *
 * The other two ways into this defect involve somebody doing something unusual — a burst of
 * concurrent requests, or a same-key double-tap. This one involves nobody doing anything at all.
 * The worker's auto-suggest pass runs every cycle for every opted-in account and selects the
 * newest held message per sender; the Screener surface a person is looking at shows the same rows
 * chosen by the same rule, character for character, because the money depends on the two agreeing.
 * So "the cron and a button press pick the same sender at the same instant" is not a coincidence
 * to be engineered — it is the design, and on an opted-in account it happens as a matter of course.
 *
 * Before the exclusive claim, both reached `askScreeningQuestion`: one debited, the other took the
 * gate's `duplicate` branch — *"already paid for, proceed"* — and made a second paid model call
 * for zero credits. The two verdicts then raced to overwrite the same advisory row.
 *
 * ## Why this file is in `apps/worker` and imports services
 *
 * The same reason `bubble-up-now.race.pg.test.ts` does: the subject IS the race between two
 * writers on separate physical connections, and one of them is a service. Re-typing the request
 * path's loop here would race a COPY of it against the pass and prove nothing about what ships.
 * The import boundary is untouched — `@trafficflow/services` stays a devDependency and no `apps/worker/src` file
 * imports it. `apps/worker/test/deps.test.ts` names this file for exactly that reason.
 */
const URL = pgTestUrl(import.meta.url);

/** Two pools: the cron's connection, the request's connection, and a reader for assertions. */
const sqlCron = postgres(URL, { max: 2 });
const sqlPress = postgres(URL, { max: 2 });
const dbCron = brandDialect(drizzle(sqlCron, { schema }), "pg");
const dbPress = brandDialect(drizzle(sqlPress, { schema }), "pg");

const NOW = new Date("2026-07-28T12:00:00Z");
const MODEL_MS = 400;

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/** ONE counter, shared by both racers — which is the only way the question can be asked. */
function spy(counter: { n: number }): ClassifierPort {
  return {
    async classify(i) {
      counter.n++;
      await sleep(MODEL_MS);
      return { destination: "INBOX", confidence: 0.8, rationale: `about ${i.from.address}`, spam: false };
    },
  };
}

/**
 * ONE PORT FOR BOTH RACERS — the request path and the cron reach the SAME entitlements program,
 * which is the whole subject of this file. A port each would give both of them their own claim
 * on one source and the collision this test exists for could not happen.
 */
const credits = fakeSpendPort();
credits.exclusive();

async function seed(sender: string): Promise<string> {
  const accountId = randomUUID();
  await dbCron.insert(accounts).values({ id: accountId, name: "cron-press" });
  credits.budget(50);
  // THE OPT-IN AND THE WATERMARK ARE ONE COLUMN. Dated in the past so the message below, whose
  // `created_at` the database writes as now(), is on the near side of it.
  await dbCron.insert(accountSettings)
    .values({ accountId, autoSuggestAt: new Date(Date.now() - 3600_000) });

  const [mb] = await dbCron.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `cp-${accountId.slice(0, 8)}@ex.example` }).returning();
  const dedup = `mid:${randomUUID()}`;
  const [m] = await dbCron.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "first contact", fromAddress: sender, date: NOW, snippet: "hello",
    // Both halves of the pass's sensitivity exclusion must read "not flagged", or the cron has
    // no candidate and this test would race one writer against nothing.
    noAi: false,
    nativeLocator: { folder: "ohmail/Screener", ref: "1:1" },
  }).returning();
  await dbCron.insert(folderState).values({
    messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  // Its copy in the Screener, as the ingest records one: the pass reads only letters with a copy on record.
  await dbCron.insert(messageInstances).values({
    accountId, mailboxId: mb!.id, messageId: m!.id, folder: "ohmail/Screener", uidvalidity: 1n, uid: 1, isPrimary: true,
  });
  return accountId;
}

/** What was CHARGED between the two racers — the port's own record of every `ok`. */
const chargesOf = (accountId: string) =>
  credits.spends.filter(
    (c) => c.accountId === accountId && c.action === "screener" && c.outcome.verdict === "ok",
  );

describe("SEC3-MONEY-1 — the auto-suggest cron and a Suggest press racing one sender", () => {
  beforeAll(async () => { await runMigrations(URL); });
  afterAll(async () => {
    await sqlCron.end({ timeout: 5 });
    await sqlPress.end({ timeout: 5 });
  });

  it("buys ONE model call and ONE credit between them, whichever wins", async () => {
    const sender = "cronpress@ex.example";
    const accountId = await seed(sender);
    const calls = { n: 0 };

    const press = new ScreenerService({ classifier: spy(calls), credits, pricing: PLANE_PRICING });
    const ctx: ServiceContext = {
      db: dbPress as unknown as Tx, accountId, userId: null,
      now: () => NOW, requestId: randomUUID(),
    };

    // TRUE PARALLELISM: two pools, two connections, started in the same tick. The classifier
    // sleeps so both are inside the window rather than politely queued behind each other.
    const [cron, pressed] = await Promise.all([
      screenerAutoSuggestPass(dbCron as unknown as Tx, {
        accountId,
        classifier: spy(calls),
        credits,
      }),
      press.suggest(ctx, { senders: [sender] }),
    ]);

    // THE PREMISE: the cron found the sender too, or the press raced nothing and the rest is vacuous.
    expect(cron.examined, "the cron had no candidate, so the press raced nothing").toBe(1);

    // ── THE INVARIANT ─────────────────────────────────────────────────────────────────────
    expect(calls.n, "cron and press each bought their own model call for one credit").toBe(1);
    const charges = chargesOf(accountId);
    expect(charges, "the two racers charged separately").toHaveLength(1);
    // The pass counts ATTEMPTS; the press reports CREDITS, at the program's price per suggestion.
    expect(cron.chargedAttempts + pressed.charged / PLANE_PRICES.screener,
      "reported spend disagrees with the port").toBe(charges.length);

    // ── AND THE PERSON WHO PRESSED IS ANSWERED EITHER WAY ─────────────────────────────────
    //
    // Whichever racer took the claim, the press comes back with the verdict: it either bought it
    // or waited for the cron's and served that. A caller being told "unavailable" because a
    // background job happened to be a millisecond ahead of them would be a regression dressed as
    // a fix.
    expect(pressed.suggestions, "the press got no answer").toHaveLength(1);
    expect(pressed.suggestions[0]!.rationale).toBe(`about ${sender}`);
    expect(pressed.skipped).toEqual([]);
    // The cron either bought it (1) or found the press had (0) — never a `stopped` pass, because
    // an overlap on ONE message is not a reason to abandon an account's whole cycle.
    expect(cron.stopped).toBeUndefined();
    expect(cron.bought).toBeLessThanOrEqual(1);

    // ── ONE STORED VERDICT, NOT TWO RACING WRITERS ────────────────────────────────────────
    const stored = await dbCron.select({ destination: routingDecisions.destination })
      .from(routingDecisions)
      .where(eq(routingDecisions.inputProvenance, SCREENER_SUGGESTION_PROVENANCE));
    const mine = await dbCron.select({ id: routingDecisions.id })
      .from(routingDecisions).where(eq(routingDecisions.accountId, accountId));
    expect(mine.length, "two callers each wrote their own advisory row").toBe(1);
    expect(stored.length).toBeGreaterThan(0);

    // ── AND WHOEVER TOOK THE CLAIM GAVE IT BACK ───────────────────────────────────────────
    //
    // The caller's half of the exclusivity contract: the work ended, so the claim is released.
    // A holder that never released would leave the next asker `inflight` for the length of
    // whatever bound the entitlements program keeps.
    expect(credits.releases.filter((r) => r.accountId === accountId), "the claim was not released")
      .toHaveLength(1);
  }, 30_000);
});

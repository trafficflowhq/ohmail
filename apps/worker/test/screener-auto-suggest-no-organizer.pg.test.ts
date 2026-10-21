import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messages, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { fakeSpendPort, type FakeSpendPort } from "./_spendport.js";
import { storeScreenerSuggestion } from "@trafficflow/db";
import type { RefundObligation, RefundObligationPort } from "@trafficflow/db";
import type { ClassifierInput, ClassifierPort, ClassifierResult } from "@trafficflow/core";
import { screenerAutoSuggestPass } from "../src/screener-auto-suggest.js";

/**
 * NO ORGANIZER, NO SPEND — the automatic pass buys advice only where a decision could be applied.
 *
 * The person stops the sole organizer. Cloud keeps the connected reader in its served list and
 * keeps buying the model's advice about held senders — advice whose only use is a decision the
 * reader may not make. It is the condition the MANUAL purchase route already reads and refuses
 * (`ScreenerService.suggest`), so this is one predicate being applied at one of its two callers
 * and not at the other.
 *
 * Real Postgres because the predicate is a read of `mailboxes`' organizer columns under the same
 * driver the route uses, and because the refund of a charge taken across the race is a row.
 */

const AVAILABLE = await realPgAvailable();
const SCREENER = "ohmail/Screener";
const OPTED_IN_AT = new Date("2026-08-01T00:00:00Z");
const AFTER = new Date("2026-08-02T00:00:00Z");

function spyClassifier(): ClassifierPort & { screened: ClassifierInput[] } {
  const screened: ClassifierInput[] = [];
  const answer = async (input: ClassifierInput): Promise<ClassifierResult> => {
    screened.push(input);
    return { destination: "ohmail/News", confidence: 0.8, rationale: "a newsletter", spam: false };
  };
  return { screened, classify: answer, screen: answer };
}

interface World { accountId: string; mailboxId: string; gate: FakeSpendPort }

/** The obligation store, recording. Idempotent per (account, attempt), as the unique index is. */
function fakeObligations(): RefundObligationPort & {
  owed: RefundObligation[]; settled: Array<{ accountId: string; attempt: string }>;
} {
  const owed: RefundObligation[] = [];
  const settled: Array<{ accountId: string; attempt: string }> = [];
  return {
    owed, settled,
    async owe(o) {
      if (!owed.some((p) => p.accountId === o.accountId && p.attempt === o.attempt)) owed.push(o);
    },
    async settle(accountId, attempt) { settled.push({ accountId, attempt }); },
  };
}

describe.skipIf(!AVAILABLE)("SCR-AUTOSUGGEST — no organizer, no spend", () => {
  let db: Tx;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    const sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
  }, 120_000);

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `noorg-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `noorg-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    await db.insert(accountSettings).values({ accountId, autoSuggestAt: OPTED_IN_AT });
    const gate = fakeSpendPort();
    gate.exclusive();
    gate.budget(100);
    return { accountId, mailboxId: mb!.id, gate };
  }

  /** The state a person leaves behind when they stop the only install that organizes. */
  async function soleOrganizerStopped(w: World): Promise<void> {
    await db.update(mailboxes)
      .set({ organizerRole: "reader", organizerState: "stopped", organizedByKind: "local" })
      .where(eq(mailboxes.id, w.mailboxId));
  }

  async function held(w: World, from: string): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId,
      bodyHash: "h", dedupKey: `noorg:${randomUUID()}`,
      subject: `hello from ${from}`, fromAddress: from, snippet: "a first message",
      date: new Date("2026-07-20T00:00:00Z"), createdAt: AFTER,
      nativeLocator: { folder: SCREENER, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  it("spends nothing and asks nothing once the sole organizer has stopped", async () => {
    const w = await newWorld();
    await held(w, "first@example.test");
    await held(w, "second@example.test");
    await soleOrganizerStopped(w);
    const classifier = spyClassifier();

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier, credits: w.gate,
    });

    expect(w.gate.spends).toEqual([]);
    expect(classifier.screened).toEqual([]);
    expect(r.chargedAttempts).toBe(0);
    expect(r.bought).toBe(0);
  });

  it("a stand-down BETWEEN the page and the claim refunds, and the debt names WHY", async () => {
    const w = await newWorld();
    await held(w, "racer@example.test");
    const classifier = spyClassifier();
    const obligations = fakeObligations();

    // THE RACE, DRIVEN AT THE ONE POINT IT HAPPENS. The page is selected while the mailbox is
    // organized; the stand-down lands while the spend is in flight — before the claim, after the
    // eligibility read. Wrapping `spend` is how this is made deterministic without a second
    // process: it is the same interleaving, at the same seam, with the clock taken out of it.
    const raced: FakeSpendPort = {
      ...w.gate,
      spend: async (...args) => {
        const out = await w.gate.spend(...args);
        await soleOrganizerStopped(w);
        return out;
      },
    };

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier, credits: raced, obligations,
    });

    // The charge landed and then bought nothing, so it is OWED — and the row says which of the
    // three ways it bought nothing, because a debt nobody can explain is a debt nobody can settle.
    expect(r.bought).toBe(0);
    expect(obligations.owed).toHaveLength(1);
    expect(obligations.owed[0]).toMatchObject({
      accountId: w.accountId, action: "screener", reason: "no_organizer",
    });
    // The gate was reachable, so the same request settled it.
    expect(obligations.settled).toHaveLength(1);
    expect(classifier.screened).toEqual([]);
  });

  it("an ALREADY-ADVISED sender's refund carries its own reason, not the neighbour's", async () => {
    const w = await newWorld();
    const messageId = await held(w, "advised@example.test");
    const classifier = spyClassifier();
    const obligations = fakeObligations();

    // The sender is advised between the candidate query and the claim — the other way this pass
    // pays for nothing. Its debt is REAL and its reason is its own: writing `no_organizer` here
    // was a defect this case exists to keep out, because the row is the only account of why
    // somebody is owed money.
    const raced: FakeSpendPort = {
      ...w.gate,
      spend: async (...args) => {
        const out = await w.gate.spend(...args);
        await storeScreenerSuggestion(db, {
          accountId: w.accountId, messageId,
          destination: "ohmail/News", confidence: 0.9, rationale: "somebody else asked",
          spam: false, senderReason: "none",
        });
        return out;
      },
    };

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier, credits: raced, obligations,
    });

    expect(r.bought).toBe(0);
    expect(obligations.owed).toHaveLength(1);
    expect(obligations.owed[0]!.reason).toBe("already_advised");
  });

  it("still buys for a mailbox this install organizes — the positive control", async () => {
    const w = await newWorld();
    await held(w, "third@example.test");
    const classifier = spyClassifier();

    const r = await screenerAutoSuggestPass(db, {
      accountId: w.accountId, classifier, credits: w.gate,
    });

    expect(r.bought).toBe(1);
    expect(r.chargedAttempts).toBeGreaterThan(0);
    expect(classifier.screened).toHaveLength(1);
  });
});

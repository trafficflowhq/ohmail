import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState, accountSettings } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import type { ClassifierPort } from "@trafficflow/core";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";
import { pgTestUrl } from "@trafficflow/db/testing";

/**
 * **SUGGEST-POSTURE — the Screener suggestion reads the account's Ohbox preference.**
 *
 * `ScreenerService.suggest` used to classify every held sender with NO `ohboxBar` and NO posture:
 * it never read `account_settings`, so a purchased suggestion ignored both the account's "My words"
 * bar and its `people_only` posture — the two things `planChange` threads on the routing path. Two
 * facts are proven here against REAL Postgres (the preference read is a `SELECT` on
 * `account_settings`, and the derivation is read at the fresh and the stored sites):
 *
 *  1. **The stored bar reaches the classifier's input.** The mutation that reintroduces the defect
 *     is dropping `ohboxBar` from the `classify(...)` call in the loop. The first test's classifier
 *     RECORDS what it was handed and BRANCHES on it, so that drop turns the recorded bar to
 *     `undefined` and flips the verdict — the guard goes red on exactly the regression.
 *  2. **Posture tightens "yes".** Under `people_only` a sender the model files into an automated
 *     pile (Reads/Receipts) reads "no"; under the lenient default (a NULL preference) it reads
 *     "yes", byte-identical to before the posture existed. The read path re-derives from the stored
 *     row, so flipping the posture flips the verdict with NO re-purchase.
 */
const URL = pgTestUrl(import.meta.url);

const sql = postgres(URL, { max: 5 });
const db = brandDialect(drizzle(sql, { schema }), "pg");

const NOW = new Date("2026-07-28T12:00:00Z");

const STRICT_BAR =
  "Only real people writing to me personally. Screen every newsletter, promotion and automated "
  + "sender — I never want bulk mail in my Ohbox.";

function ctxFor(accountId: string): ServiceContext {
  return { db, accountId, userId: null, now: () => NOW, requestId: randomUUID() };
}

/**
 * A classifier that RECORDS the bar it was given and BRANCHES on its presence: with the account's
 * bar it screens the sender out; without it, it admits them to the Ohbox. Dropping `ohboxBar` from
 * the service's classify call therefore makes `seen.bar` undefined AND flips the verdict to "yes".
 */
function barAware(seen: { bar?: string; calls: number }): ClassifierPort {
  return {
    async classify(i) {
      seen.calls++;
      seen.bar = i.ohboxBar;
      return i.ohboxBar
        ? { destination: "ohmail/Screened", confidence: 0.82, rationale: "the bar screens this sender", spam: false }
        : { destination: "INBOX", confidence: 0.9, rationale: "no bar — admitted", spam: false };
    },
  };
}

/** A classifier that ALWAYS files the sender under Reads, whatever the bar — isolates the POSTURE. */
const alwaysReads: ClassifierPort = {
  async classify() {
    return { destination: "ohmail/News", confidence: 0.7, rationale: "a newsletter", spam: false };
  },
};

/** An account with a mailbox, one held first-contact sender, and an optional stored preference. */
async function seedAccount(
  from: string, pref?: { bar?: string | null; policy?: string | null },
): Promise<string> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "suggest-posture" });
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `sp-${accountId.slice(0, 8)}@ex.example` }).returning();

  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "first contact", fromAddress: from, date: NOW, snippet: "hello",
    nativeLocator: { folder: "ohmail/Screener", ref: `1:${Math.floor(Math.random() * 1e6)}` },
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });

  if (pref) {
    await db.insert(accountSettings).values({
      accountId,
      ...(pref.bar !== undefined ? { ohboxBar: pref.bar } : {}),
      ...(pref.policy !== undefined ? { ohboxPolicy: pref.policy } : {}),
    });
  }
  return accountId;
}

describe("SUGGEST-POSTURE — suggest honours the stored Ohbox bar + posture", () => {
  beforeAll(async () => { await runMigrations(URL); });
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("threads the stored bar into every classify call, and the verdict follows it", async () => {
    // Lenient posture on purpose: this test isolates the BAR. The classifier turns the account's
    // words into a "screened" answer, so the only way the suggestion reads "no" is the bar having
    // reached the model input. Drop `ohboxBar` from the classify call and both assertions go red.
    const accountId = await seedAccount("news@bulk.example", { bar: STRICT_BAR });
    const seen = { calls: 0 } as { bar?: string; calls: number };
    const svc = new ScreenerService({ classifier: barAware(seen) });

    const res = await svc.suggest(ctxFor(accountId), { senders: ["news@bulk.example"] });

    expect(seen.calls).toBe(1);
    // THE MUTATION-WATCH ANCHOR: the account's own bar reached the classifier, verbatim.
    expect(seen.bar, "the stored ohboxBar did not reach the classify input").toBe(STRICT_BAR);
    expect(res.suggestions).toHaveLength(1);
    expect(res.suggestions[0]!.decision).toBe("no");
  });

  it("an account that set NO bar classifies with the bar omitted (unchanged behaviour)", async () => {
    // A NULL bar must be OMITTED, never the UI placeholder — so the model sees `undefined` and
    // the barAware classifier admits the sender, exactly as before this change.
    const accountId = await seedAccount("news@bulk.example");
    const seen = { calls: 0 } as { bar?: string; calls: number };
    const svc = new ScreenerService({ classifier: barAware(seen) });

    const res = await svc.suggest(ctxFor(accountId), { senders: ["news@bulk.example"] });

    expect(seen.bar).toBeUndefined();
    expect(res.suggestions[0]!.decision).toBe("yes");
  });

  it("posture tightens 'yes': Reads reads 'no' under people_only, 'yes' under the lenient default", async () => {
    // Same classifier, same automated-pile verdict, two postures. The tightening is the ONLY
    // difference, so a NULL preference is provably identical to the pre-posture behaviour.
    const strict = await seedAccount("shop@promo.example", { policy: "people_only" });
    const lenient = await seedAccount("shop@promo.example"); // no account_settings row ⇒ NULL ⇒ lenient
    const svc = new ScreenerService({ classifier: alwaysReads });

    const strictRes = await svc.suggest(ctxFor(strict), { senders: ["shop@promo.example"] });
    const lenientRes = await svc.suggest(ctxFor(lenient), { senders: ["shop@promo.example"] });

    expect(strictRes.suggestions[0]!.decision).toBe("no");
    expect(lenientRes.suggestions[0]!.decision).toBe("yes");
  });

  it("the STORED verdict re-derives under the current posture — flip it, no re-purchase, it flips", async () => {
    // Buy once under the lenient default: the model's Reads answer is stored and reads "yes".
    const accountId = await seedAccount("digest@list.example");
    const svc = new ScreenerService({ classifier: alwaysReads });
    await svc.suggest(ctxFor(accountId), { senders: ["digest@list.example"] });

    const lenientPage = await svc.list(ctxFor(accountId), {});
    expect(lenientPage.items[0]!.aiSuggestion!.decision).toBe("yes");

    // Adopt `people_only` WITHOUT buying again. The same stored row now reads "no", because the
    // Yes/No reading is the posture's, not the purchase's — the reason `storedSuggestions` takes it.
    await db.insert(accountSettings)
      .values({ accountId, ohboxPolicy: "people_only" })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { ohboxPolicy: "people_only" } });

    const strictPage = await svc.list(ctxFor(accountId), {});
    expect(strictPage.items[0]!.aiSuggestion!.decision).toBe("no");
    // …and nothing was re-sold: the sender is no longer offered because a verdict is on record.
    expect(strictPage.suggestable.senders).toEqual([]);
  });
});

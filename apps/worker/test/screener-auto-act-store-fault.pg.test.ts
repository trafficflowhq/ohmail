import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  accountSettings, accounts, folderState, mailboxes, messages, routingDecisions, rules,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS, type Tx,
} from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { screenerAutoActPass, type ScreenerActConsent } from "../src/screener-auto-act.js";

/**
 * THE AUTO-ACT PASS UNDER A REAL POSTGRES RAISE, per sender. The two-store file's MUTATION-WATCH (d)
 * faults the rule write through a proxy both stores can carry; this twin keeps the server's own
 * refusal: a trigger raises at this account's rule write inside each sender's transaction, and the
 * pass counts both senders failed, files neither, writes no rule and records each refusal.
 */
const AVAILABLE = await realPgAvailable();
const SCREENER = "ohmail/Screener";
const SPAM = "ohmail/Quarantine";
const GIVEN: ScreenerActConsent = { stillGiven: async () => true };

describe.skipIf(!AVAILABLE)("the auto-act pass on real Postgres: a store that raises at the rule write", () => {
  let own: OwnedDb;
  let db: Tx;
  const made: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    own = makeOwnedDb(PG_TEST_URL);
    db = own.db as unknown as Tx;
  }, 180_000);
  afterAll(async () => {
    for (const id of made) await db.delete(accounts).where(eq(accounts.id, id)).catch(() => {});
    await own?.close().catch(() => {});
  });

  it("MUTATION-WATCH (d, Postgres): a raise at each rule write leaves both senders waiting, counted failed", async () => {
    const accountId = randomUUID(); made.push(accountId);
    await db.insert(accounts).values({ id: accountId, name: `actpg-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `actpg-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    await db.insert(accountSettings).values({ accountId, screenerAutoApplyAt: null, screeningScope: "all_time" });
    // Confirmed by the provider (`pass`): a deny on any other letter writes no rule to fault.
    const held = async (from: string): Promise<string> => {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `actpg:${randomUUID()}`,
        subject: "hello there", fromAddress: from, authVerdict: "pass",
        nativeLocator: { folder: SCREENER, ref: `1:${Math.floor(Math.random() * 1e6)}` },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      await db.insert(routingDecisions).values({
        accountId, messageId: m!.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
        destination: SPAM, confidence: 0.99, rationale: "", spam: true, status: SCREENER_SUGGESTION_STATUS,
      });
      return m!.id;
    };
    const first = await held("one@spam.test");
    const second = await held("two@spam.test");
    const desiredOf = async (id: string): Promise<string> =>
      (await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1))[0]!.desiredFolder;

    // The server's own refusal, keyed to this account and named for this run.
    const fn = `act_rule_fault_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await db.execute(sql.raw(`create function ${fn}() returns trigger language plpgsql as $$
      begin if new.account_id = '${accountId}' then raise exception 'act fault' using errcode = '22003'; end if;
      return new; end $$`));
    await db.execute(sql.raw(`create trigger ${fn} before insert or update on rules for each row execute function ${fn}()`));
    try {
      const r = await screenerAutoActPass(db, { accountId, consent: GIVEN });
      expect(r).toMatchObject({ ran: true, filed: 0, failed: 2 });
    } finally {
      await db.execute(sql.raw(`drop trigger ${fn} on rules`));
      await db.execute(sql.raw(`drop function ${fn}()`));
    }
    expect(await desiredOf(first), "a sender was moved by a refused act").toBe(SCREENER);
    expect(await desiredOf(second)).toBe(SCREENER);
    expect(await db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.match, "one@spam.test")))).toHaveLength(0);
    const refusals = await db.select({ why: routingDecisions.actRefusal }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, accountId));
    expect(refusals.map((x) => x.why)).toEqual(["store_fault", "store_fault"]);
  });
});

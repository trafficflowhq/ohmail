import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, contacts, folderState, mailboxes, messageBodies, messages, rules,
  type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { ohboxTidyPass } from "../src/ohbox-tidy.js";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * TWO PASSES, ONE WRITE — driven through both, over real Postgres.
 *
 * The Ohbox tidy and the rule retro decide different things and write the SAME row: the desired
 * folder as an INTENT, `last_set_by = us`, the conflict flag down, and `reconcile_status` DERIVED
 * — a row can never claim a convergence it does not have, and `pending` is what makes the
 * reconciler perform the move. Real Postgres because both passes take `FOR UPDATE OF
 * folder_state`, a no-op on a single-connection store: the pass would run and the lock would
 * prove nothing.
 */

const AVAILABLE = await realPgAvailable();
const OHBOX = "INBOX";
/* The rule is written with the PRE-0.22 spelling on purpose — an older client, or a rule stored
   before the rename — and the intent must come back canonical, which is what every later
   comparison keys on. */
const READS = "ohmail/Reads";
const NEWS = "ohmail/News";
const NOW = new Date("2026-08-04T12:00:00Z");

/** The explicit empty trust set — an unlisted provider's mailbox; no auth demotion fires. */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

interface World { accountId: string; mailboxId: string }

describe.skipIf(!AVAILABLE)("the two rule passes write one folder_state intent", () => {
  let db: Tx;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
  }, 120_000);

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `pair-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `pair-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /** One message sitting in `observed`, with the folder_state row the organizer authored. */
  async function seedMessage(
    w: World, o: { from: string; observed?: string; headers?: Record<string, string[]> },
  ): Promise<string> {
    const observed = o.observed ?? OHBOX;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `pair:${randomUUID()}`, subject: "hello there", fromAddress: o.from,
      nativeLocator: { folder: observed, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, text: "", html: null, headers: o.headers ?? {},
    });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: observed, observedFolder: observed,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  /** The folder_state row as the shared write leaves it. */
  async function intentOf(messageId: string): Promise<{
    desired: string; observed: string; lastSetBy: string; status: string; conflict: boolean;
  }> {
    const [row] = await db.select({
      desired: folderState.desiredFolder, observed: folderState.observedFolder,
      lastSetBy: folderState.lastSetBy, status: folderState.reconcileStatus,
      conflict: folderState.conflict,
    }).from(folderState).where(eq(folderState.messageId, messageId));
    return row!;
  }

  /** The tidy's world: `people_only`, armed, one contact's bulk letter the pass demotes out of the Ohbox. */
  async function tidyMove(): Promise<string> {
    const w = await newWorld();
    await db.insert(accountSettings).values({
      accountId: w.accountId, ohboxPolicy: "people_only", ohboxTidyRequestedAt: NOW,
    });
    await db.insert(contacts).values({ accountId: w.accountId, address: "news@shop.test" });
    const id = await seedMessage(w, {
      from: "news@shop.test",
      headers: { "list-unsubscribe": ["<https://x.test/u>"], "list-id": ["<news.shop.test>"] },
    });
    await ohboxTidyPass(db, { trustedAuthservIdsFor: NONE, accountId: w.accountId });
    return id;
  }

  /** The retro's world: one new rule, applied backwards over mail already filed. */
  async function retroMove(destination: string): Promise<string> {
    const w = await newWorld();
    const id = await seedMessage(w, { from: "someone@example.test" });
    await db.insert(contacts).values({ accountId: w.accountId, address: "someone@example.test" })
      .onConflictDoNothing();
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "someone@example.test",
      destination, provenance: "manual", enabled: true, retroRequestedAt: NOW,
    });
    await ruleRetroPass(db, { accountId: w.accountId, trustedAuthservIdsFor: NONE }, NOW);
    return id;
  }

  it("both write the intent and leave the observed folder alone", async () => {
    const tidy = await intentOf(await tidyMove());
    const retro = await intentOf(await retroMove(READS));

    // BOTH ROWS IN ONE ASSERTION, on purpose: a loop that asserts each in turn stops at the first,
    // so a mutation in the shared write would only ever be proved through one of the two callers.
    const want = {
      // The destination moved, the observation did not: what the mail server holds is read, never
      // asserted by a pass that has opened no connection to it. The destination is stored under
      // the canonical name whichever spelling the rule was written with.
      desired: NEWS, observed: OHBOX,
      // Ours, unconflicted, and PENDING — which is what makes the reconciler do the move.
      lastSetBy: "us", conflict: false, status: "pending",
    };
    expect({ "ohbox-tidy": tidy, "rule-retro": retro })
      .toEqual({ "ohbox-tidy": want, "rule-retro": want });
  });

  it("a destination already reached is written `reconciled`, from the same derivation", async () => {
    // The retro's rule names the folder the message is already in. The intent is still written —
    // it is a fresh statement of where the message belongs — but it claims no move.
    const row = await intentOf(await retroMove(OHBOX));
    expect([row.desired, row.observed, row.status]).toEqual([OHBOX, OHBOX, "reconciled"]);
    expect([row.lastSetBy, row.conflict]).toEqual(["us", false]);
  });
});

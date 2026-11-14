import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import {
  accountSettings, accounts, autoReplyByUsWhere, awayReplies, contacts, folderState,
  mailboxes, messageBodies, messages, rules, threads,
  accountPass, requestPass,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { ohboxTidyPass } from "../src/ohbox-tidy.js";
import { ruleRetroPass } from "../src/rule-retro.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import type { Tx } from "@trafficflow/db";
import { brandDialect, dialect } from "@trafficflow/db/dialect";

/**
 * ═══ AN AUTO-REPLY IS NOT THE PERSON'S ENGAGEMENT — THE SERVER HALF, ON REAL POSTGRES ════════
 *
 * `ohbox-tidy` and `rule-retro` both carry a "the user replied from their own mail client"
 * exclusion: an own-address message in the same thread means they dealt with it, so the pass
 * leaves it alone. The away responder answering on their behalf satisfies that subquery, so every
 * message it replied to became PERMANENTLY untouchable by either pass — bulk mail pinned in the
 * Ohbox by the fact that we ourselves had answered it.
 *
 * ── WHY THIS FILE IS ON REAL POSTGRES AND ON A PRIVATE DATABASE ─────────────────────────────
 *
 * Two reasons, and neither is the usual `FOR UPDATE` one:
 *
 *   1. The predicate is a POSIX regex over jsonb. `[[:space:]]` is a property of the SERVER's
 *      collation, not of the query — so the parity table's PGlite green
 *      (`packages/services/test/auto-reply-by-us-parity.test.ts`) says nothing about what the real
 *      engine does with a tab-padded header. The same table is re-asserted here, on the engine
 *      that will actually run it.
 *   2. A PRIVATE database, not the shared `trafficflow_test`: this file seeds `away_replies` and
 *      whole threads, and a co-tenant asserting a delta over the shared table would go red for
 *      reasons that have nothing to do with it. `prepareIsolatedDb` per the box rules.
 *
 * Every case is stated as a PAIR — the machine's reply, and the person's — because the narrowing
 * can only be judged by both halves at once: admitting more candidates is the fix, and admitting
 * a message the person actually answered would be a new bug wearing the fix's clothes.
 */

const OHBOX = "INBOX";
const READS = "ohmail/News";

/**
 * The explicit empty trust set — `ohbox-tidy.pg.test.ts`'s convention, and NOT
 * `NO_TRUSTED_AUTHSERV_IDS` imported from core: `deps.test.ts` polices this directory's import
 * closure, and a barrel import for a two-word constant is exactly the kind of convenience that
 * closure exists to refuse.
 */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

/** List-Unsubscribe PLUS a corroborator: the router files a contact's mail with these to News. */
const BULK_HEADERS = {
  "list-unsubscribe": ["<https://sender.test/u>"],
  "list-id": ["<news.sender.test>"],
  "auto-submitted": ["no"],
};

let DB = "";

describe("FIX-016 — the away responder's reply does not pin mail in the Ohbox", () => {
  let db: Tx;
  let raw: ReturnType<typeof postgres>;

  beforeAll(async () => {
    DB = await prepareIsolatedDb("trafficflow_worker_fix016");
    raw = postgres(DB, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(raw, { schema }), "pg") as unknown as Tx;
  }, 180_000);

  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  interface World { accountId: string; mailboxId: string; own: string }

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `fix016-${accountId.slice(0, 8)}` });
    const own = `me-${accountId.slice(0, 8)}@example.test`;
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: own, status: "connected", organizerRole: "organizer",
    }).returning();
    return { accountId, mailboxId: mb!.id, own };
  }

  /** `people_only` and ARMED — without both, `ohboxTidyPass` returns EMPTY and proves nothing. The
   *  sender is a contact: the tidy moves a contact's bulk and keeps a stranger's. */
  async function armTidy(w: World): Promise<void> {
    await db.insert(contacts).values({ accountId: w.accountId, address: "news@sender.test" }).onConflictDoNothing();
    await db.insert(accountSettings).values({ accountId: w.accountId, ohboxPolicy: "people_only" })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { ohboxPolicy: "people_only" } });
    await requestPass(db as unknown as Tx, accountPass("ohbox_tidy", w.accountId), new Date());
  }

  async function newThread(w: World): Promise<string> {
    const [t] = await db.insert(threads).values({ accountId: w.accountId }).returning();
    return t!.id;
  }

  /** A bulk message sitting in the Ohbox, in a thread, with the strong-bulk floor's headers. */
  async function ohboxBulk(w: World, threadId: string): Promise<string> {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, threadId,
      messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "The weekly roundup", fromAddress: "news@sender.test",
      date: new Date("2026-09-01T08:00:00Z"),
      nativeLocator: { folder: OHBOX, ref: `1:${Math.floor(Math.random() * 1e6)}` },
      unread: false,
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "roundup", headers: BULK_HEADERS });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: OHBOX, observedFolder: OHBOX,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  /**
   * An own-sent reply in the same thread. `kind: "machine"` mints the ledger row the responder
   * writes (with the angle brackets it mints, against a bracket-free ingested header — the shape
   * that made an `=` correlation match nothing in production); `kind: "human"` is the person.
   * `answered` is the REAL message the reply answers: the ledger used to mint a `randomUUID()`
   * there on the premise that `away_replies` had no key to `messages`, which mail 0118 retired —
   * `(message_id, account_id)` references `messages (id, account_id)`, so a minted id is refused
   * by `away_replies_message_id_account_fk`. Production writes `candidate.id`, and the predicate
   * under test correlates on `minted_message_id`, so the column is provenance and not the subject.
   */
  async function ownReply(
    w: World, threadId: string, kind: "machine" | "human", answered: string,
  ): Promise<string> {
    const bare = `${randomUUID()}@example.test`;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, threadId,
      messageIdHeader: bare, bodyHash: randomUUID(), dedupKey: `mid:${bare}`,
      subject: "Re: The weekly roundup", fromAddress: w.own,
      // Addressed to the sender it answers, as the ingest records every reply: a Sent row whose
      // headers name nobody is addressed to nobody, and protects nobody's mail.
      toAddresses: [{ address: "news@sender.test", name: "" }],
      date: new Date("2026-09-02T08:00:00Z"),
      nativeLocator: { folder: "Sent", ref: `1:${Math.floor(Math.random() * 1e6)}` },
      unread: false,
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: "away",
      headers: kind === "machine" ? { "auto-submitted": ["auto-replied"] } : { "auto-submitted": ["no"] },
    });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "Sent", observedFolder: "Sent",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    if (kind === "machine") {
      await db.insert(awayReplies).values({
        accountId: w.accountId, mailboxId: w.mailboxId, messageId: answered,
        sender: "news@sender.test", outcome: "sent", mintedMessageId: `<${bare}>`,
      });
    }
    return m!.id;
  }

  const desiredOf = async (id: string): Promise<string> => {
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    return fs!.desiredFolder;
  };

  /* ═══ 1 · THE OHBOX TIDY ═════════════════════════════════════════════════════════════════ */

  it("DEMOTES bulk mail whose thread holds ONLY the responder's reply", async () => {
    const w = await newWorld();
    await armTidy(w);
    const t = await newThread(w);
    const bulk = await ohboxBulk(w, t);
    await ownReply(w, t, "machine", bulk);

    expect(await desiredOf(bulk)).toBe(OHBOX);
    const res = await ohboxTidyPass(db, {
      accountId: w.accountId, trustedAuthservIdsFor: NONE,
    });
    expect(res.ran).toBe(true);
    // THE FIX. Before it, this message was a permanent non-candidate.
    expect(await desiredOf(bulk)).toBe(READS);
    expect(res.moved).toBeGreaterThan(0);
  });

  it("STILL LEAVES bulk mail alone when the thread holds a reply the PERSON wrote", async () => {
    const w = await newWorld();
    await armTidy(w);
    const t = await newThread(w);
    const bulk = await ohboxBulk(w, t);
    await ownReply(w, t, "human", bulk);

    await ohboxTidyPass(db, {
      accountId: w.accountId, trustedAuthservIdsFor: NONE,
    });
    // THE POSITIVE CONTROL, and the one that decides whether the narrowing is safe.
    expect(await desiredOf(bulk)).toBe(OHBOX);
  });

  it("leaves it alone when the thread holds BOTH — a human reply outranks the machine's", async () => {
    const w = await newWorld();
    await armTidy(w);
    const t = await newThread(w);
    const bulk = await ohboxBulk(w, t);
    await ownReply(w, t, "machine", bulk);
    await ownReply(w, t, "human", bulk);

    await ohboxTidyPass(db, {
      accountId: w.accountId, trustedAuthservIdsFor: NONE,
    });
    expect(await desiredOf(bulk)).toBe(OHBOX);
  });

  /* ═══ 2 · THE RULE RETRO ═════════════════════════════════════════════════════════════════ */

  async function owedRule(w: World): Promise<string> {
    const [r] = await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "news@sender.test", destination: READS,
      provenance: "manual", enabled: true, retroRequestedAt: new Date(),
    }).returning();
    return r!.id;
  }

  it("APPLIES an owed rule to mail whose thread holds ONLY the responder's reply", async () => {
    const w = await newWorld();
    const t = await newThread(w);
    const bulk = await ohboxBulk(w, t);
    await ownReply(w, t, "machine", bulk);
    await owedRule(w);

    const res = await ruleRetroPass(db, {
      accountId: w.accountId, trustedAuthservIdsFor: NONE,
    });
    expect(await desiredOf(bulk)).toBe(READS);
    expect(res.moved).toBeGreaterThan(0);
  });

  it("STILL SKIPS mail whose thread holds a reply the PERSON wrote", async () => {
    const w = await newWorld();
    const t = await newThread(w);
    const bulk = await ohboxBulk(w, t);
    await ownReply(w, t, "human", bulk);
    await owedRule(w);

    await ruleRetroPass(db, {
      accountId: w.accountId, trustedAuthservIdsFor: NONE,
    });
    expect(await desiredOf(bulk)).toBe(OHBOX);
  });

  /* ═══ 3 · THE ORIGINAL IS NOT PROMOTED — the lane's hard stop ════════════════════════════ */

  it("never moves a message INTO the Ohbox, and never touches the reply itself", async () => {
    const w = await newWorld();
    await armTidy(w);
    const t = await newThread(w);
    const bulk = await ohboxBulk(w, t);
    const reply = await ownReply(w, t, "machine", bulk);

    await ohboxTidyPass(db, {
      accountId: w.accountId, trustedAuthservIdsFor: NONE,
    });
    // The reply stays in Sent. Nothing in this lane moves it, and nothing hides it there.
    expect(await desiredOf(reply)).toBe("Sent");
    // And nothing was promoted to the Ohbox by any of it.
    const inbox = await db.select({ id: folderState.messageId }).from(folderState)
      .where(eq(folderState.desiredFolder, OHBOX));
    expect(inbox.map((r) => r.id)).toEqual([]);
    expect(await desiredOf(bulk)).toBe(READS);
  });

  /* ═══ 4 · THE PARITY TABLE, ON THE REAL ENGINE ═══════════════════════════════════════════ */

  /**
   * The PGlite parity test's reason for existing, re-asserted where the collation is real: only
   * the whitespace and non-string rows are repeated, because they are the ones the WASM build
   * could plausibly differ on.
   *
   * ASSERTED AGAINST LITERAL EXPECTATIONS, NOT AGAINST THE TYPESCRIPT. This file deliberately does
   * NOT import `hasMachineSentHeaders`: `deps.test.ts` confines the services package in this
   * directory to tests where that package IS the consumer under test, and here it would be a
   * convenience. (The import specifier is not spelled out even in this comment, because that
   * guard matches the RAW file text and a mention would enrol this file in its allow-list.) It is
   * also the better assertion — a comparison between two implementations passes
   * when both are wrong in the same direction, which is precisely how the whitespace arm would
   * have slipped through. The TS↔SQL comparison lives where both halves are in scope
   * (`packages/services/test/auto-reply-by-us-parity.test.ts`); this asserts the ENGINE's answer.
   */
  it("the header belt gives the expected verdict on real Postgres, whitespace included", async () => {
    const w = await newWorld();
    const shapes: Array<{ what: string; headers: Record<string, unknown>; machine: boolean }> = [
      { what: "no", headers: { "auto-submitted": ["no"] }, machine: false },
      { what: "space-padded no", headers: { "auto-submitted": [" no "] }, machine: false },
      { what: "tab-padded no", headers: { "auto-submitted": ["\tno\t"] }, machine: false },
      { what: "newline-padded no", headers: { "auto-submitted": ["\nno\n"] }, machine: false },
      { what: "auto-replied", headers: { "auto-submitted": ["auto-replied"] }, machine: true },
      { what: "non-string member", headers: { "auto-submitted": [5] }, machine: false },
      { what: "precedence bulk", headers: { precedence: ["bulk"] }, machine: true },
      { what: "precedence first-class", headers: { precedence: ["first-class"] }, machine: false },
      { what: "suppress present", headers: { "x-auto-response-suppress": ["All"] }, machine: true },
    ];
    const wrong: string[] = [];
    for (const s of shapes) {
      const id = randomUUID();
      await db.insert(messages).values({
        id, accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: id,
        subject: "", fromAddress: w.own, date: new Date(),
      });
      await db.insert(messageBodies).values({ messageId: id, accountId: w.accountId, text: "", headers: s.headers });
      const where = autoReplyByUsWhere(dialect(db), {
        accountId: sql`m.account_id`, id: sql`m.id`,
        fromAddress: sql`m.from_address`, messageIdHeader: sql`m.message_id_header`,
      });
      const res = await db.execute(sql`select ${where} as verdict from messages m where m.id = ${id}::uuid`);
      const rows = res as unknown as Array<{ verdict: boolean | null }>;
      if (rows.length !== 1) wrong.push(`${s.what}: the probe row was not found`);
      const pg = rows[0]?.verdict === true;
      if (pg !== s.machine) wrong.push(`${s.what}: want ${s.machine} got ${pg}`);
    }
    expect(wrong).toEqual([]);
    // The table is not empty and it is not one-sided — a green over nothing, or over nine falses,
    // would be the shape this is guarding against.
    expect(shapes.filter((s) => s.machine).length).toBe(3);
    expect(shapes.filter((s) => !s.machine).length).toBe(6);
  });
});

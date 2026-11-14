import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import {
  accountSettings, accounts, contacts, folderState,
  mailboxes, messageBodies, messages, rules, threads,
  accountPass, requestPass,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { ohboxTidyPass } from "../src/ohbox-tidy.js";
import { ruleRetroPass } from "../src/rule-retro.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import type { Tx } from "@trafficflow/db";
import { brandDialect } from "@trafficflow/db/dialect";

/**
 * ═══ BEING ON A THREAD IS NOT ANSWERING THE PERSON ON IT ═════════════════════════════════════
 *
 * `ohbox-tidy` and `rule-retro` each leave a message alone when the person has already dealt with
 * it, and each asked the same wrong question: is there ANY own-address message in this thread. We
 * write to Alice; Alice's colleague joins the thread and writes; their mail is excluded from both
 * passes for ever by a reply that was never to them.
 *
 * Both now ask `@trafficflow/db#weAnsweredThisSenderWhere`. Every case here is a PAIR,
 * because a narrowing can only be judged by both halves at once: admitting more candidates is the
 * fix, and admitting a message the person really answered is a new bug in the fix's clothes. The
 * three arms that keep the exclusion are each driven — the recipient, the reference header, and
 * the row whose recipients were never recorded.
 *
 * ── WHY REAL POSTGRES, ON A PRIVATE DATABASE ────────────────────────────────────────────────
 *
 * The predicate reads jsonb arrays through the dialect seam and correlates a header's text
 * against another row's `message_id_header`; PGlite's answer about either says nothing about the
 * engine that runs it. PRIVATE because this file seeds whole threads and `away_replies`, and a
 * co-tenant counting either would measure its fixtures.
 */

const OHBOX = "INBOX";
const READS = "ohmail/News";
const SENDER = "news@sender.test";
const STRANGER = "someone-else@elsewhere.test";

/** The explicit empty trust set — this directory's convention; see the sibling pg file. */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

/** List-Unsubscribe PLUS a corroborator: the router files a contact's mail with these to News. */
const BULK_HEADERS: Record<string, string[]> = {
  "list-unsubscribe": ["<https://sender.test/u>"],
  "list-id": ["<news.sender.test>"],
  "auto-submitted": ["no"],
};

let DB = "";

describe("engagement is answering THIS sender, not sitting on their thread", () => {
  let db: Tx;
  let raw: ReturnType<typeof postgres>;

  beforeAll(async () => {
    DB = await prepareIsolatedDb("trafficflow_worker_learn023");
    raw = postgres(DB, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(raw, { schema }), "pg") as unknown as Tx;
  }, 180_000);

  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  interface World { accountId: string; mailboxId: string; own: string }

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `learn023-${accountId.slice(0, 8)}` });
    const own = `me-${accountId.slice(0, 8)}@example.test`;
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: own, status: "connected", organizerRole: "organizer",
    }).returning();
    return { accountId, mailboxId: mb!.id, own };
  }

  /** The tidy owed, and SENDER a contact: it moves a contact's bulk and keeps a stranger's. */
  async function armTidy(w: World): Promise<void> {
    await db.insert(contacts).values({ accountId: w.accountId, address: SENDER }).onConflictDoNothing();
    await db.insert(accountSettings).values({ accountId: w.accountId, ohboxPolicy: "people_only" })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { ohboxPolicy: "people_only" } });
    await requestPass(db as unknown as Tx, accountPass("ohbox_tidy", w.accountId), new Date());
  }

  async function newThread(w: World): Promise<string> {
    const [t] = await db.insert(threads).values({ accountId: w.accountId }).returning();
    return t!.id;
  }

  /** A bulk message from SENDER in `folder`, in a thread, carrying the strong-bulk floor. */
  async function bulkIn(w: World, threadId: string, folder: string): Promise<string> {
    const bare = `${randomUUID()}@sender.test`;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, threadId,
      messageIdHeader: bare, bodyHash: randomUUID(), dedupKey: `mid:${bare}`,
      subject: "The weekly roundup", fromAddress: SENDER,
      date: new Date("2026-09-01T08:00:00Z"),
      nativeLocator: { folder, ref: `1:${Math.floor(Math.random() * 1e6)}` },
      unread: false,
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "roundup", headers: BULK_HEADERS });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  /**
   * One message WE sent into the thread.
   *
   * `to` is who it was addressed to — `null` means the recipients were never recorded, which is
   * what an older Sent row holds and is NOT the same as "addressed to somebody else". `references`
   * names a message it answers.
   */
  async function ourSend(
    w: World, threadId: string,
    opts: {
      to: string[] | null; references?: string;
      /** The `To` the stored headers carry — what `sender-name-backfill` copies into the column. */
      headerTo?: string; noBody?: boolean;
    },
  ): Promise<string> {
    const bare = `${randomUUID()}@example.test`;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, threadId,
      messageIdHeader: bare, bodyHash: randomUUID(), dedupKey: `mid:${bare}`,
      subject: "Re: The weekly roundup", fromAddress: w.own,
      date: new Date("2026-09-02T08:00:00Z"),
      nativeLocator: { folder: "Sent", ref: `1:${Math.floor(Math.random() * 1e6)}` },
      unread: false,
      ...(opts.to === null ? {} : { toAddresses: opts.to.map((address) => ({ address, name: "" })) }),
    }).returning();
    if (!opts.noBody) {
      await db.insert(messageBodies).values({
        messageId: m!.id, accountId: m!.accountId, text: "reply",
        headers: {
          "auto-submitted": ["no"],
          ...(opts.references ? { references: [`<${opts.references}>`] } : {}),
          ...(opts.headerTo ? { to: [opts.headerTo] } : {}),
        },
      });
    }
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "Sent", observedFolder: "Sent",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  async function owedRule(w: World): Promise<void> {
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: READS,
      provenance: "manual", enabled: true, retroRequestedAt: new Date(),
    });
  }

  const desiredOf = async (id: string): Promise<string> => {
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    return fs!.desiredFolder;
  };

  const tidy = (w: World) =>
    ohboxTidyPass(db, { accountId: w.accountId, trustedAuthservIdsFor: NONE });
  const retro = (w: World) =>
    ruleRetroPass(db, { accountId: w.accountId, trustedAuthservIdsFor: NONE });

  /* ═══ 1 · COPIED ON A THREAD WE NEVER ANSWERED — NEITHER pass may count it ═══════════════ */

  it("the Ohbox tidy demotes mail on a thread our reply was addressed to somebody else", async () => {
    const w = await newWorld();
    await armTidy(w);
    const t = await newThread(w);
    const bulk = await bulkIn(w, t, OHBOX);
    await ourSend(w, t, { to: [STRANGER] });

    const res = await tidy(w);
    expect(res.ran).toBe(true);
    expect(await desiredOf(bulk), "we wrote on this thread, but never to them").toBe(READS);
  });

  it("the rule retro applies to mail on a thread our reply was addressed to somebody else", async () => {
    const w = await newWorld();
    const t = await newThread(w);
    const bulk = await bulkIn(w, t, OHBOX);
    await ourSend(w, t, { to: [STRANGER] });
    await owedRule(w);

    await retro(w);
    expect(await desiredOf(bulk)).toBe(READS);
  });

  /* ═══ 2 · A GENUINE REPLY STILL COUNTS — in both ═════════════════════════════════════════ */

  // One case per pass, not a loop in one: passes in one case ran past the default timeout, and a
  // red that is the harness's clock says nothing about the predicate.
  for (const pass of ["tidy", "retro"] as const) {
    it(`POSITIVE CONTROL — a reply addressed to THIS sender still protects their mail (${pass})`, async () => {
      const w = await newWorld();
      const t = await newThread(w);
      const held = await bulkIn(w, t, OHBOX);
      await ourSend(w, t, { to: [SENDER] });

      if (pass === "tidy") { await armTidy(w); await tidy(w); }
      if (pass === "retro") { await owedRule(w); await retro(w); }

      expect(await desiredOf(held), `${pass} moved mail the person answered`).toBe(OHBOX);
    });
  }

  /* ═══ 3 · THE LIST THREAD — the reference header is the second admitting arm ═════════════ */

  it("a reply addressed to a LIST still protects the sender it answers", async () => {
    const w = await newWorld();
    await armTidy(w);
    const t = await newThread(w);
    const bulk = await bulkIn(w, t, OHBOX);
    const [row] = await db.select({ mid: messages.messageIdHeader }).from(messages)
      .where(eq(messages.id, bulk));
    // To: the list, never the author — and `References` naming the message being answered, which
    // is the only thing on the row that says who was answered.
    await ourSend(w, t, { to: ["list@sender.test"], references: row!.mid! });

    await tidy(w);
    expect(await desiredOf(bulk), "answering on a list is answering the person").toBe(OHBOX);
  });

  it("a reference to a message of SOMEBODY ELSE'S does not protect this sender", async () => {
    const w = await newWorld();
    await armTidy(w);
    const t = await newThread(w);
    const bulk = await bulkIn(w, t, OHBOX);
    // A thread member who is not this sender: our reply answers THEM.
    const other = `${randomUUID()}@elsewhere.test`;
    await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, threadId: t,
      messageIdHeader: other, bodyHash: randomUUID(), dedupKey: `mid:${other}`,
      subject: "Re: The weekly roundup", fromAddress: STRANGER,
      date: new Date("2026-09-01T09:00:00Z"),
      nativeLocator: { folder: OHBOX, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    });
    await ourSend(w, t, { to: ["list@sender.test"], references: other });

    await tidy(w);
    expect(await desiredOf(bulk), "we answered the colleague, not the sender").toBe(READS);
  });

  /* ═══ 4 · RECIPIENTS NEVER RECORDED — unknown keeps the exclusion, named-nobody does not ═══ */

  it("a Sent row whose stored To the column never received keeps the exclusion — unknown", async () => {
    const w = await newWorld();
    await armTidy(w);
    const t = await newThread(w);
    const bulk = await bulkIn(w, t, OHBOX);
    await ourSend(w, t, { to: null, headerTo: `Them <${SENDER}>` });

    await tidy(w);
    expect(await desiredOf(bulk), "an unbackfilled Sent row must not cost protection").toBe(OHBOX);
  });

  it("a Sent row this store holds no body for keeps the exclusion — unknown", async () => {
    const w = await newWorld();
    await armTidy(w);
    const t = await newThread(w);
    const bulk = await bulkIn(w, t, OHBOX);
    await ourSend(w, t, { to: null, noBody: true });

    await tidy(w);
    expect(await desiredOf(bulk), "a Sent row with no headers here must not cost protection").toBe(OHBOX);
  });

  it("a Sent row whose stored headers name nobody is addressed to nobody — the exclusion goes", async () => {
    const w = await newWorld();
    await armTidy(w);
    const t = await newThread(w);
    const bulk = await bulkIn(w, t, OHBOX);
    await ourSend(w, t, { to: null });

    await tidy(w);
    expect(await desiredOf(bulk), "a reply that named nobody protected this sender").toBe(READS);
  });
});

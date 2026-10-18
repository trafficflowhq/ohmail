/* @postpush: alone — this file asserts the unsubscribe drain's OWN sweep totals, and that drain's
 * window is deployment-wide. One post-push run ran it beside 96 co-tenants on one lane database: they
 * seeded the window, the anti-vacuity guard refused by name, and each of the three passed when run
 * alone on a fresh one. The post-push driver reads this marker and runs the file by itself. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, sql } from "drizzle-orm";
import { accounts, learningSignals, mailboxes, messages, messageBodies, folderState, rules, unsubscribeRecords } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  makeUnsubscribeService, unsubscribeListKey,
  type ServiceContext, type HostResolver, type OneClickPost,
} from "@trafficflow/services";

/**
 * AUTO-UNSUBSCRIBE, ON REAL POSTGRES — the one claim PGlite structurally cannot check.
 *
 * PGlite is a single-connection, single-process Postgres. It serializes everything, so a unique
 * index that is missing behaves exactly like one that is present and two "concurrent" claims are
 * just two sequential ones. Three production bugs in this repo were invisible to it, and a
 * mutation removing `FOR UPDATE` from the folder mover let two passes double-move a whole batch of messages
 * while the PGlite suite stayed green.
 *
 * The property this whole feature rests on is therefore asserted here or it is not asserted at
 * all: **two concurrent triggers for the same (mailbox, list) make exactly ONE outbound
 * request.** That is not a nice-to-have. The thing on the other end is a stranger's mailing-list
 * server, the request is made on the user's behalf, and there is no undo.
 *
 * **NO REAL SENDER IS CONTACTED.** Every request goes to an injected recording port that opens
 * no socket. A `max: 8` pool, deliberately: `max: 1` would queue the "concurrent" statements in
 * the client and reintroduce the exact blind spot this file exists to remove — which is a
 * mistake this repository has already made once, in `admin`.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `w7-pg-${randomUUID().slice(0, 8)}`,
});

const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
/**
 * The position a Gmail-held mailbox trusts (`providerAuthservIds`). Every letter below carries that
 * provider's confirmation of its own sender's domain — the attacker's too, for the domain they own:
 * the automatic arm asks a list only for a confirmed sender, and the races here are about the claim.
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);

/** Counts every call. Opens nothing. Slow on purpose — see `newWorld`'s comment. */
function countingPost(delayMs = 0): OneClickPost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async post(url: string) {
      calls.push(url);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { status: 200 };
    },
  };
}

const LIST_ID = "news.sender.example";

interface World { accountId: string; mailboxId: string; messageIds: string[] }

/** A person screened this sender out — the automatic arm's licence (UD-R4-03, mail 0128). */
async function personDecided(accountId: string, address: string): Promise<void> {
  await db.insert(rules).values({
    accountId, kind: "sender", match: address.toLowerCase(), destination: "ohmail/Screened",
    provenance: "promoted", personDecidedAt: new Date(),
  });
  await db.insert(learningSignals).values({
    accountId, triggeringActionId: `screener:${randomUUID()}`, kind: "screener",
    senderAddress: address.toLowerCase(), destination: "ohmail/Screened", label: "positive",
  });
}

/**
 * One account, one mailbox, N messages that are all from the SAME list — different senders and
 * different per-message unsubscribe tokens, exactly as a real newsletter arrives. Every one of
 * them is screened out, so every one of them is independently actionable.
 *
 * If the key were the URL or the message, this world would produce N requests. It must produce
 * one.
 */
async function newWorld(n: number): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `w7-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `w7-${accountId.slice(0, 8)}@example.test`,
  }).returning();

  const messageIds: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `w7:${randomUUID()}`,
      subject: `Weekly ${i}`, fromAddress: `bounce-${randomUUID()}@sender.example`,
      nativeLocator: { folder: "ohmail/Screened", ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, text: "",
      headers: {
        "list-id": [`Weekly <${LIST_ID}>`],
        "list-unsubscribe": [`<https://sender.example/u?t=${randomUUID()}>`],
        "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
        "authentication-results": ["mx.google.com; dmarc=pass"],
      },
    });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: "ohmail/Screened", observedFolder: "ohmail/Screened",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    messageIds.push(m!.id);
    await personDecided(accountId, m!.fromAddress);
  }
  return { accountId, mailboxId: mb!.id, messageIds };
}

const recordsOf = async (accountId: string) =>
  db.select().from(unsubscribeRecords).where(eq(unsubscribeRecords.accountId, accountId));

describe.skipIf(!PG_UP)("auto-unsubscribe — the concurrency PGlite cannot see", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 8, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("EIGHT concurrent triggers for one list make exactly ONE request", async () => {
    const w = await newWorld(8);
    // A delay inside the port widens the window between the claim committing and the request
    // returning. Without the unique index every one of the eight would be inside that window
    // together and eight requests would leave the building.
    const post = countingPost(25);
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });

    await Promise.allSettled(w.messageIds.map((id) => svc.unsubscribe(ctx(w.accountId), id)));

    expect(post.calls, "a concurrent trigger sent a duplicate request to a third party")
      .toHaveLength(1);
    const rows = await recordsOf(w.accountId);
    expect(rows, "the record table holds more than one row for one list").toHaveLength(1);
    expect(rows[0]!.state).toBe("sent");
    // The eight messages carry EIGHT different `bounce-<uuid>@sender.example` addresses and one
    // `List-ID`, which is how a real newsletter arrives. Namespacing the key under the author's
    // DOMAIN still collapses them to one claim — the property the `List-ID` was chosen for — and
    // that is the reason the domain is the namespace rather than the full address.
    expect(rows[0]!.listKey).toBe(`list:sender.example|${LIST_ID}`);
  });

  it("the same trigger replayed twice, SEQUENTIALLY, still makes one request", async () => {
    // The retry case rather than the race case: a worker that crashed after committing the
    // claim and is re-run, or a user's client replaying a POST.
    const w = await newWorld(1);
    const post = countingPost();
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });

    await svc.onScreenOut(ctx(w.accountId), w.messageIds);
    await svc.onScreenOut(ctx(w.accountId), w.messageIds);

    expect(post.calls).toHaveLength(1);
    expect(await recordsOf(w.accountId)).toHaveLength(1);
  });

  it("the unique index really is the exclusion — the database refuses a second row outright", async () => {
    // Belt and braces on the constraint itself rather than on the service that relies on it. If
    // this ever stops throwing, the migration's index is gone and every claim above is a
    // read-modify-write with a race in it.
    const w = await newWorld(1);
    const row = {
      accountId: w.accountId, mailboxId: w.mailboxId, listKey: `list:${LIST_ID}`,
      state: "claimed", messageId: w.messageIds[0]!,
    };
    await db.insert(unsubscribeRecords).values(row);

    await expect(db.insert(unsubscribeRecords).values(row))
      .rejects.toThrow(/unsubscribe_records_mailbox_list_uq|duplicate key/i);
  });

  it("two DIFFERENT lists in one mailbox are two requests — the key does not over-collapse", async () => {
    // The failure this catches is the opposite of the one above: a key so coarse that leaving
    // one list silently counts as leaving every list from that mailbox.
    const w = await newWorld(1);
    const [m2] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h2",
      dedupKey: `w7:${randomUUID()}`, subject: "Other", fromAddress: "other@elsewhere.example",
      nativeLocator: { folder: "ohmail/Screened", ref: "1:99" },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m2!.id, text: "",
      headers: {
        "list-id": ["<offers.elsewhere.example>"],
        "list-unsubscribe": ["<https://elsewhere.example/u?t=x>"],
        "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
        "authentication-results": ["mx.google.com; dmarc=pass"],
      },
    });
    await db.insert(folderState).values({
      messageId: m2!.id, desiredFolder: "ohmail/Screened", observedFolder: "ohmail/Screened",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await personDecided(w.accountId, m2!.fromAddress);

    const post = countingPost();
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });
    await svc.onScreenOut(ctx(w.accountId), [...w.messageIds, m2!.id]);

    expect(post.calls).toHaveLength(2);
    expect(await recordsOf(w.accountId)).toHaveLength(2);
  });

  it("the state CHECK is closed — a state nobody enumerated cannot be stored", async () => {
    const w = await newWorld(1);
    await expect(db.insert(unsubscribeRecords).values({
      accountId: w.accountId, mailboxId: w.mailboxId, listKey: "list:invented",
      state: "probably-fine", messageId: w.messageIds[0]!,
    })).rejects.toThrow(/unsubscribe_records_state_closed|violates check constraint/i);
  });

  it("a concurrent drain and trigger for one list still make ONE request", async () => {
    // The realistic production race: the screen-out path fires `onScreenOut` for a message while
    // a drain sweeping the same mailbox reaches a DIFFERENT message from the same list.
    const w = await newWorld(2);
    const post = countingPost(25);
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });

    await Promise.allSettled([
      svc.onScreenOut(ctx(w.accountId), [w.messageIds[0]!]),
      svc.sweepScreenedOut(ctx(w.accountId), { since: new Date(Date.now() - 86_400_000), limit: 50 }),
    ]);

    expect(post.calls).toHaveLength(1);
    expect(await recordsOf(w.accountId)).toHaveLength(1);
  });

  /**
   * ── THE HOSTILE SEQUENCE: ONE SENDER MAY NOT BURN ANOTHER'S UNSUBSCRIBE ───────────────────
   *
   * The attack needs no forgery, which is what made it worth a regression rather than a note.
   * `evil.example` is a domain the attacker legitimately owns and passes authentication for.
   * They put the VICTIM list's `List-ID` on their own message beside their own one-click URL.
   * One ordinary screen-out then claims the key, and every later message from the real list
   * loses the `ON CONFLICT` and is answered `already_recorded` — permanently, per mailbox.
   *
   * It is here and not in the PGlite suite because the claim being tested IS the unique index:
   * the whole exclusion is `ON CONFLICT (mailbox_id, list_key) DO NOTHING … RETURNING`, and a
   * key collision that the database does not enforce is a test asserting its own fixture.
   */
  it("THE HOSTILE SEQUENCE: an attacker cannot burn a legitimate list's key", async () => {
    const VICTIM_LIST = "news.victim.example";
    const w = await newWorld(0);

    /** One screened-out message: whose domain it claims to be from, and which list it names. */
    const plant = async (fromDomain: string, listId: string, url: string) => {
      const [m] = await db.insert(messages).values({
        accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `h-${randomUUID().slice(0, 8)}`,
        dedupKey: `w7:${randomUUID()}`, subject: "Weekly",
        fromAddress: `bounce-${randomUUID().slice(0, 8)}@${fromDomain}`,
        nativeLocator: { folder: "ohmail/Screened", ref: `1:${randomUUID().slice(0, 4)}` },
      }).returning();
      await db.insert(messageBodies).values({
        messageId: m!.id, text: "",
        headers: {
          "list-id": [`Weekly <${listId}>`],
          "list-unsubscribe": [`<${url}>`],
          "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
          "authentication-results": ["mx.google.com; dmarc=pass"],
        },
      });
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: "ohmail/Screened", observedFolder: "ohmail/Screened",
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      await personDecided(w.accountId, m!.fromAddress);
      return m!.id;
    };

    // 1. The attacker's own mail, carrying the VICTIM's List-ID and the ATTACKER's URL.
    const evilId = await plant("evil.example", VICTIM_LIST, "https://evil.example/u?t=burn");
    // 2. The real list, later, exactly as it would arrive.
    const realId = await plant(VICTIM_LIST, VICTIM_LIST, "https://victim.example/u?t=genuine");

    const post = countingPost();
    const svc = makeUnsubscribeService({
      post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL,
    });

    // The order is the attack: the attacker gets there FIRST.
    await svc.onScreenOut(ctx(w.accountId), [evilId]);
    await svc.onScreenOut(ctx(w.accountId), [realId]);

    // THE ACCEPTANCE. Before the identity binding this was one call, to the attacker's URL, and
    // the victim's list could never be left from this mailbox again.
    expect(post.calls, "the victim's list was silenced by another sender's claim")
      .toEqual(["https://evil.example/u?t=burn", "https://victim.example/u?t=genuine"]);

    const rows = await recordsOf(w.accountId);
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => r.listKey).sort();
    // Two DIFFERENT slots: the attacker's claim lives under the domain it actually came from.
    expect(keys).toEqual([
      `list:evil.example|${VICTIM_LIST}`,
      `list:${VICTIM_LIST}|${VICTIM_LIST}`,
    ]);
    // And the attacker never occupied the key the real list derives.
    expect(keys).not.toContain(`list:${VICTIM_LIST}`);
  });

  it("the separator cannot be forged — two different senders never collide", async () => {
    // `|` is legal in a domain and in a sender-authored `List-ID`, so an unescaped join is a
    // second way to reach somebody else's slot: `d="victim.example|news"` + `l="x"` would
    // concatenate to the same bytes as `d="victim.example"` + `l="news|x"`. Asserted on the pure
    // function because it is a property of the encoding, not of any one message.
    const key = (from: string, listId: string) =>
      unsubscribeListKey({ "list-id": [`<${listId}>`] }, from);
    expect(key("a@victim.example|news", "x")).not.toBe(key("a@victim.example", "news|x"));
  });

  it("the drain's cutoff is honoured against a real clock, not a fixture one", async () => {
    const w = await newWorld(1);
    await db.update(folderState).set({ updatedAt: sql`now() - interval '30 days'` })
      .where(eq(folderState.messageId, w.messageIds[0]!));
    const post = countingPost();
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });

    const sweep = await svc.sweepScreenedOut(ctx(w.accountId), {
      since: new Date(Date.now() - 86_400_000), limit: 50,
    });

    expect(sweep.considered, "the drain reached back past its own cutoff").toBe(0);
    expect(post.calls).toHaveLength(0);
  });
});

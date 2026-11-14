import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { asc, eq } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { screenerAttemptKey } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { ClassifierPort } from "@trafficflow/core";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";

/**
 * SEC3-MONEY-3 — THE SCREENER'S PAGE ANSWERS ABOUT A SENDER, AND THE PURCHASE ABOUT A MESSAGE.
 *
 * ## The defect this file is the other half of
 *
 * The always-on pass bought one suggestion per SENDER and charged per MESSAGE. The fix is in the
 * worker (`screener-auto-suggest.ts` — its entitlement is now per sender), and on its own it would
 * have broken the feature it protects: the advice is stored against the message the model read, the
 * page looked it up by the sender's REPRESENTATIVE — their newest held message — and so one more
 * message from that sender hid an answer the account had already paid for.
 *
 * That is not only a display bug, it is the same money defect on a second door. The client's
 * automatic on-open batch buys "every waiting sender with no answer", and its whole knowledge of
 * who has an answer is this page (`apps/webapp/app/shell/screener-suggest.ts` hydrates from
 * `GET /screener`). A sender whose advice had gone invisible was therefore bought again on the next
 * Screener open, and again on the one after that — no press, once per re-send.
 *
 * ## What is asserted, and what must NOT change with it
 *
 * `list` reads by sender. `suggest` does NOT: the pressed path keeps its per-message identity,
 * because a person asking again about a sender who has since sent new mail is asking about mail the
 * model has not read, and that is a purchase. So the two assertions here are opposites on purpose —
 * the page stops charging for a re-send, the press still charges for one — and a change that made
 * either of them agree with the other would be a defect (the first re-opens the drain, the second
 * makes the re-ask free for ever, which is the unbounded-free-model-call shape
 * `AiCreditGateOptions.retryWindowMs` exists to name).
 *
 * ## Why real Postgres
 *
 * The identity is a `DISTINCT ON (lower(from_address))` over a join, with "newest wins" decided by
 * `ORDER BY rd.created_at DESC, rd.id DESC` — a claim about Postgres' own ordering of rows this
 * suite inserts within the same millisecond, and about `lower()` matching an expression index. A
 * JavaScript array cannot be wrong in the ways that can.
 */
const PG_UP = await realPgAvailable();

const NOW = new Date("2026-08-10T09:00:00Z");
/** The sender's own clock, moved forward per message so "newest held" is identifiable. */
const dateOf = (nth: number) => new Date(NOW.getTime() - 3600_000 + nth * 60_000);

let pool: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

function spy(calls: string[]): ClassifierPort {
  return {
    async classify(i) {
      calls.push(i.from.address);
      return {
        destination: "INBOX", confidence: 0.9,
        rationale: `verdict ${calls.length} about ${i.subject}`, spam: false,
      };
    },
  };
}

/**
 * THE SPEND PORT, RECORDING — what each door ASKED about, which is this file's whole subject.
 *
 * The assertions below are about IDENTITY: whether the page and the purchase key on the sender
 * or on the message. A recorded ask names the attempt key verbatim, so the identity is read off
 * the call rather than out of a ledger row — the same fact, one layer earlier, and available on
 * a server that keeps no ledger.
 */
const credits = fakeSpendPort();

const ctxFor = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId, userId: null, now: () => NOW, requestId: randomUUID(),
});

interface World { accountId: string; mailboxId: string }

async function seed(granted = 50): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `m3-${accountId.slice(0, 8)}` });
  credits.budget(granted);
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `m3-${accountId.slice(0, 8)}@ex.test` }).returning();
  return { accountId, mailboxId: mb!.id };
}

/** One held first-contact message. `nth` moves the `Date:` forward, so the highest nth represents. */
async function held(w: World, from: string, nth: number, subject = `message ${nth}`): Promise<string> {
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: dedup,
    bodyHash: randomUUID(), dedupKey: dedup,
    subject, fromAddress: from, snippet: "hello", date: dateOf(nth),
    nativeLocator: { folder: "ohmail/Screener", ref: `1:${Math.floor(Math.random() * 1e6)}` },
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

/**
 * WHAT EACH PURCHASE ASKED FOR, in the order it asked — the port records its calls, so the
 * chronology is the array's own and needs no `ORDER BY` argument about commit order.
 */
const asksOf = (accountId: string) =>
  credits.spends
    .filter((c) => c.accountId === accountId && c.action === "screener")
    .map((c) => c.attemptKey);

describe.skipIf(!PG_UP)("SEC3-MONEY-3 — the page answers per SENDER, the purchase per MESSAGE", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    pool = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(pool, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await pool?.end({ timeout: 5 }); });

  /**
   * THE MUTATION: point `list`'s read back at the representative —
   * `this.storedSuggestions(ctx, pageRows.map((r) => r.messageId), posture)`, keyed on
   * `r.messageId` in both `items` and `suggestable`. This test then reports a null suggestion and
   * the sender back in the buy list, which is the state the unpressed batch re-buys from.
   */
  it("a sender who sends again KEEPS their advice on the page, and is not priced again", async () => {
    const w = await seed();
    const calls: string[] = [];
    const svc = new ScreenerService({ classifier: spy(calls), credits, pricing: PLANE_PRICING });
    const first = await held(w, "stranger@ex.test", 1, "first contact");

    const bought = await svc.suggest(ctxFor(w.accountId), { senders: ["stranger@ex.test"] });
    expect(bought.charged).toBe(1);
    expect(bought.suggestions[0]!.messageId).toBe(first);

    // …and they send again. The representative rotates to the newer message, which carries no
    // suggestion row of its own.
    const second = await held(w, "stranger@ex.test", 2, "and again");

    const page = await svc.list(ctxFor(w.accountId));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.messageId, "the newest held message is still the representative").toBe(second);
    // THE CLAIM: the advice the account paid for is still on the row.
    expect(page.items[0]!.aiSuggestion, "advice already paid for went invisible on a re-send")
      .not.toBeNull();
    expect(page.items[0]!.aiSuggestion!.rationale).toContain("first contact");
    // AND THE MONEY CLAIM: the unpressed batch's buy list is this field, so a sender in it is a
    // sender that will be bought again with nobody pressing anything.
    expect(page.suggestable.senders, "a re-sending sender was offered for sale again").toEqual([]);
    expect(calls, "the page called the model").toHaveLength(1);
    expect(asksOf(w.accountId)).toEqual([screenerAttemptKey(first)]);
  }, 30_000);

  /**
   * THE OTHER DIRECTION, and it must NOT follow the page.
   *
   * `suggest` keeps the per-message identity: a press over a sender whose newer mail is unbought is
   * a purchase of a verdict about mail the model has not read, priced and charged like any other.
   * Making this free — which is what a sender-keyed ledger source would do — is the
   * unbounded-free-model-call shape, and it would also make "Suggest again" a control that cannot
   * do what it says.
   *
   * MUTATION: change `suggest`'s layer-1 read (`stored.get(r.messageId)`) to the sender read, and
   * this goes red with `charged: 0` and one model call.
   */
  it("the PRESS still buys a verdict about the newer mail, and the page then shows THAT one", async () => {
    const w = await seed();
    const calls: string[] = [];
    const svc = new ScreenerService({ classifier: spy(calls), credits, pricing: PLANE_PRICING });
    const first = await held(w, "chatty@ex.test", 1, "first contact");
    await svc.suggest(ctxFor(w.accountId), { senders: ["chatty@ex.test"] });
    const second = await held(w, "chatty@ex.test", 2, "newer mail");

    const again = await svc.suggest(ctxFor(w.accountId), { senders: ["chatty@ex.test"] });

    expect(again.charged, "a re-ask over unread mail was given away").toBe(1);
    expect(calls, "the model was not asked about the newer mail").toHaveLength(2);
    expect(calls[1]).toBe("chatty@ex.test");
    expect(again.suggestions[0]!.messageId).toBe(second);
    expect(asksOf(w.accountId)).toEqual([
      screenerAttemptKey(first),
      screenerAttemptKey(second),
    ]);

    // NEWEST WINS, and it is the database that decides: both rows are this sender's, inserted
    // within the same second, and the page must show the verdict about the mail on screen.
    const page = await svc.list(ctxFor(w.accountId));
    expect(page.items[0]!.aiSuggestion!.rationale).toContain("newer mail");
    expect(page.suggestable.senders).toEqual([]);
  }, 30_000);

  it("a sender with no advice at all is still priced — the page did not stop selling", async () => {
    const w = await seed();
    const svc = new ScreenerService({ classifier: spy([]), credits, pricing: PLANE_PRICING });
    await held(w, "advised@ex.test", 1);
    await svc.suggest(ctxFor(w.accountId), { senders: ["advised@ex.test"] });
    await held(w, "unknown@ex.test", 2);

    const page = await svc.list(ctxFor(w.accountId));

    expect(page.suggestable.senders).toEqual(["unknown@ex.test"]);
    expect(page.items.find((i) => i.sender.address === "unknown@ex.test")!.aiSuggestion).toBeNull();
    expect(page.items.find((i) => i.sender.address === "advised@ex.test")!.aiSuggestion).not.toBeNull();
  }, 30_000);

  /**
   * THE IDENTITY IS AN ADDRESS, WHICH THE SENDER CHOOSES — so the account has to lead it.
   *
   * `screenerSuggestionsBySender` joins `routing_decisions` to `messages` and puts `account_id` on
   * BOTH sides. Without that, one account's advice about `overlap@ex.test` would answer for every
   * other account holding mail from the same address: a chip on somebody else's row, drawn from a
   * stranger's rationale, and their sender silently dropped out of the buy list.
   */
  it("another account's advice about the SAME address answers for nobody but its own", async () => {
    const mine = await seed();
    const theirs = await seed();
    const svc = new ScreenerService({ classifier: spy([]), credits, pricing: PLANE_PRICING });
    await held(theirs, "overlap@ex.test", 1, "their mail");
    await svc.suggest(ctxFor(theirs.accountId), { senders: ["overlap@ex.test"] });
    await held(mine, "overlap@ex.test", 1, "my mail");

    const page = await svc.list(ctxFor(mine.accountId));

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.aiSuggestion, "another account's verdict was drawn on this row").toBeNull();
    expect(page.suggestable.senders).toEqual(["overlap@ex.test"]);
    expect(asksOf(mine.accountId)).toEqual([]);
  }, 30_000);

  it("CASE is not identity — a sender who varies their capitalisation is one sender", async () => {
    // Every writer and reader of an address in this tree case-folds, and the index is on
    // `lower(from_address)`. A sender who alternates would otherwise be advised once per spelling.
    const w = await seed();
    const calls: string[] = [];
    const svc = new ScreenerService({ classifier: spy(calls), credits, pricing: PLANE_PRICING });
    await held(w, "Mixed@Ex.test", 1, "first contact");
    await svc.suggest(ctxFor(w.accountId), { senders: ["mixed@ex.test"] });
    await held(w, "MIXED@ex.TEST", 2, "shouted");

    const page = await svc.list(ctxFor(w.accountId));

    expect(page.items, "one sender, two spellings, two rows").toHaveLength(1);
    expect(page.items[0]!.aiSuggestion).not.toBeNull();
    expect(page.suggestable.senders).toEqual([]);
    expect(calls).toHaveLength(1);
  }, 30_000);
});

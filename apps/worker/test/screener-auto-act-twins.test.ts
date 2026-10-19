import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messages, routingDecisions, rules,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS, type Tx,
} from "@trafficflow/db";
import { screenerAutoActPass, type ScreenerActConsent } from "../src/screener-auto-act.js";

/**
 * THE AUTO-ACT NEVER WRITES OVER A SENDER WHO HAS A RULE. A decision a person presses converges
 * the sender's key onto its acting row (`applyScreenerDecision`); the pass acting on advice writes
 * nothing and files nothing for a key that has any row (`overExisting: "skip"`). Its page skips
 * decided senders, so the case is a rule the person writes after the page was read: the injector
 * writes a screen-out as the pass opens its per-sender transaction.
 */
const SCREENER = "ohmail/Screener";
const SCREENED = "ohmail/Screened";
const SPAM = "ohmail/Quarantine";
const WHO = "late@shop.test";
/** The act's own consent, given. */
const GIVEN: ScreenerActConsent = { stillGiven: async () => true };

describe("the auto-act beside a rule written after its page was read", () => {
  let db: Tx;
  beforeAll(async () => { db = (await makeTestDb()) as unknown as Tx; });

  /** One held letter of WHO, advised to `destination`; its provider's verdict NULL unless said. */
  async function world(o: { destination?: string; authVerdict?: string } = {}): Promise<{ accountId: string; messageId: string }> {
    const destination = o.destination ?? "INBOX";
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `twin-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `twin-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `twin:${randomUUID()}`, subject: "hello", fromAddress: WHO,
      nativeLocator: { folder: SCREENER, ref: `1:${Math.floor(Math.random() * 1e6)}` },
      ...(o.authVerdict !== undefined ? { authVerdict: o.authVerdict } : {}),
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(routingDecisions).values({
      accountId, messageId: m!.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination, confidence: 0.99, rationale: "", spam: destination === SPAM, status: SCREENER_SUGGESTION_STATUS,
    });
    return { accountId, messageId: m!.id };
  }

  /** The handle the pass runs on, with the person's screen-out landing as its transaction opens. */
  function racing(accountId: string): Tx {
    let written = false;
    return new Proxy(db as object, {
      get(target, key, receiver) {
        if (key !== "transaction") return Reflect.get(target, key, receiver);
        return async (...args: unknown[]) => {
          if (!written) {
            written = true;
            await db.insert(rules).values({ accountId, kind: "sender", match: WHO, destination: SCREENED, provenance: "manual" });
          }
          return (db.transaction as (...a: unknown[]) => unknown)(...args);
        };
      },
    }) as Tx;
  }

  const rulesFor = (accountId: string) =>
    db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.match, WHO)));

  it("the person's screen-out stands alone: the pass writes no rule and files nothing for that sender", async () => {
    const w = await world();
    const r = await screenerAutoActPass(racing(w.accountId), { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ ran: true, filed: 0, kept: 1, failed: 0 });
    expect((await rulesFor(w.accountId)).map((x) => [x.provenance, x.destination])).toEqual([["manual", SCREENED]]);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    expect(fs!.desiredFolder, "the pass filed a message the person's rule decides").toBe(SCREENER);
  });

  it("the positive control: with no rule written the sender is filed and one rule is promoted", async () => {
    const w = await world();
    expect(await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN })).toMatchObject({ filed: 1 });
    expect((await rulesFor(w.accountId)).map((x) => [x.provenance, x.destination])).toEqual([["promoted", "INBOX"]]);
  });

  /* A DENY ON A LETTER ITS PROVIDER DID NOT CONFIRM files that letter alone and writes no rule; a
     rule written after the page was read still decides the sender, so that filing writes nothing. */
  it("a deny on an unconfirmed letter files nothing when the person's rule lands as its transaction opens", async () => {
    const w = await world({ destination: SPAM, authVerdict: "unavailable" });
    const r = await screenerAutoActPass(racing(w.accountId), { accountId: w.accountId, consent: GIVEN });
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    expect(fs!.desiredFolder, "the act filed a letter the person's rule decides").toBe(SCREENER);
    expect((await rulesFor(w.accountId)).map((x) => [x.provenance, x.destination])).toEqual([["manual", SCREENED]]);
    expect(r).toMatchObject({ ran: true, filed: 0, kept: 1, failed: 0, unconfirmedDenies: 0 });
  });

  it("the positive control: with no rule written the unconfirmed letter is filed and no rule is written", async () => {
    const w = await world({ destination: SPAM, authVerdict: "unavailable" });
    expect(await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN }))
      .toMatchObject({ filed: 0, kept: 1, unconfirmedDenies: 1 });
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    expect(fs!.desiredFolder).toBe(SPAM);
    expect(await rulesFor(w.accountId)).toEqual([]);
  });
});

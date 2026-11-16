import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messages, rules, threads, type Tx } from "@trafficflow/db";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * THE RETRO PASS READS THE ONE OWN-ADDRESS SET (VERIFY-026 HIGH). A rule about a removed mailbox's
 * address is admitted at the door, so the pass that walks its backlog must count that address as a
 * stranger's too: the mail from it moves where the rule says. A stranger's backlog moves (the
 * control); a LIVE own address's stays in INBOX, since a sender rule naming an own address never
 * decides own mail (HAND BACK 1). The we-answered shield keeps the wider set: a reply sent from a
 * mailbox the person later removed still keeps that conversation where it is.
 */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
const NOW = new Date("2026-10-06T12:00:00Z");

async function world(oldState: "removed" | "live") {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `retro-own-${accountId.slice(0, 8)}` });
  const [main] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "main@retro.invalid" }).returning();
  const [old] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "old@retro.invalid",
    ...(oldState === "removed" ? { status: "disabled", disabledReason: null } : {}),
  }).returning();
  const seed = async (from: string, threadId: string | null = null) => {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: main!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "hello", fromAddress: from, threadId, nativeLocator: { folder: "INBOX", ref: "1:1" },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  const rule = (match: string) => db.insert(rules).values({
    accountId, kind: "sender", match, destination: "ohmail/Screened", provenance: "manual", enabled: true,
    retroRequestedAt: new Date("2026-10-06T10:00:00Z"),
  });
  const desired = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  const pass = () => ruleRetroPass(db as unknown as Tx, { accountId, trustedAuthservIdsFor: NONE }, NOW);
  // The person's reply in `threadId`, sent from the old mailbox and addressed to `to`.
  const reply = async (threadId: string, to: string) => {
    const dedup = `mid:${randomUUID()}`;
    await db.insert(messages).values({
      accountId, mailboxId: old!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "Re: hello", fromAddress: "old@retro.invalid", toAddresses: [{ address: to }], threadId,
      nativeLocator: { folder: "Sent", ref: "1:2" },
    });
  };
  const thread = async () => (await db.insert(threads).values({ accountId, subject: "hello" }).returning())[0]!.id;
  return { seed, rule, desired, pass, reply, thread };
}

describe("the rule-retro pass against the one own-address set", () => {
  it("a rule about a removed mailbox's address moves its backlog", async () => {
    const w = await world("removed");
    const backlog = await w.seed("old@retro.invalid");
    await w.rule("old@retro.invalid");
    const out = await w.pass();
    expect({ examined: out.examined, moved: out.moved, now: await w.desired(backlog) })
      .toEqual({ examined: 1, moved: 1, now: "ohmail/Screened" });
  });

  it("CONTROL: the identical seed for a stranger's address moves the backlog", async () => {
    const w = await world("removed");
    const backlog = await w.seed("stranger@elsewhere.invalid");
    await w.rule("stranger@elsewhere.invalid");
    const out = await w.pass();
    expect({ moved: out.moved, now: await w.desired(backlog) }).toEqual({ moved: 1, now: "ohmail/Screened" });
  });

  it("a thread answered from the removed mailbox stays put; the sender's unanswered mail moves", async () => {
    const w = await world("removed");
    const t = await w.thread();
    const answered = await w.seed("friend@elsewhere.invalid", t);
    await w.reply(t, "friend@elsewhere.invalid");
    const unanswered = await w.seed("friend@elsewhere.invalid");
    await w.rule("friend@elsewhere.invalid");
    const out = await w.pass();
    expect({ moved: out.moved, answered: await w.desired(answered), unanswered: await w.desired(unanswered) })
      .toEqual({ moved: 1, answered: "INBOX", unanswered: "ohmail/Screened" });
  });

  it("CONTROL: a live own address's rule leaves its own mail in INBOX", async () => {
    const w = await world("live");
    const backlog = await w.seed("old@retro.invalid");
    await w.rule("old@retro.invalid");
    const out = await w.pass();
    expect({ moved: out.moved, now: await w.desired(backlog) }).toEqual({ moved: 0, now: "INBOX" });
  });
});

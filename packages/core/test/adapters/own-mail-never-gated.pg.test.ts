import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import {
  accounts, changeLog, folderState, mailboxes, messages, routingDecisions, rules as rulesTbl,
} from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "../../src/adapters/drizzle-repo.js";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../../src/pipeline.js";
import type { Change } from "../../src/ports.js";

/**
 * OWN MAIL NEVER AT THE GATE, BY REAL SQL. The ingest half: an arrival from any of the account's
 * mailbox addresses stays in INBOX with no routing row. The repair half: own mail WE filed into
 * `ohmail/Screener` is desired back into INBOX once, bounded per call; a person's placement, a
 * failed authentication, a sender rule and a stranger's mail are never selected.
 */

const AVAILABLE = await realPgAvailable();
const GATE = "ohmail/Screener";

describe.skipIf(!AVAILABLE)("own mail and the gate, on real Postgres", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);
  afterAll(async () => { await owned?.close().catch(() => {}); });

  async function world() {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await owned.db.insert(accounts).values({ id: accountId, name: `own-${tag}` });
    const me = `me-${tag}@own.invalid`;
    const alsoMe = `second-${tag}@own-too.invalid`;
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: me, organizerRole: "organizer" }).returning();
    await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: alsoMe, organizerRole: "organizer" });
    return { accountId, mailboxId: mb!.id, me, alsoMe };
  }

  function eml(from: string): Buffer {
    return Buffer.from([
      `Message-ID: <own-${randomUUID()}@own.invalid>`, `From: ${from}`, "To: me@own.invalid",
      "Subject: a note to myself", "Content-Type: text/plain; charset=utf-8", "", "Remember.",
    ].join("\r\n"));
  }

  async function ingest(w: { accountId: string; mailboxId: string }, raw: Buffer): Promise<string> {
    const change: Change = { type: "create", locator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e6)}` }, raw };
    const plan = await planChange(change, {
      accountId: w.accountId, mailboxId: w.mailboxId, repo: makeDrizzleRepo(owned.db), readerMode: false,
    });
    const res = await owned.db.transaction(async (tx) =>
      commitChange(plan, { ...w, repo: makeDrizzleRepo(tx as never), storageCap: UNMETERED_STORAGE_CAP }));
    return res.messageId;
  }

  const desiredOf = async (id: string): Promise<string> =>
    (await owned.db.select().from(folderState).where(eq(folderState.messageId, id)))[0]!.desiredFolder;

  it("an arrival from either own address stays in INBOX and writes no routing row", async () => {
    const w = await world();
    const a = await ingest(w, eml(w.me));
    const b = await ingest(w, eml(w.alsoMe.toUpperCase()));
    expect(await desiredOf(a)).toBe("INBOX");
    expect(await desiredOf(b)).toBe("INBOX");
    const rds = await owned.db.select().from(routingDecisions).where(eq(routingDecisions.accountId, w.accountId));
    expect(rds).toHaveLength(0);
    // CONTROL: a stranger through the same door is held.
    expect(await desiredOf(await ingest(w, eml("someone@stranger.invalid")))).toBe(GATE);
  });

  it("the repair moves own mail an organizer filed at the gate back once; a person's, a failed one, a ruled one and a stranger's stay", async () => {
    const w = await world();
    let n = 0;
    const seed = async (from: string, lastSetBy: string, auth: string | null = null): Promise<string> => {
      const i = n++;
      const [m] = await owned.db.insert(messages).values({
        accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `h${i}`, dedupKey: `own:${randomUUID()}`,
        subject: `Note ${i}`, snippet: "", fromAddress: from, unread: true, authVerdict: auth,
        nativeLocator: { folder: GATE, ref: `1:${i}` },
      }).returning();
      await owned.db.insert(folderState).values({
        messageId: m!.id, accountId: m!.accountId, desiredFolder: GATE, observedFolder: GATE,
        lastSetBy, reconcileStatus: "reconciled", conflict: false,
      });
      return m!.id;
    };
    const ours1 = await seed(w.me, "us");
    const ours2 = await seed(w.alsoMe.toUpperCase(), "us", "unavailable");
    // Met at the gate on this install's first read: the previous organizer's filing.
    const peers = await seed(w.me, "peer");
    const personMoved = await seed(w.me, "external");
    const forged = await seed(w.me, "us", "fail");
    const stranger = await seed("someone@stranger.invalid", "us");
    const ruledSender = `ruled-${w.accountId.slice(0, 8)}@own-three.invalid`;
    await owned.db.insert(mailboxes).values({ accountId: w.accountId, provider: "imap", address: ruledSender });
    const ruled = await seed(ruledSender, "us");
    await owned.db.insert(rulesTbl).values({
      accountId: w.accountId, kind: "sender", match: ruledSender, destination: GATE,
      priority: 0, provenance: "manual", enabled: true,
    });

    const release = (limit: number) => owned.db.transaction(async (tx) =>
      makeDrizzleRepo(tx as never).releaseOwnMailAtGate(w.accountId, w.mailboxId, limit));

    expect(await release(1), "bounded per call").toBe(1);
    expect(await release(100)).toBe(2);
    expect(await release(100), "idempotent: nothing is at the gate any more").toBe(0);

    expect(await desiredOf(ours1)).toBe("INBOX");
    expect(await desiredOf(ours2)).toBe("INBOX");
    expect(await desiredOf(peers)).toBe("INBOX");
    for (const kept of [personMoved, forged, stranger, ruled]) expect(await desiredOf(kept)).toBe(GATE);

    const moves = await owned.db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.op, "move")));
    expect(moves.map((m) => m.entityId).sort()).toEqual([ours1, ours2, peers].sort());
    for (const m of moves) expect(m.meta).toEqual({ from: GATE, to: "INBOX" });
    const [st] = await owned.db.select().from(folderState).where(eq(folderState.messageId, ours1));
    expect(st!.lastSetBy).toBe("us");
    expect(st!.reconcileStatus).toBe("pending");
  });
});

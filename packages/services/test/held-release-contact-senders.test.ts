import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, contacts, folderState, mailboxes, messageBodies, messages, recordChange, rules, type Tx,
} from "@trafficflow/db";
import {
  HELD_RELEASE_GROUPS_MAX, dismissHeldRelease, heldReleaseFingerprint, heldReleaseSummary, releaseHeld,
} from "../src/held-release-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * A CONTACT'S HELD MAIL IS OFFERED AND RELEASED (row 138). Mail from somebody in the account's
 * contacts that nobody wrote a rule for sat at the gate with no group and no press after the
 * one-time gate repair. The summary names each such sender beside the rule groups (`total` stays
 * the groups' figure, for older clients), the fingerprint covers both lists, and the press decides
 * a named sender into the Ohbox through the Screener's own door — desired state only.
 */

const GATE = "ohmail/Screener";
const T = Date.parse("2026-09-25T14:00:00.000Z");
const at = (minutes: number) => new Date(T + minutes * 60_000);

async function seed() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const own = `me-${accountId.slice(0, 8)}@ohmail.test`;
  await db.insert(accounts).values({ id: accountId, name: `cs-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: own, organizerRole: "organizer",
  }).returning();
  let tick = 0;
  const ctx: ServiceContext = {
    db: db as never, accountId, userId: null, now: () => new Date(T + ++tick), requestId: `cs-${randomUUID().slice(0, 8)}`,
  };
  let n = 0;
  const changed = (entityType: "message" | "rule", entityId: string, op: "create" | "move" | "update") =>
    db.transaction(async (tx) => { await recordChange(tx as never, { accountId, entityType, entityId, op, meta: null }); });
  const held = async (from: string, folder = GATE): Promise<string> => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `cs:${randomUUID()}`, subject: `Note ${i}`,
      snippet: "", fromAddress: from, date: at(-600), unread: true, createdAt: at(-600),
      nativeLocator: { folder, ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder, lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false, updatedAt: at(-100),
    });
    await changed("message", m!.id, "create");
    return m!.id;
  };
  const contact = (address: string) => db.insert(contacts).values({ accountId, address });
  const summary = () => heldReleaseSummary(db as unknown as Tx, accountId);
  return { db, accountId, own, ctx, held, contact, changed, summary };
}

describe("the summary offers a contact nobody wrote a rule for", () => {
  it("one line per contact-only sender, and `total` stays the rule groups' figure", async () => {
    const w = await seed();
    await w.held("Known@X.test");
    await w.held("known@x.test");
    await w.held("stranger@x.test");
    await w.contact("known@x.test");
    const s = await w.summary();
    expect(s.senders).toEqual([{ sender: "known@x.test", count: 2 }]);
    expect(s.total, "an older client reads `total` as the groups' figure").toBe(0);
    expect(s.groups).toEqual([]);
    expect(s.fingerprint, "a sender-only set has an identity to dismiss").not.toBe("");
  });

  it("a contact with an enabled rule is the rule's group, never a sender line (the control)", async () => {
    const w = await seed();
    await w.held("known@x.test");
    await w.contact("known@x.test");
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "known@x.test", destination: "INBOX", provenance: "manual",
      enabled: true, priority: 0, retroRequestedAt: null, createdAt: at(-1_000), updatedAt: at(-1_000),
    });
    const s = await w.summary();
    expect(s.senders).toEqual([]);
    expect(s.groups.map((g) => g.match)).toEqual(["known@x.test"]);
  });

  it("a contact's mail outside the gate is no line", async () => {
    const w = await seed();
    await w.held("known@x.test", "INBOX");
    await w.contact("known@x.test");
    expect((await w.summary()).senders).toEqual([]);
  });

  it("the fingerprint covers the sender lines: the same groups with a new line are a new set", () => {
    const g = [{ ruleId: "r1", kind: "sender" as const, match: "a@x.test", destination: "INBOX", count: 1 }];
    expect(heldReleaseFingerprint(g, [{ sender: "k@x.test", count: 1 }])).not.toBe(heldReleaseFingerprint(g, []));
    expect(heldReleaseFingerprint(g, [])).toBe(heldReleaseFingerprint(g));
  });

  it("a dismissed offer comes back when a contact's held mail joins after it", async () => {
    const w = await seed();
    await w.held("known@x.test");
    await w.contact("known@x.test");
    await dismissHeldRelease(w.ctx, { fingerprint: (await w.summary()).fingerprint });
    expect((await w.summary()).dismissed).toBe(true);
    await w.held("known@x.test");
    expect((await w.summary()).dismissed, "new held mail from the contact re-offers").toBe(false);
  });
});

describe("the press decides a named contact into the Ohbox", () => {
  it("writes the person's rule and desires the held bag into the Ohbox; the line is gone after", async () => {
    const w = await seed();
    const ids = [await w.held("known@x.test"), await w.held("known@x.test")];
    await w.contact("known@x.test");
    const out = await releaseHeld(w.ctx, { senders: ["Known@x.test"] });
    expect(out.releasedSenders).toEqual([{ sender: "known@x.test", count: 2 }]);
    expect(out.total).toBe(2);
    const [r] = await w.db.select().from(rules)
      .where(and(eq(rules.accountId, w.accountId), eq(rules.match, "known@x.test")));
    expect(r, "the press is a decision: a rule the person made").toMatchObject({ kind: "sender", destination: "INBOX", enabled: true });
    const desired = await w.db.select({ d: folderState.desiredFolder }).from(folderState);
    expect(desired.filter((x) => ids.length > 0 && x.d === "INBOX").length, "desired only: the reconciler moves the mail").toBe(2);
    const s = await w.summary();
    expect(s.senders).toEqual([]);
    const again = await releaseHeld(w.ctx, { senders: ["known@x.test"] });
    expect(again, "a replay decides nothing and says so").toEqual({ released: [], releasedSenders: [], total: 0 });
  });

  it("an absent `senders` decides no contact: an older client's press releases what it showed", async () => {
    const w = await seed();
    await w.held("known@x.test");
    await w.contact("known@x.test");
    const out = await releaseHeld(w.ctx, {});
    expect(out).toEqual({ released: [], releasedSenders: [], total: 0 });
    expect((await w.summary()).senders).toEqual([{ sender: "known@x.test", count: 1 }]);
  });

  it("a sender the summary does not offer is not decided by naming it", async () => {
    const w = await seed();
    await w.held("stranger@x.test");
    const out = await releaseHeld(w.ctx, { senders: ["stranger@x.test"] });
    expect(out.releasedSenders).toEqual([]);
    expect(await w.db.select().from(rules).where(eq(rules.accountId, w.accountId))).toEqual([]);
  });

  it("refuses a malformed or oversized `senders`", async () => {
    const w = await seed();
    const refused = async (senders: unknown) => {
      try { await releaseHeld(w.ctx, { senders: senders as string[] }); return "admitted"; }
      catch (e) { return (e as { httpStatus?: number }).httpStatus === 400 ? "refused" : String(e); }
    };
    expect(await refused("known@x.test")).toBe("refused");
    expect(await refused([1])).toBe("refused");
    expect(await refused([""])).toBe("refused");
    expect(await refused(Array.from({ length: HELD_RELEASE_GROUPS_MAX + 1 }, (_, i) => `s${i}@x.test`))).toBe("refused");
    expect(await refused(["known@x.test"]), "the control: a well-formed list is admitted").toBe("admitted");
  });
});

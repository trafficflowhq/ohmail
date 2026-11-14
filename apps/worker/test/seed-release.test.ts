import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, changeLog, folderState, mailboxes, messageBodies, messages, rules, type Tx,
} from "@trafficflow/db";
import { confirmSeed } from "@trafficflow/services/mail";
import type { ServiceContext } from "@trafficflow/services";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * ═══ CONFIRMING THE SEED RELEASES WHAT THE GATE IS HOLDING FROM THOSE PEOPLE ══════════════
 *
 * ── THE MEASURED GAP ──────────────────────────────────────────────────────────────────────
 *
 * `confirmSeed` wrote its rules with `retro_requested_at` NULL, on the argument that consent
 * granted in bulk must not move the past. A NULL there is not owed work, so no pass was ever
 * selected for those rules — and mail imported the day BEFORE the confirmation was still sitting
 * at the gate months later, with `desired = observed = 'ohmail/Screener'` and `last_set_by =
 * 'us'`. The Screener went on calling the sender first-time. The seed confirmation IS the press:
 * a person naming somebody they write to is consenting to exactly this.
 *
 * ── THE CLAIM, AND ITS EXACT BOUNDS ───────────────────────────────────────────────────────
 *
 * The rules carry `release_held_at` EQUAL to `retro_requested_at`, which is `isReleaseRun`'s
 * shape, so the pass's release arm walks ONLY rows settled at the gate. "Must not move the past"
 * therefore stays true for every row outside it — and this file drives four rows from the SAME
 * sender to say so: at the gate, in the Ohbox, hand-filed into Reads, and in flight.
 *
 * ── MUTATIONS WATCHED (each restored by `cmp`) ────────────────────────────────────────────
 *
 *  · drop `releaseHeldAt` from the seed's insert (leave `retroRequestedAt`) ⇒ 3 RED: the shape
 *      is gone, the pass moves 2 rows instead of 1, and the row IN FLIGHT is re-decided into the
 *      Ohbox. An ordinary retro re-opens the whole backlog, which is what the narrowing is for.
 *  · drop `retroRequestedAt` from the seed's insert (leave `releaseHeldAt`) ⇒ 3 RED, all of
 *      them "moved 0": the rule is never OWED, which is exactly the state measured on the
 *      reported account — a NULL there is not work, so no pass is ever selected for it.
 *  · drop the two gate equalities from `selectCandidates`' release arm ⇒ 3 RED: 3 rows move,
 *      the hand file in Reads among them. That is "must not move the past", broken.
 */

const GATE = "ohmail/Screener";
const OHBOX = "INBOX";
const READS = "ohmail/News";
const NOW = new Date("2026-08-05T08:39:00.000Z");
const IMPORTED = new Date("2026-08-04T00:18:00.000Z");
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

interface World {
  db: Awaited<ReturnType<typeof makeTestDb>>;
  accountId: string;
  mailboxId: string;
  own: string;
}

const ctxOf = (w: World): ServiceContext => ({
  db: w.db as never, accountId: w.accountId, userId: null,
  now: () => NOW, requestId: `sr-${randomUUID().slice(0, 8)}`,
});

/**
 * THE REPORTED ACCOUNT AT THE MOMENT OF CONFIRMATION: one sent message naming the correspondent,
 * and four of their messages already in the mirror from the import the day before.
 */
async function seed(): Promise<World & { held: string; ohbox: string; hand: string; flight: string }> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `sr-${accountId.slice(0, 8)}` });
  const own = `me-${accountId.slice(0, 8)}@ohmail.test`;
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: own, organizerRole: "organizer",
  }).returning();
  const w: World = { db, accountId, mailboxId: mb!.id, own };

  let n = 0;
  const message = async (o: {
    from: string; desired: string; observed?: string; lastSetBy: string;
    headers?: Record<string, string[]>; folder?: string;
  }): Promise<string> => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: w.mailboxId, bodyHash: `h${i}`, dedupKey: `sr:${randomUUID()}`,
      subject: `Note ${i}`, snippet: "", fromAddress: o.from, date: IMPORTED, unread: true,
      createdAt: IMPORTED, nativeLocator: { folder: o.folder ?? o.desired, ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: o.headers ?? {},
    });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: o.desired, observedFolder: o.observed ?? o.desired,
      lastSetBy: o.lastSetBy,
      reconcileStatus: (o.observed ?? o.desired) === o.desired ? "reconciled" : "pending",
      conflict: false,
    });
    return m!.id;
  };

  // The person's OWN sent mail — what the review is built from.
  await message({
    from: own, desired: "Sent Messages", lastSetBy: "external", folder: "Sent Messages",
    headers: { to: ["Old Friend <friend@x.test>"] },
  });

  // Four rows from the correspondent, imported before the confirmation.
  const held = await message({ from: "friend@x.test", desired: GATE, lastSetBy: "us" });
  const ohbox = await message({ from: "friend@x.test", desired: OHBOX, lastSetBy: "us" });
  // FILED BY HAND into Reads, which is the row "must not move the past" is about.
  const hand = await message({ from: "friend@x.test", desired: READS, lastSetBy: "external" });
  // At the gate but NOT SETTLED there — something is already carrying it elsewhere.
  const flight = await message({
    from: "friend@x.test", desired: GATE, observed: OHBOX, lastSetBy: "us",
  });

  return { ...w, held, ohbox, hand, flight };
}

const desiredOf = async (w: World, id: string): Promise<string> => {
  const [r] = await w.db.select().from(folderState).where(eq(folderState.messageId, id));
  return r!.desiredFolder;
};

const movesFor = async (w: World, id: string): Promise<number> =>
  (await w.db.select().from(changeLog).where(and(
    eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, id), eq(changeLog.op, "move"),
  ))).length;

const runPass = (w: World) => ruleRetroPass(
  w.db as unknown as Tx,
  { accountId: w.accountId, trustedAuthservIdsFor: NONE },
  new Date("2026-08-05T08:40:00.000Z"),
);

describe("the seed confirmation releases the mail its own gate is holding", () => {
  it("writes the RELEASE SHAPE — release_held_at equal to retro_requested_at, to the millisecond", async () => {
    const w = await seed();
    const result = await confirmSeed(ctxOf(w), ["friend@x.test"]);
    expect(result.rulesCreated).toBe(1);

    const [r] = await w.db.select().from(rules).where(eq(rules.accountId, w.accountId));
    expect(r!.provenance).toBe("seeded-from-sent");
    expect(r!.releaseHeldAt).not.toBeNull();
    // EQUALITY, not "both set": `isReleaseRun` compares `getTime()`, and two `ctx.now()` calls in
    // production are two different instants.
    expect(r!.releaseHeldAt!.getTime()).toBe(r!.retroRequestedAt!.getTime());
    expect(r!.retroDoneAt).toBeNull();
  });

  it("the held message is released to the Ohbox", async () => {
    const w = await seed();
    await confirmSeed(ctxOf(w), ["friend@x.test"]);
    const out = await runPass(w);
    expect(out.moved).toBe(1);
    expect(await desiredOf(w, w.held)).toBe(OHBOX);
    expect(await movesFor(w, w.held)).toBe(1);
  });

  it("the hand file in Reads is UNTOUCHED — the past does not move", async () => {
    const w = await seed();
    await confirmSeed(ctxOf(w), ["friend@x.test"]);
    await runPass(w);
    expect(await desiredOf(w, w.hand)).toBe(READS);
    expect(await movesFor(w, w.hand)).toBe(0);
  });

  it("the message already in the Ohbox is untouched, and the one in flight is not re-decided", async () => {
    const w = await seed();
    await confirmSeed(ctxOf(w), ["friend@x.test"]);
    await runPass(w);
    expect(await desiredOf(w, w.ohbox)).toBe(OHBOX);
    expect(await movesFor(w, w.ohbox)).toBe(0);
    // Desired is the gate and observed is not, so this row is mid-move. The release arm's SECOND
    // equality is the only thing excluding it — the first one admits it.
    expect(await desiredOf(w, w.flight)).toBe(GATE);
    expect(await movesFor(w, w.flight)).toBe(0);
  });

  it("a SECOND pass moves nothing — the candidate query is the idempotency", async () => {
    const w = await seed();
    await confirmSeed(ctxOf(w), ["friend@x.test"]);
    await runPass(w);
    const again = await runPass(w);
    expect(again.moved).toBe(0);
    expect(await movesFor(w, w.held)).toBe(1);
  });

  it("a sender the person DECLINED gets no rule and no release", async () => {
    // The offer is the review; confirming a subset is the person's own edit of it. A declined
    // address must not be released by the same pass on the strength of being in the review.
    const w = await seed();
    const result = await confirmSeed(ctxOf(w), []);
    expect(result.rulesCreated).toBe(0);
    expect(result.declined).toBe(1);
    await runPass(w);
    expect(await desiredOf(w, w.held)).toBe(GATE);
  });
});

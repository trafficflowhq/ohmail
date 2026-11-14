import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, contacts, folderState, mailboxes, messageBodies, messages, rules, type Tx,
} from "@trafficflow/db";
import { ScreenerService } from "../src/screener-service.js";
import { cutlineCounts } from "../src/consent-cutline.js";
import { heldReleaseSummary } from "../src/held-release-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * ═══ A SENDER YOU HAVE WRITTEN TO SINCE 2012 IS NOT A FIRST-TIME SENDER ═══════════════════
 *
 * ── THE REPORTED SHAPE, MEASURED ──────────────────────────────────────────────────────────
 *
 * The Screener read "1 first-time sender waiting" about a correspondent of more than a decade:
 * an enabled `seeded-from-sent` rule to INBOX and a `contacts` row both name them, and five of
 * their messages — imported the day BEFORE the seed — still sit at the gate with
 * `desired = observed = 'ohmail/Screener'` and `last_set_by = 'us'`. `confirmSeed` writes its
 * rules with `retro_requested_at` NULL ("consent granted in bulk must not move the past"), so no
 * pass was ever owed for them; `heldSenderPage` asks only where mail SITS, never whether the
 * account has already answered for its sender. The row appeared whenever a new message from
 * them made the cutline call the sender active, and vanished again when it went quiet.
 *
 * ── WHAT THIS FILE PINS ───────────────────────────────────────────────────────────────────
 *
 * The listing and both counts, over the reported fixture: the known sender is in neither, and
 * the stranger still is in both. And the held mail is not made invisible by that —
 * `heldReleaseSummary` offers it, which is the half that was MEASURED missing: the surface
 * admitted `'external'` and `'peer'` placements only, so mail ohmail itself had put at the gate
 * reported nothing to release.
 *
 * The predicate's own arms are answered on BOTH stores by
 * `packages/db/test/sqlite-cutline.test.ts`; this is the composition — a correlated `exists`
 * in the outer half of the queue's windowed query and inside the count's `classified` CTE.
 *
 * ── MUTATIONS WATCHED (each restored by `cmp`) ────────────────────────────────────────────
 *
 *  · drop the `contacts` arm of `senderIsDecidedSql`         ⇒ 5 RED across both files, "a
 *      contact with no rule leaves the queue too" among them (`pal@` lists again).
 *  · drop the deny `not exists` arm                          ⇒ 4 RED, "a DENY decision does not
 *      exclude" among them (`blocked@` vanishes on the strength of the contact alone).
 *  · drop `not senderIsDecidedSql(...)` from `heldSenderPage`⇒ 3 RED, "the known sender is not
 *      in the queue" among them.
 *  · drop `or senderIsDecidedSql(...)` from `cutlineCounts`  ⇒ 2 RED, the count answering 2
 *      where the queue drops 2 (`pal@` re-enters the count alone).
 *  · drop `'us'` from `heldAtGate`'s `last_set_by` list      ⇒ "their held mail is OFFERED FOR
 *      RELEASE" RED: no groups at all, which is what the reported account was reading.
 */

const GATE = "ohmail/Screener";
const NOW = new Date("2026-09-13T12:00:00.000Z");
const RECENT = new Date("2026-09-12T09:11:00.000Z");

interface World {
  db: Awaited<ReturnType<typeof makeTestDb>>;
  accountId: string;
  mailboxId: string;
}

const ctxOf = (w: World): ServiceContext => ({
  db: w.db as never, accountId: w.accountId, userId: null,
  now: () => NOW, requestId: `ks-${randomUUID().slice(0, 8)}`,
});

/**
 * THE REPORTED ACCOUNT, IN FOUR SENDERS.
 *
 *  · `known@`   — the correspondent. A held row at the gate stamped `'us'` and imported before
 *                 the seed, an INBOX row, a Reads row the person filed BY HAND (`'external'`),
 *                 an enabled `seeded-from-sent` rule to INBOX and a `contacts` row.
 *  · `pal@`     — a `contacts` row and NO rule at all. The arm `cutlineCounts` never had.
 *  · `blocked@` — a `contacts` row AND an enabled `manual` rule to Screened. A deny decision does
 *                 not exclude, and it defeats the contact arm: their mail is the Screened-out
 *                 tab's and they stay answerable.
 *  · `stranger@`— nothing at all. The control: something must still be in the queue, or every
 *                 assertion below is satisfied by a page that lists nobody.
 */
async function seed(): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `ks-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    organizerRole: "organizer",
  }).returning();
  const w: World = { db, accountId, mailboxId: mb!.id };

  let n = 0;
  const message = async (from: string, folder: string, lastSetBy: string): Promise<string> => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: w.mailboxId, bodyHash: `h${i}`, dedupKey: `ks:${randomUUID()}`,
      subject: `Note ${i}`, snippet: "", fromAddress: from, date: RECENT, unread: true,
      createdAt: RECENT, nativeLocator: { folder, ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder,
      lastSetBy, reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };

  await message("known@x.test", GATE, "us");
  await message("known@x.test", "INBOX", "us");
  await message("known@x.test", "ohmail/News", "external");
  await message("pal@x.test", GATE, "us");
  await message("blocked@x.test", GATE, "us");
  await message("stranger@x.test", GATE, "us");

  await db.insert(rules).values([
    {
      accountId, kind: "sender", match: "known@x.test", destination: "INBOX",
      provenance: "seeded-from-sent", enabled: true, priority: 0, retroRequestedAt: null,
    },
    {
      accountId, kind: "sender", match: "blocked@x.test", destination: "ohmail/Screened",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    },
  ]);
  for (const address of ["known@x.test", "pal@x.test", "blocked@x.test"]) {
    await db.insert(contacts).values({ accountId, address });
  }
  return w;
}

const listed = async (w: World): Promise<string[]> => {
  const page = await new ScreenerService({}).list(ctxOf(w), { limit: 100 });
  return page.items.map((i) => i.sender.address.toLowerCase()).sort();
};

const waiting = async (w: World): Promise<number> =>
  (await cutlineCounts(ctxOf(w), { baselineAt: null, dormancyDays: 60 })).activeUndecidedSenders;

describe("the Screener queue never calls a sender this account already knows first-time", () => {
  it("the known sender is not in the queue, and the stranger still is", async () => {
    const w = await seed();
    expect(await listed(w)).toEqual(["stranger@x.test"]);
  });

  it("a contact with no rule leaves the queue too — a decision is not only a rules row", async () => {
    const w = await seed();
    expect(await listed(w)).not.toContain("pal@x.test");
  });

  it("a DENY decision IS a decision, and the gate is what defeats the contact arm", async () => {
    /* RULED 2026-09-16, reversing the arm this case used to assert. Sending somebody to
       Screened is answering for them, and reading it as "not yet decided" is what put three
       senders on one live account in the queue and on the release screen at the same moment, with
       two different counts a few pixels apart. What still defeats a `contacts` row is a rule
       pinning the sender to the gate — the one destination that means "keep asking me". Their
       mail is not hidden by this: it is offered for release two cases down. */
    const w = await seed();
    expect(await listed(w)).not.toContain("blocked@x.test");

    // The gate arm, measured on its own: a contact whose rule points AT the Screener stays.
    await w.db.update(rules).set({ destination: "ohmail/Screener" })
      .where(and(eq(rules.accountId, w.accountId), eq(rules.match, "blocked@x.test")));
    expect(await listed(w)).toContain("blocked@x.test");
  });

  it("EVERY SENDER THE QUEUE DROPS IS DROPPED BY THE COUNT TOO — one predicate, both readers", async () => {
    const w = await seed();
    const queue = await listed(w);
    // The known sender and the contact are in NEITHER. That is the claim: a sender the queue
    // refuses to list can never be one this count still calls first-time.
    for (const gone of ["known@x.test", "pal@x.test"]) expect(queue).not.toContain(gone);
    expect(await waiting(w)).toBe(1);
    // CLOSED 2026-09-16. The count read any destination off the gate as a decision and
    // the queue read only the three allow destinations, so this line used to be TWO against a
    // count of ONE and the divergence was recorded here rather than fixed. Both now ask
    // `destinationIsDecisionSql`, and the two numbers are the same number.
    expect(queue).toEqual(["stranger@x.test"]);
    expect(queue.length).toBe(await waiting(w));
  });

  it("a DENY-ruled sender with NO contact is in neither the queue nor the count", async () => {
    // QUEUE-AND-CONSENT-COUNT-DISAGREE-ABOUT-A-DENY-RULED-SENDER, measured on its own shape: the
    // deny rule alone, no contact arm to carry it. Both readers ask `destinationIsDecisionSql`.
    const w = await seed();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "spam@x.test", destination: "ohmail/Quarantine",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    });
    const [m] = await w.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h-spam", dedupKey: `ks:${randomUUID()}`,
      subject: "Offer", snippet: "", fromAddress: "spam@x.test", date: RECENT, unread: true,
      createdAt: RECENT, nativeLocator: { folder: GATE, ref: "1:99" },
    }).returning();
    await w.db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: GATE, observedFolder: GATE,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    expect(await listed(w)).toEqual(["stranger@x.test"]);
    expect(await waiting(w)).toBe(1);
    // The control: with the rule off the same sender is in BOTH, so the fixture can list them.
    await w.db.update(rules).set({ enabled: false })
      .where(and(eq(rules.accountId, w.accountId), eq(rules.match, "spam@x.test")));
    expect(await listed(w)).toEqual(["spam@x.test", "stranger@x.test"]);
    expect(await waiting(w)).toBe(2);
  });

  it("POSITIVE CONTROL — switch the rule off and the known sender returns to BOTH", async () => {
    // Without this, every assertion above is satisfied by a page and a count that answer nothing
    // about `known@` for some reason of their own.
    const w = await seed();
    await w.db.update(rules).set({ enabled: false })
      .where(and(eq(rules.accountId, w.accountId), eq(rules.match, "known@x.test")));
    await w.db.delete(contacts)
      .where(and(eq(contacts.accountId, w.accountId), eq(contacts.address, "known@x.test")));
    expect(await listed(w)).toContain("known@x.test");
    expect(await waiting(w)).toBe(2);
  });

  it("their held mail is OFFERED FOR RELEASE, not hidden", async () => {
    // The other half of the exclusion, and the one that was measured missing: before the widening
    // the release screen admitted `'external'` and `'peer'` only, so the reported account's five
    // `'us'` rows at the gate reported NOTHING to release while the queue called their sender
    // first-time. Excluding a sender from the queue without this is making their mail invisible.
    const w = await seed();
    const { groups, total } = await heldReleaseSummary(w.db as unknown as Tx, w.accountId);
    expect(groups.map((g) => g.match).sort()).toEqual(["blocked@x.test", "known@x.test"]);
    expect(groups.find((g) => g.match === "known@x.test")?.count).toBe(1);
    expect(total).toBe(2);
  });

  it("MEASURED AND NOT CLOSED — a contact with no rule has no group to press", async () => {
    // `heldReleaseGroups` is keyed on a RULE, so a sender who is only a contact cannot appear on
    // that screen at all. Their held mail is released once by `gateReleasePass`; a row that
    // reaches the gate after that pass has run is the residual, filed as its own gap row rather
    // than left as a surprise in this file's silence.
    const w = await seed();
    const { groups } = await heldReleaseSummary(w.db as unknown as Tx, w.accountId);
    expect(groups.map((g) => g.match)).not.toContain("pal@x.test");
  });
});

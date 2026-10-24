import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { REFILE_HOLD_MS } from "@trafficflow/core/mail";
import { accounts, changeLog, folderState, mailboxes, messages, rules } from "@trafficflow/db";
import { rulesService } from "../src/rules-service.js";
import { ruleRowToDTO } from "../src/dto/materialize.js";
import { ruleRetroPass } from "../../../apps/worker/src/rule-retro.js";
import { mutated } from "./helpers.js";
import type { Db, ServiceContext } from "../src/context.js";

/* Every case in this file runs as the ORGANIZER, where a rule edit is written locally. `create`
 * and `update` answer a union — that mutation, or a request routed to the install that organizes
 * the mailbox — so the local arm is narrowed once here instead of at each call: `mutated` refuses
 * the routed arm by name, where a cast would leave `rule` reading as `undefined`. */
const createRule = async (...a: Parameters<typeof rulesService.create>) =>
  mutated(await rulesService.create(...a));
const updateRule = async (...a: Parameters<typeof rulesService.update>) =>
  mutated(await rulesService.update(...a));

/**
 * WHO ASKS FOR A RULE TO REACH MAIL THAT IS ALREADY FILED.
 *
 * The service's whole job here is one column. `rules.retro_requested_at` set with
 * `retro_done_at` NULL is the only definition of owed work in the system; the worker's
 * `ruleRetroPass` reads exactly that and nothing else. So these tests are about the REQUEST —
 * that it defaults on, that declining it is honoured, and that a retarget re-asks — and the work
 * itself is proven in `apps/worker/test/rule-retro.test.ts`.
 *
 * The retarget case is the one that would otherwise be missed, and it is not an edge: the sender
 * sheet refuses to write a second rule for a subject it already covers (two `manual` rules with
 * the same kind, match, priority and effect tie down to an arbitrary id tie-break in
 * `core/rules.ts#compareRules`), so a user changing their mind about a sender they have already
 * ruled on takes the PATCH path, not the POST one. A retarget that re-applied to nothing while
 * the sheet said otherwise would be the shipped feature quietly not working for its commonest
 * case.
 */

const NOW = new Date("2026-08-04T12:00:00Z");

async function world(): Promise<{ db: Db; ctx: ServiceContext }> {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `retro-${accountId.slice(0, 8)}` });
  const ctx = { db, accountId, now: () => NOW } as unknown as ServiceContext;
  return { db, ctx };
}

const row = async (db: Db, id: string) => {
  const [r] = await db.select().from(rules).where(eq(rules.id, id));
  return r!;
};

const BODY = { kind: "sender", match: "news@atelier.example", destination: "ohmail/News" };

describe("the retroactive request on create", () => {
  it("is ON when the caller says nothing — a DEFAULT, not an option", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });

    const stored = await row(db, rule.id);
    expect(stored.retroRequestedAt).toEqual(NOW);
    expect(stored.retroDoneAt, "nothing has run yet — owed, not done").toBeNull();
    expect(stored.retroCursor).toBeNull();
    expect(stored.retroMoved).toBe(0);
  });

  it("is OFF when the caller declines, and that is the only thing that turns it off", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, applyRetro: false });

    // NULL, not a stamped-then-cleared value: nobody ever asked, which is a different fact from
    // "asked and finished" and is what the worker's owed predicate distinguishes.
    expect((await row(db, rule.id)).retroRequestedAt).toBeNull();
  });

  it("refuses a non-boolean rather than coercing it", async () => {
    const { ctx } = await world();
    // `applyRetro: "false"` is TRUTHY in JavaScript. Reading a client's attempt to decline as
    // consent to reorganize a mailbox is the failure this check exists for, so it is a 400.
    await expect(
      createRule(ctx, { ...BODY, applyRetro: "false" as unknown as boolean }),
    ).rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
  });
});

describe("a RETARGET asks again, because the destination changed", () => {
  it("re-requests and CLEARS the marker and cursor when the destination moves", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    // Pretend the pass finished it.
    await db.update(rules)
      .set({ retroDoneAt: NOW, retroCursor: randomUUID(), retroMoved: 12 })
      .where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, { destination: "ohmail/Receipts" });

    const stored = await row(db, rule.id);
    expect(stored.destination).toBe("ohmail/Receipts");
    expect(stored.retroRequestedAt).toEqual(NOW);
    // The WHOLE state is reset, not just the request. Mail this rule already moved to the OLD
    // destination is a candidate again, and a stale cursor would skip everything before it.
    expect(stored.retroDoneAt).toBeNull();
    expect(stored.retroCursor).toBeNull();
    expect(stored.retroMoved).toBe(0);
  });

  it("does NOT re-request for a PATCH that does not carry the flag and moves nothing", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    const done = new Date("2026-08-04T13:00:00Z");
    await db.update(rules).set({ retroDoneAt: done, retroMoved: 12 }).where(eq(rules.id, rule.id));

    // A PATCH that re-states the destination it already has, which is what a habit-click sends.
    await updateRule(ctx, rule.id, { destination: "ohmail/News" });

    const stored = await row(db, rule.id);
    expect(stored.retroDoneAt, "re-applying finished work on every PATCH").toEqual(done);
    expect(stored.retroMoved).toBe(12);
  });

  it("does NOT re-request for a PATCH that only pauses the rule", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    const done = new Date("2026-08-04T13:00:00Z");
    await db.update(rules).set({ retroDoneAt: done }).where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, { enabled: false });

    // Nothing about where this rule sends mail moved, so there is nothing to re-apply.
    expect((await row(db, rule.id)).retroDoneAt).toEqual(done);
  });

  /**
   * THE PAIR THAT IS THE RULING, and either half alone is satisfied by the wrong implementation:
   * gate the re-arm on `validApplyRetro` (absent ⇒ true) and the case above goes red; drop the
   * explicit arm and this one does. A rule already pointing where the person wants is the only
   * rule they cannot otherwise ask for the backlog — the sheet's *also move the mail already in
   * your mailbox*, pressed on a sender who already has a rule.
   */
  it("re-requests when the caller EXPLICITLY asks, even though the destination did not move", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    const done = new Date("2026-08-04T13:00:00Z");
    await db.update(rules)
      .set({ retroDoneAt: done, retroCursor: randomUUID(), retroMoved: 12 })
      .where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, { destination: "ohmail/News", applyRetro: true });

    const stored = await row(db, rule.id);
    expect(stored.destination, "nothing about the routing moved").toBe("ohmail/News");
    expect(stored.retroRequestedAt).toEqual(NOW);
    // The whole state resets, exactly as a retarget's does: a stale cursor would resume at the end
    // of the previous walk and reconsider nothing.
    expect(stored.retroDoneAt).toBeNull();
    expect(stored.retroCursor).toBeNull();
    expect(stored.retroMoved).toBe(0);
    // …and `release_held_at` stays null, so `rule-retro.ts#isReleaseRun` reads this as an ordinary
    // unnarrowed retro rather than the gate-only release walk.
    expect(stored.releaseHeldAt).toBeNull();
  });

  it("honours a DECLINED retro on a retarget — the user may retarget without re-applying", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    const done = new Date("2026-08-04T13:00:00Z");
    await db.update(rules).set({ retroDoneAt: done }).where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, {
      destination: "ohmail/Receipts", applyRetro: false,
    });

    const stored = await row(db, rule.id);
    expect(stored.destination).toBe("ohmail/Receipts");
    expect(stored.retroDoneAt, "the opt-out must work on the retarget path too").toEqual(done);
  });
});

describe("a DECLINED edit of a rule still walking its backlog ends the walk", () => {
  /* "The rest of their mail here stays where it is": a walk left owed (parked behind a mailbox this
     install only reads) would otherwise re-arm later and file that rest by the edited rule. */
  const PARKED = "ffffffff-ffff-ffff-0000-000000000001";
  const owed = async (body: Record<string, unknown>) => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, ...body });
    await db.update(rules).set({ retroCursor: PARKED, retroMoved: 3 }).where(eq(rules.id, rule.id));
    return { db, ctx, id: rule.id };
  };

  it("on a retarget", async () => {
    const { db, ctx, id } = await owed({});
    await updateRule(ctx, id, { destination: "ohmail/Receipts", applyRetro: false });

    const stored = await row(db, id);
    expect(stored.retroDoneAt, "a declined retarget left the walk owed").toEqual(NOW);
    expect(stored.retroCursor).toBe(PARKED);
    expect(stored.retroMoved).toBe(3);
  });

  it("on a term edit", async () => {
    const { db, ctx, id } = await owed({ subjectContains: "invoice" });
    await updateRule(ctx, id, { subjectContains: "receipt", applyRetro: false });

    expect((await row(db, id)).retroDoneAt, "a declined term edit left the walk owed").toEqual(NOW);
  });
});

/**
 * SETTINGS > RULES > CHANGE DOES WHAT ITS SENTENCE SAYS. Nora's sender rule files into News; the
 * first letter was placed there by the reader's `m` press (decided), the second by a subject rule,
 * and the last two were promised to stay in the Ohbox. Change to Receipts re-files the rule's pile:
 * the first letter moves, and nothing else does.
 */
describe("a Rules-page Change re-files what the rule filed, and only that", () => {
  const NORA = "nora@corr.example";
  const EARLIER = new Date("2026-10-24T18:50:00Z");
  const PRESS = new Date("2026-10-24T19:07:18Z");
  const PAST_HOLD = (from: Date) => new Date(from.getTime() + REFILE_HOLD_MS + 1000);
  const CHANGE = { applyRetro: false, refile: true } as const;
  const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

  async function pile(opts: { from?: string; reader?: boolean } = {}) {
    const db = (await makeTestDb()) as unknown as Db;
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `pile-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    // A second mailbox this install only reads (mail 0083): the walk never finishes there, it parks.
    const [rb] = opts.reader ? await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `read-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "reader",
    }).returning() : [];
    const from = opts.from ?? "ohmail/News";
    const letter = async (folder: string, subject: string, decidedAt: Date | null, mailboxId = mb!.id): Promise<string> => {
      const dedup = `mid:${randomUUID()}`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
        subject, fromAddress: NORA, nativeLocator: { folder, ref: "1:1" },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: folder, observedFolder: folder, lastSetBy: "us",
        reconcileStatus: "reconciled", conflict: false, decidedAt,
      });
      return m!.id;
    };
    const n1 = await letter(from, "letter one", new Date("2026-10-24T18:50:30Z"));
    const n2 = await letter(from, "weekly digest two", null);
    const n3 = await letter("INBOX", "letter three", null);
    const n4 = await letter("INBOX", "letter four", null);
    // Filed there while this install still organized the second mailbox; the walk never touches it now.
    const theirs = rb ? await letter(from, "letter five", null, rb.id) : null;
    const [sender] = await db.insert(rules).values({
      accountId, kind: "sender", match: NORA, destination: from, provenance: "manual", enabled: true,
      retroRequestedAt: EARLIER, retroDoneAt: EARLIER,
    }).returning();
    await db.insert(rules).values({
      accountId, kind: "sender", match: NORA, subjectContains: "weekly", destination: from, provenance: "manual", enabled: true,
    });
    let clock = PRESS;
    const ctx = { db, accountId, now: () => clock } as unknown as ServiceContext;
    const at = async (id: string) => (await db.select({ d: folderState.desiredFolder }).from(folderState)
      .where(eq(folderState.messageId, id)))[0]!.d;
    return {
      db, ctx, id: sender!.id,
      tick: (ms: number) => { clock = new Date(clock.getTime() + ms); },
      change: (patch: Record<string, unknown>) => updateRule(ctx, sender!.id, patch),
      walk: (now: Date, writesPerCycle?: number) =>
        ruleRetroPass(db as never, { accountId, trustedAuthservIdsFor: NONE, ...(writesPerCycle ? { writesPerCycle } : {}) }, now),
      where: async () => ({ n1: await at(n1), n2: await at(n2), n3: await at(n3), n4: await at(n4) }),
      letter, at,
      place: (id: string, folder: string) => db.update(folderState).set({ desiredFolder: folder, decidedAt: clock })
        .where(eq(folderState.messageId, id)),
      ids: { n1, n2, n3, n4, theirs },
      stored: () => row(db, sender!.id),
      // The rule deltas a client is told by: one `change_log` row each.
      deltas: async () => (await db.select({ op: changeLog.op }).from(changeLog)
        .where(and(eq(changeLog.entityType, "rule"), eq(changeLog.entityId, sender!.id)))).length,
    };
  }

  it("moves the letter the rule filed, and leaves the other rule's and the Ohbox's where they are", async () => {
    const p = await pile();
    await p.change({ destination: "ohmail/Receipts", ...CHANGE });
    const res = await p.walk(PAST_HOLD(PRESS));
    expect(await p.where()).toEqual({ n1: "ohmail/Receipts", n2: "ohmail/News", n3: "INBOX", n4: "INBOX" });
    expect(res.moved).toBe(1);
  });

  it("moves nothing inside the hold, and the pile once it is past", async () => {
    const p = await pile();
    await p.change({ destination: "ohmail/Receipts", ...CHANGE });
    expect((await p.walk(new Date(PRESS.getTime() + 1000))).moved).toBe(0);
    expect((await p.where()).n1).toBe("ohmail/News");
    expect((await p.walk(PAST_HOLD(PRESS))).moved).toBe(1);
  });

  it("an Undo inside the hold moves nothing and ends the walk", async () => {
    const p = await pile();
    await p.change({ destination: "ohmail/Receipts", ...CHANGE });
    p.tick(2000);
    await p.change({ destination: "ohmail/News", applyRetro: false });
    expect((await p.walk(PAST_HOLD(PRESS))).moved).toBe(0);
    expect(await p.where()).toEqual({ n1: "ohmail/News", n2: "ohmail/News", n3: "INBOX", n4: "INBOX" });
    const r = await p.stored();
    expect(r.retroDoneAt).not.toBeNull();
    expect(r.destination).toBe("ohmail/News");
  });

  it("a rule stored as Reads re-files from News, at one instant, and says so on the rule", async () => {
    const p = await pile({ from: "ohmail/Reads" });
    const { rule } = await p.change({ destination: "ohmail/Receipts", ...CHANGE });
    const r = await p.stored();
    expect(r.refileFrom).toBe("ohmail/News");
    expect(r.refileAt).toEqual(PRESS);
    expect(r.retroRequestedAt).toEqual(PRESS);
    expect(rule.retro).toMatchObject({ requestedAt: PRESS.toISOString(), doneAt: null, from: "ohmail/News" });
    await p.walk(PAST_HOLD(PRESS));
    expect((await p.where()).n1).toBe("ohmail/Receipts");
  });

  it("a second Change inside the hold carries the first one's origin", async () => {
    const p = await pile();
    await p.change({ destination: "ohmail/Receipts", ...CHANGE });
    p.tick(2000);
    await p.change({ destination: "INBOX", ...CHANGE });
    expect((await p.stored()).refileFrom).toBe("ohmail/News");
    await p.walk(PAST_HOLD(new Date(PRESS.getTime() + 2000)));
    expect(await p.where()).toEqual({ n1: "INBOX", n2: "ohmail/News", n3: "INBOX", n4: "INBOX" });
  });

  it("refuses the shapes a re-filing cannot have", async () => {
    const p = await pile();
    for (const bad of [
      { destination: "ohmail/Receipts", applyRetro: false, refile: "yes" },
      { destination: "ohmail/Receipts", refile: true },
      { destination: "ohmail/Receipts", applyRetro: true, refile: true },
      { enabled: true, applyRetro: false, refile: true },
      { destination: "ohmail/Receipts", match: NORA, ...CHANGE },
      { destination: "ohmail/Receipts", keepProvenance: true, ...CHANGE },
    ]) {
      await expect(p.change(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    }
    expect((await p.stored()).destination).toBe("ohmail/News");
  });

  it("a paused rule, or the place it already files to, starts no walk", async () => {
    const paused = await pile();
    await paused.db.update(rules).set({ enabled: false }).where(eq(rules.id, paused.id));
    await paused.change({ destination: "ohmail/Receipts", ...CHANGE });
    expect((await paused.stored()).retroRequestedAt).toEqual(EARLIER);
    const same = await pile();
    await same.change({ destination: "ohmail/News", ...CHANGE });
    expect((await same.stored()).retroRequestedAt).toEqual(EARLIER);
    expect((await same.stored()).refileAt).toBeNull();
  });

  it("a later re-start from the sender sheet walks the whole backlog again", async () => {
    const p = await pile();
    await p.change({ destination: "ohmail/Receipts", ...CHANGE });
    await p.walk(PAST_HOLD(PRESS));
    p.tick(60_000);
    await p.change({ destination: "ohmail/Receipts", applyRetro: true });
    await p.walk(PAST_HOLD(new Date(PRESS.getTime() + 60_000)));
    expect(await p.where()).toEqual({ n1: "ohmail/Receipts", n2: "ohmail/News", n3: "ohmail/Receipts", n4: "ohmail/Receipts" });
  });

  /* The sender sheet's press asked for past mail and its walk is still owed (the worker's cadence)
     when the Change comes: the Change takes that walk to the new place, and Undo puts it back. */
  async function owedFromTheSheet() {
    const p = await pile({ from: "INBOX" });
    await p.change({ destination: "ohmail/Receipts", applyRetro: true });
    await p.place(p.ids.n1, "ohmail/Receipts");
    p.tick(60_000);
    return p;
  }

  it("a Change while the sheet's walk is owed takes that walk to the new place", async () => {
    const p = await owedFromTheSheet();
    const { rule } = await p.change({ destination: "ohmail/News", ...CHANGE });
    expect(rule.retro).toMatchObject({ doneAt: null, from: null });
    expect((await p.stored()).refileAt).toBeNull();
    await p.walk(PAST_HOLD(new Date(PRESS.getTime() + 60_000)));
    expect(await p.where()).toEqual({ n1: "ohmail/Receipts", n2: "INBOX", n3: "ohmail/News", n4: "ohmail/News" });
  });

  it("its Undo re-asks the walk where it was, so the end is the sheet press's alone", async () => {
    const p = await owedFromTheSheet();
    await p.change({ destination: "ohmail/News", ...CHANGE });
    p.tick(3000);
    await p.change({ destination: "ohmail/Receipts", applyRetro: true });
    await p.walk(PAST_HOLD(new Date(PRESS.getTime() + 63_000)));
    expect(await p.where()).toEqual({ n1: "ohmail/Receipts", n2: "INBOX", n3: "ohmail/Receipts", n4: "ohmail/Receipts" });
  });

  /* The page that first moves a letter ends the origin and files a rule delta, so the pane and a
     second Change take the place the rule files now; the rest of the old pile stays put. */
  it("a re-filing's first move ends its origin, says so, and a second Change takes the rule's own place", async () => {
    const p = await pile();
    const extra = await p.letter("ohmail/News", "letter five", null);
    await p.change({ destination: "ohmail/Receipts", ...CHANGE });
    const told = await p.deltas();
    expect((await p.walk(PAST_HOLD(PRESS), 1)).moved).toBe(1);
    expect(await p.deltas(), "the page that ended the origin told no client").toBe(told + 1);
    expect(ruleRowToDTO(await p.stored()).retro.from).toBe("ohmail/Receipts");
    p.tick(REFILE_HOLD_MS + 5000);
    const { rule } = await p.change({ destination: "ohmail/Screened", ...CHANGE });
    expect(rule.retro?.from).toBe("ohmail/Receipts");
    await p.walk(PAST_HOLD(new Date(PRESS.getTime() + REFILE_HOLD_MS + 5000)));
    expect([await p.at(p.ids.n1), await p.at(extra)].sort()).toEqual(["ohmail/News", "ohmail/Screened"]);
  });

  /* A second mailbox this install only reads: the walk never stamps there, it parks. The origin
     ends with the walk all the same, so a Change a day later re-files from where the rule files. */
  it("with a mailbox only read here, a later Change re-files from where the rule files now", async () => {
    const p = await pile({ reader: true });
    await p.change({ destination: "ohmail/Receipts", ...CHANGE });
    expect((await p.walk(PAST_HOLD(PRESS))).moved).toBe(1);
    const parked = await p.stored();
    expect(parked.retroDoneAt, "the walk stays owed for the mailbox only read here").toBeNull();
    expect(ruleRowToDTO(parked).retro.from).toBe("ohmail/Receipts");
    p.tick(24 * 3600_000);
    const { rule } = await p.change({ destination: "ohmail/Screened", ...CHANGE });
    expect(rule.retro?.from).toBe("ohmail/Receipts");
    expect((await p.walk(PAST_HOLD(new Date(PRESS.getTime() + 24 * 3600_000)))).moved).toBe(1);
    expect(await p.where()).toEqual({ n1: "ohmail/Screened", n2: "ohmail/News", n3: "INBOX", n4: "INBOX" });
    expect(await p.at(p.ids.theirs!)).toBe("ohmail/News");
  });

  it("with a mailbox only read here, a re-filing that moves nothing ends its origin when it parks", async () => {
    const p = await pile({ reader: true });
    await p.place(p.ids.n1, "INBOX");
    await p.change({ destination: "ohmail/Receipts", ...CHANGE });
    const told = await p.deltas();
    expect((await p.walk(PAST_HOLD(PRESS))).moved).toBe(0);
    expect(await p.deltas(), "the park ended the origin and told no client").toBe(told + 1);
    expect(ruleRowToDTO(await p.stored()).retro.from).toBe("ohmail/Receipts");
    p.tick(24 * 3600_000);
    const since = await p.letter("ohmail/Receipts", "letter six", null);
    await p.change({ destination: "ohmail/Screened", ...CHANGE });
    await p.walk(PAST_HOLD(new Date(PRESS.getTime() + 24 * 3600_000)));
    expect(await p.at(since)).toBe("ohmail/Screened");
  });
});

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
// A transaction object is built by the query builder and inherits no dialect brand, so a
// caller that opens one hands the child its parent's dialect — the same carry the
// production caller makes. Without it the first statement composed inside refuses.
import { carryDialect } from "../src/dialect/index.js";
import { mailboxes, messages, folderState, rules, contacts, flagState } from "../src/schema.js";
import {
  applyScreenerDecision, heldRowById, heldRowsForSender, heldRowsForDomain,
  SCREENER_FOLDER, DECIDABLE_FOLDERS, LEGACY_NEWS_FOLDER, admitsDestination, domainOf,
  validateRequestPayload,
} from "../src/screener-apply.js";
import { AccountErasedError } from "../src/erasure-fence.js";

const ACCT = "00000000-0000-0000-0000-0000000000ea";
const NOW = new Date("2026-09-03T12:00:00.000Z");

async function seedHeldMessage(
  db: Awaited<ReturnType<typeof makeTestDb>>,
  over: {
    fromAddress?: string; unread?: boolean; mailboxId?: string;
    /** `folder_state.last_set_by`. Defaults to `'us'` — see the `'peer'` case below for why it varies. */
    lastSetBy?: "us" | "external" | "peer";
    /** `messages.sender_check`; NULL (never checked) unless a case says what the ingest wrote. */
    senderCheck?: "none" | "impersonation";
  } = {},
): Promise<{ mailboxId: string; messageId: string }> {
  let mailboxId = over.mailboxId;
  if (mailboxId === undefined) {
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCT, provider: "imap", address: `${crypto.randomUUID()}@x.example`,
    }).returning({ id: mailboxes.id });
    mailboxId = mb!.id;
  }
  const [msg] = await db.insert(messages).values({
    accountId: ACCT, mailboxId, bodyHash: "h", dedupKey: crypto.randomUUID(),
    subject: "s", fromAddress: over.fromAddress ?? "person@example.com",
    unread: over.unread ?? true, ...(over.senderCheck ? { senderCheck: over.senderCheck } : {}),
  }).returning({ id: messages.id });
  await db.insert(folderState).values({
    messageId: msg!.id, desiredFolder: SCREENER_FOLDER, observedFolder: SCREENER_FOLDER,
    lastSetBy: over.lastSetBy ?? "us", reconcileStatus: "reconciled", conflict: false,
  });
  return { mailboxId, messageId: msg!.id };
}

describe("DECIDABLE_FOLDERS / admitsDestination / domainOf — the small closed vocabulary", () => {
  it("admits exactly the yes-folders — the News pile in both its spellings", () => {
    expect(admitsDestination("INBOX")).toBe(true);
    expect(admitsDestination("ohmail/News")).toBe(true);
    // The pre-0.22 spelling stays admitted (via the CONSTANT so a vocabulary sweep cannot
    // rewrite this input): stored decisions and older clients carry it.
    expect(admitsDestination(LEGACY_NEWS_FOLDER)).toBe(true);
    expect(admitsDestination("ohmail/Receipts")).toBe(true);
    expect(admitsDestination("ohmail/Screened")).toBe(false);
    expect(admitsDestination("ohmail/Quarantine")).toBe(false);
    expect(admitsDestination("ohmail/Screener")).toBe(false);
  });
  it("DECIDABLE_FOLDERS excludes ohmail/Screener — mail is HELD there, never filed to it", () => {
    expect(DECIDABLE_FOLDERS.has("ohmail/Screener")).toBe(false);
    // Six: the closed five plus the News pile's legacy spelling (0.22).
    expect(DECIDABLE_FOLDERS.size).toBe(6);
  });
  it("the duplicated News spellings equal core's — the import this package must not make", async () => {
    const core = await import("@trafficflow/core/mail");
    const db = await import("../src/screener-apply.js");
    expect(db.NEWS_FOLDER).toBe(core.NEWS_FOLDER);
    expect(db.LEGACY_NEWS_FOLDER).toBe(core.LEGACY_NEWS_FOLDER);
    expect(db.canonicalNewsSpelling(db.LEGACY_NEWS_FOLDER)).toBe(core.canonicalDestination(core.LEGACY_NEWS_FOLDER));
    expect(db.canonicalNewsSpelling("Archive/2026")).toBe(core.canonicalDestination("Archive/2026"));
  });
  it("domainOf takes everything after the first @", () => {
    expect(domainOf("a@b@c.example")).toBe("b@c.example");
    expect(domainOf("nodomain")).toBe("");
  });
});

describe("heldRowById / heldRowsForSender / heldRowsForDomain", () => {
  it("finds a held message by id, case-insensitively by sender for heldRowsForSender", async () => {
    const db = await makeTestDb();
    const { mailboxId, messageId } = await seedHeldMessage(db, { fromAddress: "Person@Example.com" });
    const byId = await db.transaction((tx) => heldRowById(tx, ACCT, messageId));
    expect(byId?.messageId).toBe(messageId);
    const bySender = await db.transaction((tx) => heldRowsForSender(tx, ACCT, "person@example.com", mailboxId));
    expect(bySender.map((r) => r.messageId)).toEqual([messageId]);
  });

  it("heldRowsForDomain matches the exact domain, not a lookalike", async () => {
    const db = await makeTestDb();
    const { mailboxId, messageId } = await seedHeldMessage(db, { fromAddress: "a@corp.example" });
    await seedHeldMessage(db, { fromAddress: "a@evil-corp.example" });
    // `carryDialect` like every production caller: the worker's drain and the screener service both
    // brand the transaction they open, because a driver's transaction object inherits no brand and
    // this read now composes its statement per dialect. A fixture that passed a bare one would be
    // testing a handle no production path produces.
    const hits = await db.transaction((tx) => heldRowsForDomain(carryDialect(db, tx), ACCT, "corp.example", mailboxId));
    expect(hits.map((r) => r.messageId)).toEqual([messageId]);
  });

  /**
   * RULING §(i).4 — the held-bag re-route is scoped to the mailbox the decision was made about.
   * Two mailboxes on the SAME account, the same sender's mail held in both: a `mailboxId` naming
   * only the first must find only the first — proof the read cannot cross into a mailbox this
   * install was never asked about.
   */
  it("heldRowsForSender/heldRowsForDomain never cross into a DIFFERENT mailbox on the same account", async () => {
    const db = await makeTestDb();
    const here = await seedHeldMessage(db, { fromAddress: "shared@corp.example" });
    const elsewhere = await seedHeldMessage(db, { fromAddress: "shared@corp.example" });
    expect(elsewhere.mailboxId).not.toBe(here.mailboxId);

    const bySender = await db.transaction(
      (tx) => heldRowsForSender(tx, ACCT, "shared@corp.example", here.mailboxId),
    );
    expect(bySender.map((r) => r.messageId)).toEqual([here.messageId]);

    const byDomain = await db.transaction(
      (tx) => heldRowsForDomain(carryDialect(db, tx), ACCT, "corp.example", here.mailboxId),
    );
    expect(byDomain.map((r) => r.messageId)).toEqual([here.messageId]);
  });
});

describe("applyScreenerDecision", () => {
  /**
   * THE DECIDE IS THE PROMOTION'S RETRO, AND IT REACHES A `'peer'` ROW.
   *
   * A row a READER adopted at the gate is stamped `'peer'` — another install of this account put
   * it there (`pipeline.ts#readerAdoption`). Every unpressed mover excludes it, which is the point;
   * the question this case settles is whether the one thing the person actually presses still
   * reaches it.
   *
   * It does, and by construction rather than by luck: `heldRowsForSender` has no `last_set_by`
   * predicate at all, and the concurrency guard below keys on `desired_folder`, not on who set it.
   * That is why a promoted rule does NOT need `retro_requested_at` — this re-route IS the retro for
   * the mail held at the moment of the press. Setting retro here instead would turn every Screener
   * decide into a sweep of the account's organized folders.
   *
   * `'external'` is asserted beside it so the case is about the GUARD and not about the fixture: a
   * message the person filed into the Screener by hand in another client is reached too, because
   * the press is theirs and it names that sender.
   */
  it("re-routes a held row a READER adopted (`peer`), and one the user filed by hand", async () => {
    const db = await makeTestDb();
    const peer = await seedHeldMessage(db, { fromAddress: "person@example.com", lastSetBy: "peer" });
    const byHand = await seedHeldMessage(db, {
      fromAddress: "person@example.com", mailboxId: peer.mailboxId, lastSetBy: "external",
    });

    const result = await db.transaction((tx) => applyScreenerDecision(tx, {
      accountId: ACCT, scope: "sender", address: "person@example.com",
      appliedFolder: "ohmail/News", decision: "yes",
      triggeringActionId: `screener:${peer.messageId}`, now: NOW, decidedBy: "person", overExisting: "converge",
    }));

    expect(result.rerouted.map((r) => r.messageId).sort())
      .toEqual([peer.messageId, byHand.messageId].sort());
    const rows = await db.select().from(folderState);
    for (const r of rows) {
      expect(r.desiredFolder, `row ${r.messageId} was not re-routed by the press`)
        .toBe("ohmail/News");
      // The press is THIS install's decision, so the re-routed row becomes ours to reconcile.
      expect(r.lastSetBy).toBe("us");
    }
  });

  it("yes/sender: contacts, baseline, promoted rule, re-route, no mark-read", async () => {
    const db = await makeTestDb();
    const { mailboxId, messageId } = await seedHeldMessage(db, { fromAddress: "person@example.com", unread: true });

    const result = await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "sender", address: "person@example.com",
      appliedFolder: "INBOX", decision: "yes", triggeringActionId: `screener:${messageId}`, now: NOW, decidedBy: "person", overExisting: "converge",
    }));

    expect(result.rerouted.map((r) => r.messageId)).toEqual([messageId]);

    const [contact] = await db.select().from(contacts)
      .where(eq(contacts.address, "person@example.com"));
    expect(contact).toBeDefined();

    const [rule] = await db.select().from(rules).where(eq(rules.id, result.createdRuleId!));
    expect(rule?.kind).toBe("sender");
    expect(rule?.match).toBe("person@example.com");
    expect(rule?.destination).toBe("INBOX");

    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs?.desiredFolder).toBe("INBOX");

    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(msg?.unread).toBe(true); // INBOX is not a mark-read destination
  });

  /**
   * THE PROMOTED RULE IS ARMED BY THE PERSON'S ANSWER (0.19). The decide files the HELD mail and
   * stops; everything of this sender's that had already left the gate is `rule-retro.ts`'s, and
   * `retro_requested_at` is the only thing that licenses it. NULL when declined — "nobody asked" is
   * a different fact from "asked and finished", and the worker's owed predicate reads exactly that
   * difference. Both arms, because either alone passes on a function that always writes the same.
   */
  it("the promoted rule is armed for the backlog when asked, and left unarmed when declined", async () => {
    const db = await makeTestDb();
    const asked = await seedHeldMessage(db, { fromAddress: "yes@example.com", unread: true });
    const onResult = await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "sender", address: "yes@example.com",
      appliedFolder: "INBOX", decision: "yes", triggeringActionId: `screener:${asked.messageId}`,
      now: NOW, applyRetro: true, decidedBy: "person", overExisting: "converge",
    }));
    const [armed] = await db.select().from(rules).where(eq(rules.id, onResult.createdRuleId!));
    expect(armed?.retroRequestedAt).toEqual(NOW);
    expect(armed?.retroDoneAt, "owed, not done").toBeNull();

    const declined = await seedHeldMessage(db, { fromAddress: "no-retro@example.com", unread: true });
    const offResult = await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "sender", address: "no-retro@example.com",
      appliedFolder: "INBOX", decision: "yes", triggeringActionId: `screener:${declined.messageId}`,
      now: NOW, applyRetro: false, decidedBy: "person", overExisting: "converge",
    }));
    const [unarmed] = await db.select().from(rules).where(eq(rules.id, offResult.createdRuleId!));
    expect(unarmed?.retroRequestedAt, "the decline must reach the rule").toBeNull();
  });

  it("a re-decide that moves an owed rule with past mail declined ends its walk", async () => {
    const db = await makeTestDb();
    const decide = async (appliedFolder: string, applyRetro: boolean, now: Date) => {
      const { messageId } = await seedHeldMessage(db, { fromAddress: "owed@example.com" });
      return db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
        accountId: ACCT, scope: "sender", address: "owed@example.com", appliedFolder, decision: "yes",
        triggeringActionId: `screener:${messageId}`, now, applyRetro, decidedBy: "person", overExisting: "converge",
      }));
    };
    const { createdRuleId } = await decide("INBOX", true, NOW);
    const later = new Date(NOW.getTime() + 60_000);
    await decide("ohmail/News", false, later);

    const [rule] = await db.select().from(rules).where(eq(rules.id, createdRuleId!));
    expect(rule?.destination).toBe("ohmail/News");
    expect(rule?.retroRequestedAt).toEqual(NOW);
    expect(rule?.retroDoneAt, "the declined re-decide left the walk owed").toEqual(later);
  });

  it("no/sender to ohmail/Screened: mark-read fires, no contact added", async () => {
    const db = await makeTestDb();
    const { mailboxId, messageId } = await seedHeldMessage(db, { fromAddress: "spammer@example.com", unread: true });

    await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "sender", address: "spammer@example.com",
      appliedFolder: "ohmail/Screened", decision: "no",
      triggeringActionId: `screener:${messageId}`, now: NOW, decidedBy: "person", overExisting: "converge",
    }));

    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(msg?.unread).toBe(false);
    expect(msg?.lastReadAt?.getTime()).toBe(NOW.getTime());

    const [contact] = await db.select().from(contacts).where(eq(contacts.address, "spammer@example.com"));
    expect(contact).toBeUndefined();

    const [fi] = await db.select().from(flagState).where(eq(flagState.messageId, messageId));
    expect(fi?.desiredSeen).toBe(true);
  });

  it("domain scope re-routes every held sender at the domain and rules on the domain", async () => {
    const db = await makeTestDb();
    // `a` and `b` share ONE mailbox and `other` sits beside them at a DIFFERENT domain — so the
    // untouched row below proves the DOMAIN boundary, the one this decision actually names.
    const a = await seedHeldMessage(db, { fromAddress: "a@corp.example" });
    // Checked at ingest, as every row since mail 0148: another address's unchecked row waits for its
    // check (`domain-press-leaves-other-claims.test.ts`).
    const b = await seedHeldMessage(db, { fromAddress: "b@corp.example", mailboxId: a.mailboxId, senderCheck: "none" });
    const other = await seedHeldMessage(db, { fromAddress: "c@notcorp.example", mailboxId: a.mailboxId });

    const result = await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "domain", address: "a@corp.example",
      appliedFolder: "ohmail/News", decision: "yes",
      triggeringActionId: "screener:domain-decide", now: NOW, decidedBy: "person", overExisting: "converge",
    }));

    expect(new Set(result.rerouted.map((r) => r.messageId)))
      .toEqual(new Set([a.messageId, b.messageId]));

    const [rule] = await db.select().from(rules).where(eq(rules.id, result.createdRuleId!));
    expect(rule?.kind).toBe("domain");
    expect(rule?.match).toBe("corp.example");

    const [fsOther] = await db.select().from(folderState).where(eq(folderState.messageId, other.messageId));
    expect(fsOther?.desiredFolder).toBe(SCREENER_FOLDER); // untouched
  });

  /**
   * THE ACCOUNT-WIDE RULING (0.20): a decision is about the SENDER, so one press re-routes the
   * sender's held bag in EVERY mailbox this install organizes — the "decided sender comes back
   * from the other mailbox" defect. The mutation this case watches: restore the mailbox filter
   * on the held-bag read (`heldRowsForSender(…, mailboxId)`) and one bag survives → red.
   */
  it("re-routes the sender's held bag in EVERY organized mailbox of the account", async () => {
    const db = await makeTestDb();
    const here = await seedHeldMessage(db, { fromAddress: "shared@corp.example" });
    const there = await seedHeldMessage(db, { fromAddress: "shared@corp.example" });
    expect(there.mailboxId).not.toBe(here.mailboxId);

    const result = await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "sender", address: "shared@corp.example",
      appliedFolder: "ohmail/News", decision: "yes",
      triggeringActionId: "screener:account-wide", now: NOW, decidedBy: "person", overExisting: "converge",
    }));

    expect(new Set(result.rerouted.map((r) => r.messageId)))
      .toEqual(new Set([here.messageId, there.messageId]));
    expect(result.heldElsewhere).toEqual([]);
    for (const m of [here, there]) {
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, m.messageId));
      expect(fs?.desiredFolder, `mailbox ${m.mailboxId}'s bag was not re-routed`).toBe("ohmail/News");
    }
  });

  /**
   * THE ONE-ORGANIZER FENCE, MOVED FROM THE QUERY TO THE ROLE LOCK: a mailbox this install does
   * not organize is NEVER written — its bag comes back as `heldElsewhere` for the caller (the
   * HTTP door queues a request; the drain drops it). The mutation this case watches: skip the
   * role read and write everywhere → the reader row moves → red.
   */
  it("a reader-role mailbox's bag is untouched and returned as heldElsewhere", async () => {
    const db = await makeTestDb();
    const mine = await seedHeldMessage(db, { fromAddress: "shared@corp.example" });
    const [foreign] = await db.insert(mailboxes).values({
      accountId: ACCT, provider: "imap", address: `${crypto.randomUUID()}@x.example`,
      organizerRole: "reader",
    }).returning({ id: mailboxes.id });
    const theirs = await seedHeldMessage(db, { fromAddress: "shared@corp.example", mailboxId: foreign!.id });

    const result = await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "sender", address: "shared@corp.example",
      appliedFolder: "ohmail/News", decision: "yes",
      triggeringActionId: "screener:reader-fence", now: NOW, decidedBy: "person", overExisting: "converge",
    }));

    expect(result.rerouted.map((r) => r.messageId)).toEqual([mine.messageId]);
    expect(result.heldElsewhere).toEqual([{ mailboxId: foreign!.id, held: 1 }]);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, theirs.messageId));
    expect(fs?.desiredFolder, "the reader mailbox's row moved — the one-organizer fence is gone")
      .toBe(SCREENER_FOLDER);
  });

  /**
   * THE `desired=Screener` GUARD — a row that has already moved on (another writer, a racing
   * decision) keeps where it went. See `screener-apply.ts`'s own header quoting `decide`'s
   * misfiled-bulletins defect.
   */
  it("does not clobber a row that has already moved off the Screener since the read", async () => {
    const db = await makeTestDb();
    const { mailboxId, messageId } = await seedHeldMessage(db, { fromAddress: "person@example.com" });
    // Simulate a racing writer that already moved this message to ohmail/News.
    await db.update(folderState).set({ desiredFolder: "ohmail/News" })
      .where(eq(folderState.messageId, messageId));

    const result = await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "sender", address: "person@example.com",
      appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:${messageId}`, now: NOW, decidedBy: "person", overExisting: "converge",
    }));

    expect(result.rerouted).toEqual([]); // the guard skipped it
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs?.desiredFolder).toBe("ohmail/News"); // untouched — user always wins
  });

  it("refuses to write on an erased account", async () => {
    const db = await makeTestDb();
    const { mailboxId, messageId } = await seedHeldMessage(db, { fromAddress: "person@example.com" });
    const { accounts } = await import("../src/schema.js");
    await db.insert(accounts).values({ id: ACCT, erasedAt: NOW });

    await expect(db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "sender", address: "person@example.com",
      appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:${messageId}`, now: NOW, decidedBy: "person", overExisting: "converge",
    }))).rejects.toThrow(AccountErasedError);
  });

  it("the screening baseline is stamped once, never re-stamped on a later decide", async () => {
    const db = await makeTestDb();
    const first = await seedHeldMessage(db, { fromAddress: "one@example.com" });
    await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "sender", address: "one@example.com",
      appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:${first.messageId}`, now: NOW, decidedBy: "person", overExisting: "converge",
    }));
    const { accountSettings } = await import("../src/schema.js");
    const [row1] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCT));
    expect(row1?.screeningBaselineAt?.getTime()).toBe(NOW.getTime());

    const later = new Date(NOW.getTime() + 60_000);
    const second = await seedHeldMessage(db, { fromAddress: "two@example.com" });
    await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "sender", address: "two@example.com",
      appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:${second.messageId}`, now: later, decidedBy: "person", overExisting: "converge",
    }));
    const [row2] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCT));
    expect(row2?.screeningBaselineAt?.getTime()).toBe(NOW.getTime()); // unchanged
  });

  /**
   * RULING §(i).5 — "The drain never stamps `screening_baseline_at`". `stampBaseline: false` is
   * how `request-drain.ts` opts out; everything else about the decision (contact, rule, re-route)
   * still applies normally — this is the ONE field the ruling singles out.
   */
  it("stampBaseline: false skips the baseline write entirely, even on a first decide", async () => {
    const db = await makeTestDb();
    const { mailboxId, messageId } = await seedHeldMessage(db, { fromAddress: "drain@example.com" });

    const result = await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope: "sender", address: "drain@example.com",
      appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:${messageId}`, now: NOW, stampBaseline: false, decidedBy: "person", overExisting: "converge",
    }));

    expect(result.rerouted.map((r) => r.messageId)).toEqual([messageId]); // everything else still applied

    const { accountSettings } = await import("../src/schema.js");
    const [row] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCT));
    expect(row?.screeningBaselineAt ?? null).toBeNull();
  });
});

describe("validateRequestPayload — the drain's own untrusted-input gate", () => {
  it("accepts a well-formed sender-scope yes decision", () => {
    const v = validateRequestPayload({
      scope: "sender", address: "Person@Example.com", appliedFolder: "INBOX", decision: "yes",
    });
    // `applyRetro` defaults TRUE for a payload that does not name it — a record written by a build
    // that predates the option keeps the behaviour it was written under.
    expect(v).toEqual({
      scope: "sender", address: "person@example.com", appliedFolder: "INBOX", decision: "yes",
      applyRetro: true,
    });
  });

  it("accepts a well-formed domain-scope no decision", () => {
    const v = validateRequestPayload({
      scope: "domain", address: "spam@corp.example", appliedFolder: "ohmail/Screened", decision: "no",
    });
    expect(v).toEqual({
      scope: "domain", address: "spam@corp.example", appliedFolder: "ohmail/Screened", decision: "no",
      applyRetro: true,
    });
  });

  /**
   * THE PAST-MAIL ANSWER CROSSES THE INSTALL BOUNDARY, or a decline made on one install becomes
   * consent on another — the record is written by a reader and applied by the organizer.
   */
  it("carries an explicit decline, and refuses a non-boolean rather than coercing it", () => {
    expect(validateRequestPayload({
      scope: "sender", address: "person@example.com", appliedFolder: "INBOX", decision: "yes",
      applyRetro: false,
    })).toMatchObject({ applyRetro: false });
    // `"false"` is truthy; reading it as consent to re-file a backlog is what this refuses.
    expect(validateRequestPayload({
      scope: "sender", address: "person@example.com", appliedFolder: "INBOX", decision: "yes",
      applyRetro: "false",
    })).toBeNull();
  });

  it("refuses a non-object payload", () => {
    expect(validateRequestPayload(null)).toBeNull();
    expect(validateRequestPayload("hello")).toBeNull();
    expect(validateRequestPayload(42)).toBeNull();
    expect(validateRequestPayload([1, 2])).toBeNull();
  });

  it("refuses an unrecognised scope", () => {
    expect(validateRequestPayload({
      scope: "everyone", address: "a@b.example", appliedFolder: "INBOX", decision: "yes",
    })).toBeNull();
  });

  it("refuses an unrecognised decision", () => {
    expect(validateRequestPayload({
      scope: "sender", address: "a@b.example", appliedFolder: "INBOX", decision: "maybe",
    })).toBeNull();
  });

  it("refuses a folder outside DECIDABLE_FOLDERS — including ohmail/Screener itself", () => {
    expect(validateRequestPayload({
      scope: "sender", address: "a@b.example", appliedFolder: "ohmail/Screener", decision: "yes",
    })).toBeNull();
    expect(validateRequestPayload({
      scope: "sender", address: "a@b.example", appliedFolder: "made/up", decision: "yes",
    })).toBeNull();
  });

  it("refuses a folder/decision disagreement — the same coin-toss decide's own validate refuses", () => {
    expect(validateRequestPayload({
      scope: "sender", address: "a@b.example", appliedFolder: "ohmail/Quarantine", decision: "yes",
    })).toBeNull();
    expect(validateRequestPayload({
      scope: "sender", address: "a@b.example", appliedFolder: "INBOX", decision: "no",
    })).toBeNull();
  });

  it("refuses an empty, absent, or wrongly-typed address", () => {
    expect(validateRequestPayload({ scope: "sender", address: "", appliedFolder: "INBOX", decision: "yes" })).toBeNull();
    expect(validateRequestPayload({ scope: "sender", address: "   ", appliedFolder: "INBOX", decision: "yes" })).toBeNull();
    expect(validateRequestPayload({ scope: "sender", appliedFolder: "INBOX", decision: "yes" })).toBeNull();
    expect(validateRequestPayload({ scope: "sender", address: 42, appliedFolder: "INBOX", decision: "yes" })).toBeNull();
  });

  it("refuses an oversized address", () => {
    const huge = `${"a".repeat(600)}@example.com`;
    expect(validateRequestPayload({
      scope: "sender", address: huge, appliedFolder: "INBOX", decision: "yes",
    })).toBeNull();
  });

  it("refuses a domain-scope decision whose address carries no @", () => {
    expect(validateRequestPayload({
      scope: "domain", address: "not-an-address", appliedFolder: "INBOX", decision: "yes",
    })).toBeNull();
  });

  it("ignores extra fields — a forward-compatible payload is not refused for carrying more than expected", () => {
    const v = validateRequestPayload({
      scope: "sender", address: "a@b.example", appliedFolder: "INBOX", decision: "yes",
      match: "a@b.example", futureField: 1,
    });
    expect(v).not.toBeNull();
  });
});

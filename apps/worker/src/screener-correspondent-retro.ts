import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  auditAction, auditLog, contacts, fencedAccountWrite, folderState, learningSignals, lockAccountRuleKeys, messages,
  notFailedAuthSql, recordChange, recordRuleDelta, ruleMatchKeySql, rules as rulesTbl, SCREENER_FOLDER,
  admitsDestination, SCREENER_ACT_TRIGGER_PREFIX, type LedgerTx, type Tx, upgradeContactsToPerson,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import {
  correspondentsAmong, messagesCitingOwnWriting, recipientsOfOwnWriting, sendersAnsweringOwnWriting,
  type CorrespondentEvidence,
} from "@trafficflow/core/adapters/drizzle-repo";
import { silentLogger, type Logger } from "@trafficflow/core/mail";
import { ruleMatchKey } from "@trafficflow/core/rule-order";
import { upsertDesired } from "./rule-pass.js";
import { writeSenderChecks } from "./sender-check-backfill.js";

/* THE SCREENER'S CORRESPONDENT RETRO — what the gate now knows at ingest, applied once to what it
 * decided before it knew. Three acts, all for somebody this account wrote to after its consent
 * point (`packages/core/src/correspondent.ts`): teach `contacts` the recipients of Sent copies
 * ingested before the ingest taught them; release their mail the gate still holds to the Ohbox
 * (desired state the reconciler converges, an audit row with its inverse per message); and switch
 * off a spam or screen-out rule the Screener's own auto-act promoted over them, never one the
 * person made. Somebody the account wrote to, found by their citation of that mail, is admitted as
 * any recipient is, a held claim (mail 0148) with the fact riding. A citer the copy does not name is
 * a correspondent for the messages that cite it only: those go, never a claim, and nothing is
 * taught. A row that FAILED authentication is never moved, nor anything in Junk. Counts only. */

/** Senders one run may examine in each of its two walks. */
const CORRESPONDENT_RETRO_SENDERS = 50;

/** How often one account is re-examined — the evidence it reads changes when somebody writes. */
export const CORRESPONDENT_RETRO_EVERY_MS = 60 * 60 * 1000;

/** The Ohbox, as the gate's own destination spells it. */
const OHBOX = "INBOX";

interface CorrespondentRetroDeps {
  accountId: string;
  log?: Logger;
  now?: () => Date;
  /** Test seam. Default {@link CORRESPONDENT_RETRO_SENDERS}. */
  senders?: number;
}

interface CorrespondentRetroResult {
  /** Addresses newly taught to `contacts` from the account's own post-consent writing. */
  learned: number;
  /** Held senders asked about. */
  examined: number;
  /** Held messages released to the Ohbox. */
  released: number;
  /** Auto-act rules switched off. */
  retired: number;
}

const ledger = (tx: Tx): LedgerTx => tx as unknown as LedgerTx;

/** THE PASS, for ONE account. Idempotent: released mail and retired rules leave its candidates. */
export async function screenerCorrespondentRetroPass(
  db: Tx, deps: CorrespondentRetroDeps,
): Promise<CorrespondentRetroResult> {
  const log = deps.log ?? silentLogger;
  const now = deps.now?.() ?? new Date();
  const limit = deps.senders ?? CORRESPONDENT_RETRO_SENDERS;
  const { accountId } = deps;
  const result: CorrespondentRetroResult = { learned: 0, examined: 0, released: 0, retired: 0 };

  // Every write below goes through the erasure fence: a contact is a correspondent's ADDRESS in a
  // table the account's sweep empties, and this pass may be past its reads when the sweep lands.
  const written = await recipientsOfOwnWriting(db, accountId);
  if (written.size > 0) {
    const fresh = [...written.keys()].filter((a) => a.includes("@"));
    result.learned = await fencedAccountWrite(db, { accountId }, async (tx) => {
      let learned = 0;
      for (let i = 0; i < fresh.length; i += 500) {
        const part = fresh.slice(i, i + 500);
        // The account WROTE to them: a person's act (mail 0148).
        const inserted = await tx.insert(contacts)
          .values(part.map((address) => ({ accountId, address, source: "person" })))
          .onConflictDoNothing({ target: [contacts.accountId, contacts.address] })
          .returning({ id: contacts.id });
        learned += inserted.length;
        await upgradeContactsToPerson(tx, accountId, part);
      }
      return learned;
    });
  }

  const held = await heldSenders(db, accountId, limit);
  result.examined = held.length;
  if (held.length > 0) {
    const found = await correspondentsAmong(db, { accountId, senders: held, references: "held" });
    // An answer held under a newer mail of theirs citing nothing: every held message is asked.
    const answering = await sendersAnsweringOwnWriting(db, accountId, held.filter((a) => !found.has(a)));
    for (const [address, evidence] of [...found, ...answering]) {
      result.released += await release(db, accountId, address, evidence, now);
    }
  }

  result.retired = await retireAutoActRules(db, accountId, limit, now);

  if (result.learned + result.released + result.retired > 0) {
    log.info("screener_correspondent_retro", {
      accountId, learned: result.learned, examined: result.examined, moved: result.released,
      resolved: result.retired,
      reason: "people this account wrote to are known, their held mail is on its way to the "
        + "Ohbox, and spam rules the Screener promoted over them on its own are switched off",
    });
  }
  return result;
}

/** Distinct held senders on mailboxes this install organizes, oldest first. */
async function heldSenders(db: Tx, accountId: string, limit: number): Promise<string[]> {
  const rows = await db.selectDistinct({ address: sql<string>`lower(${messages.fromAddress})` })
    .from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(and(...heldWhere(accountId)))
    .orderBy(asc(sql`lower(${messages.fromAddress})`))
    .limit(limit);
  return rows.map((r) => r.address).filter((a) => a.includes("@"));
}

/**
 * Held by the gate here, not moved on, not a tombstone, on a mailbox this install organizes — and
 * not a FAILED authentication: the provider's own report says that mail is not its author's, so
 * having written to the address it names proves nothing about it (the gate's own term).
 */
function heldWhere(accountId: string): SQL[] {
  return [
    eq(messages.accountId, accountId),
    eq(folderState.desiredFolder, SCREENER_FOLDER),
    eq(folderState.lastSetBy, "us"),
    isNull(messages.deletedAt),
    notFailedAuthSql(messages),
    sql`not exists (
      select 1 from mailboxes mb
       where mb.id = ${messages.mailboxId}
         and (mb.status = 'disabled' or mb.organizer_role <> 'organizer')
    )`,
  ];
}

/**
 * One sender's held mail to the Ohbox, in one transaction, guarded by the lock on each row. The
 * rule-key lock first, then the contact, then the rows: a Screener decision about the same sender
 * takes that lock, records its rule, and only then reaches `contacts` and the held bag, so a release
 * holding the rows while it waits on the contact (or the change-log sequence) deadlocked with it.
 * A named correspondent is taught as a contact even when the gate no longer holds their mail.
 */
async function release(
  db: Tx, accountId: string, address: string, evidence: CorrespondentEvidence, now: Date,
): Promise<number> {
  return fencedAccountWrite(db, { accountId }, async (tx) => {
    await lockAccountRuleKeys(tx, accountId);
    /* A copy written TO them is the person writing, whichever arm found it (`via` says how): a
       person's contact, and their held mail released, a claim included with the fact riding — the
       gate holds a claim at ingest, and this releases it within the hour. An answer from an address
       the copy does not name is released message by message: only what itself cites an own copy,
       never a claim (unchecked rows are checked first), and nothing is taught. */
    let cleared: ReadonlySet<string> | null = null;
    if (evidence.named) {
      await tx.insert(contacts).values({ accountId, address, source: "person" })
        .onConflictDoNothing({ target: [contacts.accountId, contacts.address] });
      await upgradeContactsToPerson(tx, accountId, [address]);
    } else {
      const held = await tx.select({
        id: messages.id, fromName: messages.fromName, fromAddress: messages.fromAddress,
        subject: messages.subject, senderCheck: messages.senderCheck,
      }).from(folderState)
        .innerJoin(messages, eq(messages.id, folderState.messageId))
        .where(and(...heldWhere(accountId), eq(sql`lower(${messages.fromAddress})`, address)));
      const citing = await messagesCitingOwnWriting(tx, accountId, held.map((r) => r.id));
      const candidates = held.filter((r) => citing.has(r.id));
      const marked = new Set((await writeSenderChecks(tx, accountId, candidates.filter((r) => r.senderCheck === null)
        .map((r) => ({ id: r.id, fromName: r.fromName, fromAddress: r.fromAddress, subject: r.subject }))))
        .map((r) => r.id));
      cleared = new Set(candidates.filter((r) => r.senderCheck === "none" || (r.senderCheck === null && !marked.has(r.id)))
        .map((r) => r.id));
      if (cleared.size === 0) return 0;
    }
    const locked = await dialect(tx).forUpdate(tx.select({
      messageId: messages.id, mailboxId: messages.mailboxId, observedFolder: folderState.observedFolder,
    }).from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(...heldWhere(accountId), eq(sql`lower(${messages.fromAddress})`, address))));
    const rows = cleared === null ? locked : locked.filter((r) => cleared.has(r.messageId));
    if (rows.length === 0) return 0;
    for (const r of rows) {
      await upsertDesired(tx, r, OHBOX, now);
      await recordChange(ledger(tx), {
        accountId, entityType: "message", entityId: r.messageId, op: "move",
        meta: { from: SCREENER_FOLDER, to: OHBOX },
      });
      await tx.insert(auditLog).values({
        accountId, action: auditAction("screener.correspondent_admitted"),
        payload: {
          mailboxId: r.mailboxId, messageId: r.messageId, via: evidence.via, named: evidence.named,
          sentAt: evidence.sentAt.toISOString(), from: SCREENER_FOLDER, to: OHBOX,
        },
        inverse: { messageId: r.messageId, from: OHBOX, to: SCREENER_FOLDER },
      });
    }
    return rows.length;
  });
}

/**
 * The auto-act's own denials over a correspondent. A promoted denying SENDER rule counts only
 * when every Screener decision on record about that sender came from the act itself
 * (`screener:auto:`) — a rule the person made by pressing is theirs and stands. The act records
 * the rule's own spelling as the signal's sender, so both sides are keyed as `ruleMatchKey` keys.
 */
async function retireAutoActRules(db: Tx, accountId: string, limit: number, now: Date): Promise<number> {
  const denying = await db.select({ id: rulesTbl.id, match: rulesTbl.match, destination: rulesTbl.destination })
    .from(rulesTbl)
    .where(and(
      eq(rulesTbl.accountId, accountId),
      eq(rulesTbl.kind, "sender"),
      eq(rulesTbl.provenance, "promoted"),
      eq(rulesTbl.enabled, true),
      sql`exists (
        select 1 from ${learningSignals} ls
         where ls.account_id = ${rulesTbl.accountId}
           and ls.kind = 'screener'
           and ${ruleMatchKeySql(sql`ls.sender_address`)} = ${ruleMatchKeySql(rulesTbl.match)}
           and ls.triggering_action_id like ${`${SCREENER_ACT_TRIGGER_PREFIX}%`}
      )`,
      sql`not exists (
        select 1 from ${learningSignals} ls
         where ls.account_id = ${rulesTbl.accountId}
           and ls.kind = 'screener'
           and ${ruleMatchKeySql(sql`ls.sender_address`)} = ${ruleMatchKeySql(rulesTbl.match)}
           and ls.triggering_action_id not like ${`${SCREENER_ACT_TRIGGER_PREFIX}%`}
      )`,
    ))
    .limit(limit);
  const candidates = denying.filter((r) => !admitsDestination(r.destination));
  if (candidates.length === 0) return 0;
  const found = await correspondentsAmong(db, {
    accountId, senders: candidates.map((r) => r.match), references: new Map(),
  });
  const retire = candidates.filter((r) => found.has(ruleMatchKey(r.match)));
  if (retire.length === 0) return 0;
  return fencedAccountWrite(db, { accountId }, async (tx) => {
    // A rules writer: the account's rule-key lock before its first `rules` statement.
    await lockAccountRuleKeys(tx, accountId);
    const off = await tx.update(rulesTbl).set({ enabled: false, updatedAt: now })
      .where(and(eq(rulesTbl.accountId, accountId), eq(rulesTbl.enabled, true),
        inArray(rulesTbl.id, retire.map((r) => r.id))))
      .returning({ id: rulesTbl.id });
    if (off.length === 0) return 0;
    await recordRuleDelta(ledger(tx), accountId, off.map((r) => r.id), "update");
    await tx.insert(auditLog).values(off.map((r) => ({
      accountId, action: auditAction("screener.correspondent_rule_retired"),
      payload: { ruleId: r.id }, inverse: { ruleId: r.id, enabled: true },
    })));
    return off.length;
  });
}

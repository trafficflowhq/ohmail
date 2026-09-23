import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  auditAction, auditLog, contacts, fencedAccountWrite, folderState, learningSignals, messages,
  recordChange, recordRuleDelta, rules as rulesTbl, SCREENER_FOLDER, admitsDestination,
  type LedgerTx, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import {
  correspondentsAmong, recipientsOfOwnWriting, type CorrespondentEvidence,
} from "@trafficflow/core/adapters/drizzle-repo";
import { silentLogger, type Logger } from "@trafficflow/core/mail";
import { upsertDesired } from "./rule-pass.js";

/* THE SCREENER'S CORRESPONDENT RETRO — what the gate now knows at ingest, applied once to what it
 * decided before it knew. Three acts, all for somebody this account wrote to after its consent
 * point (`packages/core/src/correspondent.ts`): teach `contacts` the recipients of Sent copies
 * ingested before the ingest taught them; release their mail the gate still holds to the Ohbox
 * (desired state the reconciler converges, an audit row with its inverse per message); and switch
 * off a spam or screen-out rule the Screener's own auto-act promoted over them, never one the
 * person made. Nothing it moves is in Junk. Logs counts only. */

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
        const inserted = await tx.insert(contacts)
          .values(part.map((address) => ({ accountId, address })))
          .onConflictDoNothing({ target: [contacts.accountId, contacts.address] })
          .returning({ id: contacts.id });
        learned += inserted.length;
      }
      return learned;
    });
  }

  const held = await heldSenders(db, accountId, limit);
  result.examined = held.length;
  if (held.length > 0) {
    const found = await correspondentsAmong(db, { accountId, senders: held, references: "held" });
    for (const [address, evidence] of found) {
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

/** Held by the gate here, not moved on, not a tombstone, on a mailbox this install organizes. */
function heldWhere(accountId: string): SQL[] {
  return [
    eq(messages.accountId, accountId),
    eq(folderState.desiredFolder, SCREENER_FOLDER),
    eq(folderState.lastSetBy, "us"),
    isNull(messages.deletedAt),
    sql`not exists (
      select 1 from mailboxes mb
       where mb.id = ${messages.mailboxId}
         and (mb.status = 'disabled' or mb.organizer_role <> 'organizer')
    )`,
  ];
}

/** One sender's held mail to the Ohbox, in one transaction, guarded by the lock on each row. */
async function release(
  db: Tx, accountId: string, address: string, evidence: CorrespondentEvidence, now: Date,
): Promise<number> {
  return fencedAccountWrite(db, { accountId }, async (tx) => {
    const rows = await dialect(tx).forUpdate(tx.select({
      messageId: messages.id, mailboxId: messages.mailboxId, observedFolder: folderState.observedFolder,
    }).from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(...heldWhere(accountId), eq(sql`lower(${messages.fromAddress})`, address))));
    if (rows.length === 0) return 0;
    await tx.insert(contacts).values({ accountId, address })
      .onConflictDoNothing({ target: [contacts.accountId, contacts.address] });
    for (const r of rows) {
      await upsertDesired(tx, r, OHBOX, now);
      await recordChange(ledger(tx), {
        accountId, entityType: "message", entityId: r.messageId, op: "move",
        meta: { from: SCREENER_FOLDER, to: OHBOX },
      });
      await tx.insert(auditLog).values({
        accountId, action: auditAction("screener.correspondent_admitted"),
        payload: {
          mailboxId: r.mailboxId, messageId: r.messageId, via: evidence.via,
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
 * (`screener:auto:`) — a rule the person made by pressing is theirs and stands.
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
           and lower(ls.sender_address) = lower(${rulesTbl.match})
           and ls.triggering_action_id like 'screener:auto:%'
      )`,
      sql`not exists (
        select 1 from ${learningSignals} ls
         where ls.account_id = ${rulesTbl.accountId}
           and ls.kind = 'screener'
           and lower(ls.sender_address) = lower(${rulesTbl.match})
           and ls.triggering_action_id not like 'screener:auto:%'
      )`,
    ))
    .limit(limit);
  const candidates = denying.filter((r) => !admitsDestination(r.destination));
  if (candidates.length === 0) return 0;
  const found = await correspondentsAmong(db, {
    accountId, senders: candidates.map((r) => r.match), references: new Map(),
  });
  const retire = candidates.filter((r) => found.has(r.match.trim().toLowerCase()));
  if (retire.length === 0) return 0;
  return fencedAccountWrite(db, { accountId }, async (tx) => {
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

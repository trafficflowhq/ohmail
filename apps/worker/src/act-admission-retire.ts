import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  admitsDestination, assertAccountOrganizes, auditAction, auditLog, contactNotes, contacts, DECIDABLE_FOLDERS,
  deleteRulesById, domainOf, endGraduationOfRule, fencedAccountWrite, learningSignals, lockAccountRuleKeys,
  OrganizedElsewhereError, readListAddresses, readOwnAddresses, ruleMatchKeySql, rules as rulesTbl, rulesTheActWrote,
  SCREENER_ACT_TRIGGER_PREFIX, type Tx,
} from "@trafficflow/db";
import { correspondentsAmong } from "@trafficflow/core/adapters/drizzle-repo";
import { ruleMatchKey } from "@trafficflow/core/rule-order";
/* The mail leaf, never the barrel: the local engines bundle this pass, and a value import from the
   barrel carries the model half into them (the engine census refuses the build). */
import { silentLogger, type Logger } from "@trafficflow/core/mail";

/**
 * THE ACT'S PAST ADMISSIONS, RETIRED (owner ruling 2026-11-02: nothing is let in that the person did
 * not let in). Before 0.30.29 the act on suggestions let senders in on confident advice: a promoted
 * allow rule nobody stamped and an inferred contact, either of which still admits their next letter.
 * Once per account, on each store: a sender whose every Screener decision on record is the act's,
 * one of them a letter it let in, loses that rule and the contact only the act wrote, and waits at
 * the Screener again. A sender the person chose in any way keeps everything. No letter moves; one
 * audit row per sender, no address in it. Paged by sender, so a page of senders it keeps still ends.
 */

/** Senders one page examines: one candidate read, the correspondent read and one transaction. */
export const ACT_ADMISSION_RETIRE_SENDERS = 100;

export interface ActAdmissionRetireDeps {
  accountId: string;
  log?: Logger;
  now?: () => Date;
  /** Test seam. Default {@link ACT_ADMISSION_RETIRE_SENDERS}. */
  batch?: number;
  /** The last sender a previous page examined: the walk goes on after it. */
  after?: string;
}

export interface ActAdmissionRetireResult {
  /** Senders this page examined. */
  examined: number;
  /** The act's allow rules deleted. */
  rules: number;
  /** Contacts only the act wrote, removed. */
  contacts: number;
  /** True ⇒ the walk reached its end, or this install organizes none of the account's mailboxes. */
  done: boolean;
  /** Where the next page starts; null once done. */
  next: string | null;
}

/** The places a decision lets a sender in: the Ohbox, News in both spellings, Receipts. */
const ADMITTING = [...DECIDABLE_FOLDERS].filter(admitsDestination).sort();

export async function retireActAdmissionsPass(
  db: Tx, deps: ActAdmissionRetireDeps,
): Promise<ActAdmissionRetireResult> {
  const { accountId } = deps;
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? ACT_ADMISSION_RETIRE_SENDERS;

  const page = await actAdmittedSenders(db, accountId, deps.after, batch);
  const next = page.length === batch ? page[page.length - 1]! : null;
  const result: ActAdmissionRetireResult = { examined: page.length, rules: 0, contacts: 0, done: next === null, next };
  if (page.length === 0) return result;

  // Facts that change slowly, read once outside the write: the account's own addresses, the brands a
  // person consented at a list's address, and everyone the account wrote to.
  const own = await readOwnAddresses(db, accountId);
  const lists = await readListAddresses(db, accountId, page);
  const wrote = await correspondentsAmong(db, { accountId, senders: page, references: new Map() });
  const asked = page.filter((s) => !own.has(s) && !wrote.has(s) && (lists.get(s)?.size ?? 0) === 0);
  if (asked.length === 0) return result;

  const written = await fencedAccountWrite(db, { accountId }, async (tx) => {
    try {
      await assertAccountOrganizes(tx, accountId);
    } catch (err) {
      if (err instanceof OrganizedElsewhereError) return null;
      throw err;
    }
    await lockAccountRuleKeys(tx, accountId);
    // Under the lock every press takes before its rule and contact: what a person chose since the
    // page was read keeps everything.
    const chosen = await personChose(tx, accountId, asked);
    const senders = asked.filter((s) => !chosen.has(s));
    if (senders.length === 0) return { rules: 0, contacts: 0 };

    const promoted = await tx.select({
      id: rulesTbl.id, kind: rulesTbl.kind, match: rulesTbl.match, destination: rulesTbl.destination,
      provenance: rulesTbl.provenance, personDecidedAt: rulesTbl.personDecidedAt,
    }).from(rulesTbl).where(and(
      eq(rulesTbl.accountId, accountId), eq(rulesTbl.kind, "sender"), eq(rulesTbl.provenance, "promoted"),
      isNull(rulesTbl.personDecidedAt), isNull(rulesTbl.subjectContains), isNull(rulesTbl.bodyContains),
      inArray(ruleMatchKeySql(rulesTbl.match), senders),
    ));
    const theAct = await rulesTheActWrote(tx, accountId, promoted.filter((r) => admitsDestination(r.destination)));
    const keyOf = new Map(promoted.filter((r) => theAct.has(r.id)).map((r) => [r.id, ruleMatchKey(r.match)]));

    // The lock order every writer under a sender's key keeps: contacts, then the rules' deltas, then
    // the graduation rows.
    const removed = await tx.delete(contacts).where(and(
      eq(contacts.accountId, accountId),
      inArray(sql`lower(${contacts.address})`, senders),
      or(isNull(contacts.source), eq(contacts.source, "inferred")),
      sql`coalesce(${contacts.name}, '') = ''`,
      sql`not exists (select 1 from ${contactNotes} where ${contactNotes.contactId} = ${contacts.id})`,
    )).returning({ address: contacts.address });
    const contactGone = new Set(removed.map((c) => c.address.toLowerCase()));
    const deleted = await deleteRulesById(tx, accountId, [...keyOf.keys()]);
    const ruleIdsOf = new Map<string, string[]>();
    for (const id of deleted) {
      const key = keyOf.get(id)!;
      ruleIdsOf.set(key, [...(ruleIdsOf.get(key) ?? []), id]);
    }
    for (const key of ruleIdsOf.keys()) await endGraduationOfRule(tx, accountId, { kind: "sender", match: key });

    const audits = senders.filter((s) => ruleIdsOf.has(s) || contactGone.has(s)).map((s) => ({
      accountId, action: auditAction("screener.act_admission_retired"),
      payload: { ruleIds: ruleIdsOf.get(s) ?? [], contactRemoved: contactGone.has(s) }, inverse: null,
    }));
    if (audits.length > 0) await tx.insert(auditLog).values(audits);
    return { rules: deleted.length, contacts: removed.length };
  });

  if (written === null) return { ...result, done: true, next: null };
  result.rules = written.rules;
  result.contacts = written.contacts;
  if (written.rules + written.contacts > 0) {
    log.info("act_admission_retired", {
      accountId, examined: result.examined, resolved: written.rules, cleared: written.contacts, done: result.done,
    });
  }
  return result;
}

/**
 * ONE PAGE OF SENDERS THE ACT LET IN, by key from `after`: every Screener decision on record about
 * them is the act's (`screener:auto:`), one of them into a place that lets a sender in, and they still
 * hold something of it — an allow rule the act may have written, or a contact nobody stamped as a
 * person's. One statement; the pattern a literal, as `markLegacyActContacts` keeps it.
 */
async function actAdmittedSenders(db: Tx, accountId: string, after: string | undefined, limit: number): Promise<string[]> {
  const act = sql.raw(`'${SCREENER_ACT_TRIGGER_PREFIX.replace(/'/g, "''")}%'`);
  const admitting = sql.join(ADMITTING.map((f) => sql`${f}`), sql`, `);
  const key = ruleMatchKeySql(learningSignals.senderAddress);
  const decided = db.select({ sender: sql<string>`${key}`.as("aa_sender") }).from(learningSignals)
    .where(and(
      eq(learningSignals.accountId, accountId), eq(learningSignals.kind, "screener"),
      isNotNull(learningSignals.senderAddress),
    ))
    .groupBy(key)
    .having(sql`min(case when ${learningSignals.triggeringActionId} like ${act} then 1 else 0 end) = 1
      and max(case when ${learningSignals.destination} in (${admitting}) then 1 else 0 end) = 1`)
    .as("aa");
  // The alias by name: inside a raw fragment the builder may drop a column's table.
  const sender: SQL = sql`${sql.identifier("aa")}.${sql.identifier("aa_sender")}`;
  const holds = sql`(exists (
      select 1 from ${rulesTbl} ar
       where ar.account_id = ${accountId} and ar.kind = 'sender' and ${ruleMatchKeySql(sql`ar.match`)} = ${sender}
         and ar.provenance = 'promoted' and ar.person_decided_at is null
         and ar.subject_contains is null and ar.body_contains is null and ar.destination in (${admitting})
    ) or exists (
      select 1 from ${contacts} ac
       where ac.account_id = ${accountId} and lower(ac.address) = ${sender}
         and (ac.source is null or ac.source = 'inferred')
    ))`;
  const rows = await db.select({ sender: decided.sender }).from(decided)
    .where(after === undefined ? holds : and(gt(sql`${sender}`, after), holds))
    .orderBy(asc(sql`${sender}`))
    .limit(limit);
  return rows.map((r) => String(r.sender)).filter((s) => s.includes("@"));
}

/**
 * The senders among `senders` a person chose, by any of the doors only a person uses: a contact of a
 * person's, or one with a name or a note; an allow rule for the sender or the domain a person wrote or
 * stamped, switched on; an AI proposal about them the person approved.
 */
async function personChose(tx: Tx, accountId: string, senders: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const noted = await tx.select({ address: contacts.address }).from(contacts).where(and(
    eq(contacts.accountId, accountId),
    inArray(sql`lower(${contacts.address})`, [...senders]),
    sql`(${contacts.source} = 'person' or coalesce(${contacts.name}, '') <> ''
      or exists (select 1 from ${contactNotes} where ${contactNotes.contactId} = ${contacts.id}))`,
  ));
  for (const c of noted) out.add(c.address.toLowerCase());

  const domains = [...new Set(senders.map(domainOf).filter((d) => d !== ""))];
  const personRules = await tx.select({ kind: rulesTbl.kind, key: sql<string>`${ruleMatchKeySql(rulesTbl.match)}` })
    .from(rulesTbl).where(and(
      eq(rulesTbl.accountId, accountId), eq(rulesTbl.enabled, true), inArray(rulesTbl.destination, ADMITTING),
      or(sql`${rulesTbl.provenance} <> 'promoted'`, isNotNull(rulesTbl.personDecidedAt)),
      or(
        and(eq(rulesTbl.kind, "sender"), inArray(ruleMatchKeySql(rulesTbl.match), [...senders])),
        domains.length === 0 ? sql`false` : and(eq(rulesTbl.kind, "domain"), inArray(ruleMatchKeySql(rulesTbl.match), domains)),
      ),
    ));
  const ruledDomains = new Set(personRules.filter((r) => r.kind === "domain").map((r) => r.key));
  for (const r of personRules) if (r.kind === "sender") out.add(r.key);
  for (const s of senders) if (ruledDomains.has(domainOf(s))) out.add(s);

  const approved = await tx.select({ sender: sql<string>`${ruleMatchKeySql(learningSignals.senderAddress)}` })
    .from(learningSignals).where(and(
      eq(learningSignals.accountId, accountId), eq(learningSignals.kind, "approval"),
      eq(learningSignals.label, "positive"),
      inArray(ruleMatchKeySql(learningSignals.senderAddress), [...senders]),
    ));
  for (const a of approved) out.add(a.sender);
  return out;
}

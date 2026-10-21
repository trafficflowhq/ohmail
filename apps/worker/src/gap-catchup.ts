import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  approvals, auditAction, auditLog, drafts, folderState, mailboxes, messageBodies, messageStates, messages,
  OwnAddressesPerPass, recordChange, routingDecisions, rules as rulesTbl, weAnsweredThisSenderWhere,
  type Tx,
} from "@trafficflow/db";
import {
  DEFAULT_OHBOX_POLICY, authVerdictFromHeaders, canonicalDestination, dsnVerdict, evaluateRules,
  identityOfRow, silentLogger, type Logger, type SweepClearance,
  /* The mail leaf, never the barrel: the local engines bundle this pass (rule-retro.ts says why). */
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { carryDialect, dialect } from "@trafficflow/db/dialect";
import { perMailboxAuthservTrust, ruleInputOf, upsertDesired, type RuleInputRow } from "./rule-pass.js";

/* MAIL FROM A GAP, FILED ONLY ON A PERSON'S PRESS. The window is the gap the reader is looking at
   now (`gap_since`; a look that finds a live holder clears it), and a letter is in it only when it
   ARRIVED and was TAKEN IN at or after its start. Once this install organizes and its rules are
   settled (`clearanceFor`: no import question open, the settings read), this pass COUNTS
   what the person's rules would file (`gap_letters`) and moves nothing; the person is shown the
   count. On their press (`gap_pressed_at`) it decides again with the same function, in one
   transaction, and files that set only while its size is the count they were shown. */

/* Where a look opens the window: a leaf, so both engines read one arbitration. */
export { gapKeyFrom, gapOpenStart, instantOf, travellingGapColumns, type TravelledGap } from "./gap-window.js";

/** Rows read per page of the walk. */
export const GAP_CATCHUP_BATCH = 100;

/** Pages one window may span. Past it the window ENDS unoffered: no drain walks it again. */
export const GAP_CATCHUP_MAX_PAGES = 20;

/** The clearance of a mailbox nobody evaluated here: its settings folder was not read. */
export const NO_FOLDER_READ: SweepClearance = { kind: "unread", why: "no_folder" };

/** The withheld state last logged per mailbox, so a standing one is said once. */
const withheldSaid = new Map<string, string>();

export interface GapCatchupDeps {
  accountId: string;
  /** Only these mailboxes — the sidecar's organizing set after a quiet drain. Absent ⇒ every one. */
  mailboxIds?: readonly string[];
  log?: Logger;
  batch?: number;
  maxPages?: number;
  /** Per-mailbox authserv trust, REQUIRED for rule-retro's reason (absent ⇒ trust nothing is a choice). */
  trustedAuthservIdsFor: (db: Tx, mailboxId: string) => Promise<ReadonlySet<string>>;
  /**
   * Whether this mailbox's rules are settled — the last read of its settings folder, handed in as
   * data (this pass opens no IMAP). Only `clear` is counted, filed or closed: under `held` (an
   * import question open) or `unread` the window waits. REQUIRED, so no caller forgets the gate.
   */
  clearanceFor: (mailboxId: string) => SweepClearance;
}

export interface GapCatchupResult {
  /** Offers written: a first count, or a new count after a press whose set had changed. */
  offered: number;
  /** Letters given a desired folder, all of them on a press. */
  moved: number;
  /** Windows closed: filed, nothing to offer, or past the page bound. */
  completed: number;
}

interface GapRow extends RuleInputRow {
  messageId: string;
  mailboxId: string;
  arrivedAt: Date;
  observedFolder: string;
  desiredFolder: string;
}

export async function gapCatchupPass(
  db: Tx, deps: GapCatchupDeps, now: Date = new Date(),
): Promise<GapCatchupResult> {
  const result: GapCatchupResult = { offered: 0, moved: 0, completed: 0 };
  if (deps.mailboxIds !== undefined && deps.mailboxIds.length === 0) return result;
  /* THE OWED SET: an open window on a mailbox this install organizes, not yet counted or pressed.
     An offer waiting for the person costs nothing here. */
  const owed = await db.select({ id: mailboxes.id }).from(mailboxes).where(and(
    eq(mailboxes.accountId, deps.accountId),
    sql`${mailboxes.status} <> 'disabled'`,
    eq(mailboxes.organizerRole, "organizer"),
    isNotNull(mailboxes.gapSince),
    or(isNull(mailboxes.gapLetters), isNotNull(mailboxes.gapPressedAt)),
    ...(deps.mailboxIds !== undefined ? [inArray(mailboxes.id, [...deps.mailboxIds])] : []),
  )).orderBy(asc(mailboxes.id));
  /* ONLY SETTLED RULES DECIDE: a mailbox whose import question is open, or whose settings were not
     read, has rules that may be about to change, so nothing is counted, filed or closed. No lock, no
     write; the window and any press stay for a later pass. */
  const settled = owed.filter((mb) => {
    const c = deps.clearanceFor(mb.id);
    if (c.kind === "clear") { withheldSaid.delete(mb.id); return true; }
    const why = c.kind === "unread" ? c.why : null;
    const state = `${c.kind}:${why ?? ""}`;
    if (withheldSaid.get(mb.id) !== state) {
      withheldSaid.set(mb.id, state);
      (deps.log ?? silentLogger).info("gap_catchup_withheld", {
        mailboxId: mb.id, accountId: deps.accountId, outcome: c.kind, why,
        reason: "the mailbox's rules are not settled (an import question is open, or its settings were not read), "
          + "so the letters that arrived while nothing organized it wait in their window",
      });
    }
    return false;
  });
  if (settled.length === 0) return result;

  const trustFor = perMailboxAuthservTrust(db, deps.trustedAuthservIdsFor);
  const own = (await db.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, deps.accountId))).map((r) => r.address.toLowerCase());
  const ownSet = await new OwnAddressesPerPass().ownAddresses(db, deps.accountId);

  for (const mb of settled) {
    await db.transaction(async (txRaw) => {
      const tx = carryDialect(db, txRaw as object) as typeof txRaw;
      const close = { gapSince: null, gapLetters: null, gapPressedAt: null };
      const here = and(eq(mailboxes.id, mb.id), eq(mailboxes.organizerRole, "organizer"));
      /* THE MAILBOX ROW FIRST, in the writers' lock order (the mailbox row, then folder_state). The
         press door takes the same lock, so a press and this pass serialize. */
      const [row] = await dialect(tx).forUpdate(tx.select({
        since: mailboxes.gapSince, letters: mailboxes.gapLetters, pressedAt: mailboxes.gapPressedAt,
      }).from(mailboxes).where(here));
      if (row === undefined || row.since === null) return;
      const pressed = row.pressedAt !== null && row.letters !== null;
      if (row.letters !== null && !pressed) return;
      const set = await gapSet(tx, deps, mb.id, own, ownSet, trustFor);
      if (set === null) {
        (deps.log ?? silentLogger).warn("gap_catchup_truncated", {
          mailboxId: mb.id, accountId: deps.accountId, maxPages: deps.maxPages ?? GAP_CATCHUP_MAX_PAGES,
          reason: "the window outgrew its page bound and ended unoffered",
        });
      }
      if (set === null || set.length === 0) {
        await tx.update(mailboxes).set(close).where(here);
        result.completed++;
        return;
      }
      /* NOT PRESSED, OR THE SET MOVED SINCE THE PERSON SAW IT: offer this count and file nothing. */
      if (!pressed || set.length !== row.letters) {
        await tx.update(mailboxes).set({ gapLetters: set.length, gapPressedAt: null }).where(here);
        result.offered++;
        return;
      }
      for (const { c, to, ruleId } of set) {
        await upsertDesired(tx, c, to, now);
        await tx.insert(routingDecisions).values({
          accountId: deps.accountId, messageId: c.messageId, inputProvenance: "rule",
          matchedRuleId: ruleId, destination: to, status: "auto_applied",
        });
        await recordChange(tx, {
          accountId: deps.accountId, entityType: "message", entityId: c.messageId, op: "move",
          meta: { from: c.desiredFolder, to },
        });
        // The undo a machine move owes, as rule-retro and ohbox-tidy write it.
        await tx.insert(auditLog).values({
          accountId: deps.accountId, action: auditAction("gap_catchup_move"),
          payload: { mailboxId: c.mailboxId, messageId: c.messageId, from: c.desiredFolder, to, ruleId },
          inverse: { messageId: c.messageId, from: to, to: c.desiredFolder },
        });
      }
      await tx.update(mailboxes).set(close).where(here);
      result.moved += set.length;
      result.completed++;
    });
  }
  return result;
}

/**
 * THE ONE DECISION: every letter in the window the person's rules file elsewhere, the count shown
 * and the set filed alike, or `null` past the page bound. A rule younger than the letter is not
 * one an organizer live at its arrival could have applied; a delivery report keeps its place.
 */
async function gapSet(
  tx: Tx, deps: GapCatchupDeps, mailboxId: string, own: readonly string[],
  ownSet: Awaited<ReturnType<OwnAddressesPerPass["ownAddresses"]>>,
  trustFor: (mailboxId: string) => Promise<ReadonlySet<string>>,
): Promise<Array<{ c: GapRow; to: string; ruleId: string | null }> | null> {
  const repo = makeDrizzleRepo(tx as unknown as Parameters<typeof makeDrizzleRepo>[0]);
  const rules = await repo.listRules(deps.accountId);
  const known = await repo.knownSenders(deps.accountId);
  /* A RULE'S AGE: the person's decision when stamped, its last change otherwise. Typed columns,
     computed here, so both stores read it alike. */
  const ruleAge = new Map((await tx.select({
    id: rulesTbl.id, personDecidedAt: rulesTbl.personDecidedAt, updatedAt: rulesTbl.updatedAt,
  }).from(rulesTbl).where(eq(rulesTbl.accountId, deps.accountId)))
    .map((r) => [r.id, r.personDecidedAt ?? r.updatedAt]));
  const batch = deps.batch ?? GAP_CATCHUP_BATCH;
  const out: Array<{ c: GapRow; to: string; ruleId: string | null }> = [];
  let afterId: string | null = null;
  for (let pages = 0; ; pages++) {
    if (pages >= (deps.maxPages ?? GAP_CATCHUP_MAX_PAGES)) return null;
    const page = await selectGapCandidates(tx, { accountId: deps.accountId, mailboxId, ownAddresses: own, limit: batch, afterId });
    for (const c of page) {
      const msg = ruleInputOf(c);
      if (dsnVerdict(msg) !== null) continue;
      // LENIENT, rule-retro's argument: only a `rule` answer is acted on, never `policy`.
      const d = evaluateRules({
        msg, rules, knownSenders: known, ownAddresses: ownSet, identity: identityOfRow(c),
        auth: authVerdictFromHeaders(c.headers, c.fromAddress, await trustFor(c.mailboxId)),
        ohboxPolicy: DEFAULT_OHBOX_POLICY,
      });
      const age = d.matchedRuleId === null ? undefined : ruleAge.get(d.matchedRuleId);
      if (d.source !== "rule" || d.destination === null || age === undefined
        || age.getTime() > c.arrivedAt.getTime()
        || canonicalDestination(d.destination) === canonicalDestination(c.desiredFolder)) continue;
      out.push({ c, to: d.destination, ruleId: d.matchedRuleId });
    }
    if (page.length < batch) return out;
    afterId = page[page.length - 1]!.messageId;
  }
}

/**
 * ONE PAGE OF GAP MAIL, locked FOR UPDATE OF folder_state, oldest id first: what a reader adopted
 * at the inbox and nothing has moved since (`'peer'`, observed and desired both INBOX), that
 * ARRIVED and was TAKEN IN inside the window, never sensitivity-flagged (sensitive mail stays in
 * INBOX), past rule-retro's user-intent exclusions, in a mailbox this install organizes.
 */
async function selectGapCandidates(
  t: Tx,
  o: { accountId: string; mailboxId: string; ownAddresses: readonly string[]; limit: number; afterId: string | null },
): Promise<GapRow[]> {
  const d = dialect(t);
  const since = sql`(select mb.gap_since from ${mailboxes} mb where mb.id = ${messages.mailboxId})`;
  /* INSIDE THE WINDOW, read off the row itself: a NULL arrival or a closed window matches nothing.
     INTAKE TOO, whatever the arrival says: a letter this store first took in while its row said
     another install held the mailbox predates the window, so it is never gap mail. */
  const filters = [
    eq(messages.accountId, o.accountId),
    eq(messages.mailboxId, o.mailboxId),
    eq(folderState.lastSetBy, "peer"),
    eq(folderState.observedFolder, "INBOX"),
    eq(folderState.desiredFolder, "INBOX"),
    sql`${messages.arrivedAt} >= ${since}`,
    sql`${messages.createdAt} >= ${since}`,
    isNull(messages.sensitivityCategory),
    eq(messages.noAi, false),
    sql`not exists (
      select 1 from ${mailboxes} mb
       where mb.id = ${messages.mailboxId}
         and (mb.status = 'disabled' or mb.organizer_role <> 'organizer')
    )`,
    sql`not exists (
      select 1 from ${messageStates} ms
       where ms.message_id = ${messages.id} and ms.state <> 'none'
    )`,
    sql`not exists (
      select 1 from ${drafts} dr where dr.in_reply_to_message_id = ${messages.id}
    )`,
    sql`not exists (
      select 1 from ${approvals} a
       where a.message_id = ${messages.id} and a.status <> 'pending'
    )`,
    sql`not ${weAnsweredThisSenderWhere(d, {
      accountId: messages.accountId as unknown as SQL,
      threadId: messages.threadId as unknown as SQL,
      fromAddress: messages.fromAddress as unknown as SQL,
      ownAddresses: o.ownAddresses,
    })}`,
  ];
  if (o.afterId !== null) filters.push(gt(messages.id, d.castUuid(o.afterId)));

  const rows = await d.forUpdate(t.select({
    messageId: messages.id,
    mailboxId: messages.mailboxId,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    fromName: messages.fromName,
    senderCheck: messages.senderCheck,
    senderCheckBrand: messages.senderCheckBrand,
    arrivedAt: messages.arrivedAt,
    observedFolder: folderState.observedFolder,
    desiredFolder: folderState.desiredFolder,
    headers: messageBodies.headers,
    bodyText: messageBodies.text,
  }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(...filters))
    .orderBy(asc(messages.id))
    .limit(o.limit), { of: folderState });

  // The selector excludes a NULL arrival; asserted rather than defaulted.
  return rows.map((r) => ({
    ...r,
    arrivedAt: r.arrivedAt as Date,
    bodyText: r.bodyText ?? "",
    headers: (r.headers as Record<string, string[]> | null) ?? {},
  }));
}

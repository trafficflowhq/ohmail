import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  approvals, auditAction, auditLog, drafts, folderState, mailboxes, messageBodies, messageStates, messageTags,
  messages, OwnAddressesPerPass, recordChange, routingDecisions, rules as rulesTbl, weAnsweredThisSenderWhere,
  type LedgerTx, type Tx,
} from "@trafficflow/db";
import {
  DEFAULT_OHBOX_POLICY, authVerdictFromHeaders, canonicalDestination, dsnVerdict, evaluateRules,
  identityOfRow, silentLogger, type Logger, type SweepClearance,
  /* The mail leaf, never the barrel: the local engines bundle this pass (rule-retro.ts says why). */
} from "@trafficflow/core/mail";
import {
  agreeWindowCutoff, gateHoldsSender, makeDrizzleRepo, unscreenedGroups, writeScreenerIntents, type UnscreenedRow,
} from "@trafficflow/core/adapters/drizzle-repo";
import { carryDialect, dialect } from "@trafficflow/db/dialect";
import { perMailboxAuthservTrust, ruleInputOf, upsertDesired, type RuleInputRow } from "./rule-pass.js";

/* MAIL FROM A GAP, FILED ONLY ON A PERSON'S PRESS. The window is the gap the reader is looking at
   now (`gap_since`; a look that finds a live holder clears it), and a letter is in it only when it
   ARRIVED and was TAKEN IN at or after its start. Once this install organizes and its rules are
   settled (`clearanceFor`: no import question open, the settings read), this pass COUNTS
   what the person's rules would file (`gap_letters`) and the letters from senders the gate does not
   know (`gap_strangers`), and moves nothing; the person is shown both counts. On their press
   (`gap_pressed_at`) it decides again with the same function, in one transaction, and files the
   first set and screens the second only while both sizes are the counts they were shown. */

/* Where a look opens the window: a leaf, so both engines read one arbitration. */
import {
  GAP_CLOCK_ALLOWANCE_MS, gapKeyFrom, gapOpenStart, handBackStart, instantOf, markOrganizedThrough, travellingGapColumns,
  type TravelledGap,
} from "./gap-window.js";
export {
  GAP_CLOCK_ALLOWANCE_MS, gapKeyFrom, gapOpenStart, handBackStart, instantOf, markOrganizedThrough, travellingGapColumns,
  type TravelledGap,
};

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
  /** Letters given a desired folder, all of them on a press: filed by a rule or screened. */
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
  messageIdHeader: string | null;
  /** `folder_state.decided_at`: a placement somebody decided is never screened. */
  decidedAt: unknown;
  /** 1 when the letter carries a tag. */
  tagged: unknown;
  /** `coalesce(date, created_at)`, as the store answers it. */
  at: unknown;
}

/** What one walk of the window found: what the rules file, and the letters from strangers. */
interface GapSet {
  file: Array<{ c: GapRow; to: string; ruleId: string | null }>;
  screen: GapRow[];
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
      const close = { gapSince: null, gapLetters: null, gapPressedAt: null, gapStrangers: null };
      const here = and(eq(mailboxes.id, mb.id), eq(mailboxes.organizerRole, "organizer"));
      /* THE MAILBOX ROW FIRST, in the writers' lock order (the mailbox row, then folder_state). The
         press door takes the same lock, so a press and this pass serialize. */
      const [row] = await dialect(tx).forUpdate(tx.select({
        since: mailboxes.gapSince, letters: mailboxes.gapLetters, pressedAt: mailboxes.gapPressedAt,
        strangers: mailboxes.gapStrangers,
      }).from(mailboxes).where(here));
      if (row === undefined || row.since === null) return;
      const pressed = row.pressedAt !== null && row.letters !== null;
      if (row.letters !== null && !pressed) return;
      const set = await gapSet(tx, deps, mb.id, own, ownSet, trustFor, now);
      if (set === null) {
        (deps.log ?? silentLogger).warn("gap_catchup_truncated", {
          mailboxId: mb.id, accountId: deps.accountId, maxPages: deps.maxPages ?? GAP_CATCHUP_MAX_PAGES,
          reason: "the window outgrew its page bound and ended unoffered",
        });
      }
      if (set === null || (set.file.length === 0 && set.screen.length === 0)) {
        if (set !== null) await sayUnarrived(tx, deps, mb.id);
        await tx.update(mailboxes).set(close).where(here);
        result.completed++;
        return;
      }
      /* NOT PRESSED, OR EITHER SET MOVED SINCE THE PERSON SAW IT: offer these counts and move
         nothing. A press on an offer an older build counted (no stranger count) never screens. */
      if (!pressed || set.file.length !== row.letters || set.screen.length !== (row.strangers ?? 0)) {
        await tx.update(mailboxes)
          .set({ gapLetters: set.file.length, gapStrangers: set.screen.length, gapPressedAt: null }).where(here);
        result.offered++;
        return;
      }
      for (const { c, to, ruleId } of set.file) {
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
      if (set.screen.length > 0) {
        const res = await writeScreenerIntents(tx, tx as unknown as LedgerTx, {
          accountId: deps.accountId, rows: set.screen.map(unscreenedRowOf), now, via: "gap", groups: "shown",
        });
        // The groups were bounded when counted, so all of them move; anything else rolls back.
        if (res.total !== set.screen.length) {
          throw new Error(`gap strangers: screened ${res.total} of ${set.screen.length} counted`);
        }
      }
      await tx.update(mailboxes).set(close).where(here);
      result.moved += set.file.length + set.screen.length;
      result.completed++;
    });
  }
  return result;
}

/**
 * Letters taken in inside the window with no arrival time: the walk cannot see them (a phone stored
 * every letter that way before it read INTERNALDATE by hand). Said, never filed; the window closes.
 */
async function sayUnarrived(tx: Tx, deps: GapCatchupDeps, mailboxId: string): Promise<void> {
  const since = sql`(select mb.gap_since from ${mailboxes} mb where mb.id = ${messages.mailboxId})`;
  const allowance = dialect(tx).interval(GAP_CLOCK_ALLOWANCE_MS);
  const [r] = await tx.select({ n: sql<number>`count(*)` }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(and(
      eq(messages.accountId, deps.accountId),
      eq(messages.mailboxId, mailboxId),
      eq(folderState.lastSetBy, "peer"),
      eq(folderState.observedFolder, "INBOX"),
      isNull(messages.arrivedAt),
      sql`${messages.createdAt} >= ${since} - ${allowance}`,
    ));
  const count = Number(r?.n ?? 0);
  if (count > 0) {
    (deps.log ?? silentLogger).warn("gap_catchup_unarrived", {
      mailboxId, accountId: deps.accountId, count,
      reason: "letters taken in while nothing organized this mailbox carry no arrival time, so the window "
        + "could not offer them; it closes, and they stay in the inbox",
    });
  }
}

/** A gap row in the shape the Screener's writes and groups read. */
function unscreenedRowOf(c: GapRow): UnscreenedRow {
  return {
    messageId: c.messageId, fromAddress: c.fromAddress, subject: c.subject, bodyText: c.bodyText,
    headers: c.headers, observedFolder: c.observedFolder, messageIdHeader: c.messageIdHeader,
    at: instantOf(c.at) ?? c.arrivedAt, arrivedAt: c.arrivedAt,
  };
}

/**
 * THE ONE DECISION: every letter in the window the person's rules file elsewhere (`file`), and
 * every letter from a sender the gate does not know (`screen`), the counts shown and the sets
 * moved alike, or `null` past the page bound. A rule younger than the letter is not one an
 * organizer live at its arrival could have applied; a delivery report keeps its place. A stranger
 * is the organize decision's own ({@link gateHoldsSender}), past a decided placement and a tag,
 * within the Screener's group bound so the count shown is the set moved.
 */
async function gapSet(
  tx: Tx, deps: GapCatchupDeps, mailboxId: string, own: readonly string[],
  ownSet: Awaited<ReturnType<OwnAddressesPerPass["ownAddresses"]>>,
  trustFor: (mailboxId: string) => Promise<ReadonlySet<string>>,
  now: Date,
): Promise<GapSet | null> {
  const repo = makeDrizzleRepo(tx as unknown as Parameters<typeof makeDrizzleRepo>[0]);
  const rules = await repo.listRules(deps.accountId);
  const known = await repo.knownSenders(deps.accountId);
  const cutoff = await agreeWindowCutoff(tx, deps.accountId, now);
  const screen: GapRow[] = [];
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
      // LENIENT, rule-retro's argument: a `rule` answer files, a stranger's `screener` answer screens, `policy` never acts.
      const d = evaluateRules({
        msg, rules, knownSenders: known, ownAddresses: ownSet, identity: identityOfRow(c),
        auth: authVerdictFromHeaders(c.headers, c.fromAddress, await trustFor(c.mailboxId)),
        ohboxPolicy: DEFAULT_OHBOX_POLICY,
      });
      if (d.source === "screener") {
        if (c.decidedAt === null && Number(c.tagged) === 0 && await gateHoldsSender(unscreenedRowOf(c), {
          rules, known, own: ownSet, cutoff, ask: repo, accountId: deps.accountId,
        })) screen.push(c);
        continue;
      }
      const age = d.matchedRuleId === null ? undefined : ruleAge.get(d.matchedRuleId);
      if (d.source !== "rule" || d.destination === null || age === undefined
        || age.getTime() > c.arrivedAt.getTime()
        || canonicalDestination(d.destination) === canonicalDestination(c.desiredFolder)) continue;
      out.push({ c, to: d.destination, ruleId: d.matchedRuleId });
    }
    if (page.length < batch) {
      const shown = new Set(unscreenedGroups(screen.map(unscreenedRowOf)).map((g) => g.address));
      return { file: out, screen: screen.filter((c) => shown.has(c.fromAddress.toLowerCase())) };
    }
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
     another install held the mailbox predates the window, so it is never gap mail. The start may be
     on the server's clock and intake is on the store's, so intake is read with the lease's allowance. */
  const filters = [
    eq(messages.accountId, o.accountId),
    eq(messages.mailboxId, o.mailboxId),
    eq(folderState.lastSetBy, "peer"),
    eq(folderState.observedFolder, "INBOX"),
    eq(folderState.desiredFolder, "INBOX"),
    sql`${messages.arrivedAt} >= ${since}`,
    sql`${messages.createdAt} >= ${since} - ${d.interval(GAP_CLOCK_ALLOWANCE_MS)}`,
    isNull(messages.sensitivityCategory),
    eq(messages.noAi, false),
    isNull(messages.deletedAt),
    isNull(messages.serverMissingAt),
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
    messageIdHeader: messages.messageIdHeader,
    decidedAt: folderState.decidedAt,
    tagged: sql<number>`case when exists (select 1 from ${messageTags} mt where mt.message_id = ${messages.id}) then 1 else 0 end`,
    at: sql<unknown>`coalesce(${messages.date}, ${messages.createdAt})`,
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

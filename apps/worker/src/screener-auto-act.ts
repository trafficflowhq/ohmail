import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  accountSettings, accounts, folderState, messages, routingDecisions,
  applyScreenerDecision, recordChanges, fencedAccountWrite,
  AccountErasedError, OrganizedElsewhereError, MailboxErasedError, MailboxNotFoundError,
  SCREENER_SUGGESTION_PROVENANCE, type LedgerTx, type ScreenerActRefusal,
  screenerSuggestionsBySender, resolveCutline, senderIsActiveSql, senderIsDecidedSql, heldSortKey,
  decisionCanBeApplied, readRequestEligibility,
  DECIDABLE_FOLDERS, SCREENER_FOLDER, SCREENER_ACT_TRIGGER_PREFIX,
  type ResolvedCutline, type Tx,
} from "@trafficflow/db";
import { capabilityForKind } from "@trafficflow/core/adapters/organizer-lease";
import { correspondentsAmong } from "@trafficflow/core/adapters/drizzle-repo";
import {
  canonicalDestination, effectForDestination, identityOfRow, silentLogger,
  type Destination, type Logger,
} from "@trafficflow/core/mail";

/* SCREENER AUTO-ACT — for an account that gave THIS pass its own consent, file the waiting senders
 * whose stored advice is confident, through the door a PRESS uses. It reads advice and never buys
 * it (no model, no spend, no claim), and files through `applyScreenerDecision` — the manual Apply's
 * and the reader drain's one implementation — so the promoted rule the person undoes, the held-bag
 * re-route that empties the Waiting count, the mark-read and the learning signal cannot drift from
 * the press. Its sibling `screener-auto.ts` decides for ITSELF (the strong-bulk floor, News and
 * Receipts only) and reads no suggestion at all, which is why a Spam verdict waited for ever. */

/**
 * The bar a DENYING suggestion (Spam, Screened) must meet. RULED 2026-09-22: a spam verdict is
 * reversible from the rules list, so 0.9 — the number `sender-check.ts#CAP_CONFIDENCE` already
 * states for a verdict the sender's own facts force.
 */
export const SCREENER_ACT_DENY_BAR = 0.9;

/**
 * The bar an ADMITTING suggestion (Imbox, News, Receipts) must meet. The same number under a
 * different argument — an admission grants a stranger passage — and stated apart so either may
 * move alone. `capSuggestion` already holds a soft-signalled admit at `SOFT_CEILING` (0.5), far
 * below this, so a sender the facts doubt cannot reach the act however sure the model sounded.
 */
export const SCREENER_ACT_ADMIT_BAR = 0.9;

/** Senders one account may be filed for in one cycle — the reconciler's per-cycle move budget. */
export const SCREENER_ACT_SENDERS_PER_CYCLE = 50;

export interface ScreenerAutoActDeps {
  /** Scope to ONE account — the caller loops its served accounts. */
  accountId: string;
  log?: Logger;
  now?: () => Date;
  /** Test seam. Default {@link SCREENER_ACT_SENDERS_PER_CYCLE}. */
  sendersPerCycle?: number;
  /** Test seams. Default {@link SCREENER_ACT_DENY_BAR} / {@link SCREENER_ACT_ADMIT_BAR}. */
  denyBar?: number;
  admitBar?: number;
  /** The account_settings row the caller already read this cycle; absent ⇒ the pass reads it. */
  settings?: ScreenerAutoActSettings;
  /** The cycle tail's clock, asked before each sender this pass would file after the first. A kept
   *  sender costs no statement and a filed one leaves the Screener, so a stop loses no progress. */
  until?: () => boolean;
  /**
   * The pass's OWN consent, and nothing else arms it. Never `screener_auto_apply_at`: that switch
   * says "Deterministic rules only — no AI". Every production caller passes
   * {@link screenerActConsentFrom}; the callers census holds that.
   */
  consent: ScreenerActConsent | null;
}

/** A given consent to act on suggestions. Asked again per sender, under the account's row lock. */
export interface ScreenerActConsent {
  stillGiven(tx: Tx): Promise<boolean>;
}

/**
 * THE ONE CONSENT the act takes: `account_settings.screener_auto_act_at` set AND the
 * account's AI switch on, one statement. The per-account AI off switch outranks every AI consent,
 * so either one off stops the next sender.
 */
export function screenerActConsentFrom(accountId: string): ScreenerActConsent {
  return {
    async stillGiven(tx: Tx): Promise<boolean> {
      const rows = await tx.select({ accountId: accountSettings.accountId })
        .from(accountSettings)
        .innerJoin(accounts, eq(accounts.id, accountSettings.accountId))
        .where(and(
          eq(accountSettings.accountId, accountId),
          isNotNull(accountSettings.screenerAutoActAt),
          eq(accounts.aiEnabled, true),
        ))
        .limit(1);
      return rows.length > 0;
    },
  };
}

type SettingsRow = typeof accountSettings.$inferSelect;

/**
 * The cutline's three answers — the one PK row this pass starts from once it has a consent. A
 * caller that already read that row for the same drain hands it over, so the pass costs the drain
 * no extra statement (the local engine's idle-drain ratchet counts it).
 */
export interface ScreenerAutoActSettings {
  screeningBaselineAt: SettingsRow["screeningBaselineAt"];
  dormancyDays: SettingsRow["dormancyDays"];
  screeningScope: SettingsRow["screeningScope"];
  /** The act's consent column off the same row; NULL ⇒ the pass reads nothing more. */
  screenerAutoActAt: SettingsRow["screenerAutoActAt"];
}

export interface ScreenerAutoActResult {
  /** False ⇒ the consent is not given; nothing past it was read. */
  ran: boolean;
  /** Waiting senders considered. */
  examined: number;
  /** Senders filed by this pass. */
  filed: number;
  /** Senders left waiting — no advice, below the bar, or a destination a decision may not file to. */
  kept: number;
  /**
   * Senders whose apply REFUSED. They stay in the Screener with their suggestion and their Apply
   * button, which is the recoverable state: nothing is claimed to have happened, and the person's
   * own press still works. The class is logged per sender.
   */
  failed: number;
  /** Destination → how many senders went there. */
  destinations: Record<string, number>;
  /** True ⇒ the page came back full, so more may be waiting; the next cycle takes them. */
  capped: boolean;
  /** True ⇒ the consent was withdrawn part-way through; the rest was NOT filed. */
  revoked: boolean;
  /** Senders left waiting because this account wrote to them — counted inside {@link kept}. */
  correspondents: number;
  /**
   * Senders left waiting because a held message of theirs claims a brand its address does not own
   * (`messages.sender_check`, mail 0147) while the advice would let them through — counted inside
   * {@link kept}. A denying plan still files.
   */
  identity: number;
}

const EMPTY = (): ScreenerAutoActResult => ({
  ran: false, examined: 0, filed: 0, kept: 0, failed: 0, destinations: {}, capped: false,
  revoked: false, correspondents: 0, identity: 0,
});

/** A waiting sender and the decision their stored advice amounts to. */
interface ActPlan {
  address: string;
  appliedFolder: Destination;
  decision: "yes" | "no";
  /** The message the advice was bought about — the learning signal's dedup key. */
  messageId: string;
  /** The stored suggestion row — where a refusal is recorded, and cleared. */
  suggestionId: string;
  /** Whether that row already carries a refusal, so a filing clears it. */
  refused: boolean;
}

/**
 * THE ONE PREDICATE, read off the SAME functions the manual door validates with. A destination
 * outside `DECIDABLE_FOLDERS` (an invention, or `ohmail/Screener` itself) is refused rather than
 * coerced, and the yes/no side is `effectForDestination`, never a second table — so the act cannot
 * file where a press could not. `null` ⇒ leave this sender waiting.
 */
export function plannedDecision(
  address: string,
  advice: {
    id: string; messageId: string; destination: string; confidence: number | null;
    actRefusal?: string | null;
  } | undefined,
  bars: { deny: number; admit: number },
): ActPlan | null {
  if (!advice) return null;
  const folder = canonicalDestination(advice.destination);
  if (!DECIDABLE_FOLDERS.has(folder)) return null;
  const admits = effectForDestination(folder as Destination) === "allow";
  const confidence = advice.confidence;
  if (confidence == null || !Number.isFinite(confidence)) return null;
  if (confidence < (admits ? bars.admit : bars.deny)) return null;
  return {
    address,
    appliedFolder: folder as Destination,
    decision: admits ? "yes" : "no",
    messageId: advice.messageId,
    suggestionId: advice.id,
    refused: advice.actRefusal != null,
  };
}

/**
 * THE PASS, for ONE account. A no-op without {@link ScreenerAutoActDeps.consent}; otherwise one page
 * of waiting senders, their stored advice, and a decision per sender through the shared door.
 *
 * Store-neutral by construction: every statement goes through the dialect seam, because this runs
 * in the Cloud worker AND in the local engine (`apps/sidecar`), which is where a standalone
 * desktop's and a standalone phone's Screener lives.
 */
export async function screenerAutoActPass(
  db: Tx, deps: ScreenerAutoActDeps, nowArg?: Date,
): Promise<ScreenerAutoActResult> {
  const log = deps.log ?? silentLogger;
  const now = (): Date => nowArg ?? deps.now?.() ?? new Date();
  const limit = deps.sendersPerCycle ?? SCREENER_ACT_SENDERS_PER_CYCLE;
  const bars = {
    deny: deps.denyBar ?? SCREENER_ACT_DENY_BAR,
    admit: deps.admitBar ?? SCREENER_ACT_ADMIT_BAR,
  };
  const accountId = deps.accountId;

  // THE CONSENT, before any other read, so no column set for another reason stands in for it.
  // Off in the row a caller handed over costs no statement; otherwise one.
  const consent = deps.consent;
  if (!consent) return EMPTY();
  if (deps.settings && deps.settings.screenerAutoActAt == null) return EMPTY();
  if (!(await consent.stillGiven(db))) return EMPTY();

  // The cutline's three answers — the suggest pass's own shape. A sender the cutline has retired
  // is not a question, so acting on advice about them would file mail no surface was asking about.
  const [settings] = deps.settings ? [deps.settings] : await db.select({
    screeningBaselineAt: accountSettings.screeningBaselineAt,
    dormancyDays: accountSettings.dormancyDays,
    screeningScope: accountSettings.screeningScope,
  }).from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);

  const cutline = resolveCutline({
    baselineAt: settings?.screeningBaselineAt ?? null,
    dormancyDays: settings?.dormancyDays ?? null,
    scope: settings?.screeningScope ?? null,
    now: now(),
  });
  const waiting = await selectWaitingSenders(db, { accountId, limit, cutline });
  const result: ScreenerAutoActResult = { ...EMPTY(), ran: true, examined: waiting.length };
  if (waiting.length === 0) return result;
  result.capped = waiting.length === limit;

  // The ONE read path for stored advice, the one the Screener surface itself reads through:
  // newest-per-sender, decided in the database rather than in a loop here.
  const advice = await screenerSuggestionsBySender(db, accountId, waiting.map((w) => w.address));
  /* THE CORRESPONDENT GATE, ABOVE THE BARS: the model's 1.0 does not outrank the person having
     written to them. A sender this account wrote to is never filed by this pass, whatever the
     advice says or how sure it is; the Screener's retro admits them instead. One read per page. */
  const correspondents = await correspondentsAmong(db, {
    accountId, senders: waiting.map((w) => w.address), references: "held",
  });
  const unchecked = await uncheckedClaims(db, accountId, waiting.map((w) => w.address));

  let planned = 0;
  for (const sender of waiting) {
    if (correspondents.has(sender.address)) {
      result.kept++;
      result.correspondents++;
      continue;
    }
    const plan = plannedDecision(sender.address, advice.get(sender.address), bars);
    if (!plan) { result.kept++; continue; }
    /* THE IDENTITY FACT, ABOVE THE BARS: advice bought on a benign message never lets through a
       sender whose other held mail claims a brand from an address the brand does not own. The
       act gains a refusal here and never a filing; the person's own press still decides. */
    if ((sender.identityHeld || unchecked.has(sender.address)) && plan.decision === "yes") {
      result.kept++;
      result.identity++;
      continue;
    }
    if (planned++ > 0 && deps.until?.()) { result.capped = true; break; }

    // Could a decision land on the mailbox this sender waits in — the shared question the suggest
    // pass asks before it spends — AND is THIS install the organizer? Both, because the second is
    // the half `applyScreenerDecision` actually writes under: acting as a READER would promote an
    // account-wide rule while the holder's own pass promotes another for the same sender.
    const eligibility = await readRequestEligibility(
      db, accountId, sender.mailboxId, capabilityForKind("screener.decide"),
    );
    if (!decisionCanBeApplied(eligibility) || eligibility!.role !== "organizer") {
      result.kept++; continue;
    }

    try {
      // THE FENCE FIRST, then the settings row: the account's erasure takes `accounts` and then
      // `account_settings`, so a pass holding the settings row while it waits on the fence inside
      // the decision is a deadlock the erasure can lose (AUTO-ACT-TAKES-SETTINGS-BEFORE-THE-FENCE).
      const applied = await fencedAccountWrite(db, { accountId }, async (tx) => {
        // THE REVOKE CHECK, PER SENDER UNDER THE ACCOUNT'S SETTINGS ROW LOCK, `screener-auto.ts`'s
        // shape: a consent withdrawn mid-page leaves the rest waiting. The lock also serializes a
        // cycle tail against a failover driver.
        await dialect(tx).forUpdate(
          tx.select({ accountId: accountSettings.accountId }).from(accountSettings)
            .where(eq(accountSettings.accountId, accountId)).limit(1),
        );
        if (!(await consent.stillGiven(tx))) return null;
        const applied = await applyScreenerDecision(tx, {
          accountId, scope: "sender", address: plan.address,
          appliedFolder: plan.appliedFolder, decision: plan.decision,
          triggeringActionId: `${SCREENER_ACT_TRIGGER_PREFIX}${plan.messageId}`,
          now: now(),
          // NOT A PRESS, so it does not move an account-wide cutoff — the drain's reading of
          // `ApplyScreenerDecisionInput.stampBaseline`, for the same reason.
          stampBaseline: false,
          // The press's own default: the promoted rule reaches this sender's mail that already
          // left the gate. One decision, one meaning, whoever carried it.
          applyRetro: true,
          // A pass never writes over a sender who has a rule, enabled or paused: a rule written
          // after the page was read keeps deciding, as the selection's decided-sender filter would
          // have had it, and a paused one is the person's or the demotion's word. Nor does it lift
          // over their domain rule — that lift is a person's answer about one address.
          overExisting: "skip",
          liftOverDomain: false,
          // NOT A PRESS: a filing this pass makes never licenses an unsubscribe.
          decidedBy: "pass",
        });
        if (plan.refused && applied.skipped === undefined) await clearActRefusal(tx, accountId, plan.suggestionId, now());
        return applied;
      });
      if (applied === null) {
        result.revoked = true;
        log.info("screener_auto_act_revoked", {
          accountId, examined: result.examined, applied: result.filed,
          reason: "the consent was withdrawn during this page; the remaining senders were not filed",
        });
        break;
      }
      // A sender who has a rule under their key is not this pass's: nothing was written or filed.
      if (applied.skipped === "ruled") { result.kept++; continue; }
      // The door's own refusal of a marked sender — the belt under the selection's flag above.
      if (applied.skipped === "identity") { result.kept++; result.identity++; continue; }
      result.filed++;
      result.destinations[plan.appliedFolder] = (result.destinations[plan.appliedFolder] ?? 0) + 1;
    } catch (err) {
      /* AN ERASED ACCOUNT IS ONE FACT ABOUT THE ACCOUNT, not a failure per sender: the fence refused
         before anything was written, and there is no suggestion row left to record a refusal on. */
      if (err instanceof AccountErasedError) {
        log.info("screener_auto_act_account_erased", {
          accountId, code: "account_erased", examined: result.examined, applied: result.filed,
          reason: "the account was erased during this page, so nothing more is filed or recorded",
        });
        break;
      }
      // The sender stays waiting with their Apply button. Named by class so an operator can tell a
      // demoted organizer from a removed mailbox from a store fault.
      result.failed++;
      log.error("screener_auto_act_failed", {
        // `err` is a logger-owned slot and the class is derived there; a thrown STRING loses its
        // payload at every such site, so that one value is carried in `code` as well.
        accountId, err,
        ...(typeof err === "string" ? { code: err.slice(0, 64) } : {}),
        reason: "this sender was not filed and stays in the Screener carrying the same suggestion, "
          + "so the person's own Apply still files them and the next cycle tries again",
      });
      await recordActRefusal(db, accountId, plan.suggestionId, actRefusalOf(err), now(), log);
    }
  }

  if (result.correspondents > 0) {
    log.info("screener_auto_act_correspondent", {
      accountId, skipped: result.correspondents,
      reason: "these senders were not filed: this account wrote to them, and no suggestion "
        + "outranks that however confident it is",
    });
  }
  if (result.identity > 0) {
    log.info("screener_auto_act_identity_kept", {
      accountId, skipped: result.identity,
      reason: "these senders were not let through: a held message names a company their address "
        + "does not belong to, and only a person's press admits that",
    });
  }
  // FIELD NAMES THE HARDENED LOGGER KEEPS, asked of it rather than guessed: `filed`, `kept` and
  // `destinations` are dropped by `ALLOWED_FIELDS`, and a counter the sink drops is a line that
  // says nothing. The destinations live in the rules the act promoted, which is a durable record.
  if (result.filed > 0 || result.failed > 0) {
    log.info("screener_auto_act", {
      accountId, examined: result.examined, applied: result.filed,
      failed: result.failed, capped: result.capped,
    });
  }
  return result;
}

/** The closed reason a refused act is recorded under; anything unnamed is a store fault. */
export function actRefusalOf(err: unknown): ScreenerActRefusal {
  if (err instanceof AccountErasedError) return "account_erased";
  if (err instanceof OrganizedElsewhereError) return "not_organizer";
  if (err instanceof MailboxErasedError || err instanceof MailboxNotFoundError) return "mailbox_removed";
  return "store_fault";
}

/**
 * THE REFUSAL, ON THE SUGGESTION ROW THE ACT READ — its own short, fenced transaction, riding the
 * narrow `screener_suggestion` entity so every surface can say the act failed. A failed write is
 * logged and never replaces the act's own error; the sender still carries its Apply either way.
 */
async function recordActRefusal(
  db: Tx, accountId: string, suggestionId: string, refusal: ScreenerActRefusal, at: Date, log: Logger,
): Promise<void> {
  try {
    await fencedAccountWrite(db, { accountId }, async (tx) => {
      const rows = await tx.update(routingDecisions)
        .set({ actRefusedAt: at, actRefusal: refusal, updatedAt: at })
        .where(and(
          eq(routingDecisions.id, suggestionId),
          eq(routingDecisions.accountId, accountId),
          eq(routingDecisions.inputProvenance, SCREENER_SUGGESTION_PROVENANCE),
        ))
        .returning({ id: routingDecisions.id });
      if (rows.length === 0) return;
      await recordChanges(tx as unknown as LedgerTx, [{
        accountId, entityType: "screener_suggestion" as const, entityId: suggestionId, op: "update" as const,
      }]);
    });
  } catch (err) {
    log.error("screener_auto_act_refusal_unrecorded", {
      accountId, err,
      reason: "the refused act could not be recorded on its suggestion, so the Screener says nothing "
        + "about it; the sender still carries the suggestion and its Apply",
    });
  }
}

/** A filing clears the refusal a previous attempt left, inside the filing's own transaction. */
async function clearActRefusal(tx: Tx, accountId: string, suggestionId: string, at: Date): Promise<void> {
  const rows = await tx.update(routingDecisions)
    .set({ actRefusedAt: null, actRefusal: null, updatedAt: at })
    .where(and(
      eq(routingDecisions.id, suggestionId),
      eq(routingDecisions.accountId, accountId),
      isNotNull(routingDecisions.actRefusal),
    ))
    .returning({ id: routingDecisions.id });
  if (rows.length === 0) return;
  await recordChanges(tx as unknown as LedgerTx, [{
    accountId, entityType: "screener_suggestion" as const, entityId: suggestionId, op: "update" as const,
  }]);
}

/**
 * THE PAGE'S SENDERS WHOSE HELD MAIL THE CHECK NEVER REACHED (a NULL column, older than mail 0147)
 * and whose name or subject claims a brand: the fact function answers for the column there, as it
 * does for every other reader (`identityOfRow`), so the act does not read "unchecked" as "nothing
 * found" before the backfill reaches the row. One read per page, three short columns per row.
 */
async function uncheckedClaims(db: Tx, accountId: string, senders: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (senders.length === 0) return out;
  const rows = await db.select({
    fromName: messages.fromName, fromAddress: messages.fromAddress, subject: messages.subject,
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(
      eq(messages.accountId, accountId),
      eq(folderState.desiredFolder, SCREENER_FOLDER),
      isNull(messages.deletedAt),
      isNull(messages.senderCheck),
      inArray(sql`lower(${messages.fromAddress})`, [...senders]),
    ));
  for (const r of rows) {
    if (identityOfRow({ ...r, senderCheck: null, senderCheckBrand: null }) !== null) out.add(r.fromAddress.toLowerCase());
  }
  return out;
}

interface WaitingSender {
  address: string;
  mailboxId: string;
  /** A non-deleted held message of this sender carries `sender_check = 'impersonation'`. */
  identityHeld: boolean;
}

/**
 * THE WAITING SENDERS, one representative each — `screener-auto-suggest.ts#selectCandidates`'s
 * window and ordering, so the act walks the queue the surface shows in the order it shows it.
 * The differences from that pass, each deliberate: NO watermark (advice that already exists is
 * owed an act whenever the consent was given) and no advice predicate here — the advice is
 * read per sender through its one read path. The sensitivity exclusion is kept: an automatic act
 * takes the stricter reading of both columns.
 */
async function selectWaitingSenders(
  db: Tx, opts: { accountId: string; limit: number; cutline: ResolvedCutline },
): Promise<WaitingSender[]> {
  const d = dialect(db);
  const sender = sql`lower(${messages.fromAddress})`;
  // The queue's own sort key (`heldSortKey`): the act walks the order the surface shows.
  const sortKey = heldSortKey(d, { date: sql`${messages.date}`, arrivedAt: sql`${messages.createdAt}` });

  const reps = db.select({
    messageId: messages.id,
    mailboxId: messages.mailboxId,
    fromAddress: messages.fromAddress,
    noAi: messages.noAi,
    sensitivityCategory: messages.sensitivityCategory,
    createdAt: messages.createdAt,
    rank: sql<number>`row_number() over (
      partition by ${sender} order by ${sortKey} desc, ${messages.id} desc
    )`.as("rank"),
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(
      eq(messages.accountId, opts.accountId),
      eq(folderState.desiredFolder, SCREENER_FOLDER),
      // The apply door reads its bag with this filter, so a sender whose only held mail is a
      // tombstone is not decidable by a press and must not be decidable by the act either — the
      // rule would be promoted over an empty re-route.
      isNull(messages.deletedAt),
    ))
    .as("reps");

  const rows = await db.select({
    mailboxId: reps.mailboxId,
    fromAddress: reps.fromAddress,
    // ANY held message of the sender, not the representative: advice is bought on one message, and
    // the newest may be the benign one (mail 0147).
    identityHeld: sql<boolean | number>`exists (
      select 1 from ${messages} im
        join ${folderState} ifs on ifs.message_id = im.id
       where im.account_id = ${opts.accountId}
         and lower(im.from_address) = lower(${reps.fromAddress})
         and ifs.desired_folder = ${SCREENER_FOLDER}
         and im.deleted_at is null
         and im.sender_check = 'impersonation'
    )`,
  }).from(reps)
    .where(and(
      eq(reps.rank, 1),
      eq(reps.noAi, false),
      isNull(reps.sensitivityCategory),
      senderIsActiveSql(d, opts.accountId, sql`lower(${reps.fromAddress})`, opts.cutline),
      sql`not ${senderIsDecidedSql(d, opts.accountId, sql`lower(${reps.fromAddress})`)}`,
    ))
    .orderBy(asc(reps.createdAt), asc(reps.messageId))
    .limit(opts.limit);

  return rows.map((r) => ({
    address: r.fromAddress.toLowerCase(), mailboxId: r.mailboxId,
    // Both stores' spellings of true: a pg boolean, a sqlite integer.
    identityHeld: r.identityHeld === true || r.identityHeld === 1,
  }));
}

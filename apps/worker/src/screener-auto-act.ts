import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { carryDialect, dialect } from "@trafficflow/db/dialect";
import {
  accountSettings, folderState, messages,
  applyScreenerDecision,
  screenerSuggestionsBySender, resolveCutline, senderIsActiveSql, senderIsDecidedSql,
  decisionCanBeApplied, readRequestEligibility,
  DECIDABLE_FOLDERS, SCREENER_FOLDER,
  type ResolvedCutline, type Tx,
} from "@trafficflow/db";
import { capabilityForKind } from "@trafficflow/core/adapters/organizer-lease";
import {
  canonicalDestination, effectForDestination, silentLogger,
  type Destination, type Logger,
} from "@trafficflow/core/mail";

/* SCREENER AUTO-ACT — "Act on suggestions for me": file the waiting senders whose stored advice is
 * confident, through the door a PRESS uses. It reads advice and never buys it (no model, no spend,
 * no claim), and files through `applyScreenerDecision` — the manual Apply's and the reader drain's
 * one implementation — so the promoted rule the person undoes from the rules list, the held-bag
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
}

export interface ScreenerAutoActResult {
  /** False ⇒ the account has NOT opted in; nothing was read past the one-row probe. */
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
  /** True ⇒ the account switched the setting OFF part-way through; the rest was NOT filed. */
  revoked: boolean;
}

const EMPTY = (): ScreenerAutoActResult => ({
  ran: false, examined: 0, filed: 0, kept: 0, failed: 0, destinations: {}, capped: false,
  revoked: false,
});

/** A waiting sender and the decision their stored advice amounts to. */
interface ActPlan {
  address: string;
  appliedFolder: Destination;
  decision: "yes" | "no";
  /** The message the advice was bought about — the learning signal's dedup key. */
  messageId: string;
}

/**
 * THE ONE PREDICATE, read off the SAME functions the manual door validates with. A destination
 * outside `DECIDABLE_FOLDERS` (an invention, or `ohmail/Screener` itself) is refused rather than
 * coerced, and the yes/no side is `effectForDestination`, never a second table — so the act cannot
 * file where a press could not. `null` ⇒ leave this sender waiting.
 */
export function plannedDecision(
  address: string,
  advice: { messageId: string; destination: string; confidence: number | null } | undefined,
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
  };
}

/**
 * THE PASS, for ONE account. A no-op for every account that has not opted in; otherwise one page of
 * waiting senders, their stored advice, and a decision per sender through the shared door.
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

  // THE OPT-IN PROBE — one PK read, and the whole cost of this pass for every account that has not
  // turned the setting on. `screener_auto_apply_at IS NOT NULL` IS the opt-in, the same column and
  // the same reading as `screener-auto.ts` and `getScreeningPreference`.
  const [settings] = await db.select({
    autoApplyAt: accountSettings.screenerAutoApplyAt,
    // The cutline's three answers, on the PK read the opt-in probe already makes — the suggest
    // pass's own shape. A sender the cutline has retired is not a question, so acting on advice
    // about them would file mail no surface was asking about.
    screeningBaselineAt: accountSettings.screeningBaselineAt,
    dormancyDays: accountSettings.dormancyDays,
    screeningScope: accountSettings.screeningScope,
  }).from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
  if (!settings?.autoApplyAt) return EMPTY();

  const cutline = resolveCutline({
    baselineAt: settings.screeningBaselineAt ?? null,
    dormancyDays: settings.dormancyDays ?? null,
    scope: settings.screeningScope ?? null,
    now: now(),
  });
  const waiting = await selectWaitingSenders(db, { accountId, limit, cutline });
  const result: ScreenerAutoActResult = { ...EMPTY(), ran: true, examined: waiting.length };
  if (waiting.length === 0) return result;
  result.capped = waiting.length === limit;

  // The ONE read path for stored advice, the one the Screener surface itself reads through:
  // newest-per-sender, decided in the database rather than in a loop here.
  const advice = await screenerSuggestionsBySender(db, accountId, waiting.map((w) => w.address));

  for (const sender of waiting) {
    const plan = plannedDecision(sender.address, advice.get(sender.address), bars);
    if (!plan) { result.kept++; continue; }

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
      const applied = await db.transaction(async (txRaw) => {
        const tx = carryDialect(db, txRaw as object) as typeof txRaw;
        // THE REVOKE CHECK, RE-READ AND LOCKED PER SENDER, `screener-auto.ts`'s shape: the probe
        // above runs once, and an account that switches the setting off mid-page must not have the
        // rest filed anyway. The lock also serializes a cycle tail against a failover driver.
        const live = await dialect(tx).forUpdate(
          tx.select({ autoApplyAt: accountSettings.screenerAutoApplyAt }).from(accountSettings)
            .where(eq(accountSettings.accountId, accountId)).limit(1),
        );
        if (!live[0]?.autoApplyAt) return null;
        return applyScreenerDecision(tx, {
          accountId, scope: "sender", address: plan.address,
          appliedFolder: plan.appliedFolder, decision: plan.decision,
          triggeringActionId: `screener:auto:${plan.messageId}`,
          now: now(),
          // NOT A PRESS, so it does not move an account-wide cutoff — the drain's reading of
          // `ApplyScreenerDecisionInput.stampBaseline`, for the same reason.
          stampBaseline: false,
          // The press's own default: the promoted rule reaches this sender's mail that already
          // left the gate. One decision, one meaning, whoever carried it.
          applyRetro: true,
        });
      });
      if (applied === null) {
        result.revoked = true;
        log.info("screener_auto_act_revoked", {
          accountId, examined: result.examined, applied: result.filed,
          reason: "the setting was switched off during this page; the remaining senders were not filed",
        });
        break;
      }
      result.filed++;
      result.destinations[plan.appliedFolder] = (result.destinations[plan.appliedFolder] ?? 0) + 1;
    } catch (err) {
      // The sender stays waiting with their Apply button. Named by class so an operator can tell an
      // erased account from a demoted organizer from a store fault.
      result.failed++;
      log.error("screener_auto_act_failed", {
        // `err` is a logger-owned slot and the class is derived there; a thrown STRING loses its
        // payload at every such site, so that one value is carried in `code` as well.
        accountId, err,
        ...(typeof err === "string" ? { code: err.slice(0, 64) } : {}),
        reason: "this sender was not filed and stays in the Screener carrying the same suggestion, "
          + "so the person's own Apply still files them and the next cycle tries again",
      });
    }
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

interface WaitingSender {
  address: string;
  mailboxId: string;
}

/**
 * THE WAITING SENDERS, one representative each — `screener-auto-suggest.ts#selectCandidates`'s
 * window and ordering, so the act walks the queue the surface shows in the order it shows it.
 * The differences from that pass, each deliberate: NO watermark (advice that already exists is
 * owed an act whenever the setting was turned on) and no advice predicate here — the advice is
 * read per sender through its one read path. The sensitivity exclusion is kept: an automatic act
 * takes the stricter reading of both columns.
 */
async function selectWaitingSenders(
  db: Tx, opts: { accountId: string; limit: number; cutline: ResolvedCutline },
): Promise<WaitingSender[]> {
  const d = dialect(db);
  const sender = sql`lower(${messages.fromAddress})`;
  const sortKey = d.truncMs(sql`coalesce(${messages.date}, ${d.ts(new Date(0))})`) as SQL<Date>;

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

  return rows.map((r) => ({ address: r.fromAddress.toLowerCase(), mailboxId: r.mailboxId }));
}

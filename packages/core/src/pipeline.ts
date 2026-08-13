import { countRealFiles, normalizeMime } from "./mime.js";
import { prepareHtmlForStorage } from "./html-storage.js";
import {
  fingerprintDedupKey, legacyDedupKey, messageFingerprint, verifiesLegacyIdentity,
} from "./identity.js";
import { classifySensitivity, type SensitivityResult } from "./sensitive.js";
import {
  NO_TRUSTED_AUTHSERV_IDS, DEFAULT_OHBOX_POLICY, authVerdictFromHeaders, dsnVerdict,
  effectForDestination, evaluateRules, type AuthVerdict, type OhboxPolicy,
} from "./rules.js";
import { classifyDedup, type DedupOutcome } from "./dedup.js";
import { reconcile, type ReconcileAction } from "./reconciler.js";
import { resolveThread } from "./threading.js";
// The ROOT barrel, not `/cloud`: this module runs inside the desktop engine, and `/cloud` is
// billing, the credit ledger, the staff handle and the whole hosted schema. `classifyLedgerSource`
// is a pure template over its two arguments and lives on a leaf both halves can name.
import { classifyLedgerSource } from "@trafficflow/db";
import type {
  Change, CreditGate, MoveEvidence, PipelineDeps, RepoPort, RoutingPort, FolderStateRow,
  NativeLocator, StoredMessage,
} from "./ports.js";
import type { ClassifierPort, ClassifierResult } from "./classifier-port.js";
import type { NormalizedMessage } from "./types.js";

/** Confidence a graduated pattern must meet before the AI branch auto-applies. */
export const AUTO_APPLY_CONFIDENCE_BAR = 0.7;

/**
 * The UIDVALIDITY half of a `NativeLocator.ref` (`${uidvalidity}:${uid}`).
 *
 * Hand-rolled rather than imported from `adapters/imap.ts#parseRef`: this module is the model layer
 * and must not pull the IMAP adapter — and with it `imapflow` — into its import graph. The format is
 * declared on {@link NativeLocator} and is the model's own, not the adapter's.
 */
const epochOfRef = (ref: string): string => ref.split(":")[0] ?? "0";

export interface ApplyContext {
  messageId: string;
  locator: NativeLocator;   // the message's current native location
  state: FolderStateRow;    // the folder state as of the reconcile decision
}

/**
 * The "Organization Writer": perform the port writes for a computed reconcile
 * action. Idempotent — `none` re-asserts convergence, and re-running `move`
 * after a crash simply re-issues the (idempotent) adapter move.
 *
 * This is the OUTSIDE-transaction move path: the worker's
 * reconcile runner calls it after the short persist transaction has committed,
 * so the IMAP `adapter.move` network call never sits inside the seq/change_log tx.
 */
export async function applyReconcileAction(
  deps: PipelineDeps,
  ctx: ApplyContext,
  action: ReconcileAction,
): Promise<{ locator: NativeLocator; state: FolderStateRow }> {
  const { repo, adapter, accountId } = deps;
  const { messageId, locator, state } = ctx;

  switch (action.type) {
    case "none": {
      const next: FolderStateRow = {
        desiredFolder: state.desiredFolder,
        observedFolder: state.desiredFolder,
        lastSetBy: state.lastSetBy,
      };
      await repo.upsertFolderState(messageId, next);
      return { locator, state: next };
    }
    case "move": {
      const newLocator = await adapter.move(locator, action.to);
      await repo.updateLocator(messageId, newLocator);
      const next: FolderStateRow = {
        desiredFolder: action.to,
        observedFolder: action.to,
        lastSetBy: "us",
      };
      await repo.upsertFolderState(messageId, next);
      await repo.recordAudit(
        accountId,
        "move",
        { messageId, from: locator.folder, to: action.to },
        { messageId, from: action.to, to: locator.folder },
      );
      return { locator: newLocator, state: next };
    }
    case "adopt_external": {
      const next: FolderStateRow = {
        desiredFolder: action.newDesired,
        observedFolder: action.newDesired,
        lastSetBy: "external",
      };
      await repo.upsertFolderState(messageId, next);
      await repo.recordAudit(
        accountId,
        "adopt_external",
        { messageId, adopted: action.newDesired, previousDesired: state.desiredFolder },
        { messageId, revertTo: state.desiredFolder },
      );
      return { locator, state: next };
    }
  }

  const _exhaustive: never = action;
  throw new Error(`unreachable reconcile action: ${JSON.stringify(_exhaustive)}`);
}

export interface ProcessResult {
  outcome: DedupOutcome["kind"];
  messageId: string;
  action: ReconcileAction;
}

// ── The two-phase, transaction-safe write path ──

export interface AiPlan {
  result: ClassifierResult;
  patternKey: string;          // "sender:<from>→<destination>"
  graduated: boolean;
  autoApplied: boolean;        // graduated && confidence >= bar
}

export interface NewPlan {
  normalized: NormalizedMessage;
  dedupKey: string;
  sensitivity: SensitivityResult;
  arrivalLocator: NativeLocator;
  desired: string;
  snippet: string;
  /**
   * The `\Seen` flag the SERVER reported for this message, carried from `Change.seen`.
   *
   * It used to be dropped here, and dropping it is how "everything is New" happened: the
   * `messages.unread` column defaults to `true`, `new_for_you` is exactly `unread = true`, so
   * the first sync of a real mailbox presented years of already-read mail as unread. The
   * mailbox is the master — its answer to "has this been read" is the one we take.
   */
  seen: boolean;
  /**
   * What this message's OWN PROVIDER said about its claimed author, as
   * {@link authVerdictFromHeaders} read it — persisted to `messages.auth_verdict` by
   * {@link commitChange}.
   *
   * REQUIRED, and computed exactly once per ingest, for the reason {@link AuthVerdict} gives
   * for the evaluator's field being required: a default would let a later edit select a branch
   * without naming it in a diff. It is carried on the plan rather than recomputed at commit so
   * the value that DECIDED the routing is the value that lands on the row — recomputing under a
   * trusted set that had changed between the two phases would store a verdict that never
   * routed anything.
   */
  authVerdict: AuthVerdict;
  /**
   * THIS ARRIVAL IS IN A FOLDER THE CUSTOMER MADE — carried from {@link Change.passive}.
   *
   * It decides ONE thing at commit, and it is the third of the three structural gates listed on
   * `imap-types.ts#PASSIVE_EXCLUDED_SPECIAL_USE`: the `folder_state` row is written
   * `last_set_by: 'external'` instead of `'us'`.
   *
   * That is not a cosmetic label. `'external'` is defined as *"a placement the USER made in their own
   * mail client"*, which is exactly what an archive folder is, and **every pass that moves mail
   * requires `'us'`** — `reconcileFolders` skips a non-`'us'` row outright, and `rule-retro`,
   * `ohbox-tidy`, `screener-auto` and `read-retro` all carry `eq(folderState.lastSetBy, "us")` in
   * their candidate predicates. So a passive row is out of every mover's reach by DATA, not only by
   * the early return in `planChange` that put it there. Two independent gates, either sufficient.
   */
  passive?: boolean;
  ai?: AiPlan;
}

export interface ExistingPlan {
  kind: "duplicate" | "own_move" | "external_move";
  messageId: string;
  arrivalLocator: NativeLocator;
  /**
   * WHERE THE STORED ROW SAYS THIS MESSAGE IS — `messages.native_locator`, as it was read.
   *
   * REQUIRED, because the one thing it decides cannot be decided without it: whether the arrival is
   * the SAME physical message re-observed or a SECOND copy sitting beside it. See the
   * `secondCopyInSameEpoch` block in {@link commitChange} for the oscillation that answering "same"
   * unconditionally produced on a real mailbox, and why an optional field with a
   * fall-back-to-repoint default would have preserved it silently.
   */
  storedLocator: NativeLocator;
  /**
   * The arrival was read out of the mailbox's own SENT folder — {@link Change.ownAuthored}, carried.
   *
   * It gates exactly one thing, and the reason is about ENUMERATION rather than about authorship: see
   * the `secondCopyInSameEpoch` block in {@link commitChange}. Sent is the one folder read from a UID
   * WATERMARK instead of end to end, and a delete below that watermark is deliberately never reported
   * (`imap.ts`, `enumFloorUid`) — so a second instance recorded there could outlive its primary with
   * nothing left to promote it. Sent is also, for the same reason, the one folder where the
   * re-download loop cannot arise: the watermark is its floor, not the known-set.
   */
  ownAuthored: boolean;
  state: FolderStateRow;
  action: ReconcileAction;
  /**
   * THE SOURCE COPY WHOSE EXPUNGE IS STILL OWED, WHEN NOTHING PROVED IT WENT AWAY.
   *
   * Present only for an `own_move` reached on `appearance_only` evidence — our move's destination
   * copy showed up while the source was never observed to disappear. That is the COPY-succeeded /
   * EXPUNGE-failed split: `imap.ts#move` is probe → pre-check → COPY → verify → expunge on a server
   * without RFC 6851 MOVE, those are separate network operations, and no isolation level can join
   * them because the split is across the IMAP boundary.
   *
   * **This locator STAYS the primary instance, and that is the point of the field.** The obvious
   * move is to repoint at the copy and call the move done, and it is wrong twice over: it declares
   * a completion nothing witnessed, and it strands the surviving source, because the only thing
   * that ever expunges it is a retry of the very move being marked complete. So the primary stays
   * here, the destination copy is recorded as a SECOND instance — known, therefore never
   * re-downloaded — and `folder_state` is left pending. The next reconcile pass then calls
   * `move(source, desired)` again, and the adapter's destination pre-check recognises the copy it
   * already made, writes nothing, and expunges this locator. That is the only sequence that
   * converges on exactly one surviving message.
   *
   * It is safe to keep reading through this locator in the meantime: the message is still there —
   * a failed expunge is precisely why — and it is byte-identical to the copy, so on-demand
   * attachment fetches and reply quoting see what they always saw.
   *
   * **Absent for the two adoptable evidence shapes, and that is the whole discrimination.** A
   * `correlated_move` (the adapter paired a vanished UID with a re-appeared one) and a
   * `verified_absence` (the primary instance is gone, written by `sync.ts` from `batch.deletes`)
   * are both genuine completions: the source really did disappear, so there is no second copy,
   * nothing to record, and the move converges normally. `ports.ts#MoveEvidence` states the rule
   * this implements — "completion is source absence".
   */
  unexpungedSource?: NativeLocator;
}

/**
 * The Sent twin of mail we already store — see {@link classifyDedup}'s `own_copy`.
 *
 * It carries the message id and where it was seen and NOTHING else, because nothing else is
 * needed: the commit path writes no row for it. A fabricated `state`/`action` pair on
 * {@link ExistingPlan} would have compiled and would have implied a reconcile decision this
 * plan does not make.
 */
export interface OwnCopyPlan {
  messageId: string;
  arrivalLocator: NativeLocator;
}

/**
 * A SECOND PHYSICAL INSTANCE of a message we already hold, with no evidence that the user put it
 * there — see {@link classifyDedup}'s `external_copy`.
 *
 * It carries `state` only so the conflict flag has a row to sit on when the message has no
 * `folder_state` yet. It carries no `action`, deliberately: this plan makes NO reconcile decision,
 * and a fabricated one would have compiled and would have implied a placement change.
 */
export interface ExternalCopyPlan {
  messageId: string;
  arrivalLocator: NativeLocator;
  state: FolderStateRow;
}

/**
 * A verified legacy row whose `dedup_key` is to be rewritten in the commit transaction.
 *
 * Step 2 of the dual-key lookup found this row under `mid:`/`body:` and
 * `verifiesLegacyIdentity` agreed it is the same logical message. Rewriting the key is what makes
 * the migration MONOTONE — `dedup_key NOT LIKE 'fp1:%'` only ever decreases — and it is why there
 * is no backfill job and no version column.
 */
export interface DedupKeyUpgrade {
  messageId: string;
  from: string;
  to: string;
}

export interface ChangePlan {
  outcome: DedupOutcome["kind"];
  new?: NewPlan;
  existing?: ExistingPlan;
  /** Present iff `outcome === "own_copy"`. Records one instance and nothing else. */
  ownCopy?: OwnCopyPlan;
  /** Present iff `outcome === "external_copy"`. Records one instance and sets `conflict`. */
  externalCopy?: ExternalCopyPlan;
  /** Present when the message was reached through the legacy key and verified. */
  upgrade?: DedupKeyUpgrade;
}

export interface PlanDeps {
  repo: RepoPort;
  accountId: string;
  mailboxId: string;
  classifier?: ClassifierPort;
  routing?: RoutingPort;
  /** The AI spend gate. Absent ⇒ unmetered; see {@link CreditGate}. */
  credits?: CreditGate;
  /**
   * The authserv-ids the ACCOUNT'S OWN provider signs `Authentication-Results` with, lowercased.
   *
   * ── WHY CONFIGURATION AND NOT A `mailboxes` COLUMN ──────────────────────────────────────
   *
   * It is a statement about WHOM THIS DEPLOYMENT BELIEVES, not about the user's mailbox. The
   * value is a property of the provider on the other end of the IMAP connection (`mx.google.com`
   * for Gmail, `hotmail.com` for Outlook), it is set by whoever operates the host, and a user
   * must not be able to name their own trusted position — that would let a sender-controlled
   * `Authentication-Results` be believed, which is precisely what `authVerdictFromHeaders`'s
   * authserv-id scan exists to refuse. A column would put it one `UPDATE` away from the
   * account. `packages/api/src/routes/shared.ts#unsubscribes` already states the same thing for
   * `UnsubscribeDeps.trustedAuthservIds`, the one pre-existing consumer, and a SECOND home for
   * one decision is how two paths come to disagree about the same message.
   *
   * So there is no migration 0032 and no `/health` marker move: this is injected, exactly like
   * the classifier, the credit gate and the routing port beside it.
   *
   * ── HOW PRODUCTION POPULATES IT ─────────────────────────────────────────────────────────
   *
   * `authserv-ids.ts#providerAuthservIds(<the IMAP host the connection dials>)` — the static
   * provider table (Gmail, Microsoft), resolved where the adapter is built and threaded here.
   * Every seam that builds sync deps REQUIRES the field (`SyncDeps.trustedAuthservIds`), because
   * for this input the absent default is the dangerous branch: this field sat optional-and-empty
   * at all five production sites, and the demote-only branch below protected nothing.
   *
   * ── ABSENT IS STILL A FIRST-CLASS STATE HERE ────────────────────────────────────────────
   *
   * Absent ⇒ {@link NO_TRUSTED_AUTHSERV_IDS} ⇒ `"unavailable"` for every message ⇒ byte-identical
   * routing to the `auth: "unauthenticated"` literal this replaced — which is also what an
   * unknown provider's mailbox resolves to. It stays optional HERE (and required one level up)
   * because a plan with no trust decision must route like the day-one engine: see
   * {@link AuthVerdict} on the large backlog.
   */
  trustedAuthservIds?: ReadonlySet<string>;
  /**
   * The account's Ohbox posture, resolved per-account from `account_settings.ohbox_policy` by the
   * worker. Injected configuration, exactly like `trustedAuthservIds` above — it is a property of
   * how THIS account has asked its mail to be organised, resolved once per cycle, and threaded here
   * rather than read inside the engine.
   *
   * Absent ⇒ {@link DEFAULT_OHBOX_POLICY} (`people_and_replied`) ⇒ the demotion branch never fires
   * ⇒ byte-identical routing to the pre-slice engine. NULL `ohbox_policy` resolves the same way, so
   * shipping this demotes no existing account until it opts in. This is the required day-one
   * behaviour, on the same discipline as `trustedAuthservIds`, and {@link evaluateRules} takes the
   * resolved value as REQUIRED so no call site can forget it.
   */
  ohboxPolicy?: OhboxPolicy;
  /**
   * The account's plain-language Ohbox bar, resolved from `account_settings.ohbox_bar`. It reaches
   * the classifier's USER turn only (never the cached taxonomy prefix — a per-account string in the
   * shared prefix would poison the cache). It changes what the model PROPOSES on the unclear
   * residue; it never itself moves a message. Absent ⇒ omitted from the payload.
   */
  ohboxBar?: string;
  /**
   * THE SCREENING CUTOFF — mail that arrived before this instant keeps its arrival folder instead
   * of being held at the gate. ABSENT ⇒ no cutoff ⇒ byte-identical routing to before mail 0056.
   *
   * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
   *
   * The router has no notion of age. `evaluateRules` answers `ohmail/Screener` for ANY sender with
   * no rule, and this function applies it, so every message from an unruled sender is physically
   * moved to the Screener folder whatever its date. On a fresh mailbox that is exactly right — it
   * IS the consent gate. On a backfill it is not: a pass reaching further into the mailbox delivers
   * years-old mail from senders the reader has long since stopped hearing from, and each one is
   * moved to the gate and queued for a decision nobody is going to make. On a mailbox with years of
   * history that is not a trickle: the backfill walks newest-first, so after the first pass
   * essentially everything it delivers predates the window, and the gate files all of it — one
   * physical IMAP move per message, into a queue the reader is expected to empty by hand.
   *
   * ── WHAT THE CUTOFF DOES, AND THE THREE THINGS IT MUST NOT ────────────────────────────────
   *
   * Only `source === "screener"` verdicts are subordinated — the gate's own fall-through for a
   * sender nobody has ruled on. Specifically NOT:
   *
   *  · `source === "rule"`. A rule is the USER's decision and outranks everything here, in both
   *    directions: an old message from a sender they screened OUT still goes to Screened, and an
   *    old message from a sender they admitted still goes to the Ohbox. Subordinating a rule
   *    verdict would let a date decide something a person already decided.
   *  · the auth-fail demotion, which also produces `source === "screener"` — and this is the one
   *    place the source test is not sufficient on its own. That branch fires on a message whose
   *    `Authentication-Results` FAILED, which is a statement about the message and not about the
   *    sender being unknown, so it is checked separately below and never subordinated.
   *  · sensitivity and the corroborated-bounce arm, both of which resolve BEFORE this and both of
   *    which promote INTO the Ohbox. Nothing here re-demotes them.
   *
   * The message keeps `change.locator.folder` — where the mail server already had it. Not the
   * Ohbox, not a heuristic destination: the whole claim is "leave the backlog alone", and picking
   * a folder for it would be a placement nobody asked for. On the ordinary path that is the INBOX
   * for INBOX mail and the user's own folder for filed mail.
   *
   * ── HOW THE AGE IS MEASURED ───────────────────────────────────────────────────────────────
   *
   * `change.internalDate` — the server's own receive clock — and NOTHING else. ABSENT ⇒ NOT old
   * ⇒ the gate's verdict stands: a message whose receive time the server did not vouch for is
   * unknown, not ancient, and the safe answer for an unknown is the consent gate. The parsed
   * `Date:` header used to be the fallback, and a security review flagged it — the header
   * is written by the SENDER, so on an INTERNALDATE-less server it let a backdated `Date:` keep
   * a stranger's fresh delivery in the INBOX. The header still orders and displays
   * (`messages.date`); it has no say here. See {@link Change.internalDate}.
   *
   * ── WHY A RESOLVED INSTANT AND NOT `{ baselineAt, dormancyDays }` ─────────────────────────
   *
   * The same discipline as `trustedAuthservIds` and `ohboxPolicy` above: the account's settings
   * are resolved ONCE per cycle by the worker (`index.ts#screeningFor`) and threaded in. Passing
   * the two components would put the arithmetic — and therefore a second chance to get it wrong —
   * inside the engine, where it would drift from the cutline's copy. ABSENT is the only state that
   * means "no cutoff", and it is what a NULL `screening_baseline_at`, a settings read that failed,
   * and every existing caller and test all produce.
   */
  screeningCutoff?: Date;
}

export interface CommitDeps {
  repo: RepoPort;
  accountId: string;
  mailboxId: string;
  routing?: RoutingPort;
}

/**
 * THE DUAL-KEY LOOKUP — how the key format changes with **no backfill**.
 *
 * Backfilling fingerprints is prohibited outright, and the reason is worth keeping next to
 * the code that exists because of it: a batch job would compute a DIFFERENT value than ingest
 * does. `message_bodies.text` is redacted for sensitive mail, `html` has been through
 * `prepareHtmlForStorage` and a 256 KiB cap, `attachments` had no content digest before this
 * change, and `messages.to_addresses` — written at ingest only since the recipients slice — holds
 * its `'[]'` default on every row that predates it. So every backfilled row would carry a key
 * that ingest cannot reproduce, and the first re-observation of that mail would insert a SECOND
 * `messages` row — which no delta removes, and which mints a second `threads` row too
 * because `commitChange`'s re-entry guard is `stored.threadId` and a new row has none.
 *
 * So the migration happens at READ time, one message at a time, on the path that has the raw
 * bytes:
 *
 *  1. `fp1:<fingerprint>` — a hit is the same logical message, done.
 *  2. the legacy `mid:`/`body:` key — a hit is a CANDIDATE and nothing more. It is VERIFIED
 *     against four stored columns (`identity.ts#verifiesLegacyIdentity`) and, only if all four
 *     agree, accepted and its key rewritten to `fp1:` in the commit transaction.
 *  3. for an `ownAuthored` create only: the same mailbox's row under this Message-ID — the
 *     own-sent twin arm, written out at its own comment below.
 *  4. none of these — a new message.
 *
 * **Any mismatch in step 2 ⇒ NEW message. Never a partial collapse.** That is what makes the
 * fallback safe rather than a re-introduction of the very defect the new key fixes: the legacy key
 * is forgeable (the Message-ID is chosen by the sender) and the verification tuple is what refuses
 * the forgery — `body_hash` kills the body-only collision, `subject` + `from_address` kill the message-id forgery.
 *
 * The cost is one extra indexed `SELECT` per genuinely-new message, and none at all once a
 * mailbox has been fully re-observed.
 */
async function resolveExisting(
  repo: RepoPort, accountId: string, mailboxId: string, normalized: NormalizedMessage,
  ownAuthored: boolean,
): Promise<{ key: string; existing: StoredMessage | null; upgrade?: DedupKeyUpgrade }> {
  const fpKey = fingerprintDedupKey(messageFingerprint(normalized));
  const onFingerprint = await repo.findByDedupKey(mailboxId, fpKey);
  if (onFingerprint) return { key: fpKey, existing: onFingerprint };

  const legacyKey = legacyDedupKey(normalized.canonical);
  const candidate = await repo.findByDedupKey(mailboxId, legacyKey);
  if (candidate && verifiesLegacyIdentity(candidate, normalized)) {
    return {
      key: legacyKey,
      existing: candidate,
      upgrade: { messageId: candidate.id, from: legacyKey, to: fpKey },
    };
  }

  //  3. THE OWN-SENT TWIN — by Message-ID alone, and ONLY for an `ownAuthored` create.
  //
  // Exchange Online files its own re-rendered copy of every SMTP submission into the Sent folder
  // beside the byte-exact copy the send path APPENDs: new `Received:` chain, re-encoded MIME,
  // re-wrapped body. Different bytes ⇒ a different fingerprint ⇒ both lookups above miss, and the
  // twin used to ingest as a SECOND `messages` row — the user's just-sent message, twice in its
  // own conversation. The same rewrite breaks the self-CC twin (`own_copy`) whenever the inbound
  // and Sent copies were rendered by different transports.
  //
  // Message-ID alone is exactly the forgeable key the fingerprint replaced, and it stays banned
  // for inbound mail: this arm is gated on `Change.ownAuthored`, which the ADAPTER stamps only on
  // pure creates read out of the mailbox's own Sent folder (`ports.ts#Change.ownAuthored`) — a
  // folder strangers cannot write into. Within that gate, matching the id is matching the user's
  // own submission against the user's own submission; classifyDedup then answers `duplicate`
  // (same folder) or `own_copy` (twin of a row elsewhere), and neither writes a placement.
  //
  // The key returned is still `fpKey`: it names THESE bytes, and no row is written under it on
  // the non-`new` outcomes this arm produces. NO `upgrade` rides along, deliberately — rewriting
  // the stored row's key to this observation's fingerprint would repoint the row's identity at
  // whichever copy was seen last, and the stored key still names the copy the row was born from.
  if (ownAuthored && normalized.canonical.messageIdHeader !== null) {
    const twin = await repo.findByMessageIdHeader(accountId, mailboxId, normalized.canonical.messageIdHeader);
    if (twin) return { key: fpKey, existing: twin };
  }

  // Either nothing was stored under the legacy key, or a row was and it is NOT this message. Both
  // are "new", and both are stored under the NEW key — so a forged `mid:` gets its own row rather
  // than joining somebody else's.
  return { key: fpKey, existing: null };
}

/** A short preview of the body for the DTO snippet + the classifier input. */
function bodySnippet(normalized: NormalizedMessage): string {
  // The FULL text, always — the snippet is the list preview the user reads, and body redaction is
  // removed. It is also the classifier input, but a sensitive/indeterminate message never reaches
  // the classifier (the AI condition below opens with `!no_ai`) and the model boundary re-screens
  // with `redactForModel` regardless, so a full snippet here never carries a code to a model.
  return normalized.textBody.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** A tiny, sensitivity-safe digest of routing-relevant headers (never the body). */
function headersDigest(normalized: NormalizedMessage): string {
  const h = normalized.headers;
  const bits: string[] = [];
  if (h["list-unsubscribe"]) bits.push("list-unsubscribe");
  if (h["precedence"]?.some((v) => /bulk/i.test(v))) bits.push("precedence:bulk");
  if (h["auto-submitted"]) bits.push("auto-submitted");
  // This bit reaches the AI router: `headersDigest` is a field of `ai/classify.ts#ClassifyInput`
  // and is forwarded into the model params. `hasAttachments` now counts only DOWNLOADABLE parts,
  // so an inline-only newsletter no longer contributes `"attachments"` here. That is the intended
  // consequence and it is an improvement — "this message carries a file" is a routing signal,
  // "this newsletter has a logo in it" is noise that was claiming to be one. Nothing is persisted:
  // the digest is recomputed from the parse on every ingest, so no stored verdict changes meaning.
  if (normalized.hasAttachments) bits.push("attachments");
  return bits.join(",");
}

/**
 * PHASE 1 — reads + (optional) classifier network call, NO writes and NO transaction.
 * Runs BEFORE the worker opens the persist transaction so the
 * IMAP reads and the Anthropic classify call never sit inside the seq/change_log tx.
 *
 * With no `classifier`/`routing` injected the routing decision is byte-identical to
 * the pre-AI baseline (sensitive → INBOX, else rule destination, else leave in place).
 */
export async function planChange(change: Change, deps: PlanDeps): Promise<ChangePlan> {
  if (!change.raw) {
    throw new Error("planChange requires change.raw (a content-bearing 'create')");
  }
  const { repo, accountId, mailboxId, classifier, routing, credits } = deps;
  const trustedAuthservIds = deps.trustedAuthservIds ?? NO_TRUSTED_AUTHSERV_IDS;
  // Resolve the posture ONCE here, at the outermost dep, exactly like `trustedAuthservIds`: NULL /
  // absent config ⇒ the lenient default ⇒ the demotion branch never fires. `evaluateRules` takes
  // the resolved value as REQUIRED so no call site is silently on the wrong side of it.
  const ohboxPolicy: OhboxPolicy = deps.ohboxPolicy ?? DEFAULT_OHBOX_POLICY;

  const normalized = await normalizeMime(change.raw);
  const { key, existing, upgrade } =
    await resolveExisting(repo, accountId, mailboxId, normalized, change.ownAuthored === true);

  // Correlate against any outstanding move we issued for this message.
  const pendingMoveFolders = new Set<string>();
  if (existing) {
    const fs = await repo.getFolderState(existing.id);
    if (fs && fs.lastSetBy === "us" && fs.desiredFolder !== fs.observedFolder) {
      pendingMoveFolders.add(fs.desiredFolder);
    }
  }

  // ── THE EVIDENCE, DERIVED ONCE, FROM THE ONLY TWO THINGS THAT CAN WITNESS A DISAPPEARANCE ──
  //
  // See {@link MoveEvidence}. A sender can make a locator APPEAR; only the user can make a stored
  // locator DISAPPEAR. So:
  //
  //  · `change.type === "move"` is the adapter's `correlateMoves` having paired a vanished known
  //    UID with a re-appeared one. It was already being computed and `classifyDedup` never read it
  //    — this line is that gap closed.
  //  · a vanished PRIMARY instance is the other half, and it is what keeps this from breaking
  //    user-always-wins in the opposite direction: a real user move that `correlateMoves` cannot
  //    pair (no Message-ID at all, or a delete and a create in different batches) still adopts.
  //    The absence is recorded by `apps/worker/src/sync.ts` from the adapter's `deletes`, and only
  //    when the folder's epoch matches — on a UIDVALIDITY change all evidence is void.
  //
  // The read is skipped entirely for a correlated move and for a message we have never seen: one
  // indexed EXISTS per re-observation of a known message, and none at all on the hot path.
  let evidence: MoveEvidence = { kind: "appearance_only" };
  if (change.type === "move") {
    evidence = { kind: "correlated_move" };
  } else if (existing && await repo.primaryInstanceVanished(existing.id)) {
    evidence = { kind: "verified_absence" };
  }

  const outcome = classifyDedup({ change, dedupKey: key, existing, pendingMoveFolders, evidence });

  if (outcome.kind === "new") {
    const sensitivity = classifySensitivity(normalized);
    const arrivalLocator = change.locator;

    // ── THE PROVIDER'S OWN REPORT ABOUT THE CLAIMED AUTHOR, READ ONCE, HERE ────────────────────
    //
    // This line is the whole point: the parser is invoked ON THE PATH THAT ROUTES.
    // It used to be a `"unauthenticated"` literal at the `evaluateRules` call below, which meant
    // a forged `From` naming a sender the account already allows was promoted normally even when
    // the provider's own `Authentication-Results` said `dkim=fail` — the demote-only branch
    // existed and protected nothing.
    //
    // ── THE ASYMMETRY, RESTATED WHERE IT CAN BE BROKEN ────────────────────────────────────
    //
    // `evaluateRules` reads exactly one member of the returned union — `"fail"` — and only ever
    // to send a message DOWN to the Screener. There is no `auth !== "pass"` anywhere and there
    // must never be one: `rules.ts#AuthVerdict` records that gating the known-sender match on a
    // positive verdict answers Screener for every row of a large backlog. **Reading
    // this value may DEMOTE. It may never be REQUIRED before an identity the user has already
    // consented to is honoured.**
    //
    // With `trustedAuthservIds` empty — the default, and the state of every deployment on the
    // day this shipped — this returns `"unavailable"` on its first line for every message, which
    // routes identically to the literal it replaced. So this change is observable only once a
    // host names a position it believes.
    //
    // ── ABOVE THE `ownAuthored` RETURN, DELIBERATELY ──────────────────────────────────────
    //
    // Both {@link NewPlan} constructions need it, because the column is a record of what the
    // provider said and the user's own Sent mail has an answer too. The cost objection that
    // keeps `listRules`/`knownSenders` below that return does not apply: this is a pure header
    // read with no round trip, and it returns on its first line when the set is empty.
    //
    // `normalized.headers` and not `change.raw`: the map `mime.ts` built is the same map
    // `message_bodies.headers` stores, so the re-evaluation passes that read the row back from
    // disk (`kickstart.ts`, `sensitive-rescreen.ts`) parse the SAME input and cannot disagree
    // with this decision by reading a different source.
    const authVerdict = authVerdictFromHeaders(
      normalized.headers, normalized.from.address, trustedAuthservIds,
    );

    // ── MAIL THE USER WROTE LEAVES THE PIPELINE HERE ───────────────────────────────────────
    //
    // `Change.ownAuthored` means the adapter read this out of the mailbox's own Sent folder.
    // Everything below this block is written for INBOUND mail and gives the wrong answer for
    // outbound mail — not a slightly worse answer, an actively destructive one:
    //
    //  · **The Screener.** `evaluateRules` files any message whose FROM is not a known contact
    //    into `ohmail/Screener`. On sent mail the FROM is the account owner, who is not in
    //    their own `contacts` — so every message the user has ever written would be moved out
    //    of their Sent folder and queued for consent. The consent gate exists to decide whether
    //    a STRANGER may reach the user; a message the user typed has nothing to consent to.
    //  · **Reads / Receipts.** The header heuristic keys on `Precedence: bulk` and
    //    `List-Unsubscribe`, which a reply to a newsletter carries by quotation and by some
    //    clients' habit of echoing headers. Filing your reply under newsletters is wrong, and
    //    it is a MOVE inside the customer's real mailbox.
    //  · **The sensitive short-circuit.** Below, `sensitivity.sensitive` forces `INBOX`. Doing
    //    that here would lift a message out of Sent and drop it in the user's inbox because
    //    they once forwarded a login code. Redaction still applies — `classifySensitivity` ran
    //    above this line and the commit path stores the redacted body — only the
    //    ROUTING override is skipped.
    //  · **The money gate.** With `desired` already decided there is no `unclear` residue, so
    //    the AI branch cannot fire and `credits.tryDebit` is unreachable. That is a property of
    //    this early return, not of a condition further down: a message the user wrote must not
    //    cost them an AI action, and re-reading their own Sent backlog must not bill anyone.
    //    Move this return below the AI block and the sent-mail test's throwing gate,
    //    which stands in for the classifier, fires twice.
    //
    // It is above the `listRules` / `knownSenders` reads deliberately: two database round trips
    // per sent message whose result is discarded is not free at a couple of thousand messages of backlog.
    //
    // `desired === arrival` is the whole organize-in-place statement for outbound mail: the
    // reconciler computes `none`, `folder_state` lands `reconciled` (`reconcileStatusFor`), and
    // the worker never issues an IMAP move. ohmail does not file your Sent folder for you.
    //
    // `seen: true` regardless of what the server reported. Nothing the user wrote is new to
    // them, and a client that appends to Sent without `\Seen` (some do) would otherwise put
    // the user's own outbox into the unread count.
    if (change.ownAuthored) {
      return {
        outcome: "new",
        new: {
          normalized,
          dedupKey: key,
          sensitivity,
          arrivalLocator,
          desired: arrivalLocator.folder,
          snippet: bodySnippet(normalized),
          seen: true,
          // Recorded, and routing-inert by construction: this branch reaches no `evaluateRules`
          // call at all, so the user's own Sent mail cannot be demoted by its own provider's
          // report no matter what that report says.
          authVerdict,
        },
      };
    }

    // ── MAIL THE CUSTOMER FILED THEMSELVES LEAVES THE PIPELINE HERE TOO ────────────────────
    //
    // `Change.passive` means the adapter read this out of a folder the CUSTOMER made — `Archive`,
    // `Private/Editor`, `_archive/Clients/…`. See `imap-types.ts#passiveFolderExclusion` for
    // which folders those are and which are held out.
    //
    // The reasoning is the `ownAuthored` block above, with one word changed: everything below is
    // written for mail ohmail is asked to ORGANIZE, and this mail has already been organized, by
    // the person whose mailbox it is.
    //
    //  · **The Screener.** `evaluateRules` files any message whose FROM is not a known contact into
    //    `ohmail/Screener`. Applied to a folder somebody spent fifteen years filing, that is a bulk
    //    MOVE of their archive into a consent queue — and the consent question is already answered:
    //    they kept the mail and gave it a name.
    //  · **Reads / Receipts.** A newsletter the customer deliberately archived under `News` would be
    //    lifted out of `News` and filed under ohmail's own newsletter folder. Their filing is theirs.
    //  · **The sensitive short-circuit.** Below, `sensitivity.sensitive` forces `INBOX`. An eight
    //    year old password reset filed under `Private/Family` would surface in today's Ohbox.
    //  · **The money gate.** With `desired` already decided there is no `unclear` residue, so the AI
    //    branch cannot fire and `credits.tryDebit` is unreachable. Backfilling a customer's archive
    //    must not spend one AI action — an archive is the largest thing in a mailbox and reading it
    //    for the first time would otherwise be the largest bill the account ever saw.
    //
    // ABOVE the `listRules` / `knownSenders` reads, on the same cost argument: two database round
    // trips per archived message whose result is discarded is not free at six thousand of them.
    //
    // `seen` is the SERVER's flag here, unlike the `ownAuthored` branch which forces true. Nothing
    // the user wrote is new to them; mail they filed away may well be unread, and claiming otherwise
    // would silently mark a whole archive read in their other mail clients on the first reconcile.
    //
    // `desired === arrival` is the whole never-reorganized statement: `reconcile` computes `none`,
    // `folder_state` lands `reconciled`, and no IMAP move is ever issued. `commitChange` writes the
    // row `last_set_by: 'external'` — see {@link NewPlan.passive} — which is what keeps every retro
    // pass out as well, since all of them require `'us'`.
    if (change.passive) {
      return {
        outcome: "new",
        new: {
          normalized,
          dedupKey: key,
          sensitivity,
          arrivalLocator,
          desired: arrivalLocator.folder,
          snippet: bodySnippet(normalized),
          seen: change.seen ?? false,
          authVerdict,
          passive: true,
        },
      };
    }

    const rules = await repo.listRules(accountId);
    const known = await repo.knownSenders(accountId);
    const decision = evaluateRules({
      msg: normalized, rules, knownSenders: known, auth: authVerdict, ohboxPolicy,
    });

    // ── SENSITIVITY REFINES PLACEMENT. IT NEVER ESTABLISHES CONSENT. ────────────────────────
    //
    // This line used to read `sensitivity.sensitive ? "INBOX" : …`, and that ternary is the
    // SAME defect a review found one file over. `rules.ts#headerHeuristic` carries the
    // rule in its own header — a signal the SENDER chooses may refine where consented mail
    // lands, and may never carry a stranger past the gate — and `classifySensitivity` is
    // exactly such a signal: it reads the subject and body, both of which the sender writes.
    // So `Subject: your verification code` was a remote, unauthenticated, one-message defeat of
    // the consent boundary, needing no knowledge of the user's contacts and no action by them.
    //
    // This is not a corner case, and the shape is worth stating because it is what makes the
    // subordination below load-bearing rather than tidy: on a mailbox with few `contacts` rows,
    // sensitivity promoted enough mail to dominate the Ohbox — most of it OTP, security,
    // verification and password-reset mail from senders nobody had consented to, which is
    // precisely the mail the Screener exists to hold.
    //
    // The subordination is expressed through `effectForDestination` rather than by testing for
    // `source === "screener"`, and that difference is the second half of the finding: a
    // `deny` verdict also covers an explicit user rule sending a sender to `ohmail/Screened` or
    // `ohmail/Quarantine`. Under the old ternary a QUARANTINED sender was freed by writing an
    // OTP-shaped body — the user's own explicit "no", overridden by the spammer. `deny` is
    // already modelled (`rules.ts#RuleEffect`) precisely so consent questions are not re-derived
    // from folder names at the point of use.
    //
    // What is deliberately UNCHANGED: an `allow` destination and the `unclear` residue both
    // still yield INBOX for sensitive mail, so a code from a sender the user already knows still
    // goes straight to them and never sits behind the gate. And NOTHING here touches the
    // sensitive-mail guarantees — `no_ai`, no-forward, no-KB and the redacted body are properties of
    // `p.sensitivity`, applied at persist below, and are independent of the folder.
    // ── A BOUNCE OF THE READER'S OWN MAIL IS ACTIONABLE, AND ONLY IF IT IS THEIRS ─────────
    //
    // `rules.ts#dsnVerdict` answers the pure half — is this DSN-shaped, and what does it claim
    // about the original — and refuses to answer the half that decides, because that half is a
    // lookup against OUR data and shape alone is a string a stranger types. Read that docblock
    // before touching anything here: the whole design is that a delivery report reaches the
    // Ohbox on evidence the sender cannot manufacture, and never on the report looking right.
    //
    // Two corroborations, either of which is enough, and both of which are facts about this
    // account rather than about the message:
    //
    //  · the report quotes a Message-ID this account HOLDS. `findThreadParent` is the existing
    //    account-scoped probe over `messages_account_message_id_header_idx` (mail 0026) — the
    //    same index, the same isolation argument, and no new column or migration. Backscatter
    //    quotes the spammer's Message-ID, which we have never held, so it misses;
    //  · `X-Failed-Recipients` names somebody this account already corresponds with. `known` is
    //    already in hand two lines above, so this costs nothing, and the point is that it is
    //    OUR contact list: a stranger can write any address into that header and cannot make it
    //    be one of the reader's correspondents.
    //
    // Neither ⇒ nothing happens here at all and the message takes the ordinary path, which for
    // an unknown daemon is the Screener. Not deleted, not quarantined — held, like any other
    // first-contact sender, one press from being admitted.
    //
    // ── IT MAY PASS THE GATE, AND IT MAY NOT OVERRULE THE USER — WHICH ARE DIFFERENT TESTS ──
    //
    // This is the one place the bounce arm differs from `sensitive`, and getting it wrong in
    // either direction is a real defect, so both are written out.
    //
    // `sensitive` is subordinate to `deniedByConsent`, which covers all three deny folders and
    // therefore includes the GATE's own `ohmail/Screener`. That is exactly right there: nothing
    // about the shape of a stranger's mail may admit the stranger. Reusing it here would make
    // this whole arm dead code, because a bounce from an unknown daemon IS a first-contact
    // sender and the gate's verdict is precisely what has to be overridden.
    //
    // The distinction that does the work is WHO decided. A gate fall-through carries
    // `matchedRuleId === null`: the account has never said anything about this daemon, and the
    // corroboration above is a fact about our own data that answers the gate's question. A
    // decision carrying a rule id is the USER's, and it stands — a sender they screened out or
    // quarantined must not be able to free themselves by sending a well-formed report, even one
    // that quotes a Message-ID we really do hold. `deniedByConsent` stays as the second half of
    // the test so an unmatched deny (there is no such source today, and this is what keeps a
    // future one from being a bypass) also refuses.
    //
    // `await` only when the shape matched, so ordinary mail costs no extra round trip.
    // `change.raw` as well as the parsed form: the quoted original lives in a
    // `message/rfc822-headers` part, which the parser does not flatten into `textBody`.
    const dsn = dsnVerdict(normalized, change.raw);
    let ownBounce = false;
    if (dsn) {
      ownBounce =
        dsn.failedRecipients.some((a) => known.has(a)) ||
        (dsn.originalMessageIds.length > 0 &&
          (await repo.findThreadParent(accountId, dsn.originalMessageIds)) !== null);
    }

    const deniedByConsent =
      decision.destination !== null && effectForDestination(decision.destination) === "deny";
    /** A corroborated bounce the account has expressed no opinion about. */
    const admitBounce = ownBounce && decision.matchedRuleId === null
      && (!deniedByConsent || decision.source === "screener");

    /* ── THE GATE DOES NOT REACH BACK PAST THE SCREENING BASELINE ────────────────────────────
     *
     * See {@link PlanDeps.screeningCutoff} for the defect and the boundaries. Three conditions,
     * each of which is a refusal to over-reach, and the third is the one that is easy to get
     * wrong:
     *
     *  1. a cutoff was resolved at all. Absent ⇒ this whole block is inert and routing is
     *     byte-identical to before mail 0056, which is what every existing caller and test gets;
     *  2. the verdict is the GATE's own — `source === "screener"`. A `rule` verdict is the user's
     *     decision and is never subordinated, in either direction;
     *  3. the message did not FAIL authentication. `evaluateRules` returns the same `screener`
     *     verdict for two different reasons — "nobody has ruled on this sender" and "this
     *     message's `Authentication-Results` said fail" — and only the first is a backlog
     *     question. The second is a statement about THIS message that an old date must not
     *     excuse; without this term, `Date: 2019` plus a failed DKIM would be a way past the gate.
     *     Read off `authVerdict`, which is the input that branch is computed from, rather than
     *     re-derived from the decision — the decision cannot tell the two apart.
     *
     * The `\Seen` state is deliberately NOT consulted. Whether the backlog has been read is a fact
     * about the user's habits, not about whether ohmail should re-file it, and the unread half of
     * exactly that conflation is the churn the cutline half of this slice removes.
     *
     * THE SERVER CLOCK ONLY — `?? normalized.date` stood here, and a security review flagged
     * it. The header `Date:` is written by the SENDER, so with the fallback in place any
     * server that omits or mangles INTERNALDATE handed the gate's clock to the sender: a
     * freshly-delivered `Date: 2019` kept a stranger's mail in the INBOX with no rule, no
     * contact and no user action. The header still orders and displays (`messages.date`); it
     * never again says "backlog". No INTERNALDATE ⇒ `null` ⇒ NOT old ⇒ the gate — so on a
     * server that never supplies INTERNALDATE the backlog suppression simply never engages and
     * a backfill screens like fresh mail. That is fail-closed, and it is the accepted cost.
     */
    const arrivedAt = change.internalDate ?? null;
    const preBaselineBacklog = deps.screeningCutoff !== undefined
      && decision.source === "screener"
      && authVerdict !== "fail"
      && arrivedAt !== null
      && arrivedAt.getTime() < deps.screeningCutoff.getTime();

    let desired: string = (sensitivity.sensitive && !deniedByConsent) || admitBounce
      ? "INBOX"
      : preBaselineBacklog
        ? change.locator.folder
        : decision.destination ?? change.locator.folder;

    let ai: AiPlan | undefined;
    // The ledger identity of ONE classification of THIS mail. Computing it writes nothing —
    // only `tryDebit` below can move money — so it is safe to build before the gate runs.
    const creditSource = classifyLedgerSource(mailboxId, key);
    // AI GATE: classify only on the unclear residue, NEVER for
    // sensitive/no_ai mail, and only when the account may spend. The classifier is not even
    // constructed here for sensitive messages, so the raw secret never leaves the process.
    //
    // THE ORDER OF THIS CONDITION IS THE INVARIANT. `&&` short-circuits, so the money question
    // is asked LAST and a `no_ai` message can never reach `tryDebit` — which is why "a
    // sensitive message produces no metering row at all" is a property of the control flow
    // rather than of anyone remembering to check. Move `tryDebit` earlier in this chain and the
    // AI-metering ledger test fails.
    //
    // `credits` ABSENT means unmetered, not refused: the free desktop tier and every test that
    // predates the gate run this exact branch with no gate, and the plan they produce must be identical.
    if (
      !sensitivity.flags.no_ai &&
      classifier &&
      routing &&
      decision.destination == null &&
      // `{ mailboxId }` ONLY. This used to pass `dedupKey: key`, and `key` is
      // `mid:${messageIdHeader}`: the raw RFC822 Message-ID, chosen by the SENDING server,
      // carrying the sender's domain and — routinely, for ESPs — the recipient's address.
      // The metering ledger is APPEND-ONLY with no delete path, so every classification wrote a
      // correspondent into a table that cannot be rewritten, and closing the admin console's
      // render path did not remove one byte of it from disk or from backups.
      //
      // Nothing needed it. Debit identity is `creditSource`, which sha256s the key already
      // (`classifyLedgerSource`), so `meta.dedupKey` was redundant as well as unsafe — the same
      // finding as `mailboxes.error_detail`, one column over: the projection asked what TYPE the
      // value was and never asked WHO WROTE IT.
      (credits == null || await credits.tryDebit(creditSource, { mailboxId }))
    ) {
      let result: ClassifierResult;
      try {
        result = await classifier.classify({
          from: normalized.from,
          subject: normalized.subject,
          snippet: bodySnippet(normalized),
          headersDigest: headersDigest(normalized),
          fewShot: [],
          // The account's own words, into the USER turn only. Absent ⇒ omitted. It sharpens what
          // the model proposes on this unclear residue; it never itself moves the message.
          ohboxBar: deps.ohboxBar,
        });
      } catch (err) {
        // RETHROW, deliberately, and do NOT refund. Two separate decisions, and the second one
        // is a later correction to the first.
        //
        // The rethrow: this is a classifier FAULT, not an out-of-credits state. Degrading here
        // would file the message by rules and never look again, turning a transient model
        // outage into permanent mis-routing. Aborting leaves the message un-ingested and the
        // sync cursor unadvanced — the existing crash-safe behaviour — so `runSyncCycle`
        // re-plans this exact mail on its next pass.
        //
        // The absent refund: that retry is FREE, because `creditSource` is already on record
        // and the gate answers `duplicate → proceed` for an open attempt. The charge is
        // therefore honoured by the retry, and refunding as well would hand the work over for
        // nothing — a model outage would have re-classified the entire backlog free (the
        // giveaway the gate's "THE ATTEMPT, NOT THE SOURCE" note describes). Compensation here
        // is the retry, and it is guaranteed by construction rather than by a catch block.
        //
        // The call sites where the retry is NOT guaranteed — the drafting request path, whose
        // retry belongs to a human who may give up, and the proposal cron, whose next pass
        // falls in a new period bucket — do refund, and a refund there re-opens the work for a
        // fresh charge rather than making it free.
        throw err;
      }
      const patternKey = `sender:${normalized.from.address}→${result.destination}`;
      const graduated = await routing.isGraduated(accountId, patternKey, "route");
      const autoApplied = graduated && result.confidence >= AUTO_APPLY_CONFIDENCE_BAR;
      if (autoApplied) desired = result.destination;
      ai = { result, patternKey, graduated, autoApplied };
    }

    return {
      outcome: "new",
      new: {
        normalized,
        dedupKey: key,
        sensitivity,
        arrivalLocator,
        desired,
        snippet: bodySnippet(normalized),
        // `?? false` and not `?? true`: an adapter that cannot report flags (the fallback path
        // has no prior flags to diff against) must not be able to assert that mail IS read.
        // Unknown degrades to unread, which is the recoverable direction — a real \Seen arrives
        // as an inbound flag change and converges.
        seen: change.seen ?? false,
        // The SAME value `evaluateRules` was handed above. Carrying it rather than recomputing
        // at commit is what makes "the verdict on the row is the verdict that routed" a
        // property of the code and not of two call sites staying in step.
        authVerdict,
        ai,
      },
    };
  }

  // Existing message: never re-ingest. `upgrade` rides along on every one of these shapes — a
  // verified legacy row's key is rewritten whatever the outcome turns out to be.
  const existingMsg = outcome.existing;

  // The Sent twin of mail we already hold. No placement decision and no delta — see
  // `classifyDedup`'s `own_copy` note for the self-CC case this exists to stop. It DOES record its
  // physical instance now, which is what stops the locator being re-fetched every cycle on a
  // folder with no watermark.
  if (outcome.kind === "own_copy") {
    return {
      outcome: "own_copy",
      ownCopy: { messageId: existingMsg.id, arrivalLocator: change.locator },
      ...(upgrade ? { upgrade } : {}),
    };
  }

  const state: FolderStateRow =
    (await repo.getFolderState(existingMsg.id)) ?? {
      desiredFolder: change.locator.folder,
      observedFolder: change.locator.folder,
      lastSetBy: "us",
    };

  // ── A SECOND DELIVERY IS NOT A DECISION. IT NEVER REACHES `reconcile` ──────────────────────
  //
  // `external_copy` returns BEFORE the reconciler, and that is belt and braces on purpose:
  // `reconcile` already refuses to adopt without evidence, and this path has none, so it would
  // answer `move` — an attempt to drag the copy back to `desired_folder`, which is a network write
  // against a locator the user never asked us to touch. Returning here means the observable effect
  // of a forged delivery is exactly: one instance row, one `conflict` flag, nothing else.
  if (outcome.kind === "external_copy") {
    return {
      outcome: "external_copy",
      externalCopy: { messageId: existingMsg.id, arrivalLocator: change.locator, state },
      ...(upgrade ? { upgrade } : {}),
    };
  }

  // ── OUR MOVE'S COPY APPEARED. THAT IS NOT THE SAME AS OUR MOVE HAVING LANDED ────────────────
  //
  // `classifyDedup` answers `own_move` from `pendingMoveFolders` alone — from the FOLDER — and it
  // is right to: whatever else is true, an observation in the folder we have an outstanding move
  // to is our own doing and must never be re-ingested. What it cannot tell from the folder is
  // whether the SOURCE went, and `ports.ts#MoveEvidence` says why that is the only question that
  // settles completion: "our own pending-operation record ... says nothing about COMPLETION —
  // completion is source absence."
  //
  // So the two `own_move` shapes are separated here rather than in `classifyDedup`, which has no
  // locator to hand back:
  //
  //  · `correlated_move` / `verified_absence` — the source is gone. A real completion. Nothing to
  //    record, and this field stays absent.
  //  · `appearance_only` — a copy is at the destination and the source was never seen to leave.
  //    Both exist on the server right now, and `updateLocator` is about to point us at the copy.
  //
  // ── WHY THE MOVE IS KEPT PENDING RATHER THAN DECLARED COMPLETE ──────────────────────────────
  //
  // The copy is sitting in the folder we wanted it in, so a decision made from this one
  // observation says "done". It is not done: the source is still on the server, and the ONLY
  // thing that ever removes it is a retry of this very move. Converge here and the retry is never
  // queued, so the duplicate becomes permanent — bookkept, never repaired.
  //
  // This is safe to do now, and it was not before, because it depends entirely on the move being
  // IDEMPOTENT. `imap.ts#move` reads the destination before it writes: finding the copy it already
  // made, it writes nothing and goes straight to the expunge it still owes. Without that pre-check
  // a retry copies again — the destination gains an identical message every cycle, and the verify,
  // which requires exactly one fingerprint match, then finds several and refuses for ever. That is
  // why these two changes are one change, and why keeping this pending on its own would have been
  // strictly worse than the duplicate it was trying to fix.
  const unexpungedSource =
    outcome.kind === "own_move" && evidence.kind === "appearance_only"
      ? existingMsg.nativeLocator
      : undefined;

  // A withheld move keeps its INTENT. `reconcile` would answer `none` — from this observation
  // alone desired and observed agree — and that answer is exactly the premature completion above.
  // Re-asserting the pending `move` is what puts the retry, and with it the source expunge, back
  // into the reconcile pass's queue.
  const action: ReconcileAction = unexpungedSource
    ? { type: "move", to: state.desiredFolder }
    : reconcile(state, change.locator.folder, evidence);

  return {
    outcome: outcome.kind,
    existing: {
      kind: outcome.kind as ExistingPlan["kind"],
      messageId: existingMsg.id,
      arrivalLocator: change.locator,
      storedLocator: existingMsg.nativeLocator,
      ownAuthored: change.ownAuthored === true,
      state,
      action,
      ...(unexpungedSource ? { unexpungedSource } : {}),
    },
    ...(upgrade ? { upgrade } : {}),
  };
}

/**
 * PHASE 2 — persist the plan, NO network. Runs inside the
 * worker's short transaction with a tx-scoped repo (`makeDrizzleRepo(tx)`), so
 * every entity write and every `change_log` row (allocateSeq → insert) commit
 * atomically. The optimistic, client-visible `move` change is emitted here at
 * local-state commit; the physical IMAP move happens afterwards,
 * OUTSIDE this transaction, via the reconcile runner.
 */
export async function commitChange(plan: ChangePlan, deps: CommitDeps): Promise<ProcessResult> {
  const { repo, accountId, mailboxId, routing } = deps;

  // ── THE VERIFIED LEGACY KEY IS REWRITTEN FIRST, IN THIS TRANSACTION ────────────────────────
  //
  // Before anything else, so that whatever this commit does next it does to a row that is already
  // on the new key. That is what makes the migration monotone: `dedup_key NOT LIKE 'fp1:%'` only
  // ever decreases, and it never rises, because nothing writes a legacy key any more.
  if (plan.upgrade) {
    await repo.upgradeDedupKey(plan.upgrade.messageId, plan.upgrade.from, plan.upgrade.to);
  }

  // ── THE OUTCOME THAT CHANGES NO PLACEMENT ──────────────────────────────────────────────────
  //
  // A Sent observation of a message we already store. NOT `updateLocator`, above all: that call
  // is what would repoint the row at the Sent copy, vacate the INBOX UID from the folder's
  // known-set, and hand the next cycle a "new" INBOX message to re-fetch — on top of the
  // adoption that already removed it from the Imbox.
  //
  // It used to write NOTHING, and the reason it did not loop was the adapter's Sent UID watermark
  // and nothing else. That is an accident of one folder: `recordInstance` is what makes the
  // declined locator KNOWN, so the property now holds for any folder, watermark or not.
  if (plan.outcome === "own_copy") {
    const c = plan.ownCopy!;
    await repo.recordInstance(c.messageId, c.arrivalLocator);
    return { outcome: "own_copy", messageId: c.messageId, action: { type: "none" } };
  }

  // ── A SECOND DELIVERY OF A MESSAGE WE ALREADY HOLD ─────────────────────────────────────────
  //
  // The complete observable effect, and every omission below is deliberate:
  //
  //  · `recordInstance` — the copy's locator becomes KNOWN, so its body is never fetched again.
  //    Without it the same bytes are pulled from the server on every cycle for ever, because
  //    nothing else in the system remembers a locator we declined to make primary.
  //  · `setFolderConflict` — the record that two instances exist. It touches `desired_folder`,
  //    `observed_folder` and `last_set_by` NOT AT ALL.
  //  · NO `updateLocator`: the primary instance stays where the user's own decision left it.
  //  · NO `recordChange`: no client is told anything moved, because nothing did.
  //  · NO `recordAudit` `adopt_external`: nothing was adopted. The acceptance criterion for this
  //    behaviour is literally "no `adopt_external` audit row" after the forgery is run twice.
  if (plan.outcome === "external_copy") {
    const c = plan.externalCopy!;
    await repo.recordInstance(c.messageId, c.arrivalLocator);
    await repo.setFolderConflict(c.messageId, c.state);
    return { outcome: "external_copy", messageId: c.messageId, action: { type: "none" } };
  }

  if (plan.outcome === "new") {
    const p = plan.new!;
    const stored = await repo.insertMessage({
      accountId, mailboxId,
      canonical: p.normalized.canonical,
      dedupKey: p.dedupKey,
      subject: p.normalized.subject,
      fromAddress: p.normalized.from.address,
      // ── THE SENDER'S DISPLAY NAME, WHICH THIS LINE IS THE FIRST TO PERSIST ───────────────
      //
      // The same repair as the recipients below, one header up: `parseMessage` has produced
      // `from: { name, address }` since the parser was written, this function persisted only
      // `.address`, and `materialize.ts` hardcoded the other half (`from: { name: null, … }`) —
      // so every ingested message reached the reader as a bare address, and nothing failed,
      // because a name the sender never set and a name ingest dropped are the same `null` on
      // the wire. Same parse, not a second reading, on the recipients' argument verbatim.
      fromName: p.normalized.from.name,
      // ── THE RECIPIENTS, WHICH THIS LINE IS THE FIRST TO PERSIST ──────────────────────────
      //
      // `messages.to_addresses` / `cc_addresses` have existed since the mail schema landed and
      // `materialize.ts#messageRowToDTO` has always projected them, but no Cloud ingest ever wrote
      // them. Every Cloud-ingested message therefore reached the reader as `to: []` and rendered
      // no "To" line — and nothing failed, because an unwritten column and a message addressed to
      // nobody are the same `[]` on the wire. The values were right here in `p.normalized` the
      // whole time; `parseMessage` has populated them since the parser was written, and
      // `messageFingerprint` already consumes both.
      //
      // Same parse, not a second reading — which is what keeps the row and the fingerprint that
      // decides its identity from being able to disagree about who a message was sent to.
      to: p.normalized.to,
      cc: p.normalized.cc,
      date: p.normalized.date,
      nativeLocator: p.arrivalLocator,
      flags: p.sensitivity.flags,
      snippet: p.snippet,
      sensitivityCategory: p.sensitivity.category,
      // BOTH halves of the pair count DOWNLOADABLE parts, never `attachments.length`.
      // They have to move together: a DTO reading `hasAttachments: false, attachmentCount: 3`
      // is the same lie the flag alone was telling, one field over. `countRealFiles` is the
      // single definition and `mime.ts#isRealFile` argues it.
      hasAttachments: p.normalized.hasAttachments,
      attachmentCount: countRealFiles(p.normalized.attachments),
      // THE SERVER'S OWN READ-STATE, not the column default. See `NewPlan.seen`: without this
      // line the default `unread = true` wins and every message the user has ever read comes
      // back as "New" on the first sync of a real mailbox.
      unread: !p.seen,
      // ── THE VERDICT THAT ROUTED THIS MESSAGE, WRITTEN IN THE INGEST TRANSACTION ──────────
      //
      // `planChange` computed it once and `evaluateRules` already consumed it; this is the same
      // value, not a second reading. Persisting it here rather than leaving it to a later pass
      // is what stops the row and the routing from being able to disagree — a NULL column
      // resolves to `"unauthenticated"` (`rules.ts#AuthVerdict`), and a NULL on a message that
      // was in fact demoted would leave the reason for its demotion nowhere on disk.
      //
      // The column is `messages.auth_verdict`, added by mail 0028 and written by nothing on the
      // ingest path until this line — `unsubscribe-service.ts` writes it too, from the same
      // parser and the same stored headers, and an unsubscribe attempt is the only other writer.
      authVerdict: p.authVerdict,
    });

    // ── THE WINNER OWNS THE TAIL. A LOSER WRITES NOTHING (measured on real Postgres) ───────────
    //
    // `insertMessage` is an upsert, so two ingests that both planned `new` — two cycles observing
    // one message before either commits — BOTH arrive here, and the loser holds the WINNER'S row.
    // The `messages` row converges correctly, which is what `UNIQUE (mailbox_id, dedup_key)` is
    // for. Everything below this line did not, because the loser used to be unable to tell that it
    // had lost:
    //
    //  · `insertAttachments` has no conflict target and `attachments` has no natural key, so one
    //    attachment became TWO rows. Measured: `expected [ … ] to have a length of 1 but got 2`.
    //  · `recordChange` emitted a SECOND `message`/`create` delta for one id — a convergence
    //    break, the client told to create the same message twice, with no delta that
    //    removes either.
    //  · `upsertFolderState` overwrote the winner's row, and it writes `conflict` FALSE, silently
    //    erasing the stale-source record written at the bottom of this function.
    //
    // A `duplicate` outcome is the honest name for it: this observation added no message. Returning
    // here is also why no DDL was needed — the constraint that decides the winner already exists,
    // and this line stops throwing its verdict away.
    //
    // If the loser observed a DIFFERENT locator (the same mail delivered to two folders at once),
    // nothing is written here either: that locator is simply not yet recorded, so the next cycle
    // re-presents it and the ordinary `external_copy` path handles it with the evidence machinery
    // intact — which is the branch that knows how to record a second instance without adopting it.
    if (!stored.created) {
      return { outcome: "duplicate", messageId: stored.id, action: { type: "none" } };
    }

    // Attachment METADATA (never bytes) persists in the SAME transaction as the
    // message — atomic ingest, no orphan attachment without its message.
    await repo.insertAttachments(stored.id, accountId, p.normalized.attachments);

    // THE FULL ORIGINAL BODY, ALWAYS — text AND html, sensitive or not. Body redaction is removed:
    // the mailbox on the IMAP server (the master) already holds this mail unredacted, so storing a
    // redacted display copy only hid it from the one person entitled to read it, and it over-fired.
    // The disclosure gate to a MODEL is elsewhere and unchanged — `no_ai`/`no_kb` keep this mail out
    // of automatic AI, and `redactForModel` strips the credential from any user-pressed AI payload.
    //
    // `prepareHtmlForStorage` is the ONLY route html takes into the database — this is the sole
    // writer of `message_bodies.html` (`privacy-service.ts` flips `loadedRemoteContent` and
    // nothing else; `message-service.ts` only reads). It strips oversized inline base64 payloads
    // and enforces the 256 KiB cap that the `message_bodies_html_cap` CHECK constraint asserts.
    await repo.insertMessageBody(stored.id, {
      text: p.normalized.textBody,
      html: prepareHtmlForStorage(p.normalized.htmlBody),
      headers: p.normalized.headers,
    });

    // ── THREADING, HERE AND NOT ANYWHERE ELSE ──────────────────────────────────────────────
    //
    // In the persist phase because it is a pure DB read/write with no network in it — the header
    // chain is already in `p.normalized.headers` and the parent lookup is one indexed statement — so it
    // belongs in the persist transaction with every other entity write and its `change_log`
    // rows. The plan phase would put a read outside the transaction that commits its consequence, and
    // a cron would leave every message unthreaded until it next ran.
    //
    // BEFORE the `message` create, deliberately. The `thread` create is then the lower seq, so
    // a client applying the delta in order never sees a message referencing a thread it has not
    // been told about. It is also why the message needs no `update` of its own: the create is
    // recorded after `setMessageThread`, and a client materializing it reads the committed row.
    //
    // `stored.threadId` is the re-entry guard. `insertMessage` is an upsert, so a concurrent
    // second ingest of the same mail gets the existing row back; resolving again would be
    // harmless for anchored mail (`ON CONFLICT` returns the same thread) but would mint a
    // second `threads` row for a message with no Message-ID at all, whose NULL anchor nothing
    // can dedup.
    if (!stored.threadId) {
      const resolution = await resolveThread(repo, {
        accountId,
        messageId: stored.id,
        messageIdHeader: p.normalized.canonical.messageIdHeader,
        headers: p.normalized.headers,
        subject: p.normalized.subject,
        // Sender AND recipients, because the plan HAS them. The backfill can only pass the
        // sender: `insertMessage` writes `messages.to_addresses` only from this slice onward, so
        // the rows a backfill reaches carry `'[]'`. That asymmetry is documented on
        // `ThreadResolutionInput.participants`.
        participants: [p.normalized.from, ...p.normalized.to],
        date: p.normalized.date,
        emitMessageUpdate: false,
      });
      // Recorded HERE and not inside the resolver: `allocateSeq` holds the account's seq row
      // lock to commit, so every `threads` lock has to be taken before the first one of these or
      // a concurrent backfill batch deadlocks against us. See `ThreadResolution.changes`.
      for (const c of resolution.changes) {
        await repo.recordChange({ accountId, entityType: c.entityType, entityId: c.entityId, op: c.op, meta: null });
      }
    }

    await repo.recordChange({ accountId, entityType: "message", entityId: stored.id, op: "create", meta: null });

    const initial: FolderStateRow = {
      desiredFolder: p.desired,
      observedFolder: p.arrivalLocator.folder,
      // `'external'` for a folder the CUSTOMER made — see {@link NewPlan.passive} for why this one
      // word is a structural gate rather than a label.
      lastSetBy: p.passive ? "external" : "us",
    };
    await repo.upsertFolderState(stored.id, initial);

    // Optimistic, user-wins move change at local commit. The physical
    // move follows outside the tx; a later change corrects any IMAP divergence.
    if (p.desired !== p.arrivalLocator.folder) {
      await repo.recordChange({
        accountId, entityType: "message", entityId: stored.id, op: "move",
        meta: { from: p.arrivalLocator.folder, to: p.desired },
      });
    }

    // AI branch persistence: routing_decision (+ change), and — unless graduated —
    // an approval that gates the move until the user acts.
    if (p.ai && routing) {
      const status = p.ai.autoApplied ? "auto_applied" : "pending_approval";
      const rd = await routing.recordRoutingDecision({
        accountId,
        messageId: stored.id,
        inputProvenance: "ai",
        destination: p.ai.result.destination,
        confidence: p.ai.result.confidence,
        rationale: p.ai.result.rationale,
        spam: p.ai.result.spam,
        status,
      });
      await repo.recordChange({ accountId, entityType: "routing_decision", entityId: rd.id, op: "create", meta: null });

      if (!p.ai.autoApplied) {
        const appr = await routing.enqueueApproval({
          accountId,
          kind: "routing",
          messageId: stored.id,
          routingDecisionId: rd.id,
          action: "move",
          summary: `Route to ${p.ai.result.destination}`,
          payload: { folder: p.ai.result.destination },
          confidence: p.ai.result.confidence,
          expiresAt: null,
        });
        await repo.recordChange({ accountId, entityType: "approval", entityId: appr.id, op: "create", meta: null });
      }
    }

    const action: ReconcileAction =
      p.desired === p.arrivalLocator.folder ? { type: "none" } : { type: "move", to: p.desired };
    return { outcome: "new", messageId: stored.id, action };
  }

  // Existing message: repair the locator, then settle folder state WITHOUT a network
  // move. A `move` action (our own intent not yet applied) is left pending for the
  // reconcile runner; `adopt_external` records the user-wins outcome + a corrective
  // move change; `none` converges.
  const e = plan.existing!;
  // ── A WITHHELD MOVE DOES NOT REPOINT ────────────────────────────────────────────────────────
  //
  // See `ExistingPlan.unexpungedSource`. Our move's copy is at the destination and the source is
  // still on the server, so there are two physical messages and only one of them may be called
  // the message's location. It has to be the SOURCE: that is the locator the retry must be handed
  // to, and repointing at the copy would leave the surviving source addressable by nothing.
  //
  // The copy is recorded as a second instance instead, which is what stops it being rediscovered
  // next cycle as a stranger and paying a full RFC822 re-fetch. No tuple conflict is possible —
  // the primary is at the source, the copy is a different folder/uid — so unlike the repointing
  // path this write has no ordering constraint against the primary.
  // ── A SECOND PHYSICAL COPY IS RECORDED, NEVER REPOINTED TO ─────────────────────────────────────
  //
  // `updateLocator` MOVES the message's one primary instance (`drizzle-repo.ts#setPrimaryInstance`
  // is an UPDATE of the primary row, not an insert). So when two physical copies of one logical
  // message sit in the SAME folder — a re-imported mailbox, a client that appended twice — only one
  // of them can ever be in the known-set, and repointing hands the other one back to the next
  // cycle as an unknown UID:
  //
  //     cycle 1: uid 400 known, uid 900 unknown → fetch 900 → duplicate → primary moves to 900
  //     cycle 2: uid 900 known, uid 400 unknown → fetch 400 → duplicate → primary moves to 400
  //     …for ever, one full RFC822 body per copy per cycle, and `fetchCapped` truncated on every
  //     pass because the unknown set never shrinks — so `hasBacklog` is pinned true and
  //     `initial_import_completed_at` is unreachable.
  //
  // MEASURED, not hypothesised. On a live mailbox in this state the observable signature is exact
  // and worth recognising: the folder's `exists` far exceeds the instance rows recorded for it, the
  // folder cursor's `uidnext` has been held at 0 since the mailbox was created, and the stored
  // message count does not move across an hour of continuous cycling. It is a mailbox working hard
  // and importing nothing.
  //
  // The rule below is stated in terms of what each answer MEANS, not of the outcome kinds:
  //
  // `external_copy` is NOT in the condition and needs no place there: it takes its own return above
  // and already calls `recordInstance` without repointing. `duplicate` is the same observation in the
  // same folder, and it was the one that repointed.
  //
  // ── AND THE SENT FOLDER IS EXCLUDED, ON AN ENUMERATION ARGUMENT, NOT AN AUTHORSHIP ONE ────────
  //
  // Sent is the one folder read from a UID WATERMARK rather than end to end, and a delete BELOW that
  // watermark is deliberately never reported (`imap.ts`, `enumFloorUid`) — so the promotion in
  // `forgetInstanceAt` that closes this change's residual would never be reached there, and a
  // recorded non-primary copy could outlive its primary with nothing to move the row onto. The same
  // property makes the exclusion free: the watermark, not the known-set, is that folder's
  // enumeration floor, so a second copy in Sent cannot become a permanently-unknown UID and the loop
  // this block exists to break cannot form. Exchange Online's shape — its own re-rendered copy filed
  // beside the byte-exact one the send path appended — therefore keeps converging on the newest
  // observed UID exactly as it did (`sent-record.test.ts`).
  //
  //  · a different UID in the SAME epoch is a genuine second copy on the server right now. Record it
  //    (non-primary): it becomes known, its body is never fetched again, and the message keeps the
  //    locator it already had. Repointing on the strength of a second copy is the same class of
  //    mistake `external_copy` exists to refuse — a delivery deciding something.
  //  · a different EPOCH is a RENUMBERING. The stored locator is meaningless, so repoint.
  //  · the same locator is a replay. Repoint (a touch).
  //  · `own_move` / `external_move` repoint by definition — the message really is at the arrival
  //    locator, and the source is gone or being adopted.
  //
  // The residual this creates is closed in `forgetInstanceAt`: if the copy the primary points at is
  // later expunged, that call PROMOTES a surviving instance, so `messages.native_locator` never
  // names a UID the server does not hold. Before this change the same repair happened by accident —
  // the survivor came back as "unknown" and repointed the primary — which is the oscillation itself.
  const secondCopyInSameEpoch =
    e.kind === "duplicate"
    && !e.ownAuthored
    && e.storedLocator.folder === e.arrivalLocator.folder
    && epochOfRef(e.storedLocator.ref) === epochOfRef(e.arrivalLocator.ref)
    && e.storedLocator.ref !== e.arrivalLocator.ref;
  if (e.unexpungedSource || secondCopyInSameEpoch) {
    await repo.recordInstance(e.messageId, e.arrivalLocator);
  } else {
    await repo.updateLocator(e.messageId, e.arrivalLocator);
  }

  switch (e.action.type) {
    case "none": {
      await repo.upsertFolderState(e.messageId, {
        desiredFolder: e.state.desiredFolder,
        observedFolder: e.state.desiredFolder,
        lastSetBy: e.state.lastSetBy,
      });
      break;
    }
    case "adopt_external": {
      const to = e.action.newDesired;
      await repo.upsertFolderState(e.messageId, { desiredFolder: to, observedFolder: to, lastSetBy: "external" });
      await repo.recordAudit(
        accountId,
        "adopt_external",
        { messageId: e.messageId, adopted: to, previousDesired: e.state.desiredFolder },
        { messageId: e.messageId, revertTo: e.state.desiredFolder },
      );
      await repo.recordChange({
        accountId, entityType: "message", entityId: e.messageId, op: "move",
        meta: { from: e.state.desiredFolder, to },
      });
      break;
    }
    case "move": {
      // Leave the pending row as-is (desired != observed); the reconcile runner
      // realizes the physical move outside any transaction.
      await repo.upsertFolderState(e.messageId, e.state);
      break;
    }
  }

  // ── THE TWO COPIES ARE BOTH ON RECORD, AND THE MOVE IS STILL OWED ──────────────────────────
  //
  // See `ExistingPlan.unexpungedSource`. The instance write happened above, before the switch,
  // because it no longer competes for a tuple with anything: the primary stays at the source, so
  // recording the destination copy is an ordinary insert.
  //
  // The conflict flag is raised HERE, after the switch, and that position is load-bearing.
  // `upsertFolderState` writes `conflict` false on every call (`RepoPort.upsertFolderState`), so
  // raising it before the switch sets a column that is silently cleared microseconds later — a
  // test asserting the flag would pass against a row that no longer carries it. Swap these and
  // the test covering this ordering goes red on exactly that.
  //
  // The state passed here is the PENDING one — observed is the source, not the destination — but
  // be clear about how little that does: `setFolderConflict`'s update branch writes `conflict` and
  // `updated_at` and NOTHING else, so on this path the fields are inert. They are supplied
  // correctly because its INSERT branch (a message with no `folder_state` row yet) does use them,
  // and a converged pair there would be a completion nobody witnessed. That branch is not
  // reachable from a withheld move, which always has a pending row already — so this is stated
  // rather than tested, and mutating these two values leaves every test in this slice green.
  // The pending row that actually matters is written by the `move` arm of the switch above.
  //
  // THE DURABLE RECORD IS THE INSTANCE ROW, NOT THE FLAG — measured, not assumed. A non-primary
  // `message_instances` row whose folder is not the message's `desired_folder` is the queryable
  // "a source expunge is still owed", it needs no new table because the schema already spells it,
  // and it self-heals: if the source does vanish later, `sync.ts`'s `forgetInstanceAt` deletes it
  // by locator. `folder_state.conflict` is POINT-IN-TIME by comparison: `upsertFolderState` writes
  // `conflict: false` unconditionally, so the next ordinary re-observation clears it. Anything
  // that needs to find these must read the instance table.
  if (e.unexpungedSource) {
    await repo.setFolderConflict(e.messageId, {
      desiredFolder: e.state.desiredFolder,
      observedFolder: e.state.observedFolder,
      lastSetBy: e.state.lastSetBy,
    });
  }

  return { outcome: e.kind, messageId: e.messageId, action: e.action };
}

import { countRealFiles, normalizeMime } from "./mime.js";
import { prepareHtmlForStorage } from "./html-storage.js";
import {
  fingerprintDedupKey, legacyDedupKey, messageFingerprint, verifiesLegacyIdentity,
} from "./identity.js";
import { classifySensitivity, type SensitivityResult } from "./sensitive.js";
import {
  NO_TRUSTED_AUTHSERV_IDS, DEFAULT_OHBOX_POLICY, authVerdictFromHeaders, dsnVerdict,
  effectForDestination, evaluateRules, screenerAdmits, type AuthVerdict, type OhboxPolicy,
} from "./rules.js";
import { classifyDedup, type DedupOutcome } from "./dedup.js";
// The leaf predicate, not `adapters/imap.js`: this module is the model layer and naming the
// adapter here would pull `imapflow` into the desktop engine — the same reason `epochOfRef` above
// is hand-rolled. `gone.ts` carries the rule this file's `move` arm implements.
import { isMessageGone } from "./gone.js";
import { reconcile, type ReconcileAction } from "./reconciler.js";
// TYPE-ONLY, and that is what keeps the model layer's rule intact: `import type` is erased, so
// this adds no module to any bundle (both files are already engine inputs in any case). The
// conditional completion is declared on `WorkerRepo` and the apply path REQUIRES it — see
// {@link ReconcileApplyDeps}.
import type { WorkerRepo } from "./adapters/drizzle-repo.js";
import { resolveThread } from "./threading.js";
// The LEAF, not `/cloud` and not the root barrel: this module runs inside the desktop engine, and
// `/cloud` is billing, the credit ledger, the staff handle and the whole hosted schema.
// `classifyAttemptKey` is a pure template over its two arguments and lives on a leaf both halves
// can name — this line used to say exactly that while naming the root BARREL, which only avoided
// the hosted half for as long as the barrel happened not to reach it. Naming the leaf itself is
// what makes that a property instead of a coincidence.
import { classifyAttemptKey } from "@trafficflow/db/ledger-source";
import { aiSpendPermitted } from "./ports.js";
import type {
  Change, CreditGate, MoveEvidence, PipelineDeps, RepoPort, RoutingPort, FolderStateRow,
  MessageBodyInput, NativeLocator, StoredMessage,
} from "./ports.js";
import type { ClassifierPort, ClassifierResult } from "./classifier-port.js";
import type { NormalizedMessage } from "./types.js";
// A VALUE import, and from `types.js` rather than `adapters/imap-types.js` which re-exports it:
// that module's entry point carries `imapflow`, and this predicate is deliberately kept in a module
// with no imports at all so every caller can reach it. See {@link isOrganizedFolder}.
import { isOrganizedFolder } from "./types.js";

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
 * {@link applyReconcileAction}'s deps — {@link PipelineDeps} whose repo can complete a landed move
 * CONDITIONALLY.
 *
 * Required, never optional-chained: an absent method would collapse "this repo predates the
 * primitive" into "the blind write is fine", and the blind write is the defect this exists for.
 * Every production caller passes a `DrizzleRepo`, so the requirement is checked where those three
 * call sites compile rather than at run time.
 */
export interface ReconcileApplyDeps extends Omit<PipelineDeps, "repo"> {
  repo: RepoPort & Pick<WorkerRepo, "completeFolderState">;
}

/**
 * The "Organization Writer": perform the port writes for a computed reconcile action. Idempotent,
 * and the OUTSIDE-transaction move path: `adapter.move` never sits inside the seq/change_log tx.
 * A gone source locator is DEFERRED, never thrown: all four call sites are a committed user
 * decision, and a gone locator says nothing about whether it can be carried out — throwing
 * reported a committed decision as a server error and abandoned the rows behind it. The deferral
 * writes no folder state — a post-I/O write of a pre-I/O value overwrites newer decisions —
 * leaving the row in the reconciler's queue. It does NOT re-resolve and move again: a MUTATION
 * may not. `deferred` rides the return so a counting caller does not over-report.
 */
export async function applyReconcileAction(
  deps: ReconcileApplyDeps,
  ctx: ApplyContext,
  action: ReconcileAction,
): Promise<{ locator: NativeLocator; state: FolderStateRow; deferred?: boolean }> {
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
      let newLocator: NativeLocator;
      try {
        newLocator = await adapter.move(locator, action.to);
      } catch (err) {
        if (!isMessageGone(err)) throw err;
        // Deferred, and it writes NOTHING — the point, not an omission. This arm used to
        // `upsertFolderState` the desire it was called with, and the value was computed BEFORE
        // the IMAP round trip, so a newer decision committed mid-flight was overwritten by the
        // older one — a post-I/O write of a pre-I/O value, no less that shape for being on a
        // failure path. Guarding with a compare would work and is the wrong fix, because the
        // write is not needed: the intent belongs to the CALLER, and all four callers persist it
        // inside the transaction that took the decision. A deferral leaves the row exactly as
        // committed — `desired ≠ observed`, the reconciler's queue — and this function only
        // reports what happened.
        const pending: FolderStateRow = {
          desiredFolder: action.to,
          observedFolder: state.observedFolder,
          lastSetBy: "us",
        };
        await repo.recordAudit(
          accountId,
          "move_deferred",
          {
            messageId, from: locator.folder, to: action.to,
            reason: "the message is no longer at the locator this decision was computed against — "
              + "it moved, or its folder was recreated. The intent stands and the organizer "
              + "applies it once the next scan re-finds the message by Message-ID.",
          },
          null,
        );
        return { locator, state: pending, deferred: true };
      }
      await repo.updateLocator(messageId, newLocator);
      const next: FolderStateRow = {
        desiredFolder: action.to,
        observedFolder: action.to,
        lastSetBy: "us",
      };
      // The completion is conditional, and `desired_folder` is not in its SET list. `action.to`
      // is the desire this move was computed against, read before a round trip that takes minutes
      // on a slow host — and `desired_folder` has six other writers that take no mailbox row.
      // Writing the pair back through `upsertFolderState` REVERTED any decision that committed
      // meanwhile: a lost update, nothing erroring, the mail ending where the older decision
      // said. So the desire travels as the WITNESS and the landed folder as the fact; on a miss
      // the newer desire stands, the row goes pending against it, and the locator this call just
      // repointed is where the next cycle files from.
      const matched = await repo.completeFolderState(messageId, {
        expectDesiredFolder: action.to,
        observedFolder: action.to,
        lastSetBy: "us",
        physicalObservation: true,
      });
      await repo.recordAudit(
        accountId,
        "move",
        { messageId, from: locator.folder, to: action.to },
        { messageId, from: action.to, to: locator.folder },
      );
      if (!matched) {
        // `false` answers BOTH "a newer intent owns the row" and "there is no row", and the two
        // want opposite writes — so they are told apart by a read, never by the flag. No row means
        // no intent to preserve: every production caller commits one before the move, so this arm
        // is a decision taken without persistence, and the landed folder is the only truth there
        // is to record.
        const live = await repo.getFolderState(messageId);
        if (!live) {
          await repo.upsertFolderState(messageId, next);
          return { locator: newLocator, state: next };
        }
        // A superseded completion is owed to the log: silence is how this class stayed invisible
        // at the worker's writer. No inverse — there is nothing for an operator to undo.
        await repo.recordAudit(
          accountId,
          "move_superseded",
          {
            messageId, from: locator.folder, to: action.to,
            reason: "a newer decision for this message committed while the move was in flight. "
              + "The landed folder is recorded and the newer desire stands; the organizer applies "
              + "it on its next cycle.",
          },
          null,
        );
        // The caller is told what STANDS, not what this call wanted.
        return { locator: newLocator, state: live };
      }
      return { locator: newLocator, state: next };
    }
    case "adopt_external": {
      // `'external'` unconditionally, and NOT `action.attribution`: this is the reconcile runner,
      // which carries an organizer's intent to the server. A reader issues no moves and never
      // reaches it, so an adoption arriving here is a person's own hand by construction. The
      // reader's adopt is committed in `commitChange` instead, which does read `attribution`.
      const next: FolderStateRow = {
        desiredFolder: action.newDesired,
        observedFolder: action.newDesired,
        lastSetBy: "external",
      };
      await repo.upsertFolderState(messageId, next);
      // A tombstoned message that re-appears is being RESTORED by its user (mail 0065) — the
      // adopt evidence is the same evidence, so the un-delete rides the same arm.
      await repo.clearDeletedOnAdopt?.(messageId);
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
   * What this message's own provider said about its claimed author, as {@link
   * authVerdictFromHeaders} read it — persisted to `messages.auth_verdict` by {@link
   * commitChange}. REQUIRED and computed exactly once per ingest: a default would let a later
   * edit select a branch without naming it in a diff. Carried on the plan rather than recomputed
   * at commit, so the value that DECIDED the routing is the value that lands on the row —
   * recomputing under a trusted set that changed between the phases would store a verdict that
   * never routed anything.
   */
  authVerdict: AuthVerdict;
  /**
   * This placement was made by somebody other than this organizer — the customer's own hand, or
   * the previous organizer an import hold has not yet asked about. It decides ONE thing at
   * commit, the third of the three structural gates: the `folder_state` row is written
   * `last_set_by: 'external'` instead of `'us'` — and every pass that moves mail requires `'us'`
   * (`rule-retro` the widest, at `["us", "peer"]`), so a passive row is out of every unpressed
   * mover's reach by DATA, not only by the early return that put it there. What it no longer
   * decides is WHICH non-`us` value: {@link NewPlan.adoption} says whose it was, and the commit
   * reads `p.passive ? (p.adoption ?? "external") : "us"` — see {@link readerAdoption}.
   */
  passive?: boolean;
  /**
   * WHOSE placement this is, when {@link NewPlan.passive} says it is not ours — `'peer'`, meaning
   * another install of this same account, or absent, meaning the user's own hand.
   *
   * Written ONLY by the reader arm, and only for a folder `isOrganizedFolder` answers true for.
   * `change.passive` and the import hold leave it absent on purpose and so keep `'external'`; the
   * reasoning for each is in {@link readerAdoption}. Absent is therefore the default that BOTH
   * untouched callers take, which is why it is pinned by its own control rather than left to the
   * `??`.
   */
  adoption?: "peer";
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
   * The ARRIVAL's parsed body (mail 0065) — what {@link commitChange} restores a `junk_filed`/
   * `expunged` husk from when the message re-appears in a watched folder: the bytes are in hand
   * (this plan was built from a create carrying RFC822), so leaving the husk would strand a
   * message the server demonstrably holds behind an empty pane for ever. Optional so every
   * existing constructor and fake keeps compiling; absent ⇒ nothing to restore from.
   */
  body?: MessageBodyInput;
  /**
   * The source copy whose expunge is still owed, when nothing proved it went away. Present only
   * for an `own_move` on `appearance_only` evidence — the COPY-succeeded/EXPUNGE-failed split of
   * a no-MOVE server. This locator STAYS the primary: repointing at the copy would declare a
   * completion nothing witnessed and strand the surviving source, whose only remover is a retry
   * of this very move. The copy is recorded as a second instance and `folder_state` stays
   * pending; the next reconcile retries, the adapter's pre-check recognises its own copy, writes
   * nothing, and expunges this locator — the only converging sequence. Absent for
   * `correlated_move` and `verified_absence`: genuine completions — completion is source absence.
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
  /**
   * This install is a READER of this mailbox, not its organizer. REQUIRED: an omitted
   * `readerMode` routes as an ORGANIZER — two installs moving one person's mail. A census pins
   * the compositions passing the field; one place decides the value. What the mode does: a NEW
   * message keeps its arrival folder, committed {@link NewPlan.passive} (`'external'` in the
   * customer's folders, `'peer'` in one ohmail organizes); an EXISTING message found somewhere
   * new is adopted `'external'`; NO rules, classifier, credit or learning signal — the branch is
   * never entered, proved by an injected double asserting silence; never a `move`. `'peer'`
   * narrows the `'us'` gate by one pass, `rule-retro`, on a press.
   */
  readerMode: boolean;
  classifier?: ClassifierPort;
  routing?: RoutingPort;
  /** The AI spend gate. Absent ⇒ unmetered; see {@link CreditGate}. */
  credits?: CreditGate;
  /**
   * The authserv-ids the account's own provider signs `Authentication-Results` with, lowercased.
   * Configuration, not a `mailboxes` column: a statement about WHOM THIS DEPLOYMENT BELIEVES — a
   * user must not name their own trusted position, or a sender-controlled header could be
   * believed; a column would put it one UPDATE away. Production populates it via
   * `providerAuthservIds(<the IMAP host dialled>)`; every sync-deps seam REQUIRES the field,
   * because it sat optional-and-empty at all five production sites and the demote-only branch
   * protected nothing. Absent stays first-class HERE: it resolves to `"unavailable"` for every
   * message — byte-identical routing to the literal it replaced.
   */
  trustedAuthservIds?: ReadonlySet<string>;
  /**
   * The account's Ohbox posture, resolved per-account from `account_settings.ohbox_policy` by the
   * worker — injected configuration, like `trustedAuthservIds` above: a property of how THIS
   * account asked its mail to be organised, resolved once per cycle and threaded here. Absent
   * resolves to {@link DEFAULT_OHBOX_POLICY} (`people_and_replied`), so the demotion branch never
   * fires and routing is byte-identical to the pre-slice engine; a NULL `ohbox_policy` resolves
   * the same way, so shipping this demotes no existing account until it opts in. {@link
   * evaluateRules} takes the resolved value as REQUIRED so no call site can forget it.
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
   * The screening cutoff — mail arrived before this instant keeps its arrival folder instead of
   * being held at the gate; ABSENT means no cutoff. The router has no notion of age, so a
   * backfill moved years-old mail into the Screener, into a queue nobody will empty. Only `source
   * === "screener"` verdicts are subordinated — NOT a `rule` verdict, NOT the auth-fail demotion
   * (checked separately), NOT sensitivity or the bounce arm. The message keeps
   * `change.locator.folder`. Age is `change.internalDate` ONLY: the `Date:` header is
   * sender-written, and the old fallback let a backdated header keep a stranger's fresh delivery
   * in the INBOX; absent INTERNALDATE means NOT old — the gate.
   */
  screeningCutoff?: Date;
  /**
   * A foreign organizer profile's import decision is open — the routing half of the write-behind
   * HOLD; ABSENT means inert. Measured in a takeover drill: the profile answered for every
   * screened sender, the write-behind held it and asked — and the sync loop ran at full authority
   * meanwhile, moving all 31 INBOX messages of screened senders into the Screener. While open,
   * the GATE's own verdicts adopt the arrival folder — {@link screeningCutoff}'s subordination —
   * committed {@link NewPlan.passive}, keeping every retro pass from re-deciding after the
   * import. The hold ends when the user answers or the document equals local state. The cost: a
   * new stranger mid-window lands where the server delivered it.
   */
  importDecisionOpen?: boolean;
}

/**
 * The typed "no cap" — the value a composition root writes to say its deployment meters no
 * storage: the desktop engine, the self-host server (a self-hoster's limit is their own disk),
 * and every test not about the cap. A symbol and not `null`/`undefined`, because for the storage
 * cap the absent-config default IS the dangerous branch — a wiring refactor that drops the field
 * must be a compile error, not a silently unmetered cap. The hosted worker never types this name;
 * its composition threads `storageCapOf`'s per-account number, and a test pins that wiring by
 * flipping it here and watching the decline path go dark.
 */
export const UNMETERED_STORAGE_CAP: unique symbol = Symbol("ohmail: unmetered storage");

/** An account's storage cap as `commitChange` receives it: bytes, or the typed "no cap". */
export type StorageCap = number | typeof UNMETERED_STORAGE_CAP;

export interface CommitDeps {
  repo: RepoPort;
  accountId: string;
  mailboxId: string;
  routing?: RoutingPort;
  /**
   * The account's managed storage cap, REQUIRED — resolved once per account per cycle by the
   * caller (the hosted worker via `storageCapOf`; everything unmetered types
   * {@link UNMETERED_STORAGE_CAP}). At cap the body write stores a withheld husk instead of
   * content and NOTHING else changes: same message row, same snippet, same attachments
   * metadata, same threading, same deltas, same folder move, same routing. The mailbox on the
   * IMAP server is the master and never suffers.
   */
  storageCap: StorageCap;
}

/**
 * The dual-key lookup — how the key format changes with NO backfill. Backfilling fingerprints is
 * prohibited: a batch job computes a DIFFERENT value than ingest (redacted text, capped html,
 * missing digests), so a backfilled row's first re-observation would insert a SECOND `messages`
 * row — which no delta removes, and which mints a second `threads` row too. The migration happens
 * at read time: (1) `fp1:` — the same message; (2) the legacy key — a CANDIDATE only, verified
 * against four stored columns, then rewritten; (3) the own-sent twin arm, `ownAuthored` only; (4)
 * new. Any mismatch in step 2 means NEW — the legacy key is forgeable, and the verification tuple
 * refuses the forgery. Cost: one indexed SELECT per genuinely-new message.
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

  // Step 3: the own-sent twin — by Message-ID alone, and ONLY for an `ownAuthored` create.
  // Exchange Online files its own re-rendered copy of every SMTP submission into Sent beside the
  // byte-exact copy the send path APPENDs: different bytes, different fingerprint, both lookups
  // miss, and the twin used to ingest as a SECOND row — the user's just-sent message, twice in
  // its own conversation. Message-ID alone is exactly the forgeable key the fingerprint replaced,
  // and it stays banned for inbound mail: this arm is gated on `Change.ownAuthored`, which the
  // ADAPTER stamps only on pure creates read out of the mailbox's own Sent folder — a folder
  // strangers cannot write into. The key returned is still `fpKey`, and NO `upgrade` rides along:
  // rewriting the stored key to this observation's fingerprint would repoint the row's identity
  // at whichever copy was seen last.
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

/**
 * Whose placement is this — for a READER. `'us'`: THIS install decided; every unpressed mover
 * requires it, and it is the durable record of which install organized — a reader writing it
 * would turn a promotion into a bulk re-filing. `'external'`: the USER placed it, in a folder of
 * their own. `'peer'`: another install of this account placed it, in a folder ohmail organizes —
 * before it existed a reader wrote `'external'` here, and mail behind a decision already made
 * stayed frozen at the gate. `'peer'` is out of every unpressed mover's reach; only `rule-retro`
 * admits it, on a press. Decided by the WRITER: only the code that knows it is a reader can tell
 * adoption from a person's drag. The `?? "external"` default is pinned by its own control.
 */
function readerAdoption(arrivalFolder: string): { adoption?: "peer" } {
  return isOrganizedFolder(arrivalFolder) ? { adoption: "peer" } : {};
}

/**
 * The same question for an EXISTING message has a different answer. `readerAttribution` used to
 * answer `'peer'` for the six organized folders, and reading the two seams as one cost a person's
 * own filing: dragging a message out of `ohmail/Reads` back into `INBOX` was recorded as another
 * install's placement, and `rule-retro` moved it back out on the next press — their hand, undone
 * by their own rule. `'peer'` is a CLAIM about who acted, and for held mail there is no evidence
 * — so it is adopted `'external'`, failing safe. Named consequence: a genuine peer move of held
 * mail is also `'external'` and a pressed retro rule will not reach it. {@link readerAdoption} is
 * untouched: a never-held message carries no placement of ours.
 */

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

  // The evidence, derived once, from the only two things that can witness a disappearance ({@link
  // MoveEvidence}): a sender can make a locator APPEAR; only the user can make a stored locator
  // DISAPPEAR. `change.type === "move"` is the adapter's `correlateMoves` having paired a
  // vanished known UID with a re-appeared one — computed all along, and `classifyDedup` never
  // read it; this line closes that gap. A vanished PRIMARY instance is the other half, and it is
  // what keeps user-always-wins in the opposite direction: a real user move `correlateMoves`
  // cannot pair still adopts. The read is skipped for a correlated move and for a never-seen
  // message: one indexed EXISTS per re-observation, none on the hot path.
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

    // The provider's own report about the claimed author, read once, HERE — invoked on the path
    // that ROUTES. It used to be an `"unauthenticated"` literal, so a forged `From` naming an
    // allowed sender was promoted normally even when `Authentication-Results` said `dkim=fail`.
    // The asymmetry, restated where it can be broken: `evaluateRules` reads exactly one member —
    // `"fail"` — and only to send a message DOWN; there is no `auth !== "pass"` anywhere and
    // there must never be one. Reading this may DEMOTE; it may never be REQUIRED before a
    // consented identity is honoured. With the trusted set empty this returns `"unavailable"` on
    // its first line. Above the `ownAuthored` return: both plans need it, and it is a pure header
    // read. `normalized.headers`, not `change.raw`: the same map the row stores, so re-evaluation
    // passes parse the SAME input.
    const authVerdict = authVerdictFromHeaders(
      normalized.headers, normalized.from.address, trustedAuthservIds,
    );

    // Mail the user WROTE leaves the pipeline here. Everything below is written for INBOUND mail
    // and answers destructively for outbound: the Screener would queue every message the user
    // ever wrote for consent (their FROM is not in `contacts`); the Reads/Receipts heuristics key
    // on headers a reply echoes; the sensitive short-circuit would lift a message out of Sent
    // over a forwarded login code; and with `desired` already decided the AI branch cannot fire —
    // a message the user wrote must not cost an AI action. Above the `listRules`/`knownSenders`
    // reads on cost: two round trips per sent message, discarded. `desired === arrival` is
    // organize-in-place for outbound — ohmail does not file your Sent folder. `seen: true`
    // regardless of the server: nothing the user wrote is new to them, and a client that appends
    // to Sent without `\Seen` would put their own outbox into the unread count.
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

    // Mail the customer FILED THEMSELVES leaves the pipeline here too. `Change.passive` means the
    // adapter read this out of a folder the customer made; the reasoning is the `ownAuthored`
    // block with one word changed — this mail has already been organized, by the person whose
    // mailbox it is. The Screener applied to fifteen years of filing is a bulk move of an archive
    // into a consent queue whose question is answered; an archived newsletter must not be lifted
    // into ohmail's folder; an old password reset must not surface in today's Ohbox; and the AI
    // branch cannot fire — backfilling an archive must not spend an AI action. `seen` is the
    // SERVER's flag: filed mail may well be unread, and claiming otherwise would mark a whole
    // archive read in their other clients. `desired === arrival` is the never-reorganized
    // statement; the row lands `'external'`, keeping every retro pass out.
    /**
     * A reader ADOPTS. It does not decide. This arm sits with `change.passive` because it is the
     * SAME plan — arrival folder kept, `'external'`, no decision recorded — and above the
     * `listRules`/`knownSenders` reads for a stronger reason than cost: a reader must not merely
     * discard the gate's verdict, it must never COMPUTE one. `sensitivity` IS still computed,
     * deliberately: pure, local, landing on the message row where `no_ai` is a standing property
     * — a reader storing "not sensitive" would hand its own AI-draft door a wrong answer. What it
     * may NOT do is force `INBOX`: that is a MOVE. `seen` is the SERVER's flag: a reader claiming
     * mail unread would mark somebody's archive unread in every other client.
     */
    if (deps.readerMode === true) {
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
          ...readerAdoption(arrivalLocator.folder),
        },
      };
    }

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

    // Sensitivity refines placement. It never establishes consent. The old `sensitivity.sensitive
    // ? "INBOX"` ternary is the defect `rules.ts#headerHeuristic` names: a sender-chosen signal
    // may refine where consented mail lands, never carry a stranger past the gate — `Subject:
    // your verification code` was a remote defeat of the consent boundary. The subordination is
    // `effectForDestination`: a `deny` verdict also covers an explicit user rule, so a
    // QUARANTINED sender cannot free themselves with an OTP-shaped body. `allow` and `unclear`
    // still yield INBOX for sensitive mail. The bounce arm: two corroborations, either sufficient
    // — a quoted Message-ID this account HOLDS, or `X-Failed-Recipients` naming an existing
    // correspondent. It may pass the GATE, never overrule the USER: a gate fall-through carries
    // `matchedRuleId === null`; a rule id stands.
    const dsn = dsnVerdict(normalized, change.raw);
    let ownBounce = false;
    /**
     * A bounce for an away reply is not the reader's mail at all. This is our own bounce, and
     * nobody composed the failed message — the responder did, and it already records the dead
     * address on `away_sender_state.undeliverable_at`. So the one delivery report the product
     * acted on by itself was the one it put in somebody's Ohbox, once per throttle interval for a
     * whole trip. `isOwnAwayReply` and not the quoted `Auto-Submitted` header, which is a string
     * its sender writes — routing on it would let a stranger lift their mail out of the Screener.
     * The minted id is a uuid THIS account generated, the same join
     * `markUndeliverableFromBounces` uses.
     */
    let awayReplyBounce = false;
    if (dsn) {
      awayReplyBounce = dsn.originalMessageIds.length > 0
        && await repo.isOwnAwayReply(accountId, dsn.originalMessageIds);
      ownBounce = awayReplyBounce ||
        dsn.failedRecipients.some((a) => known.has(a)) ||
        (dsn.originalMessageIds.length > 0 &&
          (await repo.findThreadParent(accountId, dsn.originalMessageIds)) !== null);
    }

    const deniedByConsent =
      decision.destination !== null && effectForDestination(decision.destination) === "deny";
    /** A corroborated bounce the account has expressed no opinion about. */
    const admitBounce = ownBounce && decision.matchedRuleId === null
      && (!deniedByConsent || decision.source === "screener");
    /**
     * The responder's own bounce, filed to `ohmail/Receipts` — kept, findable, out of the way.
     *
     * Subordinate to the USER's decision on exactly the terms `admitBounce` is, and for the same
     * reason: a daemon somebody quarantined must not be re-filed by us, in either direction.
     */
    const fileBounceAsReceipt = awayReplyBounce && decision.matchedRuleId === null
      && (!deniedByConsent || decision.source === "screener");

    /**
     * The gate does not reach back past the screening baseline. Three refusals to over-reach: a
     * cutoff was resolved at all; the verdict is the GATE's own — a `rule` verdict is never
     * subordinated; and the message did not FAIL authentication — `evaluateRules` returns the
     * same `screener` verdict for "nobody ruled" and "failed auth", and only the first is a
     * backlog question: without this term, `Date: 2019` plus a failed DKIM would be a way past
     * the gate; read off `authVerdict`. `\Seen` is not consulted. THE SERVER CLOCK ONLY — `??
     * normalized.date` stood here and a security review flagged it: the header is sender-written.
     * No INTERNALDATE means NOT old means the gate — fail-closed, the accepted cost.
     */
    const arrivedAt = change.internalDate ?? null;
    /* Read off `screenerAdmits` rather than spelled here: `sensitive-rescreen.ts` writes holds
       too and had no cutoff at all, and a cutoff enforced at one of two doors is not a cutoff. */
    const preBaselineBacklog = !screenerAdmits({
      arrivedAt, cutoff: deps.screeningCutoff, source: decision.source,
      authFailed: authVerdict === "fail",
    });

    /* ── THE GATE DEFERS WHILE THE MAILBOX'S TRAVELLING DECISIONS AWAIT THEIR ANSWER ─────────
     *
     * See {@link PlanDeps.importDecisionOpen} — the routing half of the organizer-profile HOLD
     * (TAKEOVER-RESCREEN). The same two refusals as the baseline block above, for the same
     * reasons: a `rule` verdict is the user's decision and stands, and the auth-fail demotion is
     * a statement about THIS message that an open import question must not excuse. No date term:
     * the window is bounded by the user's answer, not by a clock, and the mail it protects is
     * precisely the mail whose placement the previous organizer already decided.
     */
    const heldForImport = deps.importDecisionOpen === true
      && decision.source === "screener"
      && authVerdict !== "fail";

    /* AHEAD OF `sensitive`, which is the one ordering choice here worth stating. A sensitivity
       reading is a heuristic over text; this is a lookup that says what the failed message WAS.
       And the text it would be reading is the user's own out-of-office message, so a code-shaped
       false positive in it costs nothing to file as a receipt. */
    let desired: string = fileBounceAsReceipt
      ? "ohmail/Receipts"
      : (sensitivity.sensitive && !deniedByConsent) || admitBounce
        ? "INBOX"
        : preBaselineBacklog || heldForImport
          ? change.locator.folder
          : decision.destination ?? change.locator.folder;

    let ai: AiPlan | undefined;
    // The identity of ONE classification of THIS mail — the mailbox and the hashed dedup key,
    // which is what makes a reprocess of the same mail the same work. It is the BARE key: whoever
    // answers composes the ledger source from it, and a key that already carries a namespace is
    // refused there rather than doubled (see `sourceFor`). Computing it writes nothing — only the
    // spend below can move money — so it is safe to build before the gate runs.
    const attemptKey = classifyAttemptKey(mailboxId, key);
    // AI gate: classify only on the unclear residue, never for sensitive/no_ai mail, and only
    // when the account may spend. The classifier is not even constructed for sensitive messages,
    // so the raw secret never leaves the process. THE ORDER OF THIS CONDITION IS THE INVARIANT:
    // `&&` short-circuits, so the money question is asked LAST and a `no_ai` message can never
    // reach `tryDebit` — "a sensitive message produces no metering row" is a property of the
    // control flow, not of anyone remembering. Move `tryDebit` earlier and the AI-metering ledger
    // test fails. `credits` ABSENT means unmetered, not refused: the free desktop tier and every
    // pre-gate test run this branch with no gate, and the plan must be identical.
    if (
      !sensitivity.flags.no_ai &&
      classifier &&
      routing &&
      decision.destination == null &&
      // `{ mailboxId }` ONLY. This used to pass `dedupKey: key`, and `key` is
      // `mid:${messageIdHeader}` — the raw Message-ID, chosen by the sending server, carrying the
      // sender's domain and, routinely for ESPs, the recipient's address. The metering ledger is
      // APPEND-ONLY with no delete path, so every classification wrote a correspondent into a
      // table that cannot be rewritten, and closing the admin render path removed nothing from
      // disk or backups. Nothing needed it: the spend identity is `attemptKey`, which sha256s the
      // key already. `aiSpendPermitted` reads the six-verdict answer for this path: proceed on
      // `ok` and `duplicate` (already paid), skip on everything else — including `inflight`,
      // where another caller is running the model for this exact mail right now.
      (credits == null || aiSpendPermitted(
        await credits.spend(accountId, "classify_ingest", attemptKey, { mailboxId })))
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
        // Rethrow, deliberately, and do NOT refund — two decisions. The rethrow: a classifier
        // FAULT, not out-of-credits. Degrading would file by rules and never look again, making a
        // transient outage permanent mis-routing; aborting leaves the message un-ingested and the
        // cursor unadvanced, so the next pass re-plans this mail. The absent refund: that retry
        // is FREE — `attemptKey` is on record and the gate answers `duplicate → proceed` for an
        // open attempt — so the charge is honoured by the retry, and refunding as well would
        // re-classify an entire backlog free through an outage. The call sites where the retry is
        // NOT guaranteed — the drafting request (a human may give up) and the proposal cron (a
        // new period bucket) — do refund, re-opening the work for a fresh charge.
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
        // A placement adopted under the import hold is the standing state of the user's mailbox,
        // not this organizer's decision — `passive` commits `'external'`, keeping every retro
        // pass from re-deciding after the import lands; without this one word the hold would only
        // postpone the re-screen it prevents. ONLY when the hold's arm actually decided, two
        // exclusions: `desired` must equal the arrival folder — the sensitive and bounce lifts
        // pick INBOX, a REAL move when the mail sits elsewhere, and `reconcileFolders` skips
        // `external` rows, so a passive-stamped lift would leave the server behind while every
        // client claims INBOX; and not `admitBounce` even when no move is needed — a corroborated
        // DSN arriving in the INBOX was still THIS organizer's decision, and an `external` stamp
        // would hide it from the retro passes entitled to revisit our decisions.
        ...(heldForImport && !admitBounce && desired === change.locator.folder ? { passive: true } : {}),
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

  // Our move's copy appeared. That is not the same as our move having LANDED. `classifyDedup`
  // answers `own_move` from the folder alone, rightly; what the folder cannot say is whether the
  // SOURCE went — completion is source absence. The two shapes separate here:
  // `correlated_move`/`verified_absence` — real completions, the field stays absent;
  // `appearance_only` — both copies exist on the server right now. The move stays PENDING: the
  // source's only remover is a retry of this very move, so converging here makes the duplicate
  // permanent. Safe now because the move is idempotent (the destination pre-check); without it a
  // retry copies again every cycle. NEVER for a reader: a demoted organizer's rows survive, so
  // `own_move` is reachable — and this field is "a source expunge is owed by US"; a reader owes
  // no IMAP write but `setFlags`, and leaving it set would queue an expunge nothing may perform.
  const unexpungedSource =
    deps.readerMode !== true && outcome.kind === "own_move" && evidence.kind === "appearance_only"
      ? existingMsg.nativeLocator
      : undefined;

  // A withheld move keeps its INTENT. `reconcile` would answer `none` — from this observation
  // alone desired and observed agree — and that answer is exactly the premature completion above.
  // Re-asserting the pending `move` is what puts the retry, and with it the source expunge, back
  // into the reconcile pass's queue.
  /**
   * A reader's reconciler never answers `move`. The organizer's reconciler carries OUR intent; a
   * reader has none, so the only truthful answer about a moved message is "it moved" —
   * `adopt_external`, writing `desired = observed = where it is` with `'external'` and the audit
   * row. Two organizer arms are refused rather than merely not taken: `unexpungedSource`
   * re-asserts a pending move — a reader issues no moves, and re-asserting one would queue a mail
   * move nobody decided for the moment this install is promoted; and the `move` fall-through —
   * for a reader a divergence is the mailbox, the master. `none` when the message is where the
   * row says: a reader's steady state writes nothing.
   */
  const action: ReconcileAction = deps.readerMode === true
    ? (change.locator.folder === state.desiredFolder
      ? { type: "none" }
      : {
        // No attribution rides along: adopting a message we ALREADY HOLD is the person's own hand
        // (`'external'` at the commit). See the block where `readerAttribution` used to be.
        type: "adopt_external",
        newDesired: change.locator.folder,
      })
    : unexpungedSource
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
      // The arrival's content, for the husk restore — the same three fields the new path
      // stores, through the same html gate (`prepareHtmlForStorage` is the ONLY route html
      // takes into the database; see the new path's body write).
      body: {
        text: normalized.textBody,
        html: prepareHtmlForStorage(normalized.htmlBody),
        headers: normalized.headers,
      },
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

  // REQUIRED AT RUNTIME TOO, not only in the type: most test files are not typechecked, so a
  // stale caller would otherwise thread `undefined` — which is neither a number nor the typed
  // unmetered symbol, and would reach the adapter's cap comparison as a silent decline of every
  // body. For a storage cap every wrong default is the dangerous branch in one direction or the
  // other, so an undeclared caller fails HERE, loudly, before any write.
  if ((deps.storageCap as unknown) === undefined) {
    throw new Error(
      "CommitDeps.storageCap is required: pass the account's cap in bytes, or UNMETERED_STORAGE_CAP",
    );
  }

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

  // A second delivery of a message we already hold — the complete observable effect, every
  // omission deliberate: `recordInstance` — the copy's locator becomes KNOWN, its body never
  // fetched again (nothing else remembers a locator we declined to make primary);
  // `setFolderConflict` — the record that two instances exist, touching `desired_folder`,
  // `observed_folder` and `last_set_by` NOT AT ALL; no `updateLocator` — the primary stays where
  // the user's decision left it; no `recordChange` — no client is told anything moved, because
  // nothing did; no `adopt_external` audit row — nothing was adopted, and the acceptance
  // criterion is literally that absence after the forgery is run twice.
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
      // The recipients, which this line is the first to persist.
      // `messages.to_addresses`/`cc_addresses` have existed since the schema landed and the DTO
      // has always projected them, but no Cloud ingest ever wrote them — every Cloud message
      // reached the reader as `to: []` with no "To" line, and nothing failed, because an
      // unwritten column and a message addressed to nobody are the same `[]` on the wire. The
      // values were in `p.normalized` the whole time. Same parse, not a second reading — which
      // keeps the row and the fingerprint that decides its identity from disagreeing about who a
      // message was sent to.
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
      // The verdict that routed this message, written in the ingest transaction. `planChange`
      // computed it once and `evaluateRules` already consumed it; this is the same value, not a
      // second reading. Persisting here rather than in a later pass stops the row and the routing
      // from disagreeing — a NULL column resolves to `"unauthenticated"`, and a NULL on a message
      // that was in fact demoted would leave the reason for its demotion nowhere on disk. The
      // column is `messages.auth_verdict` (mail 0028), written by nothing on the ingest path
      // until this line; the unsubscribe service is the only other writer, from the same parser
      // and the same stored headers.
      authVerdict: p.authVerdict,
    });

    // The winner owns the tail. A loser writes NOTHING (measured on real Postgres).
    // `insertMessage` is an upsert, so two ingests that both planned `new` both arrive here, and
    // the loser holds the WINNER'S row — the `messages` row converges. Everything below did not:
    // `insertAttachments` has no conflict target, so one attachment became two rows (measured);
    // `recordChange` emitted a second `create` delta for one id — a convergence break;
    // `upsertFolderState` overwrote the winner's row and silently cleared the stale-source
    // `conflict`. A `duplicate` outcome is the honest name: this observation added no message. No
    // DDL was needed — the deciding constraint already exists; this line stops throwing its
    // verdict away. A loser that observed a DIFFERENT locator writes nothing either: the next
    // cycle re-presents it and `external_copy` records it with the evidence machinery intact.
    if (!stored.created) {
      return { outcome: "duplicate", messageId: stored.id, action: { type: "none" } };
    }

    // Attachment METADATA (never bytes) persists in the SAME transaction as the
    // message — atomic ingest, no orphan attachment without its message.
    await repo.insertAttachments(stored.id, accountId, p.normalized.attachments);

    // The full original body, always — text AND html, sensitive or not. Body redaction is
    // removed: the mailbox on the IMAP server already holds this mail unredacted, so a redacted
    // display copy only hid it from the one person entitled to read it, and it over-fired. The
    // disclosure gate to a MODEL is elsewhere and unchanged — `no_ai`/`no_kb` keep this mail out
    // of automatic AI, and `redactForModel` strips the credential from any user-pressed payload.
    // `prepareHtmlForStorage` is the ONLY route html takes into the database — the sole writer of
    // `message_bodies.html`. The storage-cap seam is inside this one call: the adapter reserves
    // the bytes against `deps.storageCap` in this transaction, and at cap stores the withheld
    // husk instead; everything below proceeds identically — the acceptance that matters is a
    // rule-matched sender still moving on IMAP while its body is withheld.
    await repo.insertMessageBody(stored.id, {
      text: p.normalized.textBody,
      html: prepareHtmlForStorage(p.normalized.htmlBody),
      headers: p.normalized.headers,
    }, {
      accountId,
      capBytes: deps.storageCap === UNMETERED_STORAGE_CAP ? null : deps.storageCap,
    });

    // Threading, here and not anywhere else. In the persist phase because it is a pure DB
    // read/write with no network — the header chain is in `p.normalized.headers` and the parent
    // lookup is one indexed statement — so it belongs in the persist transaction with every other
    // entity write; the plan phase would put a read outside the transaction that commits its
    // consequence, and a cron would leave every message unthreaded until it ran. BEFORE the
    // `message` create, deliberately: the `thread` create takes the lower seq, so a client
    // applying deltas in order never sees a message referencing a thread it has not been told
    // about. `stored.threadId` is the re-entry guard: `insertMessage` is an upsert, and resolving
    // again would mint a second `threads` row for a message with no Message-ID, whose NULL anchor
    // nothing can dedup.
    if (!stored.threadId) {
      const resolution = await resolveThread(repo, {
        accountId,
        messageId: stored.id,
        messageIdHeader: p.normalized.canonical.messageIdHeader,
        headers: p.normalized.headers,
        subject: p.normalized.subject,
        // Sender AND recipients, because the plan HAS them. The backfill can only pass the
        // sender: `insertMessage` has not always written `messages.to_addresses`, so
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
      // NOT a label — a structural gate. See {@link NewPlan.passive} and {@link readerAdoption}:
      // `'us'` is "this install decided", `'external'` is "the user filed it by hand in a folder of
      // their own", `'peer'` is "another install of this account placed it in a folder we organize".
      // The `?? "external"` is the branch `change.passive` and the import hold take, and it is
      // pinned by a control of its own rather than left to this operator.
      lastSetBy: p.passive ? (p.adoption ?? "external") : "us",
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
  // A withheld move does not repoint; a second physical copy is recorded, never repointed to.
  // `updateLocator` MOVES the one primary instance, so with two copies in the SAME folder only
  // one can be in the known-set — repointing hands the other back as an unknown UID: fetch and
  // repoint, alternating for ever, one full body per copy per cycle, so the first-import stamp is
  // unreachable. MEASURED live: `exists` far above the instance rows, `uidnext` held at 0, the
  // stored count motionless. Sent is no longer excluded — its claim holds only once a watermark
  // is PUBLISHED, and on a truncating first scan every own-authored second copy is exactly the
  // permanently-unknown UID the claim denied: 9.4 MB per two-minute cycle for weeks. The
  // own-authored arm records AND repoints; a different epoch — repoint; a replay — repoint. The
  // residual is closed in `forgetInstanceAt`, which promotes a survivor.
  const sameFolderSameEpochCopy =
    e.kind === "duplicate"
    && e.storedLocator.folder === e.arrivalLocator.folder
    && epochOfRef(e.storedLocator.ref) === epochOfRef(e.arrivalLocator.ref)
    && e.storedLocator.ref !== e.arrivalLocator.ref;
  const secondCopyInSameEpoch = sameFolderSameEpochCopy && !e.ownAuthored;
  // An own-authored (Sent) copy: record AND repoint — both halves load-bearing. Sent is read from
  // a UID watermark, and a delete BELOW it is never reported, so whichever copy the row names can
  // silently die with no promotion. RECORD the stored locator as a non-primary instance so both
  // UIDs are in the known-set — without it, the measured repoint ping-pong. REPOINT the primary
  // to the newest observed copy — without it, Exchange's replace shape leaves `native_locator`
  // naming a dead UID for ever. A stale non-primary row is the accepted residual: never
  // enumerated again. The primary can go stale under EITHER policy, and that state is DEGRADED,
  // not lost: `MessageGoneError`, `voidGoneFiling`, then adoption. "Newest" is a UID comparison,
  // not arrival order: a cold Sent scan hands creates over newest-first, and an unconditional
  // repoint would walk the primary BACKWARD onto the copy the provider expunges.
  const arrivalIsNewer = sameFolderSameEpochCopy
    && Number(e.arrivalLocator.ref.split(":")[1]) > Number(e.storedLocator.ref.split(":")[1]);
  if (!e.unexpungedSource && sameFolderSameEpochCopy && await repo.primaryInstanceVanished(e.messageId)) {
    // FIRST, ahead of every recording arm and for own-authored and inbound copies alike (review
    // rounds 4 and 6): the primary is GONE — an observed expunge removed it with nothing to
    // promote, and `messages.native_locator` names a UID the server does not hold. ANY live copy
    // beats a dead locator, whatever its uid and whoever authored it — this is locator repair,
    // not placement (folder_state is untouched), so the adoption boundary is not in play.
    // Without this arm a surviving copy would be recorded non-primary, its uid would join the
    // known-set, and nothing would ever repair the row — every move, reply and attachment read
    // pinned to a missing message. (`unexpungedSource` is excluded because its source instance
    // demonstrably still exists — the primary cannot be gone.)
    await repo.updateLocator(e.messageId, e.arrivalLocator);
  } else if (e.unexpungedSource || secondCopyInSameEpoch) {
    await repo.recordInstance(e.messageId, e.arrivalLocator);
  } else if (sameFolderSameEpochCopy && arrivalIsNewer) {
    await repo.updateLocator(e.messageId, e.arrivalLocator);
    await repo.recordInstance(e.messageId, e.storedLocator);
  } else if (sameFolderSameEpochCopy) {
    await repo.recordInstance(e.messageId, e.arrivalLocator);
  } else {
    await repo.updateLocator(e.messageId, e.arrivalLocator);
  }

  // A re-appearance un-deletes, whoever authored it (mail 0065). The server demonstrably holds
  // this message in a watched folder — that is what an existing-message arrival IS — so a
  // standing tombstone is the mirror describing a mailbox that does not exist. Cleared here,
  // BEFORE the switch, not only in the adopt arm: the case the adopt arm alone would miss is our
  // own completed move whose bookkeeping crashed — the reaper tombstones the instanceless row,
  // and the arrival then classifies as `own_move`/`none`, which adopts nothing. The resurrection
  // delta is emitted after the switch, and the seq allocation stays behind the counter lock the
  // body restore may take — the lock-order rule.
  const resurrected = (await repo.clearDeletedOnAdopt?.(e.messageId)) === true;
  // The husk restore: a `junk_filed`/`expunged` body whose bytes just arrived is refilled under
  // the normal storage-cap accounting; a `storage_cap` husk is standing policy and is refused
  // inside the repo method. Before any recordChange — counter row, then seq row, always.
  if (e.body) {
    await repo.restoreWithheldBody?.(e.messageId, e.body, {
      accountId,
      capBytes: deps.storageCap === UNMETERED_STORAGE_CAP ? null : deps.storageCap,
    });
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
      // `'external'` unconditionally, for an organizer and a reader alike: adopting a message we
      // already hold means it moved to a folder we did not choose, and the only account of that
      // which the wire supports is the person's own hand. The reader seam used to override this
      // with `'peer'`, which read a drag from `ohmail/Reads` into `INBOX` as another install's
      // filing and let a pressed rule undo it — see the block where `readerAttribution` was, and
      // `reconciler.ts#ReconcileAction` for why the field is gone rather than merely unset.
      await repo.upsertFolderState(e.messageId, {
        desiredFolder: to, observedFolder: to, lastSetBy: "external",
      });
      // The tombstone was already cleared before the switch (every arrival shape clears it, not
      // only this arm — see the block above); the `move` change below carries the live entity,
      // so this arm needs no separate resurrection delta.
      await repo.recordAudit(
        accountId,
        "adopt_external",
        { messageId: e.messageId, adopted: to, previousDesired: e.state.desiredFolder },
        { messageId: e.messageId, revertTo: e.state.desiredFolder },
      );
      const adoptSeq = await repo.recordChange({
        accountId, entityType: "message", entityId: e.messageId, op: "move",
        meta: { from: e.state.desiredFolder, to },
      });
      // ── THE OVERRIDE FEEDS THE ROUTE THAT FILED IT ──────────────────────────────────────
      //
      // The one seam where a graduated route is contradicted by the only evidence that settles
      // it: the person moved the mail out of the folder we chose. `null` for every ordinary
      // adoption, so the ingest path pays one indexed read here and nothing else.
      const override = await routing?.recordExternalOverride?.({
        accountId, messageId: e.messageId,
        filedTo: e.state.desiredFolder, movedTo: to, seq: adoptSeq,
      });
      // The demotion switched a promoted rule off, and a client that is not told still shows it
      // ON — the state would be a silent one, which is the failure this seam exists to make
      // visible. This arm holds the ledger transaction, so the delta is owed here.
      for (const ruleId of override?.ruleIds ?? []) {
        await repo.recordChange({
          accountId, entityType: "rule", entityId: ruleId, op: "update", meta: null,
        });
      }
      break;
    }
    case "move": {
      // Leave the pending row as-is (desired != observed); the reconcile runner
      // realizes the physical move outside any transaction.
      await repo.upsertFolderState(e.messageId, e.state);
      break;
    }
  }

  // The resurrection delta for the arms whose switch emits no change of their own: a client
  // holding the tombstone needs one newer-seq entity write to live again ("a LATER create
  // resurrects" — the sync service re-materializes the row for an `update`).
  if (resurrected && e.action.type !== "adopt_external") {
    await repo.recordChange({
      accountId, entityType: "message", entityId: e.messageId, op: "update", meta: null,
    });
  }

  // The two copies are both on record, and the move is still owed — see
  // `ExistingPlan.unexpungedSource`. The instance write happened above the switch: the primary
  // stays at the source, so recording the copy competes for no tuple. The conflict flag is raised
  // HERE, after the switch: `upsertFolderState` writes `conflict` false on every call, so raising
  // it earlier sets a column silently cleared microseconds later — swap these and the ordering
  // test goes red. The state passed is the PENDING one, its fields inert on this path; the
  // unreachable INSERT branch is why they are supplied correctly. THE DURABLE RECORD IS THE
  // INSTANCE ROW, NOT THE FLAG: a non-primary row whose folder is not `desired_folder` is the
  // queryable "an expunge is owed", self-healing via `forgetInstanceAt`; the flag is
  // point-in-time — the next re-observation clears it.
  if (e.unexpungedSource) {
    await repo.setFolderConflict(e.messageId, {
      desiredFolder: e.state.desiredFolder,
      observedFolder: e.state.observedFolder,
      lastSetBy: e.state.lastSetBy,
    });
  }

  return { outcome: e.kind, messageId: e.messageId, action: e.action };
}

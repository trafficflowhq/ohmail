import type { NormalizedMessage, Destination, AttachmentMeta, EmailAddress } from "./types.js";
import type { AuthVerdict, Rule } from "./rules.js";
import type { ClassifierPort } from "./classifier-port.js";

export interface NativeLocator { folder: string; ref: string; } // IMAP ref = `${uidvalidity}:${uid}`

export type ChangeType = "create" | "move" | "flag" | "delete";
export interface Change {
  type: ChangeType;
  locator: NativeLocator;   // where the change was observed
  raw?: Buffer;             // present on 'create' (RFC822 source)
  seen?: boolean;           // read-state for 'flag'
  /**
   * THIS MAIL WAS WRITTEN BY THE USER — it was observed in the mailbox's own Sent folder.
   * Absent ⇒ inbound, which is what every adapter and fake without this flag produces.
   *
   * The ADAPTER sets it, and only the adapter can: the Sent folder's path is server-specific
   * (`Sent`, `Sent Items`, `INBOX/Sent`, `[Gmail]/Sent Mail`), resolved at login from
   * SPECIAL-USE or a name match. Deriving it in the pipeline would put provider folder-naming
   * inside the routing decision, and routing is exactly what this flag turns off:
   * `planChange` returns before the rules, before the Screener and before the money gate,
   * because none of them have a correct answer for mail whose sender is the account owner.
   *
   * Set ONLY on pure creates, never on a correlated `move`. A message correlated as moving
   * INTO Sent is one the user filed there from another folder, and the existing
   * `adopt_external` path is the right outcome for it; suppressing that would strand the row
   * pointing at a UID that no longer exists.
   */
  ownAuthored?: boolean;
}

export interface AdapterPort {
  move(locator: NativeLocator, toFolder: Destination | string): Promise<NativeLocator>;
}

/**
 * Narrow READ-ONLY port over a mailbox's folder layout. `ImapAdapter` implements it beside
 * {@link AdapterPort}, which is why it is declared here with the other ports rather than beside
 * its first consumer: a port is a statement about what an adapter offers, and grouping it with
 * the algorithm that happens to consume it made the adapter name that algorithm's module in a
 * type position on every build.
 *
 * Two methods, and neither writes anything — the seam is deliberately too narrow to file, move or
 * delete a message through.
 */
export interface FolderScanner {
  /** Canonical paths of every folder on the server (INBOX + user folders + our own). */
  listFolders(): Promise<string[]>;
  /** Up to `limit` DISTINCT sender addresses (lowercased) sampled from `folder`. */
  sampleSenders(folder: string, limit: number): Promise<string[]>;
}

/**
 * ── THE MOVE-EVIDENCE DISCRIMINANT. THE WHOLE CONSENT RULE IS ONE SENTENCE ───────────────────
 *
 * > A sender can only cause a locator to **APPEAR**. Only the user (or a client they own) can
 * > cause a stored locator to **DISAPPEAR**. Adoption requires a disappearance.
 *
 * That is what separates "the user filed this message somewhere" from "a stranger delivered
 * bytes". Before this type, `classifyDedup` answered `external_move` — and `commitChange` then
 * flipped `folder_state.desired_folder` and emitted a `move` delta — for ANY observation of a
 * known logical identity in a folder we did not record. A second delivery matching an existing
 * message therefore forged a placement the user had never chosen. The attacker needs no
 * capability at all: they send twice.
 *
 * **And "which folder" is not a substitute.** A user's own provider-side sieve rules can deliver
 * straight into `ohmail/*`, so an appearance in an ohmail folder is not evidence either. An
 * appearance without a correlated disappearance is never an adoption REGARDLESS OF FOLDER.
 *
 * It needs no cryptography, which is why it is a discriminated union of three plain facts:
 *
 *  · `correlated_move` — the adapter's `correlateMoves` paired a vanished known UID with a
 *    re-appeared one and emitted `change.type === "move"`. The strongest evidence there is, and
 *    it was already being COMPUTED and then ignored.
 *  · `verified_absence` — the message's stored PRIMARY `message_instances` row is gone, because
 *    the server reported that UID expunged. UIDVALIDITY makes "UID S no longer exists in folder F
 *    at epoch V" a durable fact rather than an impression.
 *  · `appearance_only` — something showed up. Not evidence of anything, and the reason
 *    `external_copy` exists as an outcome.
 *
 * Two things that look like evidence and are not, recorded so they are not reached for later:
 * **CONDSTORE modseq** orders observations and establishes no causation; and **our own pending
 * -operation record** distinguishes our move from the user's but says nothing about COMPLETION —
 * completion is source absence.
 *
 * ── HOW THAT LAST SENTENCE IS IMPLEMENTED (and claims are contracts) ─────────────────────────
 *
 * `pipeline.ts#planChange` reads this union to tell our move LANDING (`correlated_move` or
 * `verified_absence` — the source really went) from our move's COPY merely APPEARING
 * (`appearance_only`). On the second it does NOT complete the move: the primary instance stays on
 * the source, the destination copy is recorded as a non-primary `message_instances` row, and
 * `folder_state` is left pending. So the duplicate is a stated fact, never re-downloaded, and
 * still OWED — `reconcileFolders` picks the row up again and hands the source locator back to
 * `imap.ts#move`, which finds the copy it already made, writes nothing, and performs the expunge.
 * That INSTANCE ROW is the durable record; `folder_state.conflict` is raised with it but is
 * point-in-time, because `upsertFolderState` clears it on the next re-observation.
 *
 * **The two halves are one change.** Withholding completion is only safe while the adapter reads
 * the destination before it writes; without that pre-check a retry copies the message again on
 * every cycle and then refuses for ever on an ambiguity it created itself. See
 * `pipeline.ts#ExistingPlan.unexpungedSource`, `imap.ts#move`, and the paired pins in the
 * pipeline and move-completion tests.
 *
 * **On a UIDVALIDITY change ALL evidence is void.** A new epoch renumbers, so every remembered
 * UID stops meaning anything and an absence at the old epoch is silence. `apps/worker/src/sync.ts`
 * enforces that where absence is recorded, not here.
 */
export type MoveEvidence =
  | { kind: "correlated_move" }
  | { kind: "verified_absence" }
  | { kind: "appearance_only" };

/** The two members that permit adoption. Exhaustive, so a fourth member is a compile error. */
export function permitsAdoption(evidence: MoveEvidence): boolean {
  switch (evidence.kind) {
    case "correlated_move":
    case "verified_absence":
      return true;
    case "appearance_only":
      return false;
    default: {
      const exhaustive: never = evidence;
      void exhaustive;
      return false;
    }
  }
}

export interface StoredMessage {
  id: string;
  dedupKey: string;
  nativeLocator: NativeLocator;
  /**
   * ── THE FOUR VERIFICATION COLUMNS ───────────────────────────────────────────────────────
   *
   * `message_id_header`, `body_hash`, `subject`, `from_address` as they are STORED. Carried on
   * every lookup result because step 2 of the dual-key lookup has to compare them — a row found
   * under a legacy `mid:`/`body:` key may not be collapsed onto the incoming message on the
   * strength of that key, since that key IS the defect. See
   * `identity.ts#verifiesLegacyIdentity`.
   *
   * Free: `findByDedupKey` already `SELECT *`s the row and threw these away.
   */
  messageIdHeader: string | null;
  bodyHash: string;
  subject: string;
  fromAddress: string;
  /**
   * The conversation this row already belongs to, or null (mail 0026).
   *
   * Carried out of `insertMessage` because that method is an UPSERT: on a dedup conflict it
   * returns the row that was already there. Without this field `commitChange` could not tell a
   * genuine insert from a re-entry and would resolve threading a second time for a message that
   * already has a thread — which for the one message shape that anchors nothing (no Message-ID
   * header at all, so a NULL anchor that `ON CONFLICT` cannot dedup) means a second `threads`
   * row. Free: the returning clause already reads the whole row.
   */
  threadId: string | null;
}

export interface InsertMessageInput {
  accountId: string; mailboxId: string;
  canonical: NormalizedMessage["canonical"];
  dedupKey: string; subject: string; fromAddress: string; date: Date | null;
  nativeLocator: NativeLocator;
  flags: { no_ai: boolean; no_forward: boolean; no_kb: boolean; priority: boolean };
  snippet?: string;                          // sensitivity-redacted preview (never an OTP)
  sensitivityCategory?: string | null;       // SensitivityResult.category surfaced in the DTO
  // BOTH count DOWNLOADABLE parts only — `mime.ts#isRealFile`, i.e. `inline = false`, the same
  // predicate `attachments-service.ts` selects the Files list and download-all with. NOT
  // `normalized.attachments.length`, which counts cid: logos and pixels as files.
  hasAttachments?: boolean;                  // normalized.attachments.some(isRealFile)
  attachmentCount?: number;                  // countRealFiles(normalized.attachments)
  /**
   * The server's OWN read-state at ingest — `!seen` from the adapter's `\Seen` flag.
   *
   * Optional, defaulting to the column default `true`, so every earlier caller and every fake
   * repo keeps compiling. It is not cosmetic: the pipeline used to drop `Change.seen` entirely,
   * so the first sync of a real mailbox filed mail the user read years ago under "New" — the
   * `new_for_you` view is literally `messages.unread = true`. The truth is on the server and
   * we were throwing it away one line before writing the row.
   */
  unread?: boolean;
  /**
   * `messages.auth_verdict` (mail 0028) — what this message's own provider reported about its
   * claimed author, as `rules.ts#authVerdictFromHeaders` read it at ingest.
   *
   * OPTIONAL, and its absence is NOT the same shape of default as `unread` above. A caller that
   * omits it leaves the column NULL, and NULL resolves to `"unauthenticated"` — "nobody looked"
   * — which is the permissive member of the union (`rules.ts#AuthVerdict`). So an omission can
   * never demote a message, and every fake repo and every earlier caller keeps its exact
   * behaviour. `planChange` always states it; nothing else inserts messages.
   */
  authVerdict?: AuthVerdict;
}

export interface FolderStateRow { desiredFolder: string; observedFolder: string; lastSetBy: "us" | "external"; }

/**
 * The `\Seen` analogue of {@link FolderStateRow} — the read-state desired state (mail 0024).
 *
 * Same three fields for the same reason: the API may never open IMAP, so a
 * read/unread click records intent and the worker performs the network write. `lastSetBy`
 * carries the user-wins rule — `reconcileMailbox` refuses to push a row it did not author, so a
 * message marked unread again in Apple Mail is never silently re-read by us.
 */
export interface FlagStateRow { desiredSeen: boolean; observedSeen: boolean; lastSetBy: "us" | "external"; }

/** The stored, sensitivity-safe body persisted to `message_bodies` (redacted when sensitive). */
export interface MessageBodyInput {
  text: string;
  html: string | null;
  headers: Record<string, string[]>;
}

/**
 * A client-visible mutation to append to the delta `change_log`. The
 * pipeline emits ONE of these per mutation via `repo.recordChange`, which — on the
 * DrizzleRepo — allocates the gap-free per-account seq and inserts the row inside
 * the AMBIENT transaction. `entityType` mirrors the db-layer
 * `EntityType`; kept as a string here so `ports.ts` stays free of a db import.
 */
export interface RepoChangeInput {
  accountId: string;
  entityType: string;                        // message | routing_decision | approval | message_state | folder | …
  entityId: string;
  op: "create" | "update" | "move" | "delete";
  meta?: { from: string | null; to: string } | null;
}

/** An already-ingested ancestor named by a header candidate. */
export interface ThreadParent {
  messageId: string;
  /**
   * Null for mail ingested before threading existed and not yet backfilled. The resolver does NOT write to it —
   * it falls through to the anchor, which the parent will derive identically when the backfill
   * reaches it. See `resolveThread`'s "why outcome 2 does not reach over" note: that write would
   * be ingest's only lock on a pre-existing `messages` row, and it deadlocks against the
   * backfill's `FOR UPDATE` page.
   */
  threadId: string | null;
}

/** The find-or-create input for one conversation, keyed on its root Message-ID. */
export interface ThreadUpsertInput {
  accountId: string;
  /** Null anchors nothing: NULLs are distinct in the unique index, so each is a singleton. */
  rootMessageIdHeader: string | null;
  subject: string;
  participants: EmailAddress[];
  lastMessageAt: Date | null;
}

/** `created` is the DATABASE's answer (`xmax = 0`), not this process's guess. */
export interface ThreadUpsertResult { id: string; created: boolean; }

/** What one joining message contributes to a thread it did not create. */
export interface ThreadMergeInput {
  participants: EmailAddress[];
  lastMessageAt: Date | null;
}

/**
 * WHAT `insertMessage` DID, NOT JUST WHAT ROW CAME BACK.
 *
 * `insertMessage` is an UPSERT on `UNIQUE (mailbox_id, dedup_key)`, so it has always had two
 * outcomes and returned one type. `created: false` means **a concurrent or earlier ingest owns
 * this row and every child row that hangs off it** — attachments, the body, the thread, the
 * `change_log` entries, the folder state — and the caller must write NOTHING.
 *
 * ── THE RACE THIS EXISTS FOR, MEASURED ON REAL POSTGRES ─────────────────────────────────────
 *
 * Two ingests of one message can both call `planChange` before either commits, so BOTH plan
 * `new`. The loser's `INSERT … ON CONFLICT DO NOTHING` blocks on the winner's uncommitted row,
 * then returns nothing once the winner commits, and the row it gets back from the re-read is the
 * WINNER'S. The `messages` row therefore converges correctly — that much of the earlier analysis
 * is right, and the loser never destroys the winner's row.
 *
 * What did not converge is everything `commitChange` does AFTER that call, because the return
 * type could not express which branch had been taken. Measured, two concurrent cycles over one
 * message: **two `attachments` rows for one attachment** (`insertAttachments` has no conflict
 * target and the table has no natural key) and **two `message`/`create` rows in `change_log`** for
 * one id — a convergence break, the client told to create the same message twice. A
 * racing loser's `upsertFolderState` also resets `folder_state.conflict` to false, which silently
 * erases the move-completion record written one field over.
 *
 * The information was never missing — `drizzle-repo.ts` already branches on whether `RETURNING`
 * came back empty. It was computed and thrown away at the return type, which is why no test could
 * see it. It is NOT an `xmax` question: for `ON CONFLICT DO NOTHING` an empty `RETURNING` IS the
 * answer, unlike `upsertThread`'s `DO UPDATE`, where `RETURNING` always fires and `(xmax = 0)` is
 * the only way to ask.
 */
export type InsertedMessage = StoredMessage & { created: boolean };

export interface RepoPort {
  findByDedupKey(mailboxId: string, dedupKey: string): Promise<StoredMessage | null>;
  /**
   * Insert a message, or return the row a concurrent/earlier ingest already wrote.
   *
   * **Check {@link InsertedMessage.created} before writing anything else.** The winner owns the
   * whole tail; a loser that proceeds duplicates every child row it touches.
   */
  insertMessage(input: InsertMessageInput): Promise<InsertedMessage>;
  insertMessageBody(messageId: string, body: MessageBodyInput): Promise<void>;
  /**
   * Persist attachment METADATA (never bytes) for a message. Called by the pipeline
   * in the SAME transaction as `insertMessage` (atomic ingest — no orphan
   * attachment without its message). No-op when `rows` is empty.
   */
  insertAttachments(messageId: string, accountId: string, rows: AttachmentMeta[]): Promise<void>;
  getFolderState(messageId: string): Promise<FolderStateRow | null>;
  upsertFolderState(messageId: string, s: FolderStateRow): Promise<void>;
  /**
   * Repoint the message at `locator` — `messages.native_locator` AND its PRIMARY
   * `message_instances` row, in that one call.
   *
   * Both writes here and not at the call sites, because `native_locator` is now a MIRROR of the
   * primary instance and every existing caller (`applyReconcileAction`, `reconcileFolders`,
   * `commitChange`) already goes through this method. Splitting them would mean three places to
   * remember, and the failure of forgetting one is silent: the instance table is what
   * `listKnownLocators` reads, so a stale primary makes the adapter treat a UID that no longer
   * exists as known and never fetch the one that replaced it.
   */
  updateLocator(messageId: string, locator: NativeLocator): Promise<void>;

  // ── Physical identity: `message_instances` ──
  //
  // ONE logical message can legitimately occupy SEVERAL physical locators at once — the Sent twin
  // of a self-CC, a mailing list echo, a user's own IMAP copy, and (the case this slice is about)
  // a second delivery of the same bytes. `messages.native_locator` can only name one of them, so
  // every other one used to be invisible to the known-set and its body was re-fetched on every
  // cycle for ever. `own_copy` escaped that only because the Sent folder has a UID WATERMARK —
  // and INBOX has none.

  /**
   * Record a NON-PRIMARY physical instance: a locator this logical message also occupies.
   *
   * Idempotent on `(mailbox_id, folder, uidvalidity, uid)`; a re-observation only advances
   * `last_seen_at`. It never re-attributes a locator that another message already claims — a UID
   * is not reused inside an epoch, so a conflict with a different `message_id` is an anomaly, and
   * silently repointing it would be a write an attacker could aim.
   *
   * **This is what terminates the re-fetch loop.** The locator joins `listKnownLocators`, so the
   * next `changesSince` does not present it as unknown and does not pull its body again.
   */
  recordInstance(messageId: string, locator: NativeLocator): Promise<void>;
  /**
   * Is this message's stored PRIMARY instance KNOWN TO BE GONE — the `verified_absence` half of
   * {@link MoveEvidence}?
   *
   * True only when the row names a native locator AND no `message_instances` row claims it as
   * primary. Both halves are load-bearing. A row with `native_locator IS NULL` has no instance to
   * be missing, so answering `true` for it would manufacture adoption evidence out of an
   * incomplete row — and rows like that exist (seeds, backlog fixtures). The absence itself is
   * created by `apps/worker/src/sync.ts` consuming the adapter's `deletes`, which is the only
   * place a disappearance is ever observed.
   */
  primaryInstanceVanished(messageId: string): Promise<boolean>;
  /**
   * Upgrade a verified legacy `mid:`/`body:` key to `fp1:` — step 2 of the dual-key lookup, in the
   * SAME transaction as the rest of the commit.
   *
   * Guarded on the OLD value, so a concurrent upgrade is a no-op rather than a second write, and
   * guarded against an existing `fp1:` row for the same mailbox, so it cannot raise 23505 and take
   * the whole ingest transaction with it. Returns whether the row moved.
   */
  upgradeDedupKey(messageId: string, from: string, to: string): Promise<boolean>;
  /**
   * Flag `folder_state.conflict` WITHOUT touching desired/observed/last_set_by — the whole
   * observable effect of an `external_copy`.
   *
   * A separate method and not a field on {@link FolderStateRow}, because `upsertFolderState`
   * writes `conflict: false` on every call: routing the conflict through it would mean every
   * later reconcile silently cleared the record. `s` seeds the row only when there is none.
   */
  setFolderConflict(messageId: string, s: FolderStateRow): Promise<void>;
  listRules(accountId: string): Promise<Rule[]>;
  knownSenders(accountId: string): Promise<Set<string>>;
  recordAudit(accountId: string, action: string, payload: unknown, inverse: unknown): Promise<void>;
  /** Append a client-visible change to the delta log in the ambient transaction. */
  recordChange(input: RepoChangeInput): Promise<bigint>;

  // ── Threading. All three run inside the caller's transaction. ──

  /**
   * The closest already-ingested ancestor named by `candidates`, in CANDIDATE ORDER, or null.
   *
   * **Account-scoped, and that is a security boundary rather than a filter.** A Message-ID is
   * chosen by whoever sent the mail, so an unscoped lookup would let a stranger name another
   * account's header and have their message adopt that account's thread — the account-isolation boundary.
   */
  findThreadParent(accountId: string, candidates: readonly string[]): Promise<ThreadParent | null>;
  /**
   * Find-or-create the conversation anchored at `rootMessageIdHeader`.
   *
   * Must be a single `INSERT … ON CONFLICT (account_id, root_message_id_header)` and not a
   * SELECT-then-INSERT: two mailboxes of one account draining in parallel both miss the SELECT
   * and both insert, which splits one conversation in two with nothing to say so.
   */
  upsertThread(input: ThreadUpsertInput): Promise<ThreadUpsertResult>;
  /** Fold a joining message into an existing thread. False ⇒ nothing moved, so no change row. */
  mergeThreadMessage(threadId: string, input: ThreadMergeInput): Promise<boolean>;
  /**
   * Attach a message to a thread. False ⇒ it already had one and nothing was written — the
   * `WHERE thread_id IS NULL` guard is what makes a re-run and a concurrent second writer
   * no-ops rather than reassignments.
   */
  setMessageThread(messageId: string, threadId: string): Promise<boolean>;
}

// ── Routing / approval persistence for the AI branch ──

export interface RoutingDecisionInput {
  accountId: string;
  messageId: string;
  inputProvenance: "rule" | "header" | "screener" | "ai";
  matchedRuleId?: string | null;
  destination: string;
  confidence?: number | null;
  rationale?: string | null;
  spam?: boolean;
  status: "auto_applied" | "pending_approval" | "approved" | "rejected";
}

export interface ApprovalInput {
  accountId: string;
  kind: "routing";
  messageId?: string | null;
  routingDecisionId?: string | null;
  action: string;
  summary?: string;
  payload?: unknown;
  confidence?: number | null;
  expiresAt?: Date | null;
}

/**
 * Persistence for the AI `unclear` branch. Implemented by DrizzleRepo.
 * `isGraduated` reads the `graduations` table written by
 * LearningService — a table-level seam, no code cycle. The write methods run
 * inside the same transaction the pipeline commits under; the pipeline records the
 * corresponding `change_log` rows via `repo.recordChange` (one delta sink).
 */
export interface RoutingPort {
  recordRoutingDecision(d: RoutingDecisionInput): Promise<{ id: string }>;
  /** Account-scoped: the `graduations` unique key is (accountId, patternKey, action),
   *  so a pattern that graduated for one account must NOT read as graduated for another. */
  isGraduated(accountId: string, patternKey: string, action: "route"): Promise<boolean>;
  enqueueApproval(a: ApprovalInput): Promise<{ id: string }>;
}

/**
 * The MONEY half of the AI gate — the narrow port the pipeline sees.
 *
 * It is a PORT and not a decorator around {@link ClassifierPort} on purpose, and that is what
 * rules the decorator out: `pipeline.ts` has no try/catch around `classifier.classify`, so a
 * refusal expressed as a throw would abort the whole message's ROUTING instead of degrading it
 * to rules-only. A boolean cannot do that.
 *
 * Hence the two contractual properties, both of which are asserted rather than asserted-to:
 *
 *  · **`tryDebit` never throws.** `false` is the only way it says no.
 *  · **Absent `credits` means UNMETERED, not refused.** The free desktop tier runs this exact
 *    pipeline against a local model with no account and no ledger, and every test that predates
 *    the gate injects no gate at all. `undefined` therefore has to mean "do not ask", and the proof
 *    that it does is a test comparing whole plan objects, not a flag.
 *
 * ONE method, and the missing `refund` is the point. The pipeline used to refund a classifier
 * fault; it no longer does, because the fault RETHROWS, which leaves the message un-ingested
 * and the sync cursor unadvanced, so the next cycle re-plans the same mail against a debit
 * source already on record — a free retry. Refunding as well handed the work over for nothing.
 * Compensation on this path is the retry, so the port is exactly this literal
 * `{ tryDebit(source) }` shape and a one-method test double is a complete implementation rather
 * than a convenient partial one.
 *
 * The production implementation is the AI credit gate in `@trafficflow/db`, which is wider
 * (`spend`, `refund`, `refundAttempt`) for the call sites that need more; structural typing means
 * the pipeline still only ever sees the one method it is allowed to use.
 */
export interface CreditGate {
  /** `true` ⇒ the AI branch may run (charged now, or already paid for); `false` ⇒ skip it. */
  tryDebit(source: string, meta?: Record<string, unknown>): Promise<boolean>;
}

/**
 * Pipeline dependencies. `classifier`/`routing` are optional — when BOTH are absent
 * the pipeline behaves exactly as the pre-AI baseline (byte-identical routing), which is the gate
 * that keeps the prior tests green. The AI branch fires only on the rules `unclear`
 * residue AND when the message is not sensitive (`!flags.no_ai`) AND when `credits`
 * permits the spend — see {@link CreditGate}.
 */
export interface PipelineDeps {
  repo: RepoPort;
  adapter: AdapterPort;
  accountId: string;
  mailboxId: string;
  classifier?: ClassifierPort;
  routing?: RoutingPort;
  /** The AI spend gate. Absent ⇒ unmetered (desktop tier, and every test that predates it). */
  credits?: CreditGate;
  clock?: () => Date;
}

import type { SpendOutcome, SpendPort } from "@trafficflow/db";
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
   * This mail was written by the user — observed in the mailbox's own Sent folder. Absent means
   * inbound, what every adapter and fake without the flag produces. The ADAPTER sets it, and only
   * the adapter can: the Sent folder's path is server-specific, resolved at login — deriving it
   * in the pipeline would put provider folder-naming inside the routing decision, and routing is
   * exactly what this flag turns off: `planChange` returns before the rules, the Screener and the
   * money gate, because none has a correct answer for mail whose sender is the account owner. Set
   * ONLY on pure creates, never on a correlated `move`: a message correlated as moving INTO Sent
   * is the user filing mail, and `adopt_external` is the right outcome.
   */
  ownAuthored?: boolean;
  /**
   * This mail is in a folder the customer made — passive presence. Absent means one of the
   * folders ohmail organizes. The ADAPTER sets it, for {@link ownAuthored}'s reason: it is a fact
   * about the server's folder inventory, and a pipeline deriving it from the NAME would get Sent
   * wrong on every no-SPECIAL-USE server. What it turns off is ORGANIZING and nothing else:
   * `planChange` returns with `desired` equal to the arrival folder — stored, threaded,
   * searchable, and no rule, Screener decision, AI proposal or IMAP move is ever computed. Their
   * filing is theirs. Set ONLY on pure creates: a correlated move INTO one of these folders is
   * the customer filing mail we hold, and `adopt_external` already follows their hand.
   */
  passive?: boolean;
  /**
   * When the server received this message — IMAP `INTERNALDATE`, absent for adapters that carry
   * none. The `Date:` header is sender-written; this is the one date a sender cannot choose,
   * which is why the field exists: the screening cutoff decides whether a message keeps its
   * arrival folder, and a stranger who could pick that date could put `Date: 2019` on a fresh
   * delivery and reach the Ohbox. ABSENT means the cutoff does not apply — the gate, like fresh
   * mail; the header-date fallback was a security-review finding and is gone rather than bounded.
   * NOT combined with the header date the way `arrivalKey` combines them for ordering: a forged
   * early header would win the minimum. INTERNALDATE alone, never a mix.
   */
  internalDate?: Date;
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
 * The move-evidence discriminant. The consent rule in one sentence: a sender can only cause a
 * locator to APPEAR; only the user can cause a stored locator to DISAPPEAR; adoption requires a
 * disappearance. Before this type, any observation of a known identity in an unrecorded folder
 * was adopted — a second delivery forged a placement. "Which folder" is not a substitute: sieve
 * rules can deliver into `ohmail/*`. Three facts: `correlated_move`, `verified_absence`,
 * `appearance_only` (not evidence — why `external_copy` exists). Two false friends: CONDSTORE
 * modseq proves nothing; our own pending record says nothing about COMPLETION — completion is
 * source absence. On a UIDVALIDITY change all evidence is void.
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
   * The four verification columns — `message_id_header`, `body_hash`, `subject`, `from_address`
   * as STORED. Carried on every lookup result because step 2 of the dual-key lookup must compare
   * them: a row found under a legacy `mid:`/`body:` key may not be collapsed onto the incoming
   * message on the strength of that key, since that key IS the defect
   * (`identity.ts#verifiesLegacyIdentity`). Free: `findByDedupKey` already selects the row and
   * threw these away.
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
  /**
   * The From header's display name — `messages.from_name` (mail 0057).
   *
   * OPTIONAL, defaulting to NULL, which is the column's own default — the same compatibility
   * shape as `to`/`cc` below, so every fake repo and every earlier caller keeps its behaviour.
   * The parser has carried this on `NormalizedMessage.from.name` for its whole life; ingest
   * persisted only `.address`, the projection hardcoded `name: null`, and every message reached
   * the reader as a bare address. This field is what carries the name the last step.
   */
  fromName?: string | null;
  /**
   * `To:` and `Cc:`, parsed — `messages.to_addresses`/`cc_addresses`. OPTIONAL, defaulting to
   * `[]`, exactly the columns' own default — so every fake repo keeps its behaviour and an
   * omission is indistinguishable from what the database would have written. The columns existed
   * and the DTO always projected them, but nothing on the Cloud ingest path ever wrote them —
   * every Cloud message reached the reader as `to: []`, and no test could see it: a defaulted
   * column and a message addressed to nobody are the same value on the wire. The shape is
   * `EmailAddress[]` because that is what the projection reads and what the sidecar's mirror
   * writes into the same two columns — one on-disk shape, written from two directions.
   */
  to?: EmailAddress[];
  cc?: EmailAddress[];
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

/**
 * WHO put this message where it is — the value every pass that could move it again consults.
 * `"us"` — THIS install decided; required by every unpressed mover, and the durable record of
 * which install organized. `"external"` — the USER placed it by hand; the reconciler and all four
 * retro passes leave it alone, permanently. `"peer"` — ANOTHER install of this account placed it,
 * in a folder ohmail organizes, observed by a READER; reachable only by `rule-retro`, on a press.
 * No migration and no CHECK: the column is `text NOT NULL` — which is why an unrecognised value
 * must never map onto `"us"`: the fail-safe direction is to leave a row alone, not hand it to a
 * mover.
 */
export type FolderAttribution = "us" | "external" | "peer";

export interface FolderStateRow {
  desiredFolder: string;
  observedFolder: string;
  lastSetBy: FolderAttribution;
  /**
   * The physical folder that SATISFIES `desiredFolder` when the two legitimately differ — the
   * spam verdict's shape: the verdict names the pile (`ohmail/Quarantine`) and the reconciler
   * files into the provider's native `\Junk`. The completion carries `observedFolder = <junk
   * path>` — the server's truth, never rewritten — and this field says that truth is the desire
   * FULFILLED, not a divergence owed a move. `reconcileStatusFor` answers `reconciled` only when
   * `observedFolder` EQUALS this value; any later write omitting the field recomputes from the
   * plain pair — a user's re-file goes `pending` as before. Optional; omitted means the
   * historical derivation.
   */
  satisfiedBy?: string | null;
}

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
 * What the account's managed storage cap means for THIS body write — resolved by the caller
 * (`commitChange`, from the required `CommitDeps.storageCap`) and enforced by the adapter in the
 * SAME transaction as the insert. `capBytes: null` is UNMETERED, and it is a value somebody TYPED
 * (`UNMETERED_STORAGE_CAP` at a composition root), never an absent-config default — the
 * declaration-not-inference rule. A number is the cap in bytes; at or over it the adapter stores
 * a WITHHELD row (empty text, no html, the real headers, `withheld_reason = 'storage_cap'`) and
 * everything else about ingest proceeds unchanged.
 */
export interface BodyStorageContext {
  accountId: string;
  capBytes: number | null;
}

/** What the adapter did with the body's CONTENT. Organizing is identical either way. */
export type BodyStorageOutcome = "stored" | "withheld";

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
 * What `insertMessage` DID, not just what row came back. An UPSERT on `UNIQUE (mailbox_id,
 * dedup_key)`; `created: false` means a concurrent or earlier ingest owns this row and every
 * child row, and the caller must write NOTHING. The race, measured on real Postgres: two ingests
 * both plan `new`, the loser's re-read holds the WINNER'S row — the `messages` row converges, and
 * everything afterwards did not: two `attachments` rows for one attachment, two `create` deltas
 * for one id, the loser's `upsertFolderState` erasing the winner's `conflict`. The information
 * was computed and thrown away at the return type. Not an `xmax` question: for `DO NOTHING`, an
 * empty `RETURNING` IS the answer.
 */
export type InsertedMessage = StoredMessage & { created: boolean };

export interface RepoPort {
  findByDedupKey(mailboxId: string, dedupKey: string): Promise<StoredMessage | null>;
  /**
   * A stored message of THIS mailbox carrying this Message-ID, spelled as ingest stores it —
   * bracket-stripped, case preserved. Oldest row wins, so observations converge. One caller, and
   * the gate is the contract: the own-sent twin lookup, reached only for a `Change.ownAuthored`
   * create — there, and only there, the Message-ID alone may name a row: everything in that
   * folder was written by the user's own clients. It exists because Exchange Online re-renders
   * the copy it files beside the byte-exact one the send path APPENDs, defeating both fingerprint
   * lookups — a Microsoft-hosted message ingested twice. For INBOUND mail the Message-ID is a string
   * a stranger types; never call this outside the gate — the forgery pin goes red when it widens.
   */
  findByMessageIdHeader(accountId: string, mailboxId: string, messageIdHeader: string): Promise<StoredMessage | null>;
  /**
   * Insert a message, or return the row a concurrent/earlier ingest already wrote.
   *
   * **Check {@link InsertedMessage.created} before writing anything else.** The winner owns the
   * whole tail; a loser that proceeds duplicates every child row it touches.
   */
  insertMessage(input: InsertMessageInput): Promise<InsertedMessage>;
  /**
   * Persist the body — or, at the storage cap, the honest husk of one. The adapter reserves
   * `bodyBytesOf(body)` against `storage.capBytes` and the body insert in ONE transaction;
   * a decline writes the withheld row (headers kept, content empty,
   * `withheld_reason='storage_cap'`) so organizing and the mirror keep working. The IMAP
   * original is untouched either way.
   */
  insertMessageBody(
    messageId: string, body: MessageBodyInput, storage: BodyStorageContext,
  ): Promise<BodyStorageOutcome>;
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
   * `message_instances` row, in one call. Both writes here and not at the call sites, because
   * `native_locator` is a MIRROR of the primary instance and every existing caller already goes
   * through this method. Splitting them would mean three places to remember, and forgetting one
   * is silent: the instance table is what `listKnownLocators` reads, so a stale primary makes the
   * adapter treat a dead UID as known and never fetch the one that replaced it.
   */
  updateLocator(messageId: string, locator: NativeLocator): Promise<void>;
  /**
   * Clear `messages.deleted_at` because the message RE-APPEARED in a watched folder (mail 0065) —
   * a restore from Trash or Junk in the user's own client, a second delivery, or our own
   * completed move whose bookkeeping crashed. Called for EVERY existing-message arrival shape,
   * not only the adopt arm: the own-move case adopts nothing, and gating the clear on adoption
   * left that message deleted for ever while it sat in its destination. The caller owes the
   * resurrection delta for arms whose switch emits none. Returns whether anything was cleared.
   * Optional so every fake repo keeps compiling.
   */
  clearDeletedOnAdopt?(messageId: string): Promise<boolean>;
  /**
   * Refill a `junk_filed`/`expunged` husk from an arrival that carries the bytes (mail 0065) —
   * the message re-appeared in a watched folder, so the mirror owes it its content back. Runs
   * under the normal storage-cap accounting (the rolling-window reserve; at the pathological
   * ceiling the husk stands, honestly). A `storage_cap` husk is standing POLICY and is refused
   * here — the cap's restore is a ratified pass of its own, not a side effect of a duplicate
   * delivery. Returns whether content was written. OPTIONAL so every fake keeps compiling.
   */
  restoreWithheldBody?(
    messageId: string, body: MessageBodyInput, storage: BodyStorageContext,
  ): Promise<boolean>;

  // ── Physical identity: `message_instances` ──
  //
  // ONE logical message can legitimately occupy SEVERAL physical locators at once — the Sent twin
  // of a self-CC, a mailing list echo, a user's own IMAP copy, and (the case instances exist for)
  // a second delivery of the same bytes. `messages.native_locator` can only name one of them, so
  // every other one used to be invisible to the known-set and its body was re-fetched on every
  // cycle for ever. `own_copy` escaped that only because the Sent folder has a UID WATERMARK —
  // and INBOX has none.

  /**
   * Record a NON-PRIMARY physical instance: a locator this logical message also occupies.
   * Idempotent on `(mailbox_id, folder, uidvalidity, uid)`; a re-observation only advances
   * `last_seen_at`. It never re-attributes a locator another message claims — a UID is not reused
   * inside an epoch, so a conflict with a different `message_id` is an anomaly, and silently
   * repointing it would be a write an attacker could aim. This is what terminates the re-fetch
   * loop: the locator joins `listKnownLocators`, so the next `changesSince` does not present it
   * as unknown and does not pull its body again.
   */
  recordInstance(messageId: string, locator: NativeLocator): Promise<void>;
  /**
   * Is this message's stored PRIMARY instance known to be gone — the `verified_absence` half of
   * {@link MoveEvidence}? True only when the row names a native locator AND no
   * `message_instances` row claims it as primary. Both halves are load-bearing: a row with
   * `native_locator IS NULL` has no instance to be missing, so answering `true` for it would
   * manufacture adoption evidence out of an incomplete row — and such rows exist (seeds, backlog
   * fixtures). The absence itself is created by `sync.ts` consuming the adapter's `deletes`, the
   * only place a disappearance is ever observed.
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
   * Is one of `candidates` the Message-ID this account's AWAY RESPONDER minted for a reply it
   * sent? Account-scoped, for {@link findThreadParent}'s reason. The question exists so the
   * pipeline can tell a bounce the reader must see from a bounce the product already handles
   * itself, and the answer must be a fact a stranger cannot manufacture: a delivery report quotes
   * the failed message's headers, so `Auto-Submitted: auto-replied` is readable straight out of a
   * report anybody can write — the minted `<uuid@domain>` is a value THIS account generated and
   * stored before it dialled. `candidates` arrive bracket-free and lower-cased while the ledger
   * stores the id verbatim; the implementation normalises — a caller must not.
   */
  isOwnAwayReply(accountId: string, candidates: readonly string[]): Promise<boolean>;
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
  /**
   * A person moved a message AWAY from where a graduated route filed it: record the override,
   * and demote the route once enough of them stand inside the window.
   *
   * `null` ⇒ nothing to contradict (no graduated route filed it there — every ordinary
   * adoption) or the move is a replay. OPTIONAL because a shell with no routing port never
   * auto-applies and so can never produce an override: absent means "this install has no such
   * thing", never "refuse".
   */
  recordExternalOverride?(input: ExternalOverrideInput): Promise<ExternalOverrideOutcome | null>;
}

/** One externally observed move, as the override seam sees it. */
export interface ExternalOverrideInput {
  accountId: string;
  messageId: string;
  /** The folder the message was filed INTO by the route now being contradicted. */
  filedTo: string;
  /** Where the person put it. Carried for the log line; never part of the pattern. */
  movedTo: string;
  /** The adoption's `change_log` seq — what makes a replay of THIS move count once. */
  seq: bigint;
}

export interface ExternalOverrideOutcome {
  patternKey: string;
  /** Overrides standing inside the window, this one included. */
  overrides: number;
  demoted: boolean;
  /** Promoted rules the demotion switched off. The caller owes each one a `rule` delta. */
  ruleIds: readonly string[];
}

/**
 * The MONEY half of the AI gate — the narrow port the pipeline sees. A PORT and not a decorator
 * around {@link ClassifierPort}: the pipeline has no try/catch around `classify`, so a
 * refusal-as-throw would abort the whole message's routing instead of degrading to rules-only.
 * Two properties: `tryDebit` never throws — `false` is the only no; absent `credits` means
 * UNMETERED, not refused. ONE method, and the missing `refund` is the point: a classifier fault
 * RETHROWS, so the retry is free against the recorded attempt — refunding as well handed the work
 * over for nothing. `SpendPort` and not a boolean: six verdicts, read once and exhaustively in
 * {@link aiSpendPermitted}, so a new verdict is a compile error rather than a silent `false`.
 */
export type CreditGate = Pick<SpendPort, "spend">;

/**
 * May the AI branch run — the INGEST path's reading of a spend verdict, and only its. The other
 * call sites read the same six words differently and must: the Screener waits out an `inflight`,
 * the drafting path answers 402/409/503. Here there is exactly one thing to do with a no — file
 * the message on the deterministic rules — so the reading is a boolean. `ok` and `duplicate`
 * proceed: the first charged this attempt, the second found the work already paid for — refusing
 * a duplicate would charge twice or drop routing already bought. `inflight` does NOT proceed:
 * another caller is running the model for this exact mail, and proceeding buys a second paid call
 * for one credit.
 */
export function aiSpendPermitted(outcome: SpendOutcome): boolean {
  switch (outcome.verdict) {
    case "ok":
    case "duplicate":
      return true;
    case "insufficient":
    case "refused":
    case "inflight":
    case "fault":
      return false;
    default: {
      // A verdict nobody here has read. Unreachable while the port has six, and a compile error
      // the day it has seven — which is why every arm above is spelled out.
      const unread: never = outcome;
      return unread;
    }
  }
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

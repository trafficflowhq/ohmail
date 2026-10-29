import type {
  AdapterPort, RepoPort, RoutingPort, StoredMessage, MessageIdCandidate, InsertedMessage, InsertMessageInput,
  FolderStateRow, NativeLocator, MessageBodyInput, BodyStorageContext, BodyStorageOutcome, RepoChangeInput,
  RoutingDecisionInput, ApprovalInput, AttachmentMeta,
  ThreadParent, ThreadUpsertInput, ThreadUpsertResult, ThreadMergeInput,
} from "../src/ports.js";
import type { Destination, EmailAddress } from "../src/types.js";
import type { FolderCompletion } from "../src/adapters/drizzle-repo.js";
import type { MessageSearchInput } from "../src/message-search.js";
import type { KnownSenders, Rule } from "../src/rules.js";
import type { ContactSource } from "../src/ports.js";
import { normalizeMime } from "../src/mime.js";
import { fingerprintDedupKey, foldMessageIdDomain, messageFingerprint } from "../src/identity.js";
import { isSentFolderPath } from "../src/types.js";
import type { CorrespondentEvidence } from "../src/correspondent.js";

/**
 * The `dedup_key` ingest will write for these raw bytes — DERIVED, never spelled out.
 *
 * Tests used to hardcode `"mid:m-1@example.com"`. A literal like that is a second implementation of
 * the key, and when the format changed every one of them became a test asserting the OLD behaviour
 * while looking like it asserted the new. Going through the real `normalizeMime` +
 * `messageFingerprint` means a test can only pass if it is asking for the key the pipeline actually
 * computed — including every field the fingerprint reads.
 */
export async function dedupKeyFor(raw: Buffer | string): Promise<string> {
  return fingerprintDedupKey(messageFingerprint(await normalizeMime(raw)));
}

export class FakeAdapter implements AdapterPort {
  moves: Array<{ from: NativeLocator; to: string }> = [];
  /** Optional probe: records whether `move` was ever called while a flag is set (tx-boundary tests). */
  onMove?: () => void;
  private uid = 1000;
  async move(locator: NativeLocator, toFolder: Destination | string): Promise<NativeLocator> {
    this.onMove?.();
    this.moves.push({ from: locator, to: String(toFolder) });
    return { folder: String(toFolder), ref: `1:${++this.uid}` }; // new UID after a move
  }
}

interface Row { stored: StoredMessage; input: InsertMessageInput; }

/** The in-memory shape of one `threads` row. */
export interface FakeThread {
  id: string;
  accountId: string;
  rootMessageIdHeader: string | null;
  subject: string;
  participants: EmailAddress[];
  lastMessageAt: Date | null;
}

/** One `message_instances` row, as the fake keeps it. See {@link FakeRepo.instances} for the key. */
export interface FakeInstance {
  messageId: string;
  folder: string;
  ref: string;
  isPrimary: boolean;
}

export class FakeRepo implements RepoPort {
  rows = new Map<string, Row>();
  /**
   * `message_instances`, keyed `mailboxId` NUL `folder` NUL `ref` — the fake's stand-in for
   * `UNIQUE (mailbox_id, folder, uidvalidity, uid)`. `ref` carries the epoch, so the epoch is part
   * of the key here exactly as it is in the real one.
   */
  instances = new Map<string, FakeInstance>();
  /** Messages whose `folder_state.conflict` has been raised (the `external_copy` conflict). */
  conflicts = new Set<string>();
  folder = new Map<string, FolderStateRow>();
  bodies = new Map<string, MessageBodyInput>();
  attachments = new Map<string, AttachmentMeta[]>();   // messageId -> metadata rows
  audits: Array<{ action: string; payload: unknown; inverse: unknown }> = [];
  changes: Array<RepoChangeInput & { seq: bigint }> = [];
  rules: Rule[] = [];
  senders = new Set<string>();
  /** The subset of {@link senders} an automatic writer taught (`contacts.source = 'inferred'`). */
  inferredSenders = new Set<string>();
  /* The minted ids on this account's `away_replies` ledger, bracket-free and keyed the way the
     adapter keys them — {@link foldMessageIdDomain}, domain folded and `id-left` left alone. It
     said "lower-cased exactly as `parseMessageIds` writes" and folded the WHOLE candidate, which
     is a normalisation neither the adapter nor `parseMessageIds` performs: the double made the
     lookup case-insensitive where production was case-SENSITIVE, so every test of this path was
     green while a mixed-case mailbox domain missed on the live one. */
  awayReplyMintedIds = new Set<string>();
  /** `away_sender_state.undeliverable_at`, by sender — the fake's whole away state. */
  awayUndeliverable = new Map<string, Date>();
  /** Senders with an `away_sender_state` row at all; only these can be stamped. */
  awaySenders = new Set<string>();
  /** Which correspondent each minted id was sent to — the ledger's `sender` column. */
  awayReplySenderOf = new Map<string, string>();
  threads = new Map<string, FakeThread>();
  private byDedup = new Map<string, string>();
  private seq = 0;
  private threadSeq = 0;
  private changeSeq = 0n;

  private key(mailboxId: string, dedupKey: string): string {
    return `${mailboxId} ${dedupKey}`;
  }

  async findByDedupKey(mailboxId: string, dedupKey: string): Promise<StoredMessage | null> {
    const id = this.byDedup.get(this.key(mailboxId, dedupKey));
    if (!id) return null;
    return { ...this.rows.get(id)!.stored };
  }

  /**
   * `RepoPort.findByMessageIdHeader`: the rows under one id, those with an instance in the
   * mailbox's Sent set first (the test {@link sentCopiesByHeader} applies). Insertion order stands
   * in for `created_at, id` ("oldest row wins"): `insertMessage` only ever appends, and the sort is stable.
   */
  async findByMessageIdHeader(accountId: string, mailboxId: string, messageIdHeader: string): Promise<MessageIdCandidate[]> {
    const out: MessageIdCandidate[] = [];
    for (const { stored, input } of this.rows.values()) {
      if (input.accountId !== accountId || input.mailboxId !== mailboxId) continue;
      if (stored.messageIdHeader === null || stored.messageIdHeader !== messageIdHeader) continue;
      out.push({ row: { ...stored }, date: input.date, inSent: this.hasSentInstance(stored.id) });
    }
    return out.sort((a, b) => Number(b.inSent) - Number(a.inSent)).slice(0, 8);
  }

  /**
   * The Sent folder the attach wrote down for a mailbox (`mailboxes.sent_folder`, mail 0132): a
   * server's own name for Sent that no Sent-shaped path matches. A test sets it as the attach would.
   */
  sentFolders = new Map<string, string>();

  /**
   * An instance of this row in its mailbox's Sent set — a Sent-shaped path or the folder the attach
   * wrote down, as `correspondent.ts#inSentFolderSql` spells it: the server's locator, never the `From`.
   */
  private hasSentInstance(messageId: string): boolean {
    const named = this.rows.has(messageId) ? this.sentFolders.get(this.rows.get(messageId)!.input.mailboxId) : undefined;
    return [...this.instances.values()].some((i) => i.messageId === messageId
      && (isSentFolderPath(i.folder) || (named !== undefined && i.folder === named)));
  }

  /**
   * One of OUR automatic replies — `@trafficflow/db#autoReplyByUsWhere`: from the account's own
   * address, and either on the away ledger by the id it minted, or carrying the machine-sent headers
   * (`Auto-Submitted` other than `no`, a bulk or auto-reply `Precedence`, `X-Auto-Response-Suppress`).
   */
  private isOurAutomaticReply(messageId: string): boolean {
    const row = this.rows.get(messageId);
    if (!row || !this.own.has(row.input.fromAddress.trim().toLowerCase())) return false;
    const header = row.stored.messageIdHeader;
    if (header !== null && this.awayReplyMintedIds.has(foldMessageIdDomain(header))) return true;
    const headers = this.bodies.get(messageId)?.headers ?? {};
    const values = (name: string): string[] => (headers[name] ?? []).map((v) => v.trim().toLowerCase());
    return values("auto-submitted").some((v) => v !== "no")
      || values("precedence").some((v) => ["bulk", "autoreply", "auto_reply", "junk", "list"].some((n) => v.includes(n)))
      || (headers["x-auto-response-suppress"] ?? []).length > 0;
  }

  /**
   * ── THIS USED TO THROW, AND THE THROW WAS A LIE ABOUT THE PORT ───────────────────────
   *
   * `if (this.byDedup.has(dk)) throw new Error("duplicate dedupKey")`, described in
   * `ports.contract.test.ts` as "mirrors the DB unique constraint". It does not. The constraint is
   * real, but `DrizzleRepo.insertMessage` deliberately ABSORBS it: `ON CONFLICT DO NOTHING`
   * followed by a re-read, so the production port CONVERGES ON THE WINNER'S ROW and never raises.
   *
   * The cost of the lie was not cosmetic. It made the concurrent-ingest path structurally
   * unreachable in every fake-based test in this repository — the second writer blew up here
   * instead of proceeding into `commitChange`'s tail — so the duplicated `attachments` rows and
   * the duplicated `message`/`create` delta could only ever be seen on real Postgres, and nothing
   * in `packages/core/test/` could have caught them.
   *
   * `created` is reported and, on a duplicate, `setPrimary` is SKIPPED — mirroring the real
   * method's "only on a GENUINE insert" branch. Re-asserting the primary from a re-ingest would
   * drag the row back to an arrival locator the user's own history may have moved on from.
   */
  async insertMessage(input: InsertMessageInput): Promise<InsertedMessage> {
    const dk = this.key(input.mailboxId, input.dedupKey);
    const won = this.byDedup.get(dk);
    if (won !== undefined) return { ...this.rows.get(won)!.stored, created: false };
    const id = `msg-${++this.seq}`;
    const stored: StoredMessage = {
      id, dedupKey: input.dedupKey, nativeLocator: input.nativeLocator, threadId: null,
      // The four columns the dual-key lookup verifies against, stored exactly as the real repo
      // stores them — so a legacy row seeded here is a legacy row the verification can refuse.
      messageIdHeader: input.canonical.messageIdHeader,
      bodyHash: input.canonical.bodyHash,
      subject: input.subject,
      fromAddress: input.fromAddress,
    };
    this.rows.set(id, { stored: { ...stored }, input });
    this.byDedup.set(dk, id);
    // Mirrors `DrizzleRepo.insertMessage`: a message and its PRIMARY instance are born together,
    // so "every stored message with a locator has a primary instance" holds in the fake too and
    // `primaryInstanceVanished` cannot answer true for a freshly-ingested row.
    this.setPrimary(input.mailboxId, id, input.nativeLocator);
    return { ...stored, created: true };
  }

  // ── `message_instances` ──

  private instanceKey(mailboxId: string, locator: NativeLocator): string {
    return `${mailboxId}\u0000${locator.folder}\u0000${locator.ref}`;
  }

  /** The mailbox a stored message belongs to. The fake's `messages.mailbox_id`. */
  private mailboxOf(messageId: string): string {
    return this.rows.get(messageId)?.input.mailboxId ?? "";
  }

  private setPrimary(mailboxId: string, messageId: string, locator: NativeLocator): void {
    // Vacate the destination tuple if THIS message already holds it as a non-primary copy, then
    // move the primary — the same two steps, in the same order, as `setPrimaryInstance`.
    const destination = this.instanceKey(mailboxId, locator);
    const sitting = this.instances.get(destination);
    if (sitting && sitting.messageId === messageId && !sitting.isPrimary) this.instances.delete(destination);
    for (const [k, v] of this.instances) {
      if (v.messageId === messageId && v.isPrimary) this.instances.delete(k);
    }
    this.instances.set(destination, {
      messageId, folder: locator.folder, ref: locator.ref, isPrimary: true,
    });
  }

  async recordInstance(messageId: string, locator: NativeLocator): Promise<void> {
    const mailboxId = this.mailboxOf(messageId);
    const k = this.instanceKey(mailboxId, locator);
    const existing = this.instances.get(k);
    // Never re-attribute a locator another message claims — the `setWhere` guard, in the fake.
    if (existing && existing.messageId !== messageId) return;
    if (existing) return;
    this.instances.set(k, {
      messageId, folder: locator.folder, ref: locator.ref, isPrimary: false,
    });
  }

  async primaryInstanceVanished(messageId: string): Promise<boolean> {
    const row = this.rows.get(messageId);
    if (!row) return false;
    // BOTH halves, as in SQL: a row with no native locator has no instance to be missing, so it
    // must not read as a disappearance.
    if (row.input.nativeLocator == null) return false;
    for (const v of this.instances.values()) {
      if (v.messageId === messageId && v.isPrimary) return false;
    }
    return true;
  }

  /**
   * The worker's `forgetInstanceAt` — the only writer of a DISAPPEARANCE.
   *
   * PROMOTES a survivor when the vanished row was the PRIMARY, mirroring
   * `DrizzleRepo.forgetInstanceAt`. The invariant is `messages.native_locator` names an instance that
   * exists, and it became load-bearing rather than accidental the moment a message could hold two
   * instances in ONE folder — see `commitChange`'s `secondCopyInSameEpoch`. A fake that deleted and
   * stopped would have made that repair untestable here and would have lied about it.
   *
   * Insertion order stands in for `first_seen_at`, which is what the real query orders by.
   */
  async forgetInstanceAt(mailboxId: string, locator: NativeLocator): Promise<NativeLocator | null> {
    const key = this.instanceKey(mailboxId, locator);
    const removed = this.instances.get(key);
    this.instances.delete(key);
    if (!removed?.isPrimary) return null;
    for (const [, v] of this.instances) {
      if (v.messageId !== removed.messageId) continue;
      v.isPrimary = true;
      const promoted: NativeLocator = { folder: v.folder, ref: v.ref };
      const row = this.rows.get(v.messageId);
      if (row) row.stored.nativeLocator = promoted;
      return promoted;
    }
    return null;
  }

  async upgradeDedupKey(messageId: string, from: string, to: string): Promise<boolean> {
    const row = this.rows.get(messageId);
    if (!row || row.stored.dedupKey !== from) return false;
    const mailboxId = row.input.mailboxId;
    if (this.byDedup.has(this.key(mailboxId, to))) return false;
    this.byDedup.delete(this.key(mailboxId, from));
    this.byDedup.set(this.key(mailboxId, to), messageId);
    row.stored.dedupKey = to;
    row.input = { ...row.input, dedupKey: to };
    return true;
  }

  async setFolderConflict(messageId: string, s: FolderStateRow): Promise<void> {
    if (!this.folder.has(messageId)) this.folder.set(messageId, { ...s });
    this.conflicts.add(messageId);
  }

  /**
   * The adapter contract, restated over Maps: reserve the body's bytes against the cap in the
   * same "transaction" (here: the same call), store the content when reserved, store the
   * withheld husk (real headers, empty content) when at cap. `storedBytes` mirrors
   * `account_storage.bytes` so a pipeline test can assert a decline moved no counter.
   */
  storedBytes = new Map<string, number>();
  /** The search documents the pipeline wrote with each body, by message (mail 0125). */
  searchDocs = new Map<string, MessageSearchInput>();
  withheld = new Map<string, MessageBodyInput>();
  async insertMessageBody(
    messageId: string, body: MessageBodyInput, storage: BodyStorageContext, search?: MessageSearchInput,
  ): Promise<BodyStorageOutcome> {
    if (search !== undefined) this.searchDocs.set(messageId, search);
    const bytes = Buffer.byteLength(body.text, "utf8") +
      (body.html === null ? 0 : Buffer.byteLength(body.html, "utf8"));
    const used = this.storedBytes.get(storage.accountId) ?? 0;
    const reserved = storage.capBytes === null || used < storage.capBytes;
    if (!reserved) {
      if (!this.bodies.has(messageId)) {
        const husk = { text: "", html: null, headers: body.headers };
        this.bodies.set(messageId, husk);
        this.withheld.set(messageId, husk);
      }
      return "withheld";
    }
    if (!this.bodies.has(messageId)) {
      this.bodies.set(messageId, body);
      this.storedBytes.set(storage.accountId, used + bytes);
    }
    return "stored";
  }


  async insertAttachments(messageId: string, _accountId: string, rows: AttachmentMeta[]): Promise<void> {
    if (rows.length === 0) return;
    this.attachments.set(messageId, [...(this.attachments.get(messageId) ?? []), ...rows]);
  }

  async getFolderState(messageId: string): Promise<FolderStateRow | null> {
    const s = this.folder.get(messageId);
    return s ? { ...s } : null;
  }

  async upsertFolderState(messageId: string, s: FolderStateRow): Promise<void> {
    this.folder.set(messageId, { ...s });
  }

  /**
   * {@link WorkerRepo.completeFolderState}, and it fails the way PRODUCTION fails: the desire is a
   * WITNESS read live, `desiredFolder` is never written, `observedFolder` lands on a miss only for
   * a caller carrying a fresh physical fact, and `lastSetBy` is touched on a match alone. A fake
   * that wrote the pair unconditionally would make the arm under test unreachable.
   */
  async completeFolderState(messageId: string, c: FolderCompletion): Promise<boolean> {
    const live = this.folder.get(messageId);
    if (!live) return false;                       // no row: the UPDATE matches nothing
    const matched = live.desiredFolder === c.expectDesiredFolder;
    if (matched || c.physicalObservation === true) live.observedFolder = c.observedFolder;
    if (matched) {
      live.lastSetBy = c.lastSetBy;
      if (c.satisfiedBy !== undefined) live.satisfiedBy = c.satisfiedBy;
    }
    return matched;
  }

  /**
   * {@link WorkerRepo.adoptFolderState}, failing the way production fails: the witness is read
   * live and a miss writes NOTHING — not the desire, not the observation, not the authorship.
   */
  async adoptFolderState(
    messageId: string, s: FolderStateRow, expectDesiredFolder: string, decidedAt: Date | null = null,
  ): Promise<boolean> {
    const live = this.folder.get(messageId);
    if (live && live.desiredFolder !== expectDesiredFolder) return false;
    this.folder.set(messageId, { ...s });
    this.adoptionStamps.set(messageId, decidedAt);
    return true;
  }

  /** The `decided_at` each adoption stamped (mail 0145), by message. */
  adoptionStamps = new Map<string, Date | null>();

  /** The fake's `flag_state`, by message — written by {@link applyExternalFlag} alone. */
  flags = new Map<string, { desiredSeen: boolean; observedSeen: boolean; lastSetBy: string }>();

  /**
   * {@link WorkerRepo.applyExternalFlag} as production answers it: the row whose PRIMARY locator
   * this is adopts the server's `\Seen` unless a `\Seen` write of ours is still pending; `null`
   * when no row stands there. `input.unread` is the fake's `messages.unread`.
   */
  async applyExternalFlag(
    mailboxId: string, locator: NativeLocator, seen: boolean,
  ): Promise<{ messageId: string; applied: boolean; changed: boolean } | null> {
    for (const { stored, input } of this.rows.values()) {
      if (input.mailboxId !== mailboxId) continue;
      if (stored.nativeLocator.folder !== locator.folder || stored.nativeLocator.ref !== locator.ref) continue;
      const f = this.flags.get(stored.id);
      if (f && f.lastSetBy === "us" && f.desiredSeen !== f.observedSeen) {
        return { messageId: stored.id, applied: false, changed: false };
      }
      const changed = (input.unread ?? true) !== !seen;
      input.unread = !seen;
      this.flags.set(stored.id, { desiredSeen: seen, observedSeen: seen, lastSetBy: "external" });
      return { messageId: stored.id, applied: true, changed };
    }
    return null;
  }

  async updateLocator(messageId: string, locator: NativeLocator): Promise<void> {
    const row = this.rows.get(messageId);
    if (!row) return;
    row.stored.nativeLocator = { ...locator };
    // The instance moves with the mirror, in one call, exactly as `DrizzleRepo.updateLocator` does.
    this.setPrimary(row.input.mailboxId, messageId, locator);
  }

  async listRules(_accountId: string): Promise<Rule[]> { return this.rules; }
  /** The account's list addresses and the brands a press consented under each (mail 0150). */
  lists = new Map<string, Set<string>>();
  async knownSenders(_accountId: string): Promise<KnownSenders> {
    return { addresses: this.senders, inferred: this.inferredSenders, lists: this.lists };
  }
  /** `RepoPort.recordListAddresses`: a new address gets a row with no brands, never a contact, never an own one. */
  async recordListAddresses(_accountId: string, addresses: readonly string[]): Promise<number> {
    const unique = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.includes("@") && !this.own.has(a)))];
    for (const a of unique) if (!this.lists.has(a)) this.lists.set(a, new Set());
    return unique.length;
  }
  /** The account's own mailbox addresses, lower-cased — `RepoPort.ownAddresses`. */
  own = new Set<string>();
  async ownAddresses(_accountId: string): Promise<Set<string>> { return this.own; }
  /**
   * The account's own Sent copies among `references`, by header — the fake's `ownSentCopies`, the
   * ONE read both the reply arm and the bounce arm ask, as production's two readers share one
   * statement: a stored row of this account with an instance in its mailbox's Sent set, arrived
   * after {@link correspondenceSince}, not one of our automatic replies, its To and Cc unioned per
   * header. `correspondentCalls` counts the reply arm's questions.
   */
  correspondenceSince = new Date(0);
  correspondentCalls = 0;
  private sentCopiesByHeader(
    accountId: string, references: readonly string[],
  ): Map<string, { sentAt: Date; recipients: Set<string> }> {
    const out = new Map<string, { sentAt: Date; recipients: Set<string> }>();
    for (const { stored, input } of this.rows.values()) {
      if (input.accountId !== accountId) continue;
      if (!stored.messageIdHeader || !references.includes(stored.messageIdHeader)) continue;
      const at = input.arrivedAt ?? input.date ?? null;
      if (!this.hasSentInstance(stored.id) || at === null || at <= this.correspondenceSince) continue;
      if (this.isOurAutomaticReply(stored.id)) continue;
      const copy = out.get(stored.messageIdHeader) ?? { sentAt: at, recipients: new Set<string>() };
      if (at > copy.sentAt) copy.sentAt = at;
      for (const a of [...(input.to ?? []), ...(input.cc ?? [])]) {
        const address = a.address.trim().toLowerCase();
        if (address !== "") copy.recipients.add(address);
      }
      out.set(stored.messageIdHeader, copy);
    }
    return out;
  }
  async isCorrespondent(
    accountId: string, sender: string, references: readonly string[],
  ): Promise<CorrespondentEvidence | null> {
    this.correspondentCalls += 1;
    const s = sender.trim().toLowerCase();
    let best: CorrespondentEvidence | null = null;
    // A named reading outranks an unnamed one, then the newer writing — the predicate's own order.
    for (const copy of this.sentCopiesByHeader(accountId, references).values()) {
      const ev: CorrespondentEvidence = { sentAt: copy.sentAt, via: "replied", named: copy.recipients.has(s) };
      if (!best || (ev.named && !best.named) || (ev.named === best.named && ev.sentAt > best.sentAt)) best = ev;
    }
    return best;
  }
  /**
   * `RepoPort.citesOwnWriting` over the same read: the first of `ids` that is an own Sent copy
   * written to no list address — a copy to a list is public, as the store reads it.
   */
  async citesOwnWriting(accountId: string, ids: readonly string[]): Promise<string | null> {
    const copies = this.sentCopiesByHeader(accountId, ids);
    return ids.find((id) => {
      const copy = copies.get(id);
      return copy !== undefined && ![...copy.recipients].some((a) => this.lists.has(a));
    }) ?? null;
  }
  async upsertContacts(_accountId: string, addresses: readonly string[], source: ContactSource): Promise<number> {
    let added = 0;
    for (const a of addresses) {
      const key = a.trim().toLowerCase();
      if (!key.includes("@")) continue;
      // The adapter's rule: a person's write upgrades an inferred row, nothing downgrades one.
      if (this.senders.has(key)) { if (source === "person") this.inferredSenders.delete(key); continue; }
      this.senders.add(key);
      if (source === "inferred") this.inferredSenders.add(key);
      added += 1;
    }
    return added;
  }
  /* Mirrors the adapter's SEMANTICS through the adapter's own helper — account-scoped, the
     DOMAIN folded and nothing else. A double that folds more than production does cannot fail
     the way production fails, and this one did not. */
  async isOwnAwayReply(_accountId: string, candidates: readonly string[]): Promise<boolean> {
    return candidates.some((c) => this.awayReplyMintedIds.has(foldMessageIdDomain(c)));
  }

  /* The adapter's two statements, in the same order and with the same guard: the ledger names
     the correspondents, and only a row still unstamped is written. `awaySenders` stands for the
     row's existence — a correspondent with no `away_sender_state` row was never replied to and
     has nothing to stamp. */
  async markAwayReplyUndeliverable(
    _accountId: string, candidates: readonly string[], at: Date,
  ): Promise<number> {
    if (candidates.length === 0) return 0;
    let marked = 0;
    for (const c of candidates) {
      const sender = this.awayReplyMintedIds.has(foldMessageIdDomain(c))
        ? this.awayReplySenderOf.get(foldMessageIdDomain(c))
        : undefined;
      if (sender === undefined || !this.awaySenders.has(sender)) continue;
      if (this.awayUndeliverable.has(sender)) continue;
      this.awayUndeliverable.set(sender, at);
      marked += 1;
    }
    return marked;
  }

  async recordAudit(_accountId: string, action: string, payload: unknown, inverse: unknown): Promise<void> {
    this.audits.push({ action, payload, inverse });
  }

  async recordChange(input: RepoChangeInput): Promise<bigint> {
    const seq = ++this.changeSeq;
    this.changes.push({ ...input, seq });
    return seq;
  }

  /* Through the singular, deliberately: the batch is a round-trip saving and nothing else, so the
     recorded list and its seq order must be what the same changes made one at a time produce.
     A fake that appended the batch some other way would let an ordering defect pass here. */
  async recordChanges(inputs: readonly RepoChangeInput[]): Promise<bigint[]> {
    const seqs: bigint[] = [];
    for (const input of inputs) seqs.push(await this.recordChange(input));
    return seqs;
  }

  // ── Threading ──
  //
  // Mirrors the DrizzleRepo's SEMANTICS, not its SQL. Two of them are load-bearing and both are
  // mutation-tested in `threading.test.ts`: `findThreadParent` filters by `accountId` (drop that
  // and one account's Message-ID joins another's thread), and `upsertThread` keys on
  // `(accountId, rootMessageIdHeader)` with NULL treated as DISTINCT — the Postgres unique-index
  // rule, without which every anchorless message would collide on one thread.

  async findThreadParent(accountId: string, candidates: readonly string[]): Promise<ThreadParent | null> {
    const byHeader = new Map<string, { id: string; threadId: string | null }>();
    for (const [id, row] of this.rows) {
      if (row.input.accountId !== accountId) continue;
      const header = row.input.canonical.messageIdHeader;
      if (!header) continue;
      const prev = byHeader.get(header);
      const threadId = row.stored.threadId ?? null;
      if (!prev || (prev.threadId === null && threadId !== null)) byHeader.set(header, { id, threadId });
    }
    for (const candidate of candidates) {
      const hit = byHeader.get(candidate);
      if (hit) return { messageId: hit.id, threadId: hit.threadId };
    }
    return null;
  }

  async upsertThread(input: ThreadUpsertInput): Promise<ThreadUpsertResult> {
    if (input.rootMessageIdHeader !== null) {
      for (const t of this.threads.values()) {
        if (t.accountId === input.accountId && t.rootMessageIdHeader === input.rootMessageIdHeader) {
          return { id: t.id, created: false };
        }
      }
    }
    const id = `thr-${++this.threadSeq}`;
    this.threads.set(id, {
      id,
      accountId: input.accountId,
      rootMessageIdHeader: input.rootMessageIdHeader,
      subject: input.subject,
      participants: [...input.participants],
      lastMessageAt: input.lastMessageAt,
    });
    return { id, created: true };
  }

  async mergeThreadMessage(threadId: string, input: ThreadMergeInput): Promise<boolean> {
    const t = this.threads.get(threadId);
    if (!t) return false;
    const byAddress = new Map(t.participants.map((p) => [p.address.toLowerCase(), p]));
    let grew = false;
    for (const p of input.participants) {
      const key = p.address.toLowerCase();
      if (!key || byAddress.has(key)) continue;
      byAddress.set(key, p);
      grew = true;
    }
    const advance = input.lastMessageAt !== null
      && (t.lastMessageAt === null || input.lastMessageAt.getTime() > t.lastMessageAt.getTime());
    if (!grew && !advance) return false;
    if (grew) t.participants = [...byAddress.values()];
    if (advance) t.lastMessageAt = input.lastMessageAt;
    return true;
  }

  async setMessageThread(messageId: string, threadId: string): Promise<boolean> {
    const row = this.rows.get(messageId);
    if (!row || row.stored.threadId !== null) return false;
    row.stored.threadId = threadId;
    return true;
  }
}

/** In-memory RoutingPort for the AI-branch tests: configurable graduated patterns. */
export class FakeRouting implements RoutingPort {
  decisions: Array<RoutingDecisionInput & { id: string }> = [];
  approvals: Array<ApprovalInput & { id: string }> = [];
  graduated = new Set<string>();               // patternKeys treated as graduated
  private seq = 0;

  async recordRoutingDecision(d: RoutingDecisionInput): Promise<{ id: string }> {
    const id = `rd-${++this.seq}`;
    this.decisions.push({ ...d, id });
    return { id };
  }

  async isGraduated(accountId: string, patternKey: string, _action: "route"): Promise<boolean> {
    return this.graduated.has(`${accountId}:${patternKey}`) || this.graduated.has(patternKey);
  }

  async enqueueApproval(a: ApprovalInput): Promise<{ id: string }> {
    const id = `ap-${++this.seq}`;
    this.approvals.push({ ...a, id });
    return { id };
  }
}

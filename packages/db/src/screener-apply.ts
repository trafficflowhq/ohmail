import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { accountSettings, contacts, folderState, messages, rules as rulesTbl } from "./schema-mail.js";
import { recordChange, type LedgerTx, type Tx } from "./change-log.js";
import { dialect } from "./dialect/index.js";
import { readAccountErasedAt } from "./erasure-fence.js";
import { recordLearningSignal } from "./learning-signal.js";
import { upsertDesiredSeen } from "./flag-intent.js";

/**
 * `recordChange` wants `LedgerTx` (`PgTransaction`, narrower than `Tx`/`PgDatabase`) because it is
 * only ever safe to call inside an open transaction. Every caller of this module already is one —
 * `applyScreenerDecision` runs inside the caller's own `db.transaction(...)` — so the cast is the
 * same one `screener-service.ts` already makes at its own `recordChange` call sites, not a
 * widening of what is actually safe.
 */
const ledger = (tx: Tx): LedgerTx => tx as unknown as LedgerTx;

/**
 * The Screener decision's apply, on its own leaf — moved down the spine (0.14.1).
 * `ScreenerService.decide` is a promoted rule, a held-bag re-route and a mark-read in one
 * transaction; 0.14.1 adds a second caller — a READER's decision drained from `ohmail/_meta` by
 * the worker, which may not import services at runtime. The transactional CORE (contacts, the
 * baseline stamp, the promoted rule, the guarded re-route, mark-read, `change_log`, the learning
 * signal) lives here; `ScreenerService.applyDecision` is a thin wrapper. Not moved: the physical
 * IMAP move (a caller concern), the auto-unsubscribe courtesy (the drain does not perform it — a
 * named gap), and the idempotency claim-and-replay (each door keys its own).
 */

/** Where unknown first-contact senders are held (core routing, `source:"screener"`). */
export const SCREENER_FOLDER = "ohmail/Screener";
const YES_FOLDER = "INBOX"; // Imbox
const NO_FOLDER = "ohmail/Screened";

/**
 * The five places a decision may file mail, duplicated from core's `effectForDestination` rather
 * than imported — this package must not depend on `@trafficflow/core`
 * (`organizer-role.ts#CAPABILITY_REQUESTS` has the direction argument). The set is closed and
 * stable, and `screener-apply.test.ts` holds this copy equal to `effectForDestination`'s answer
 * for every member. `ohmail/Screener` is deliberately ABSENT: it is where mail is HELD, never a
 * place a decision may file to. The allow members are {@link YES_FOLDER}, `ohmail/Reads`,
 * `ohmail/Receipts`; the deny members are {@link NO_FOLDER} and `ohmail/Quarantine`.
 */
export const DECIDABLE_FOLDERS: ReadonlySet<string> = new Set([
  YES_FOLDER, "ohmail/Reads", "ohmail/Receipts", NO_FOLDER, "ohmail/Quarantine",
]);

/**
 * The two "no" destinations whose mail a decision marks read, and the safety line. A screen-out
 * or a spam press is the user saying they are done with this sender, so the dismissed mail should
 * not sit unread forever. The membership IS the safety boundary: admitted mail is never touched —
 * admitting a sender is not reading their backlog — and `ohmail/Screener` is not decidable at
 * all, so mail waiting at the gate can never be pre-read. The `\Seen` write is additive and
 * reversible: `flag_state.desired_seen = true` with `last_set_by = 'us'`; no move, no delete, no
 * flag removed. It equals `decision === "no"` today, but is expressed as folder membership so a
 * future destination cannot silently inherit a read-mark by being wired to a `no`.
 */
const MARK_READ_ON_DECIDE: ReadonlySet<string> = new Set([NO_FOLDER, "ohmail/Quarantine"]);

/** `effectForDestination(dest) === "allow"` for the {@link DECIDABLE_FOLDERS} set, duplicated for the same reason. */
export function admitsDestination(dest: string): boolean {
  return dest === YES_FOLDER || dest === "ohmail/Reads" || dest === "ohmail/Receipts";
}

/**
 * Validate a decision payload that arrived through an RFC822 header (0.14.1). At the writing end
 * it was built from already-validated values; by the time the drain reads it back it has crossed
 * an install boundary through a mailbox ANOTHER machine wrote to — a corrupted append, a future
 * build's shape, or a hostile one — so it is validated again, independently, with the SAME rules
 * the writing end enforces. Untrusted and bounded (the wire format caps it at {@link
 * REQUEST_PAYLOAD_MAX_BYTES} encoded); every field checked before a single write. Returns `null`
 * for anything that fails ANY check. The caller REFUSES on `null`, never coerces to a guess.
 */
export interface ValidatedRequestPayload {
  scope: "sender" | "domain";
  /** Lower-cased. Always present — a domain decision's domain is derived from it, never carried separately. */
  address: string;
  appliedFolder: string;
  decision: "yes" | "no";
}

/** A generous ceiling on the address field alone — RFC 5321's own 254-octet mailbox limit, doubled. */
const REQUEST_ADDRESS_MAX_CHARS = 512;

export function validateRequestPayload(payload: unknown): ValidatedRequestPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;

  const scope = p.scope;
  if (scope !== "sender" && scope !== "domain") return null;

  const decision = p.decision;
  if (decision !== "yes" && decision !== "no") return null;

  const addressRaw = p.address;
  if (typeof addressRaw !== "string") return null;
  const address = addressRaw.trim().toLowerCase();
  if (address === "" || address.length > REQUEST_ADDRESS_MAX_CHARS) return null;

  const appliedFolder = p.appliedFolder;
  if (typeof appliedFolder !== "string" || !DECIDABLE_FOLDERS.has(appliedFolder)) return null;
  // MEMBERSHIP FIRST, agreement second — `decide`'s own validate does the same in the same
  // order, and for the same reason: a caller must name a real folder before its side of the
  // gate is even asked.
  if (admitsDestination(appliedFolder) !== (decision === "yes")) return null;

  // A domain decision needs a domain — `decide`'s own 422, re-checked here because the payload
  // could claim `scope: "domain"` against an address with no `@` at all.
  if (scope === "domain" && domainOf(address) === "") return null;

  return { scope, address, appliedFolder, decision };
}

/**
 * `domainOf` — everything after the FIRST `@`, or `""` for an address with none. Several copies of
 * this one-liner exist elsewhere in the repository, each its own file for the same reason as
 * `CAPABILITY_REQUESTS`: no shared dependency `packages/core` or a worker-side caller can reach.
 * `packages/services/src/screener-service.ts` is NOT one of them (0.14.1 removed its own
 * copy) — `services` may import `db`, so THIS is the shared implementation for that direction, the
 * export in `index.ts` below is load-bearing, and `screener-apply.test.ts` pins its behaviour for
 * both callers rather than each testing its own copy.
 */
export function domainOf(address: string): string {
  const i = address.indexOf("@");
  return i >= 0 ? address.slice(i + 1) : "";
}

/** A held (or formerly held) message, as the apply and the validate layers both need it. */
export interface AppliedScreenerRow {
  messageId: string;
  mailboxId: string;
  threadId: string | null;
  fromAddress: string;
  subject: string;
  snippet: string;
  date: Date | null;
  observedFolder: string;
  nativeLocator: unknown;
  updatedAt: Date;
  /** The server's current `\Seen`, `!unread`, as the mirror last recorded it. */
  unread: boolean;
}

const HELD_COLUMNS = {
  messageId: messages.id, mailboxId: messages.mailboxId, threadId: messages.threadId,
  fromAddress: messages.fromAddress, subject: messages.subject, snippet: messages.snippet,
  date: messages.date, nativeLocator: messages.nativeLocator, observedFolder: folderState.observedFolder,
  updatedAt: messages.updatedAt, unread: messages.unread,
} as const;

function toAppliedScreenerRow(r: {
  messageId: string; mailboxId: string; threadId: string | null; fromAddress: string; subject: string;
  snippet: string; date: Date | null; nativeLocator: unknown; observedFolder: string;
  updatedAt: Date; unread: boolean;
}): AppliedScreenerRow {
  return {
    messageId: r.messageId, mailboxId: r.mailboxId, threadId: r.threadId ?? null, fromAddress: r.fromAddress,
    subject: r.subject, snippet: r.snippet, date: r.date, observedFolder: r.observedFolder,
    // `?? null`, not a bare pass-through — `unknown` accepts `undefined` too, and
    // `screener-service.ts`'s own opportunistic reconcile pass casts this field straight to
    // `NativeLocator` (`m.nativeLocator as NativeLocator`) before handing it to the adapter. A
    // `null` here is drizzle's own convention for an absent JSONB column and something that call
    // site can at least fail predictably on; `undefined` is not a value that column ever holds and
    // has no business surviving this row's own construction. Same defensive shape as `threadId`.
    nativeLocator: r.nativeLocator ?? null, updatedAt: r.updatedAt, unread: r.unread,
  };
}

/**
 * All held mail for the account, optionally narrowed by `extra` and by `mailboxId`. Mirrors
 * `ScreenerReadService.heldRows`. `mailboxId` stays optional on this LEAF only because
 * `heldRowById` looks up by primary key, where a mailbox filter changes nothing.
 * `heldRowsForSender` / `heldRowsForDomain` — the two functions {@link applyScreenerDecision}
 * actually re-routes — REQUIRE it: a decision names the mailbox it was made about, an account may
 * hold several mailboxes with different roles, and a decision about ONE mailbox re-routing a
 * sender's held mail in a DIFFERENT one this install does not organize is exactly the
 * cross-mailbox write the one-organizer rule forbids.
 */
async function heldRows(
  tx: Tx, accountId: string, extra?: SQL, mailboxId?: string,
): Promise<AppliedScreenerRow[]> {
  const filters: SQL[] = [
    eq(messages.accountId, accountId),
    eq(folderState.desiredFolder, SCREENER_FOLDER),
    isNull(messages.deletedAt),
  ];
  if (mailboxId !== undefined) filters.push(eq(messages.mailboxId, mailboxId));
  if (extra) filters.push(extra);
  const rows = await tx.select(HELD_COLUMNS).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(...filters))
    .orderBy(desc(messages.date));
  return rows.map(toAppliedScreenerRow);
}

/** One held message by id, scoped to the account. `null` when it is not currently held. */
export async function heldRowById(tx: Tx, accountId: string, id: string): Promise<AppliedScreenerRow | null> {
  const rows = await heldRows(tx, accountId, eq(messages.id, id));
  return rows[0] ?? null;
}

/**
 * Every held row for ONE sender, in ONE mailbox, matched case-insensitively. See `decide`'s own
 * comment for why `lower()`, and this module's own header for why `mailboxId` is
 * required: a decision may re-route mail only in the mailbox it was made about.
 */
export async function heldRowsForSender(
  tx: Tx, accountId: string, address: string, mailboxId: string,
): Promise<AppliedScreenerRow[]> {
  return heldRows(tx, accountId, sql`lower(${messages.fromAddress}) = ${address}`, mailboxId);
}

/**
 * Every held row for ONE domain, in ONE mailbox — `domainOf`, translated to SQL. See `decide`'s
 * own comment for the three rejected shapes, and {@link heldRowsForSender}'s own note for why
 * `mailboxId` is required.
 */
export async function heldRowsForDomain(
  tx: Tx, accountId: string, domain: string, mailboxId: string,
): Promise<AppliedScreenerRow[]> {
  /* BOTH HALVES THROUGH THE SEAM. `position(x IN y)` and `substring(x FROM n)` are SQL SYNTAX and
     not functions — the argument separator is a KEYWORD — which is why no list of function names
     ever caught them, and why the device store answers a syntax error at the query rather than a
     wrong result. Its own spellings take the arguments in the opposite order, so this is a member
     rather than a shared string. */
  const d = dialect(tx);
  const address = sql`lower(${messages.fromAddress})`;
  const at = d.strpos(address, sql`'@'`);
  return heldRows(tx, accountId, sql`
    ${at} > 0
    and ${d.substr(address, sql`${at} + 1`)} = ${domain}
  `, mailboxId);
}

/** Thrown by {@link applyScreenerDecision} on an erased account. See `erasure-fence.ts`'s own header. */
export class AccountErasedError extends Error {
  constructor(readonly accountId: string) {
    super(`account ${accountId} has been deleted; its settings cannot be changed`);
    this.name = "AccountErasedError";
  }
}

export interface ApplyScreenerDecisionInput {
  accountId: string;
  /**
   * The mailbox this decision was MADE about. The held-bag re-route is scoped to
   * it (`heldRowsForSender`/`heldRowsForDomain` now require it); the promoted rule stays
   * account-wide, unchanged from before this ruling — `rules` has no `mailboxId` column and a
   * sender/domain rule has always matched across every mailbox on the account, which is this
   * function's pre-existing behaviour, not the cross-mailbox write this parameter closes.
   */
  mailboxId: string;
  scope: "sender" | "domain";
  /**
   * The representative message's from-address, lower-cased — ALWAYS required regardless of
   * `scope`, on `decide`'s own shape: a domain decision still adds this ONE address as a contact
   * and still derives the domain FROM it (`domainOf(address)`), never from a second field a caller
   * could disagree with the first about.
   */
  address: string;
  /** Already validated by the caller: a member of {@link DECIDABLE_FOLDERS} that agrees with `decision`. */
  appliedFolder: string;
  decision: "yes" | "no";
  /** Dedup key for the learning signal — `screener:<message id>` on the HTTP door, `screener:<request id>` on the drain. */
  triggeringActionId: string;
  now: Date;
  /**
   * Defaults `true`. The organizer's request drain never stamps `screening_baseline_at`, so it
   * passes `false`. `screening_baseline_at` gates which of an account's ALREADY-HELD mail counts
   * as pre-existing versus newly screened (see this function's own comment on the `setWhere`
   * above); it is account-wide and, unlike the held-bag re-route (mailbox-scoped by `mailboxId`
   * above), has no per-mailbox fence to fall back on. Request signatures are
   * still owed — see `apps/worker/src/request-drain.ts`'s own header — so until it lands, the
   * drain path must not be the one thing that can move this account-wide cutoff.
   */
  stampBaseline?: boolean;
}

export interface ApplyScreenerDecisionResult {
  createdRuleId: string;
  /** The subset of the held bag this decision ACTUALLY re-routed — see `decide`'s own `desired=Screener` guard. */
  rerouted: AppliedScreenerRow[];
  /** The LAST `change_log` seq this call emitted — an HTTP caller re-emits it as `X-Sync-Seq` on an idempotent replay. */
  lastSeq: bigint;
}

/**
 * THE ONE IMPLEMENTATION. Contacts, the screening baseline, the promoted rule, the held-bag
 * re-route (guarded on `desired_folder = 'ohmail/Screener'`: a row that has already moved on
 * keeps where it went — user always wins), mark-read-on-decide, `change_log` for every write, and
 * the learning signal. See the module header for what stays with each caller. FENCES FIRST, as
 * the first statement of whatever transaction the caller opened: this writes `account_settings`
 * (the baseline stamp), and every such writer fences before touching anything else
 * (`erasure-fence.ts`'s rule).
 */
export async function applyScreenerDecision(
  tx: Tx, input: ApplyScreenerDecisionInput,
): Promise<ApplyScreenerDecisionResult> {
  const {
    accountId, mailboxId, scope, address, appliedFolder, decision, triggeringActionId, now,
    stampBaseline = true,
  } = input;
  const domain = domainOf(address);

  const erasedAt = await readAccountErasedAt(tx, dialect(tx), accountId);
  if (erasedAt != null) throw new AccountErasedError(accountId);

  if (decision === "yes") {
    await tx.insert(contacts).values({ accountId, address })
      .onConflictDoNothing({ target: [contacts.accountId, contacts.address] });
  }

  // The screening baseline, stamped on the first decide and never again — see `decide`'s own
  // header  for the full argument; `setWhere: isNull(...)` is what makes a later decide
  // a no-op here rather than a re-stamp that drags the cutoff forward. `stampBaseline` false skips
  // this write entirely — see the field's own doc comment on `ApplyScreenerDecisionInput`.
  if (stampBaseline) {
    await tx.insert(accountSettings).values({
      accountId, screeningBaselineAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: accountSettings.accountId,
      set: { screeningBaselineAt: now, updatedAt: now },
      setWhere: isNull(accountSettings.screeningBaselineAt),
    });
  }

  const [rule] = await tx.insert(rulesTbl).values({
    accountId,
    kind: scope === "domain" ? "domain" : "sender",
    match: scope === "domain" ? domain : address,
    destination: appliedFolder,
    provenance: "promoted",
    enabled: true,
  }).returning({ id: rulesTbl.id });
  // Tracked and returned so an HTTP caller can re-emit it as `X-Sync-Seq` on an idempotent
  // replay — `claimIdempotencyKey`'s own `seq` field. The drain has no such replay contract and
  // simply discards it.
  let lastSeq = await recordChange(
    ledger(tx), { accountId, entityType: "rule", entityId: rule!.id, op: "create", meta: null },
  );

  const heldMail = scope === "domain"
    ? await heldRowsForDomain(tx, accountId, domain, mailboxId)
    : await heldRowsForSender(tx, accountId, address, mailboxId);

  const rerouted: AppliedScreenerRow[] = [];
  for (const m of heldMail) {
    const [hit] = await tx.insert(folderState).values({
      messageId: m.messageId, desiredFolder: appliedFolder, observedFolder: m.observedFolder,
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
    }).onConflictDoUpdate({
      target: folderState.messageId,
      set: {
        desiredFolder: appliedFolder, lastSetBy: "us", reconcileStatus: "pending", conflict: false,
        updatedAt: now,
      },
      // A row that has moved ON since `heldMail` was read keeps where it went. See `decide`'s own
      // header for the misfiled-bulletins defect this guard closes.
      setWhere: eq(folderState.desiredFolder, SCREENER_FOLDER),
    }).returning({ messageId: folderState.messageId });
    if (!hit) continue;
    rerouted.push(m);
    lastSeq = await recordChange(ledger(tx), {
      accountId, entityType: "message", entityId: m.messageId, op: "move",
      meta: { from: m.observedFolder, to: appliedFolder },
    });

    if (MARK_READ_ON_DECIDE.has(appliedFolder)) {
      await upsertDesiredSeen(tx, m.messageId, !m.unread, true, now);
      await tx.update(messages)
        .set({ unread: false, lastReadAt: now, updatedAt: now })
        .where(and(eq(messages.id, m.messageId), eq(messages.accountId, accountId)));
      lastSeq = await recordChange(ledger(tx), {
        accountId, entityType: "message", entityId: m.messageId, op: "update", meta: null,
      });
    }
  }

  await recordLearningSignal(tx, accountId, {
    triggeringActionId,
    kind: "screener",
    senderAddress: scope === "domain" ? null : address,
    senderDomain: scope === "domain" ? domain : null,
    destination: appliedFolder,
    label: "positive",
  });

  return { createdRuleId: rule!.id, rerouted, lastSeq };
}

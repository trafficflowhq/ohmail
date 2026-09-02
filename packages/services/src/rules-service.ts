import { and, asc, eq } from "drizzle-orm";
import { assertAccountOrganizes, rules, recordChange, claimIdempotencyKey, type Tx } from "@trafficflow/db";
import type { Destination } from "@trafficflow/core/mail";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";
import { materializeRule } from "./dto/materialize.js";
import type { Folder, RuleDTO } from "./dto/types.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;
/** Materialize inside the ambient tx (reads its uncommitted writes) — same query surface as Db. */
const asDb = (tx: Tx): Db => tx as unknown as Db;

const KINDS = new Set(["sender", "domain", "header"]);
/** The six canonical folders a rule may route to (core `Destination`). */
const FOLDERS: Destination[] = [
  "INBOX", "ohmail/Screener", "ohmail/Reads",
  "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine",
];
const FOLDER_SET = new Set<string>(FOLDERS);

/**
 * The ceiling on a subject term, mirroring the `rules_subject_contains_nonempty` CHECK (mail 0050).
 *
 * Both layers, deliberately: the CHECK is what holds for every writer including a future importer,
 * and this is what turns a violation into a 400 the client can render instead of a 500 from a
 * constraint the API never mentioned. They must agree — a service limit ABOVE the CHECK is a
 * database error dressed as a validated request.
 */
export const MAX_SUBJECT_CONTAINS_CHARS = 200;

/**
 * The ceiling on a body term, mirroring `rules_body_contains_nonempty` (mail 0052) on the same
 * two-layer argument. The same number as the subject ceiling deliberately: the term is a needle,
 * and the haystack being a whole message body is not a licence to store a bigger needle.
 */
export const MAX_BODY_CONTAINS_CHARS = 200;

export interface CreateRuleBody {
  kind: string;
  match: string;
  destination: string;
  priority?: number;
  enabled?: boolean;
  /**
   * THE SECOND TERM — *from this address AND with this in the subject*. Absent or `null` for a rule
   * with one term, which is every rule that existed before mail 0050.
   *
   * `kind: "sender"` ONLY, and a term on any other kind is a 400 rather than a silently dropped
   * field. The reason is not squeamishness about scope: a domain rule narrowed by subject is a
   * coherent thing to want, but nothing composes one — the subject sheet is opened from ONE
   * message and offers that message's sender — so accepting it would be an untested wire shape
   * whose only reachable caller is a hand-written request. `header` is refused for the same reason
   * the engine's `rule_create` has no `header` arm: it names no principal.
   *
   * Stored VERBATIM after trimming, and matched case-folded by
   * `core/src/rules.ts#subjectSatisfies`. The case the user typed is preserved because the rules
   * surface and the sender sheet both quote it back at them — folding at rest would show somebody
   * `[ninjafirewall]` for a token they read off their own mail as `[NinjaFirewall]`.
   */
  subjectContains?: string | null;
  /**
   * THE THIRD TERM — *from this address AND with this in the message text* (mail 0052). Absent or
   * `null` for a rule without one. Everything `subjectContains` documents applies verbatim:
   * `kind: "sender"` only and a 400 anywhere else, stored VERBATIM after trimming, matched
   * case-folded by `core/src/rules.ts#bodySatisfies` against the message's canonical plain text.
   * It composes with the subject term — a rule may carry both, and both must then hold.
   */
  bodyContains?: string | null;
  /**
   * ALSO APPLY THIS RULE TO MAIL THAT IS ALREADY FILED — **defaults to TRUE**.
   *
   * A rule is meant to apply to ALL messages, future and previous, by default, so it manages the
   * mailbox efficiently. The design decision is about the DEFAULT; an opt-in would have changed
   * nothing about managing a mailbox, so `undefined` means yes and only an explicit `false`
   * declines.
   *
   * What it does here is one column. `retro_requested_at` is stamped inside the create/update
   * transaction and nothing else happens in this process: the worker's retro-apply pass finds
   * the owed rule on its next per-account cycle and walks the backlog in bounded pages, writing
   * `folder_state` desired-state that the reconciler turns into real IMAP moves. A rule matching
   * four thousand messages must not run inside a request, and this is the seam that keeps it out
   * of one.
   */
  applyRetro?: boolean;
}
export type PatchRuleBody = Partial<CreateRuleBody>;

/**
 * Idempotency handle threaded in by the route; the row is written IN the create tx.
 *
 * `POST /rules` needs one because `rules` carries NO unique constraint — two identical
 * rules are a legal thing for a user to ask for, so nothing in the schema can tell a
 * retry apart from a deliberate second rule. The KEY is the only thing that can, which
 * is why it must be claimed rather than inferred from the row's content.
 */
export interface RuleIdempotency {
  key: string;
  requestHash: string;
}

/** A mutation's result: the DTO plus the change_log seq to echo as `X-Sync-Seq`. */
export interface RuleMutation {
  rule: RuleDTO;
  seq: number;
}

/**
 * RulesService — user-authored routing rules CRUD. Every
 * client-visible mutation runs ONE `db.transaction` that writes the `rules` row
 * AND appends a `rule` change through the `change_log` seam SyncService reads
 * (in-tx). Every query is scoped to `ctx.accountId`; a cross-account id
 * is indistinguishable from a missing one → 404.
 */
export class RulesService {
  async list(ctx: ServiceContext): Promise<RuleDTO[]> {
    const rows = await ctx.db.select({ id: rules.id }).from(rules)
      .where(eq(rules.accountId, ctx.accountId)).orderBy(asc(rules.id));
    const items: RuleDTO[] = [];
    for (const r of rows) {
      const dto = await materializeRule(ctx.db, ctx.accountId, r.id);
      if (dto) items.push(dto);
    }
    return items;
  }

  async get(ctx: ServiceContext, id: string): Promise<RuleDTO> {
    const dto = await materializeRule(ctx.db, ctx.accountId, id);
    if (!dto) throw new ServiceError("not_found", 404, "rule not found");
    return dto;
  }

  async create(
    ctx: ServiceContext, body: CreateRuleBody,
    opts: { idempotency?: RuleIdempotency | null } = {},
  ): Promise<RuleMutation> {
    const kind = this.validKind(body.kind);
    const destination = this.validDestination(body.destination);
    const match = this.validMatch(body.match);
    const priority = this.validPriority(body.priority);
    const applyRetro = this.validApplyRetro(body.applyRetro);
    const subjectContains = this.validSubjectContains(body.subjectContains, kind);
    const bodyContains = this.validBodyContains(body.bodyContains, kind);

    return asTx(ctx).transaction(async (tx) => {
      /* -- A READER'S ACCOUNT WRITES NO RULES (mail 0083) ---------------------------------
       *
       * A rule is not a note: `evaluateRules` is the router, `rule-retro.ts` re-files the backlog
       * a new rule covers, and both run on the organizer's authority inside the organizer's own
       * cycle. A rule written where nothing organizes is an instruction that is never carried
       * out — and worse than inert, because the person is told their mail will be filed that way.
       *
       * ACCOUNT-SCOPED, not per-mailbox: rules apply to the account and travel in the profile
       * document, so the question is whether this install organizes ANYTHING. On a one-mailbox
       * standalone that collapses to "all refused", which is the honest answer for a door whose
       * effect would be nil.
       */
      await assertAccountOrganizes(tx as unknown as Tx, ctx.accountId);

      const [row] = await tx.insert(rules).values({
        accountId: ctx.accountId,
        kind, match, destination, priority,
        enabled: body.enabled ?? true,
        provenance: "manual",
        // NULL is the resting state and the only representation of "no second term" — see the
        // migration's CHECK. `validSubjectContains` has already turned `""` and a whitespace-only
        // string into `null`, so this can never insert a term that matches every subject.
        subjectContains,
        // The third term (mail 0052), on identical terms via `validBodyContains`.
        bodyContains,
        // The request, not the work. `NULL` means nobody ever asked this rule to reach mail
        // already on disk, which is the honest state for a rule created with `applyRetro: false`
        // and for every rule that existed before this column did.
        retroRequestedAt: applyRetro ? ctx.now() : null,
      }).returning({ id: rules.id });
      const seq = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "rule", entityId: row!.id, op: "create", meta: null,
      });

      // Materialize INSIDE the tx (reads the uncommitted insert) so the DTO stored below is
      // byte-for-byte the one the route returns. Nothing after this tx touches the row.
      const rule = await materializeRule(asDb(tx), ctx.accountId, row!.id);
      if (!rule) throw new ServiceError("internal", 500, "rule vanished after write");

      // Store the verbatim 201 IN this tx so a retry after a lost response replays the
      // SAME rule instead of minting a second one. The engine's retry queue drains every
      // pending action, and rule creation is a default on the sender sheet, so this is the
      // ordinary case rather than a rare one. Inserted directly — services cannot import
      // packages/api (copied from ApprovalService/PushService).
      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: 201,
          responseJson: rule,
          seq: Number(seq),
          now: ctx.now(),
        });
        // A LOST claim = a concurrent same-key request committed first. Throwing rolls THIS
        // transaction back (the rule AND its change_log row) and the caller replays the
        // winner's response.
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return { rule, seq: Number(seq) };
    });
  }

  /**
   * A retried PATCH used to re-run the UPDATE, append a SECOND `change_log` row and
   * answer a DIFFERENT `X-Sync-Seq`. It cannot duplicate a rule (it addresses an existing
   * id), so the damage is churn rather than data: every synced client is woken for a delta
   * that changes nothing, and the two answers for one request disagree about the seq.
   *
   * Same cure as `create`, and for the same reason the middleware alone cannot supply one:
   * `withIdempotency` only EXPOSES the handle, so the claim has to land in THIS transaction
   * or the concurrent case (both lookups miss in autocommit) still emits two changes.
   */
  /**
   * ── A RETARGET IS A RETROACTIVE REQUEST TOO, AND IT IS THE COMMON PATH ─────────────
   *
   * The sender sheet does NOT create a second rule when one already covers the subject — two
   * `manual` rules with the same kind, match, priority and effect tie all the way down to an
   * arbitrary ID tie-break in `core/src/rules.ts#compareRules`, so a duplicate would make "future
   * mail files there too" a coin toss. It PATCHes the existing rule's destination instead. That
   * is what a user changing their mind about a sender they have already ruled on does, which is
   * the ordinary case rather than an edge one.
   *
   * So a retarget that did not re-request the retroactive pass would apply to future mail only,
   * while the sheet said the same sentence it says for a fresh rule. The whole retro state is
   * therefore RESET — cursor and marker cleared, not just the request re-stamped — because the
   * destination changed: mail this rule already moved to the OLD destination is a candidate
   * again, and a stale cursor would skip everything before it.
   *
   * Only when the destination actually changes. A PATCH that flips `enabled` or nudges
   * `priority` re-applies nothing, because nothing about where this rule sends mail moved.
   *
   * ── AND A SUBJECT TERM CHANGE IS THE SAME KIND OF EVENT (mail 0050) ────────────────────
   *
   * `subject_contains` decides WHICH mail this rule is about, so editing it re-opens the backlog
   * exactly as a destination change does — and in both directions. NARROWING (adding or tightening
   * a term) leaves mail the rule already moved sitting somewhere it no longer claims; WIDENING
   * (clearing it) brings mail into scope that the pass has never examined. Neither is fixed by the
   * arrival path, because that only ever sees new mail.
   *
   * So the retro state is reset for a term change on the same reasoning as a retarget: cursor and
   * marker cleared rather than the request merely re-stamped, because a stale cursor would skip
   * everything before it. Note the honest limit, which is the one the copy must never overstate: a
   * message the NARROWED rule moved to the old destination is not moved BACK by this — the pass
   * writes desired-state for messages a rule now claims and never un-files one it has stopped
   * claiming. Only some other rule, or the user, moves that mail again.
   */
  async update(
    ctx: ServiceContext, id: string, patch: PatchRuleBody,
    opts: { idempotency?: RuleIdempotency | null } = {},
  ): Promise<RuleMutation> {
    const set: Record<string, unknown> = { updatedAt: ctx.now() };
    if (patch.kind !== undefined) set.kind = this.validKind(patch.kind);
    if (patch.destination !== undefined) set.destination = this.validDestination(patch.destination);
    if (patch.match !== undefined) set.match = this.validMatch(patch.match);
    if (patch.priority !== undefined) set.priority = this.validPriority(patch.priority);
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const applyRetro = this.validApplyRetro(patch.applyRetro);

    return asTx(ctx).transaction(async (tx) => {
      /* -- A READER'S ACCOUNT WRITES NO RULES (mail 0083) ---------------------------------
       *
       * A rule is not a note: `evaluateRules` is the router, `rule-retro.ts` re-files the backlog
       * a new rule covers, and both run on the organizer's authority inside the organizer's own
       * cycle. A rule written where nothing organizes is an instruction that is never carried
       * out — and worse than inert, because the person is told their mail will be filed that way.
       *
       * ACCOUNT-SCOPED, not per-mailbox: rules apply to the account and travel in the profile
       * document, so the question is whether this install organizes ANYTHING. On a one-mailbox
       * standalone that collapses to "all refused", which is the honest answer for a door whose
       * effect would be nil.
       */
      await assertAccountOrganizes(tx as unknown as Tx, ctx.accountId);

      // Read the CURRENT destination before the write, inside the transaction, so "did the
      // destination change" is answered against the row this update is about to replace rather
      // than against a value the caller supplied. A PATCH that sets the destination it already
      // has re-applies nothing, which is what makes a habit-click cheap.
      //
      // `kind` and `subjectContains` join the read for mail 0050. The kind is needed because
      // `validSubjectContains` refuses a term on anything but `sender` and a PATCH need not carry
      // the kind at all — validating against the caller's absent field instead of the stored row
      // is how a domain rule acquires a subject term the API says it will not accept.
      const [before] = await tx.select({
        destination: rules.destination, kind: rules.kind, subjectContains: rules.subjectContains,
        bodyContains: rules.bodyContains,
      }).from(rules)
        .where(and(eq(rules.id, id), eq(rules.accountId, ctx.accountId))).limit(1);

      if (patch.subjectContains !== undefined) {
        set.subjectContains = this.validSubjectContains(
          patch.subjectContains,
          // The kind AFTER this patch: a single request may legally move a rule from `domain` to
          // `sender` and give it a term in the same breath.
          (set.kind as string | undefined) ?? before?.kind ?? "sender",
        );
      }
      // The body term (mail 0052): identical handling, including the resolved after-patch kind.
      if (patch.bodyContains !== undefined) {
        set.bodyContains = this.validBodyContains(
          patch.bodyContains,
          (set.kind as string | undefined) ?? before?.kind ?? "sender",
        );
      }

      // Either half of "which mail does this rule claim, and where does it send it" moving is a
      // retroactive event. Compared against the STORED value, so a PATCH that re-sends the term it
      // already has costs nothing — the habit-click argument above, applied to the second term.
      const destinationMoved = set.destination !== undefined
        && set.destination !== before?.destination;
      const subjectMoved = set.subjectContains !== undefined
        && (set.subjectContains ?? null) !== (before?.subjectContains ?? null);
      // …and to the third (mail 0052): a body-term edit re-opens the backlog in both directions,
      // on the subject term's reasoning verbatim.
      const bodyMoved = set.bodyContains !== undefined
        && (set.bodyContains ?? null) !== (before?.bodyContains ?? null);
      const retargeted = before !== undefined && (destinationMoved || subjectMoved || bodyMoved);
      if (retargeted && applyRetro) {
        set.retroRequestedAt = ctx.now();
        set.retroDoneAt = null;
        set.retroCursor = null;
        set.retroMoved = 0;
      }

      // Scope the UPDATE to the account: a cross-account id matches 0 rows.
      const updated = await tx.update(rules).set(set)
        .where(and(eq(rules.id, id), eq(rules.accountId, ctx.accountId)))
        .returning({ id: rules.id });
      if (updated.length === 0) throw new ServiceError("not_found", 404, "rule not found");
      const seq = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "rule", entityId: id, op: "update", meta: null,
      });

      // Materialize INSIDE the tx (reads the uncommitted update), so the DTO stored below is
      // byte-for-byte the one the route returns. This used to run AFTER the commit, which was
      // harmless while nothing stored it and is not once a replay must hand back the same body.
      const rule = await materializeRule(asDb(tx), ctx.accountId, id);
      if (!rule) throw new ServiceError("internal", 500, "rule vanished after write");

      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: 200,
          responseJson: rule,
          seq: Number(seq),
          now: ctx.now(),
        });
        // A LOST claim = a concurrent same-key request committed first. Throwing rolls THIS
        // transaction back (the update AND its change_log row) and the caller replays the
        // winner's response.
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return { rule, seq: Number(seq) };
    });
  }

  /**
   * THE DELETE THAT ANSWERS WRONG. A retried DELETE hits `deleted.length === 0` and
   * throws `not_found` — telling the user their revoke FAILED for an operation that
   * SUCCEEDED. The engine's retry queue drains every pending action (`flushPending`), so a
   * lost response on a revoke reaches this by the ordinary path, not an exotic one.
   *
   * ── 204 UNDER A KEY, 404 WITHOUT ONE ─────────────────────────────────────────────────
   *
   * Both answers are true of a second DELETE: "the rule is gone, which is what you asked
   * for" and "there is no such rule". The KEY is what picks between them, exactly as it
   * does for `create`: presenting one is the caller stating THIS IS A RETRY OF THAT
   * REQUEST, and honouring it means handing back the first outcome — the same 204 and the
   * same `X-Sync-Seq`. A caller with no key has offered no evidence it ever performed the
   * delete, and for an id it never owned (cross-account is indistinguishable from
   * missing) 404 is the only honest answer. Answering 204 unconditionally would make this
   * endpoint one that can never say "no such rule".
   *
   * A delete that genuinely finds nothing claims NOTHING: the claim is inside the
   * transaction that throws, so it rolls back with it. The key stays usable, which is
   * right — a key is a promise about an EFFECT, and there was none.
   */
  async remove(
    ctx: ServiceContext, id: string,
    opts: { idempotency?: RuleIdempotency | null } = {},
  ): Promise<{ seq: number }> {
    const seq = await asTx(ctx).transaction(async (tx) => {
      /* -- A READER'S ACCOUNT WRITES NO RULES (mail 0083) ---------------------------------
       *
       * A rule is not a note: `evaluateRules` is the router, `rule-retro.ts` re-files the backlog
       * a new rule covers, and both run on the organizer's authority inside the organizer's own
       * cycle. A rule written where nothing organizes is an instruction that is never carried
       * out — and worse than inert, because the person is told their mail will be filed that way.
       *
       * ACCOUNT-SCOPED, not per-mailbox: rules apply to the account and travel in the profile
       * document, so the question is whether this install organizes ANYTHING. On a one-mailbox
       * standalone that collapses to "all refused", which is the honest answer for a door whose
       * effect would be nil.
       */
      await assertAccountOrganizes(tx as unknown as Tx, ctx.accountId);
      const deleted = await tx.delete(rules)
        .where(and(eq(rules.id, id), eq(rules.accountId, ctx.accountId)))
        .returning({ id: rules.id });
      if (deleted.length === 0) throw new ServiceError("not_found", 404, "rule not found");
      const emitted = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "rule", entityId: id, op: "delete", meta: null,
      });

      // Status 204 with `{}` for a body that is never read: `routes/rules.ts` replays this
      // ITSELF rather than through `withIdempotency`, because the shared replay path is
      // JSON-only and cannot construct a bodiless response — and `response_json` is NOT
      // NULL, so the placeholder is the schema's requirement, not a choice.
      //
      // The claim is NOT the only way a concurrent same-key delete ends. The loser blocks on
      // the winner's ROW lock at the `delete` above, wakes to 0 matched rows and throws 404
      // before it ever reaches here — so the route ALSO re-reads the key on `not_found`.
      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: 204,
          responseJson: {},
          seq: Number(emitted),
          now: ctx.now(),
        });
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return emitted;
    });
    return { seq: Number(seq) };
  }

  private validKind(v: unknown): string {
    if (typeof v !== "string" || !KINDS.has(v)) {
      throw new ServiceError("validation_failed", 400, "kind must be one of sender, domain, header");
    }
    return v;
  }
  private validDestination(v: unknown): Folder {
    if (typeof v !== "string" || !FOLDER_SET.has(v)) {
      throw new ServiceError("validation_failed", 400, "destination is not a canonical folder");
    }
    return v as Folder;
  }
  private validMatch(v: unknown): string {
    if (typeof v !== "string" || v.length === 0) {
      throw new ServiceError("validation_failed", 400, "match is required");
    }
    return v;
  }
  private validPriority(v: unknown): number {
    if (v === undefined) return 0;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new ServiceError("validation_failed", 400, "priority must be an integer");
    }
    return v;
  }
  /**
   * `undefined` ⇒ TRUE. That default is the feature (see {@link CreateRuleBody.applyRetro}), and
   * it is the one `valid*` here that does not default to the inert value — deliberately, and
   * stated so a later reader does not "fix" it into consistency with its neighbours.
   *
   * A non-boolean is a 400 rather than a coercion: `applyRetro: "false"` is truthy in JavaScript,
   * and silently reading a client's attempt to DECLINE as consent to move thousands of messages
   * is the failure mode this check exists for.
   */
  private validApplyRetro(v: unknown): boolean {
    if (v === undefined) return true;
    if (typeof v !== "boolean") {
      throw new ServiceError("validation_failed", 400, "applyRetro must be a boolean");
    }
    return v;
  }

  /**
   * The second term, or `null`. Four refusals and one normalisation, and the ORDER matters.
   *
   *  · `undefined`/`null` ⇒ `null`. Absent means "an ordinary one-term rule"; an explicit `null` is
   *    a PATCH CLEARING the term, which is a legitimate edit and the only way to widen a narrow rule
   *    back to its whole sender.
   *  · A non-string is a 400, never a coercion. `subjectContains: 0` stringified to `"0"` would be
   *    a rule matching every subject containing a zero, which is not what any caller meant.
   *  · **A STRING THAT TRIMS TO NOTHING IS A 400, NOT A COERCION TO `null`** — and this line was the
   *    other way round for an hour, so the reasoning is worth keeping. `""` is a substring of EVERY
   *    subject, so a blank term stored literally is a rule that matches everything while its row
   *    reads as specific; that is what the migration's CHECK refuses. Coercing it to `null` here is
   *    not dangerous in the same way (the result is a bare rule, which is the pre-column behaviour),
   *    but it is a SILENT WIDENING of exactly the request the caller made: the subject sheet says
   *    "file just the ones whose subject matches" and the account would get a rule filing all of
   *    that sender's mail. Refusing is the only answer that cannot surprise anybody, and it makes
   *    the three layers — CHECK, service, engine — agree on one meaning per input. An explicit
   *    `null` remains the way to say "no term", so nothing legitimate is unreachable.
   *  · Over {@link MAX_SUBJECT_CONTAINS_CHARS} is a 400 — checked AFTER trimming, so trailing
   *    whitespace does not decide it — mirroring the CHECK so the ceiling is a validation error and
   *    not a constraint violation surfacing as a 500.
   *  · A term on any kind but `sender` is a 400. It is refused rather than dropped because
   *    silently discarding a field the caller sent is how a client ends up believing it wrote a
   *    narrow rule and getting a broad one. See {@link CreateRuleBody.subjectContains} for why the
   *    other kinds are not offered at all.
   *
   * `kind` is the kind the row will HAVE after this write, resolved by the caller — never the
   * caller's `patch.kind`, which may be absent on a PATCH.
   */
  private validSubjectContains(v: unknown, kind: string): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") {
      throw new ServiceError("validation_failed", 400, "subjectContains must be a string or null");
    }
    const term = v.trim();
    if (term.length === 0) {
      throw new ServiceError(
        "validation_failed", 400,
        "subjectContains must not be blank — send null to remove the subject term",
      );
    }
    if (term.length > MAX_SUBJECT_CONTAINS_CHARS) {
      throw new ServiceError(
        "validation_failed", 400,
        `subjectContains must be at most ${MAX_SUBJECT_CONTAINS_CHARS} characters`,
      );
    }
    if (kind !== "sender") {
      throw new ServiceError(
        "validation_failed", 400, "subjectContains is only valid on a sender rule",
      );
    }
    return term;
  }

  /**
   * The body term, under `validSubjectContains`' contract verbatim (mail 0052): the same four
   * refusals in the same order, the same normalisation, and above all the same REFUSAL of a
   * string that trims to nothing — `""` is a substring of every message text, so coercing it to
   * `null` here would silently widen the exact request the caller made. An explicit `null` still
   * clears the term, which is the only way to widen a narrow rule back. Kept as its own method
   * rather than a parameterised one so each column's error text names the field the caller sent.
   */
  private validBodyContains(v: unknown, kind: string): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") {
      throw new ServiceError("validation_failed", 400, "bodyContains must be a string or null");
    }
    const term = v.trim();
    if (term.length === 0) {
      throw new ServiceError(
        "validation_failed", 400,
        "bodyContains must not be blank — send null to remove the body term",
      );
    }
    if (term.length > MAX_BODY_CONTAINS_CHARS) {
      throw new ServiceError(
        "validation_failed", 400,
        `bodyContains must be at most ${MAX_BODY_CONTAINS_CHARS} characters`,
      );
    }
    if (kind !== "sender") {
      throw new ServiceError(
        "validation_failed", 400, "bodyContains is only valid on a sender rule",
      );
    }
    return term;
  }
}

export const rulesService = new RulesService();

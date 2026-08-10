import { and, asc, eq } from "drizzle-orm";
import { rules, recordChange, claimIdempotencyKey, type Tx } from "@trafficflow/db";
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

export interface CreateRuleBody {
  kind: string;
  match: string;
  destination: string;
  priority?: number;
  enabled?: boolean;
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

    return asTx(ctx).transaction(async (tx) => {
      const [row] = await tx.insert(rules).values({
        accountId: ctx.accountId,
        kind, match, destination, priority,
        enabled: body.enabled ?? true,
        provenance: "manual",
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
      // Read the CURRENT destination before the write, inside the transaction, so "did the
      // destination change" is answered against the row this update is about to replace rather
      // than against a value the caller supplied. A PATCH that sets the destination it already
      // has re-applies nothing, which is what makes a habit-click cheap.
      const [before] = await tx.select({ destination: rules.destination }).from(rules)
        .where(and(eq(rules.id, id), eq(rules.accountId, ctx.accountId))).limit(1);
      const retargeted = before !== undefined
        && set.destination !== undefined
        && set.destination !== before.destination;
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
}

export const rulesService = new RulesService();

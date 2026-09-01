import { and, asc, eq, gt } from "drizzle-orm";
import {
  approvals, routingDecisions, messages, folderState, claimIdempotencyKey, recordChange, type Tx,
} from "@trafficflow/db";
import type { AdapterPort, Destination, NativeLocator } from "@trafficflow/core/mail";
import { applyReconcileAction } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";
import { LearningService } from "./learning-service.js";
import { patternKeyFor } from "./learning-service.js";
import { materializeApproval } from "./dto/materialize.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import type { ApprovalDTO, Page } from "./dto/types.js";

export interface ApprovalDeps {
  /**
   * The IMAP write-path adapter for the inline approved move (OUTSIDE the tx).
   * OPTIONAL: the serverless API constructs the service WITHOUT one — the DB
   * tx still sets folder_state `pending` + emits the move change, and the always-on
   * worker performs the physical IMAP move on its next reconcile cycle.
   */
  adapter?: AdapterPort;
  learning?: LearningService;
}

export interface ApprovalDecisionBody {
  decision: "approve" | "reject";
}

/** Idempotency handle threaded in by the route; the row is written IN the decide tx. */
export interface ApprovalIdempotency {
  key: string;
  requestHash: string;
}

export interface ListApprovalsOptions {
  status?: "pending" | "approved" | "rejected" | "expired";
  cursor?: string;
  limit?: number;
}

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;
/** Materialize inside the ambient tx (reads its uncommitted writes) — same query surface as Db. */
const asDb = (tx: Tx): Db => tx as unknown as Db;

/**
 * ApprovalService. Lists pending approvals and resolves them. On
 * **approve** the stored routing payload is executed via the reconciler write-path
 * — the physical move runs OUTSIDE the DB transaction — the approval +
 * routing decision flip to `approved`, a `move` change is emitted, and the action
 * feeds the learning loop as a POSITIVE signal (advancing graduation counters via
 * SQL). On **reject** the approval flips to `rejected`, an override is
 * recorded, and the learning loop is fed a NEGATIVE signal (demotion). Deciding an
 * already-resolved/expired approval is a 422.
 */
export class ApprovalService {
  private readonly learning: LearningService;
  constructor(private readonly deps: ApprovalDeps) {
    this.learning = deps.learning ?? new LearningService();
  }

  async list(ctx: ServiceContext, opts: ListApprovalsOptions = {}): Promise<Page<ApprovalDTO>> {
    const limit = clampLimit(opts.limit);
    const filters = [eq(approvals.accountId, ctx.accountId)];
    if (opts.status) filters.push(eq(approvals.status, opts.status));
    if (opts.cursor) filters.push(gt(approvals.id, decodeListCursor(opts.cursor)));

    const rows = await ctx.db.select({ id: approvals.id }).from(approvals)
      .where(and(...filters)).orderBy(asc(approvals.id)).limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    const items: ApprovalDTO[] = [];
    for (const r of pageRows) {
      const dto = await materializeApproval(ctx.db, ctx.accountId, r.id);
      if (dto) items.push(dto);
    }
    const nextCursor = rows.length > limit ? encodeListCursor(pageRows[pageRows.length - 1]!.id) : null;
    return { items, nextCursor };
  }

  async decide(
    ctx: ServiceContext, id: string, b: ApprovalDecisionBody,
    opts: { idempotency?: ApprovalIdempotency | null } = {},
  ): Promise<ApprovalDTO> {
    const [appr] = await ctx.db.select().from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.accountId, ctx.accountId))).limit(1);
    if (!appr) throw new ServiceError("not_found", 404, "approval not found");
    // A FAST REFUSAL, and only that — it names the status a user sees ("already rejected")
    // without doing the work. What makes the decision single is the claim in the tx below;
    // this check is free to be stale, and is.
    if (appr.status !== "pending") {
      throw new ServiceError("unprocessable", 422, `approval already ${appr.status}`);
    }
    const expired = appr.expiresAt != null && appr.expiresAt.getTime() <= ctx.now().getTime();
    if (expired) throw new ServiceError("unprocessable", 422, "approval has expired");

    // Resolve the target folder + the message's current native location (reads before the tx, step 1).
    const target = extractFolder(appr.payload);
    let msg: { id: string; fromAddress: string; locator: NativeLocator; observedFolder: string } | null = null;
    if (appr.messageId) {
      const [m] = await ctx.db.select({
        id: messages.id, fromAddress: messages.fromAddress, nativeLocator: messages.nativeLocator,
        observedFolder: folderState.observedFolder,
      }).from(messages).leftJoin(folderState, eq(folderState.messageId, messages.id))
        .where(and(eq(messages.id, appr.messageId), eq(messages.accountId, ctx.accountId))).limit(1);
      if (m) {
        const loc = (m.nativeLocator as NativeLocator | null) ?? { folder: m.observedFolder ?? "INBOX", ref: "0:0" };
        msg = { id: m.id, fromAddress: m.fromAddress, locator: loc, observedFolder: m.observedFolder ?? loc.folder };
      }
    }

    const approve = b.decision === "approve";
    const label = approve ? "positive" : "negative";

    // ── DB tx: flip status, (approve) re-route folder-state, emit change_log, feed learning (step 2) ──
    const dto = await asTx(ctx).transaction(async (tx) => {
      /**
       * THE STATUS FLIP IS A CLAIM, NOT A WRITE — and the read above is only a fast refusal.
       *
       * The `pending` check at the top of this method runs OUTSIDE this transaction, and the
       * write used to assert nothing about the state that check observed:
       *
       *     .where(eq(approvals.id, id))     // the primary key, and nothing else
       *
       * That is check-then-act. It is not rescued by row locking either: the qual is a primary
       * key, so a concurrent writer cannot falsify it, and Postgres' EvalPlanQual re-check under
       * a lock wait re-evaluates a predicate that was never in doubt. BOTH decisions land.
       *
       * Measured on two devices answering one card: two `approval/update` rows in the delta
       * stream — every client told the card resolved twice — and, with the presses swapped, an
       * approval reading `rejected` over a message the approve had already re-routed to the
       * Ohbox and queued for a real IMAP move. The reject branch writes no `folder_state`, so
       * there is nothing for it to undo; the row and the mail disagree about what the user
       * chose, and the reconciler goes on to perform the move the row denies.
       *
       * So the state predicate is repeated IN the UPDATE and the returned row count IS the
       * decision — the `consumeLoginToken` shape, which is what `claimMessageFailures`,
       * `bubbleUpPass` and the credits debit all use. Exactly one decider can observe a row
       * here; the loser throws, which rolls this transaction back with every effect in it
       * (the re-route, the change rows, the learning signal) and answers the same 422 an
       * already-decided approval has always answered.
       *
       * `accountId` rides along for the reason it is on the read: an id is not an authorisation.
       */
      const claimed = await tx.update(approvals)
        .set({ status: approve ? "approved" : "rejected", updatedAt: ctx.now() })
        .where(and(
          eq(approvals.id, id),
          eq(approvals.accountId, ctx.accountId),
          eq(approvals.status, "pending"),
        ))
        .returning({ id: approvals.id });
      if (claimed.length === 0) {
        // Deliberately NOT re-read to name the winning status. The row is whatever the other
        // decider just wrote, the 422 is the same either way, and a second read inside this
        // transaction is one more thing that can be wrong about a decision it did not make.
        throw new ServiceError("unprocessable", 422, "approval already decided");
      }
      if (appr.routingDecisionId) {
        await tx.update(routingDecisions)
          .set({ status: approve ? "approved" : "rejected", updatedAt: ctx.now() })
          .where(eq(routingDecisions.id, appr.routingDecisionId));
      }
      let lastSeq = await recordChange(tx, { accountId: ctx.accountId, entityType: "approval", entityId: id, op: "update", meta: null });

      if (approve && msg && target) {
        await tx.insert(folderState).values({
          messageId: msg.id, desiredFolder: target, observedFolder: msg.observedFolder,
          lastSetBy: "us", reconcileStatus: "pending", conflict: false,
        }).onConflictDoUpdate({
          target: folderState.messageId,
          set: { desiredFolder: target, lastSetBy: "us", reconcileStatus: "pending", conflict: false, updatedAt: ctx.now() },
        });
        lastSeq = await recordChange(tx, {
          accountId: ctx.accountId, entityType: "message", entityId: msg.id, op: "move",
          meta: { from: msg.observedFolder, to: target },
        });
      }

      if (msg && target) {
        await this.learning.recordOn(tx, ctx.accountId, {
          triggeringActionId: `approval:${id}`,
          kind: "approval",
          senderAddress: msg.fromAddress,
          destination: target,
          label,
        });
      }

      // Materialize the resolved ApprovalDTO INSIDE the tx (reads the uncommitted
      // status flip). The demotion pass + physical move below never touch the
      // `approvals` row, so this is the exact DTO the method returns.
      const materialized = await materializeApproval(asDb(tx), ctx.accountId, id);
      if (!materialized) throw new ServiceError("internal", 500, "approval vanished after decision");

      // Store the verbatim response IN this tx so a commit-then-crash retry
      // replays the SAME 200 — never re-flipping the approval (which, already
      // resolved, would otherwise 422). Inserted directly (services can't import packages/api).
      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: 200,
          responseJson: materialized,
          seq: Number(lastSeq),
          now: ctx.now(),
        });
        // A LOST claim = a concurrent same-key request committed first. Throwing rolls THIS
        // transaction back (effect included) and the caller replays the winner's response.
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return materialized;
    });

    // Demotion pass on reject (accumulated overrides disable a promoted pattern).
    if (!approve && msg && target) {
      const pk = patternKeyFor({ senderAddress: msg.fromAddress, destination: target });
      if (pk) await this.learning.promoteOrDemote(ctx, pk);
    }

    // ── Physical IMAP move via the reconciler write-path, OUTSIDE the tx (step 3, idempotent) ──
    // Only when an adapter is injected. The serverless API path has none — the
    // folder_state row is left `pending` and the always-on worker drains it later.
    //
    // That last sentence is also the answer to a stale source locator, and it is why
    // `applyReconcileAction` defers one rather than throwing (see its header): the transaction
    // above wrote `desired_folder` + `reconcile_status: 'pending'` for this message, so a
    // deferred move is EXACTLY the adapter-less shape this path already ships and converges on.
    // Throwing turned it into a 500 over an approval that had committed — and the idempotency
    // claim stored the 200, so the retry replayed success for a request the user saw fail.
    if (approve && msg && target && this.deps.adapter) {
      const repo = makeDrizzleRepo(ctx.db as unknown as Tx);
      await applyReconcileAction(
        { repo, adapter: this.deps.adapter, accountId: ctx.accountId, mailboxId: "" },
        { messageId: msg.id, locator: msg.locator, state: { desiredFolder: target, observedFolder: msg.observedFolder, lastSetBy: "us" } },
        { type: "move", to: target },
      );
    }

    return dto;
  }
}

function extractFolder(payload: unknown): Destination | null {
  if (payload && typeof payload === "object" && "folder" in payload) {
    const f = (payload as { folder?: unknown }).folder;
    if (typeof f === "string") return f as Destination;
  }
  return null;
}

export function makeApprovalService(deps: ApprovalDeps): ApprovalService {
  return new ApprovalService(deps);
}

import { and, eq } from "drizzle-orm";
import {
  rules as rulesTbl, messages, folderState, auditLog, recordChange, type Tx,
} from "@trafficflow/db";
import type {
  AdapterPort, Destination, MigrationObservation, FolderScanner, NativeLocator, ScanOptions,
} from "@trafficflow/core";
import { applyReconcileAction, scanFoldersForMigration, reconcile } from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { ServiceContext } from "./context.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;
const domainOf = (addr: string): string => { const i = addr.indexOf("@"); return i >= 0 ? addr.slice(i + 1) : ""; };

export interface MigrateInput {
  /** Optional mailbox scope for the (opt-in) reconciler re-route pass. */
  mailboxId?: string;
  observations: MigrationObservation[];
}

export interface MigrateOptions {
  /**
   * When true, ALSO re-route already-ingested mail so it matches a migrated rule,
   * via the reconciler write-path OUTSIDE any DB transaction, idempotent
   * (a message already in its destination reconciles to `none` → no move). Default
   * false — migration is **rules-only** by default, so it cannot thrash
   * live folders.
   */
  reroute?: boolean;
}

export interface MigrateSummary {
  created: number;      // migrated rules newly inserted this run
  unchanged: number;    // migrated rules that already existed (idempotent re-run)
  ruleIds: string[];    // ids of all migrated rules for the supplied observations
  rerouted: number;     // messages physically re-routed (0 unless reroute:true)
  /**
   * Messages whose re-route was DEFERRED rather than performed: the source locator was stale, so
   * the desire is persisted and the organizer applies it once the next scan re-finds the message.
   *
   * Separate from {@link rerouted} because they are different facts and the difference is what the
   * user is told. Counting a deferred row as rerouted would report mail as moved that has not
   * moved; dropping it would report a mailbox as fully migrated while rows are still queued.
   */
  deferred: number;
}

/**
 * HeyMigrationService (sub-plan 1e). Seeds the deterministic ruleset from a HEY /
 * existing-mailbox export or folder-scan.
 *
 * **Idempotent & reversible (spec §16).** `migrateFromObservations` upserts one
 * `provenance:'migrated'` rule per observation, keyed on `(accountId, kind, match)`
 * among migrated rules: a re-run with the same observations creates ZERO duplicates
 * and returns them all as `unchanged`. Each newly-created rule emits a `change_log`
 * `rule` `create`; the whole run also writes an append-only `audit_log` entry whose
 * inverse is the undo. `undoMigration` removes ONLY `provenance:'migrated'` rules
 * (manual/promoted rules are untouched), emitting a `change_log` `rule` `delete` per
 * removed rule.
 *
 * **Rules-only by default.** Migration creates rules; it does not move live mail.
 * An opt-in `reroute` pass routes any backfill placement through the reconciler
 * write-path OUTSIDE the tx, idempotently, so it can never thrash folders.
 */
export class HeyMigrationService {
  constructor(private readonly deps: { adapter?: AdapterPort } = {}) {}

  /**
   * Folder-scan → observations. Enumerates the mailbox's folders via the injected
   * {@link FolderScanner} (the `ImapAdapter` implements it), samples each folder's
   * senders, and maps real server folders to canonical Destinations (skipping our
   * own `ohmail/*` management folders). The returned observations feed
   * {@link migrateFromObservations}.
   */
  async scanFolders(scanner: FolderScanner, opts: ScanOptions = {}): Promise<MigrationObservation[]> {
    return scanFoldersForMigration(scanner, opts);
  }

  async migrateFromObservations(
    ctx: ServiceContext,
    input: MigrateInput,
    opts: MigrateOptions = {},
  ): Promise<MigrateSummary> {
    // Dedup observations by (kind, match) up front — the last destination wins for a key,
    // so a single migrated rule per (kind, match) is produced deterministically.
    const byKey = new Map<string, MigrationObservation>();
    for (const o of input.observations) {
      const match = o.kind === "domain" ? o.senderOrDomain.toLowerCase() : o.senderOrDomain.toLowerCase();
      byKey.set(`${o.kind}:${match}`, { ...o, senderOrDomain: match });
    }
    const deduped = [...byKey.values()];

    const ruleIds: string[] = [];
    let created = 0;
    let unchanged = 0;
    const createdIds: string[] = [];

    // ── ONE short tx: upsert migrated rules + change_log for creates + audit_log (no network) ──
    await asTx(ctx).transaction(async (tx) => {
      for (const o of deduped) {
        const [existing] = await tx
          .select({ id: rulesTbl.id, destination: rulesTbl.destination })
          .from(rulesTbl)
          .where(and(
            eq(rulesTbl.accountId, ctx.accountId),
            eq(rulesTbl.kind, o.kind),
            eq(rulesTbl.match, o.senderOrDomain),
            eq(rulesTbl.provenance, "migrated"),
          ))
          .limit(1);

        if (existing) {
          // Already migrated for this key → idempotent no-op (refresh destination if the
          // observation now maps elsewhere; still counts as unchanged — no new row).
          if (existing.destination !== o.destination) {
            await tx.update(rulesTbl)
              .set({ destination: o.destination, updatedAt: ctx.now() })
              .where(eq(rulesTbl.id, existing.id));
          }
          ruleIds.push(existing.id);
          unchanged++;
          continue;
        }

        const [row] = await tx.insert(rulesTbl).values({
          accountId: ctx.accountId,
          kind: o.kind,
          match: o.senderOrDomain,
          destination: o.destination,
          provenance: "migrated",
          enabled: true,
        }).returning({ id: rulesTbl.id });
        await recordChange(tx, {
          accountId: ctx.accountId, entityType: "rule", entityId: row!.id, op: "create", meta: null,
        });
        ruleIds.push(row!.id);
        createdIds.push(row!.id);
        created++;
      }

      if (createdIds.length > 0) {
        // Append-only audit with the inverse (undo) action (spec §13.3 / §16 reversibility).
        await tx.insert(auditLog).values({
          accountId: ctx.accountId,
          action: "hey_migrate",
          payload: { createdRuleIds: createdIds, observations: deduped.length },
          inverse: { action: "undo_hey_migration", ruleIds: createdIds },
        });
      }
    });

    // ── Opt-in re-route via the reconciler write-path, OUTSIDE the tx (idempotent) ──
    let rerouted = 0;
    let deferred = 0;
    if (opts.reroute) {
      ({ moved: rerouted, deferred } = await this.rerouteToMatchRules(ctx, deduped));
    }

    return { created, unchanged, ruleIds, rerouted, deferred };
  }

  /** Remove ONLY `provenance:'migrated'` rules; emit a `change_log` `rule` `delete` per row. */
  async undoMigration(ctx: ServiceContext): Promise<{ removed: number }> {
    return asTx(ctx).transaction(async (tx) => {
      const removedRows = await tx.delete(rulesTbl)
        .where(and(eq(rulesTbl.accountId, ctx.accountId), eq(rulesTbl.provenance, "migrated")))
        .returning({ id: rulesTbl.id });
      for (const r of removedRows) {
        await recordChange(tx, {
          accountId: ctx.accountId, entityType: "rule", entityId: r.id, op: "delete", meta: null,
        });
      }
      if (removedRows.length > 0) {
        await tx.insert(auditLog).values({
          accountId: ctx.accountId,
          action: "undo_hey_migration",
          payload: { removedRuleIds: removedRows.map((r) => r.id) },
          inverse: { action: "hey_migrate" },
        });
      }
      return { removed: removedRows.length };
    });
  }

  /**
   * Re-route already-ingested mail whose sender/domain matches a migrated observation
   * but whose desired folder differs. Idempotent: a message already in its destination
   * reconciles to `none` (no adapter move). Runs OUTSIDE any DB tx. Bounded: at most
   * one move per out-of-place matching message.
   *
   * ── ONE STALE LOCATOR MAY NOT END THE MIGRATION ─────────────────────────────────────────
   *
   * This loop runs AFTER the rules have committed, over every message in the account, on a verb
   * the user opted into once. Until `applyReconcileAction` learned to defer a gone locator, the
   * first message whose source UID had moved threw straight out of this method: the rules were in
   * place, the mail behind that row was never attempted, and — because this pass is the only thing
   * that persists these desires — the un-attempted rows carried NO durable intent for the
   * organizer to drain. A provider recycling one folder therefore silently truncated a
   * mailbox-wide migration, and re-running the verb was the only recovery.
   *
   * The seam now persists the desire and reports `deferred`, so the loop continues and every row
   * it touched is queued. Nothing else here catches: a transport failure or a refused MOVE is not
   * evidence about the rest of the mailbox either, but it is also not a condition this pass can
   * make durable on its own, so it still ends the pass rather than being logged away.
   */
  private async rerouteToMatchRules(
    ctx: ServiceContext,
    observations: MigrationObservation[],
  ): Promise<{ moved: number; deferred: number }> {
    const adapter = this.deps.adapter;
    if (!adapter) return { moved: 0, deferred: 0 };

    // Build sender/domain → destination lookups (sender wins over domain).
    const bySender = new Map<string, Destination>();
    const byDomain = new Map<string, Destination>();
    for (const o of observations) {
      if (o.kind === "sender") bySender.set(o.senderOrDomain, o.destination);
      else byDomain.set(o.senderOrDomain, o.destination);
    }

    const rows = await ctx.db.select({
      messageId: messages.id, fromAddress: messages.fromAddress, nativeLocator: messages.nativeLocator,
      desiredFolder: folderState.desiredFolder, observedFolder: folderState.observedFolder,
      lastSetBy: folderState.lastSetBy,
    }).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(eq(messages.accountId, ctx.accountId));

    const repo = makeDrizzleRepo(ctx.db as unknown as Tx);
    let moved = 0;
    let deferred = 0;
    for (const r of rows) {
      const from = r.fromAddress.toLowerCase();
      const dest = bySender.get(from) ?? byDomain.get(domainOf(from));
      if (!dest) continue;

      const state = {
        desiredFolder: dest,
        observedFolder: r.observedFolder,
        lastSetBy: (r.lastSetBy as "us" | "external") ?? "us",
      };
      // Reconciler decides: already-there → none (no move); otherwise move toward the migrated
      // destination.
      //
      // `appearance_only` is the honest evidence and it changes nothing here. This
      // pass builds `state.observedFolder` FROM `r.observedFolder` and then asks about that same
      // folder, so `observedNow !== state.observedFolder` is false by construction and the
      // adoption arm is unreachable from this call site — it only ever sees `none` and `move`. The
      // argument is required rather than defaulted so that this is written down at the call site
      // instead of being a property somebody has to re-derive.
      const action = reconcile(state, r.observedFolder, { kind: "appearance_only" });
      if (action.type !== "move") continue;

      const locator = (r.nativeLocator as NativeLocator | null) ?? { folder: r.observedFolder, ref: "0:0" };
      const applied = await applyReconcileAction(
        // mailboxId is unused by the move path (it goes through adapter.move + repo),
        // matching the established ScreenerService/ApprovalService call sites.
        { repo, adapter, accountId: ctx.accountId, mailboxId: "" },
        { messageId: r.messageId, locator, state },
        action,
      );
      if (applied.deferred) deferred++;
      else moved++;
    }
    return { moved, deferred };
  }
}

export function makeHeyMigrationService(deps: { adapter?: AdapterPort } = {}): HeyMigrationService {
  return new HeyMigrationService(deps);
}

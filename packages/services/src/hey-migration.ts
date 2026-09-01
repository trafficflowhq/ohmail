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
  /**
   * Messages the re-route DECLINED to touch because their destination had changed since this pass
   * read the account — somebody's newer decision, which wins.
   *
   * Reported rather than silent for the reason `rerouted` is: three different outcomes, three
   * numbers. A superseded row folded into either of the others would claim this pass acted on a
   * message it deliberately left alone.
   */
  superseded: number;
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
    let superseded = 0;
    if (opts.reroute) {
      ({ moved: rerouted, deferred, superseded } = await this.rerouteToMatchRules(ctx, deduped));
    }

    return { created, unchanged, ruleIds, rerouted, deferred, superseded };
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
  ): Promise<{ moved: number; deferred: number; superseded: number }> {
    const adapter = this.deps.adapter;
    if (!adapter) return { moved: 0, deferred: 0, superseded: 0 };

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
    let superseded = 0;
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
      // ── RECORD THE INTENT BEFORE THE NETWORK CALL, NOT AFTER IT ─────────────────────────────
      //
      // This pass is the only thing that persists the desires it computes, and it used to persist
      // them as a side effect of `applyReconcileAction` — which meant AFTER the IMAP move, and on
      // the failure path meant writing back a value read before it. Review named the consequence:
      // a newer decision committed by another device during the move was overwritten by this
      // older one.
      //
      // Writing first fixes both halves. The desire is durable before anything can go wrong, so a
      // stale locator (or a refused move, or a lost connection) leaves a row the organizer drains
      // rather than an intent nobody recorded; and because nothing is written after the round
      // trip, there is no pre-I/O value left to overwrite a post-I/O one with. `observedFolder`
      // stays what we last saw, which is what makes the row unconverged and therefore queued.
      // ── AND IT IS CONDITIONAL ON THE SNAPSHOT STILL BEING TRUE ──────────────────────────────
      //
      // The `rows` read above is ONE bulk snapshot of the whole account, and this loop then spends
      // an IMAP round trip per out-of-place message. Over a large mailbox that is a long time, and
      // review found what an unconditional write did with it: a decision committed on another
      // device for a message this loop has not reached yet is overwritten by the snapshot's older
      // value when the loop gets there. Moving the write earlier fixed the post-I/O race and
      // opened a snapshot-age one in its place, which is not progress.
      //
      // `DO UPDATE … WHERE desired_folder = <what the snapshot saw>` is the whole guard, and it is
      // the construction `screener-service.ts` already uses for the same reason: re-route only the
      // rows that are STILL where this pass believed they were. A row that has moved on keeps
      // where it went — "user always wins", the rule the reconciler runs on. `.returning()` is
      // what makes the skip observable, so a row the guard declined is not counted as re-routed
      // and never reaches the adapter.
      // `asTx` and not `ctx.db` directly: this file's other writers go through the same cast, and
      // it is what gives the upsert its `returning` typing. Not inside a transaction — this pass
      // runs outside one deliberately, and the guard is a single statement.
      const [claimed] = await asTx(ctx).insert(folderState).values({
        messageId: r.messageId, desiredFolder: dest, observedFolder: r.observedFolder,
        lastSetBy: "us", reconcileStatus: "pending", conflict: false,
      }).onConflictDoUpdate({
        target: folderState.messageId,
        set: {
          desiredFolder: dest, lastSetBy: "us", reconcileStatus: "pending", conflict: false,
          updatedAt: ctx.now(),
        },
        setWhere: eq(folderState.desiredFolder, r.desiredFolder),
      }).returning({ messageId: folderState.messageId });
      if (!claimed) {
        superseded++;
        continue;
      }
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
    return { moved, deferred, superseded };
  }
}

export function makeHeyMigrationService(deps: { adapter?: AdapterPort } = {}): HeyMigrationService {
  return new HeyMigrationService(deps);
}

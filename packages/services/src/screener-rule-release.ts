import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { canonicalDestination } from "@trafficflow/core/folder-name";
import { ruleMatchKey, SCREENER_RELEASE_MOVE_MAX } from "@trafficflow/core/rule-order";
import { dialect } from "@trafficflow/db/dialect";
import { folderState, lockAccountMailboxes, lockAccountRuleKeys, messages, readIdempotencyKey, ruleMatchKeySql, rules } from "@trafficflow/db";
import type { ScreenerRuleRelease } from "@ohmail/wire";
import { bridgeTx, runInTransaction, type IdempotencyClaim, type ServiceContext } from "./context.js";
import { IdempotencyRaceLost, ServiceError } from "./errors.js";
import type { MessageService } from "./message-service.js";

const HOLDING = new Set(["ohmail/Screened", "ohmail/Quarantine"]);
const FILED = new Set(["INBOX", "ohmail/News", "ohmail/Receipts"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRelease(raw: unknown): ScreenerRuleRelease {
  const release = raw as Partial<ScreenerRuleRelease> | null;
  if (!release || !Array.isArray(release.messageIds)
      || release.messageIds.some((id) => typeof id !== "string" || !UUID.test(id))
      || (release.existingRuleId !== undefined
        && (typeof release.existingRuleId !== "string" || !UUID.test(release.existingRuleId)))
      || !((HOLDING.has(release.from ?? "") && FILED.has(release.to ?? ""))
        || (FILED.has(release.from ?? "") && HOLDING.has(release.to ?? "")))) {
    throw new ServiceError("validation_failed", 400, "invalid Screener release");
  }
  return {
    from: release.from!, to: release.to!, messageIds: [...new Set(release.messageIds)].slice(0, SCREENER_RELEASE_MOVE_MAX),
    ...(release.existingRuleId === undefined ? {} : { existingRuleId: release.existingRuleId }),
  };
}

type RuleEdit =
  | { ruleId: string; destination?: string; enabled?: boolean }
  | { sender: string; destination: string };

/** Book the held placements and the rule edit under a single account-bound commit. */
export async function withScreenerRuleRelease<T>(
  ctx: ServiceContext,
  raw: unknown,
  edit: RuleEdit,
  mail: MessageService,
  claim: IdempotencyClaim | null | undefined,
  write: (inside: ServiceContext) => Promise<T>,
): Promise<T> {
  const release = readRelease(raw);
  if (HOLDING.has(release.from)
    && (edit.destination !== release.to || ("enabled" in edit && edit.enabled === false))) {
    throw new ServiceError("validation_failed", 400, "the rule and the release must name the same destination");
  }

  const wake = new Set<string>();
  const result = await runInTransaction(ctx, async (inside) => {
    const tx = bridgeTx(inside.db);
    const { accountId } = inside;
    await lockAccountRuleKeys(tx, accountId);
    if (claim && await readIdempotencyKey(tx, accountId, claim.key, ctx.now())) {
      throw new IdempotencyRaceLost(accountId, claim.key);
    }

    let sender;
    if ("ruleId" in edit) {
      // Match the backlog pass: lock the rule before any message or folder state.
      const [rule] = await dialect(tx).forUpdate(tx.select({
        kind: rules.kind, match: rules.match, destination: rules.destination,
        subject: rules.subjectContains, body: rules.bodyContains, enabled: rules.enabled,
      }).from(rules).where(and(eq(rules.accountId, accountId), eq(rules.id, edit.ruleId))), { mode: "update" });
      if (!rule || rule.kind !== "sender" || !rule.enabled || rule.subject?.trim() || rule.body?.trim()
          || canonicalDestination(rule.destination) !== release.from) {
        throw new ServiceError("conflict", 409, "the sender rule has changed");
      }
      sender = ruleMatchKey(rule.match);
    } else {
      sender = ruleMatchKey(edit.sender);
      if (!HOLDING.has(release.from)) throw new ServiceError("validation_failed", 400, "invalid Screener release");
      const existing = await dialect(tx).forUpdate(tx.select({ id: rules.id }).from(rules).where(and(
        eq(rules.accountId, accountId), eq(rules.kind, "sender"),
        sql`${ruleMatchKeySql(rules.match)} = ${sender}`,
        sql`${dialect(tx).hasNonBlank(rules.subjectContains)} is not true`,
        sql`${dialect(tx).hasNonBlank(rules.bodyContains)} is not true`,
      )).orderBy(asc(rules.id)), { mode: "update" });
      if (release.existingRuleId === undefined ? existing.length > 0
        : !existing.some((rule) => rule.id === release.existingRuleId)) {
        throw new ServiceError("conflict", 409, "the sender rule has changed");
      }
    }

    await lockAccountMailboxes(tx, accountId);
    if (release.messageIds.length > 0) {
      const letters = await dialect(tx).forUpdate(tx.select({
        id: messages.id, sender: messages.fromAddress,
      }).from(messages).where(and(
        eq(messages.accountId, accountId), inArray(messages.id, release.messageIds), isNull(messages.deletedAt),
      )).orderBy(asc(messages.id)), { mode: "update" });
      if (letters.length !== release.messageIds.length || letters.some((letter) => ruleMatchKey(letter.sender) !== sender)) {
        throw new ServiceError("not_found", 404, "a released letter was not found for this sender");
      }
      // Keep a concurrent folder move from slipping between the source check and the write.
      await dialect(tx).forUpdate(tx.select({ id: folderState.messageId }).from(folderState).where(and(
        eq(folderState.accountId, accountId), inArray(folderState.messageId, release.messageIds),
      )).orderBy(asc(folderState.messageId)), { mode: "update" });
      for (const { id } of letters) {
        await mail.move(inside, id, { from: release.from, folder: release.to, pressRule: true }, { wakeAfter: wake });
      }
    }
    return write(inside);
  }, { fence: { accountId: ctx.accountId } });

  await Promise.all([...wake].map((mailboxId) => mail.ringFiledMailbox(ctx, mailboxId)));
  return result;
}

import { eq } from "drizzle-orm";
import { accounts, changeScreenerLearning, readScreenerLearning } from "@trafficflow/db";
import type { ScreenerLearningEdit, ScreenerLearningView } from "@ohmail/wire";
import { bridgeTx, type ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { requireUuid } from "./ids.js";

function checkedEdit(value: unknown): ScreenerLearningEdit {
  if (value && typeof value === "object" && "kind" in value) {
    if (value.kind === "enable" && "enabled" in value && typeof value.enabled === "boolean") {
      return { kind: value.kind, enabled: value.enabled };
    }
    if (value.kind === "notice" || value.kind === "reset") return { kind: value.kind };
    if (value.kind === "forget" && "id" in value && typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id)) {
      return { kind: value.kind, id: value.id };
    }
  }
  throw new ServiceError("validation_failed", 400, "Invalid Screener learning change");
}

export async function screenerLearningSettings(
  ctx: ServiceContext, mailboxId: unknown, edit?: unknown,
): Promise<ScreenerLearningView> {
  const scope = { accountId: ctx.accountId, mailboxId: requireUuid(mailboxId, "mailboxId") };
  const db = bridgeTx(ctx.db);
  const [account] = await db.select({ aiEnabled: accounts.aiEnabled }).from(accounts).where(eq(accounts.id, ctx.accountId));
  const change = edit === undefined ? null : checkedEdit(edit);
  const state = change ? await changeScreenerLearning(db, scope, change, ctx.now())
    : await readScreenerLearning(db, scope, ctx.now());
  if (!state) throw new ServiceError("not_found", 404, "Mailbox not found");
  return {
    enabled: state.enabled, aiEnabled: account?.aiEnabled === true,
    notice: state.notice, text: state.text, updatedAt: state.updatedAt,
    lessons: state.lessons.slice(-5).reverse().map(({ id, kind, topic, suggested, previous, chosen }) => ({
      id, kind, topic, suggested, previous, chosen,
    })),
  };
}

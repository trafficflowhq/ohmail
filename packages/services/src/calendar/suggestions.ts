import { and, eq } from "drizzle-orm";
import { recordCalendarChanges } from "@trafficflow/db";
import { holdCalendarMailbox } from "@trafficflow/db/calendar";
import { dialect } from "@trafficflow/db/dialect";
import { calSuggestions } from "@trafficflow/db/mail";
import { withAccountTx, type ServiceContext } from "../context.js";
import { ServiceError } from "../errors.js";
import { isUuid } from "../ids.js";
import { requireCalendarOn } from "./settings-service.js";

export async function setCalendarSuggestionDismissed(ctx: ServiceContext, id: string, body: unknown) {
  if (!isUuid(id)) throw new ServiceError("validation_failed", 400, "a suggestion id is required");
  if (typeof body !== "object" || body === null || !("dismissed" in body) || typeof body.dismissed !== "boolean") {
    throw new ServiceError("validation_failed", 400, "dismissed must be true or false");
  }
  const { dismissed } = body;
  await requireCalendarOn(ctx);
  return withAccountTx(ctx, async (tx) => {
    const where = and(eq(calSuggestions.accountId, ctx.accountId), eq(calSuggestions.id, id));
    const missing = () => new ServiceError("not_found", 404, "no suggestion of this account under that id");
    const [source] = await tx.select({ mailboxId: calSuggestions.mailboxId }).from(calSuggestions).where(where);
    if (!source) throw missing();
    const d = dialect(tx);
    await holdCalendarMailbox(tx, d, { accountId: ctx.accountId, mailboxId: source.mailboxId });
    // scoped-by: `where`, this account's suggestion by its id
    const [row] = await d.forUpdate(tx.select({ state: calSuggestions.state }).from(calSuggestions).where(where));
    if (!row || (row.state !== "open" && row.state !== "dismissed")) throw missing();
    const state = dismissed ? "dismissed" : "open";
    if (row.state === state) return { dismissed, seq: null };

    // scoped-by: `where`, this account's suggestion by its id
    await tx.update(calSuggestions).set({ state, decidedAt: dismissed ? ctx.now() : null }).where(where);
    const [seq] = await recordCalendarChanges(tx, ctx.accountId, [
      { kind: "calendar_suggestion", id, op: dismissed ? "delete" : "create" },
    ]);
    return { dismissed, seq: seq! };
  });
}

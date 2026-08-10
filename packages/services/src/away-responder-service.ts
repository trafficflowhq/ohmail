import { eq } from "drizzle-orm";
import { awayResponders } from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import type { AwayResponderDTO } from "./dto/types.js";

export interface AwayResponderBody {
  enabled?: boolean;
  subject?: string | null;
  body?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toDTO(row: typeof awayResponders.$inferSelect): AwayResponderDTO {
  return {
    enabled: row.enabled,
    subject: row.subject ?? null,
    body: row.body ?? null,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The default disabled shape returned by GET when the account has never configured one. */
const DEFAULT_SHAPE: AwayResponderDTO = {
  enabled: false, subject: null, body: null, startsAt: null, endsAt: null, updatedAt: null,
};

/**
 * AwayResponderService (contract §5.16) — the single per-account autoresponder
 * row. `get` returns the stored row or a default disabled shape; `put` upserts
 * the one-per-account row (UNIQUE(account_id) drives ON CONFLICT). REST-only (no
 * change_log, RC4). When both `startsAt` and `endsAt` are set, `startsAt` must be
 * ≤ `endsAt`.
 */
export class AwayResponderService {
  async get(ctx: ServiceContext): Promise<AwayResponderDTO> {
    const [row] = await ctx.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, ctx.accountId)).limit(1);
    return row ? toDTO(row) : DEFAULT_SHAPE;
  }

  /** PUT /away-responder — full replace / upsert of the account's single row. */
  async put(ctx: ServiceContext, body: AwayResponderBody): Promise<AwayResponderDTO> {
    const enabled = body.enabled ?? false;
    const subject = this.validNullableText(body.subject, "subject");
    const text = this.validNullableText(body.body, "body");
    const startsAt = this.validDate(body.startsAt, "startsAt");
    const endsAt = this.validDate(body.endsAt, "endsAt");
    if (startsAt && endsAt && startsAt.getTime() > endsAt.getTime()) {
      throw new ServiceError("validation_failed", 400, "startsAt must be before or equal to endsAt");
    }

    const now = ctx.now();
    const [row] = await ctx.db.insert(awayResponders).values({
      accountId: ctx.accountId, enabled, subject, body: text, startsAt, endsAt, updatedAt: now,
    }).onConflictDoUpdate({
      target: awayResponders.accountId,
      set: { enabled, subject, body: text, startsAt, endsAt, updatedAt: now },
    }).returning();
    return toDTO(row!);
  }

  private validNullableText(v: unknown, field: string): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw new ServiceError("validation_failed", 400, `${field} must be a string`);
    return v;
  }

  private validDate(v: unknown, field: string): Date | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw new ServiceError("validation_failed", 400, `${field} must be an ISO datetime string`);
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new ServiceError("validation_failed", 400, `${field} is not a valid ISO datetime`);
    return d;
  }
}

export const awayResponderService = new AwayResponderService();

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
  audience?: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The two audiences, as the ONE list both the validator and the DTO type read.
 *
 * The database CHECK (`away_responders_audience_closed`) is the other half and it is not a
 * duplicate: this one turns a bad request into a 400 naming the field, and that one makes a
 * member nobody enumerated unrepresentable regardless of which writer produced it. Widening the
 * audience is the only irreversible thing this feature does — a reply sent to a stranger cannot
 * be recalled — so it is worth having both.
 */
export const AWAY_AUDIENCES = ["screened_in", "everyone"] as const;
export type AwayAudience = (typeof AWAY_AUDIENCES)[number];

function toDTO(row: typeof awayResponders.$inferSelect): AwayResponderDTO {
  return {
    enabled: row.enabled,
    subject: row.subject ?? null,
    body: row.body ?? null,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    // A stored value outside the closed set cannot reach here through this service or through the
    // CHECK, so the narrowing is a type assertion and not a fallback: inventing `screened_in` for
    // an unrecognised member would report a narrower audience than the pass would act on.
    audience: row.audience as AwayAudience,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The default disabled shape returned by GET when the account has never configured one. */
const DEFAULT_SHAPE: AwayResponderDTO = {
  enabled: false, subject: null, body: null, startsAt: null, endsAt: null,
  audience: "screened_in", updatedAt: null,
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
    const audience = this.validAudience(body.audience);
    if (startsAt && endsAt && startsAt.getTime() > endsAt.getTime()) {
      throw new ServiceError("validation_failed", 400, "startsAt must be before or equal to endsAt");
    }

    const now = ctx.now();
    const [row] = await ctx.db.insert(awayResponders).values({
      accountId: ctx.accountId, enabled, subject, body: text, startsAt, endsAt, audience, updatedAt: now,
    }).onConflictDoUpdate({
      target: awayResponders.accountId,
      set: { enabled, subject, body: text, startsAt, endsAt, audience, updatedAt: now },
    }).returning();
    return toDTO(row!);
  }

  /**
   * The audience, or `'screened_in'` for an omitted one — the NARROW member, and it has to be the
   * narrow one.
   *
   * `put` is a FULL REPLACE (the route's contract), so an omitted field is not "leave it alone", it
   * is "this request did not ask for it". Defaulting an omitted audience to the stored value would
   * make a client that predates this field silently preserve `everyone`; defaulting it to
   * `everyone` would be a widening nobody requested. Only the narrow member is safe to infer, and
   * it is the same value the column's own DEFAULT writes.
   */
  private validAudience(v: unknown): AwayAudience {
    if (v === undefined || v === null) return "screened_in";
    if (typeof v !== "string" || !(AWAY_AUDIENCES as readonly string[]).includes(v)) {
      throw new ServiceError(
        "validation_failed", 400, `audience must be one of ${AWAY_AUDIENCES.join(", ")}`,
      );
    }
    return v as AwayAudience;
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

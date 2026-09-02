import { eq } from "drizzle-orm";
import { awayResponders } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core/mail";
import { AWAY_THROTTLES, type AwayThrottle } from "./away-responder-pass.js";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import type { AwayResponderDTO } from "./dto/types.js";

const log = createLogger({ service: "away-responder-service" });

export interface AwayResponderBody {
  enabled?: boolean;
  /**
   * ACCEPTED AND IGNORED, for exactly one release. The responder is reply-only now, so there is no
   * subject to store — but a 0.13 client (a browser tab that has not reloaded, a desktop on the
   * hosted door that has not updated) still PUTs one, and this endpoint is a FULL REPLACE.
   * Refusing the field would 400 that client's every save, including the save that turns the
   * responder OFF — which is the one save nobody may be prevented from making. So it is read,
   * counted in the log, and dropped. Removed in 0.15 together with the column.
   */
  subject?: string | null;
  body?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  audience?: string | null;
  throttle?: string | null;
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
    body: row.body ?? null,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    // A stored value outside the closed set cannot reach here through this service or through the
    // CHECK, so the narrowing is a type assertion and not a fallback: inventing `screened_in` for
    // an unrecognised member would report a narrower audience than the pass would act on.
    audience: row.audience as AwayAudience,
    // Same narrowing and the same reason as `audience` above: a stored value outside the closed
    // set cannot reach here through this service or through the CHECK, so this is an assertion and
    // not a fallback. Inventing `per_day` for an unrecognised member would report a RATE the pass
    // does not act on — and the two members that differ most, `always` and `per_week`, differ by a
    // factor of seven in how often a stranger hears from this address.
    throttle: row.throttle as AwayThrottle,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The default disabled shape returned by GET when the account has never configured one. */
const DEFAULT_SHAPE: AwayResponderDTO = {
  enabled: false, body: null, startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day", updatedAt: null,
};

/**
 * WHEN THE RESPONDER'S CURRENT ENABLEMENT BEGAN — ONE implementation, used by {@link
 * AwayResponderService.put} and by `profile-import-service.ts`, because two writers of this column
 * disagreeing is the whole failure it was added to fix.
 *
 * It moves on the OFF → ON TRANSITION and at no other time:
 *
 *   not enabled          → null. Turning the responder off ends the window. Keeping the instant
 *                          would make a re-enable months later answer everything that arrived in
 *                          between, because the floor would still be the old one.
 *   enabled, was off     → now. A fresh window: the backlog before this instant is not answered,
 *                          which is the rule "enabling a responder never answers the backlog".
 *   enabled, was on      → unchanged. THIS IS THE POINT OF THE COLUMN. An edit mid-trip — a typo
 *                          fix, a date change, a new throttle — leaves the floor where it was, so
 *                          the correspondents who wrote before the edit are still answerable.
 *                          `updated_at` moved on every save, which is why they used to get no
 *                          reply at all — neither the old text nor the new one.
 */
export function nextEnabledAt(prev: Date | null, enabled: boolean, now: Date): Date | null {
  if (!enabled) return null;
  return prev ?? now;
}

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
    const text = this.validNullableText(body.body, "body");
    const startsAt = this.validDate(body.startsAt, "startsAt");
    const endsAt = this.validDate(body.endsAt, "endsAt");
    const audience = this.validAudience(body.audience);
    const throttle = this.validThrottle(body.throttle);
    if (startsAt && endsAt && startsAt.getTime() > endsAt.getTime()) {
      throw new ServiceError("validation_failed", 400, "startsAt must be before or equal to endsAt");
    }
    // A client that still sends a subject is a client one release behind. Counted, not refused —
    // see `AwayResponderBody.subject`. The VALUE is never logged: it is the user's own prose.
    if (body.subject !== undefined && body.subject !== null) {
      log.info("away_put_legacy_client", {
        accountId: ctx.accountId,
        reason: "the client sent a subject; the responder is reply-only and the field was ignored",
      });
    }

    const now = ctx.now();
    /**
     * THE ENABLEMENT INSTANT NEEDS THE PREVIOUS ROW, so it is read here rather than derived from
     * the upsert. One extra indexed read on the one write in this feature that starts mail going
     * out, and it buys the property `enabled_at` exists for: an edit while the responder is on must
     * NOT move the floor.
     *
     * It is deliberately not folded into the `ON CONFLICT` SET as a CASE over the existing row —
     * which would save the read — because `nextEnabledAt` is then written twice, once in TypeScript
     * for the insert arm and once in SQL for the update arm, and the profile importer would need a
     * third. Two encodings of "when did this window open" is exactly the drift this column replaced.
     */
    const [prev] = await ctx.db.select({ enabledAt: awayResponders.enabledAt })
      .from(awayResponders).where(eq(awayResponders.accountId, ctx.accountId)).limit(1);
    const enabledAt = nextEnabledAt(prev?.enabledAt ?? null, enabled, now);

    const [row] = await ctx.db.insert(awayResponders).values({
      accountId: ctx.accountId, enabled, body: text, startsAt, endsAt, audience, throttle,
      enabledAt, updatedAt: now,
    }).onConflictDoUpdate({
      target: awayResponders.accountId,
      // `subject` is NOT in the SET: the column survives one release for a rolling deploy's sake
      // and this service neither reads nor writes it. A row that still carries one keeps it,
      // inert, until the 0.15 contract migration drops it.
      set: { enabled, body: text, startsAt, endsAt, audience, throttle, enabledAt, updatedAt: now },
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

  /**
   * The throttle, or `'per_day'` for an omitted one — the DEFAULT member, and unlike `audience`
   * this is deliberately not the narrowest.
   *
   * `put` is a FULL REPLACE, so an omitted field is "this request did not ask for it", and the only
   * safe thing to infer is a value that cannot surprise: `per_day` is the column's own DEFAULT,
   * what every row migrated by 0087 carries, and what the settings copy calls "at most once a day".
   * Inferring `always` from silence would multiply how often a stranger hears from this address by
   * whatever their sending rate is; inferring `per_week` would silently throttle somebody who never
   * asked for it. A client that predates the field sends none and keeps the migrated behaviour,
   * which is the honest reading of a request that does not mention it.
   */
  private validThrottle(v: unknown): AwayThrottle {
    if (v === undefined || v === null) return "per_day";
    if (typeof v !== "string" || !(AWAY_THROTTLES as readonly string[]).includes(v)) {
      throw new ServiceError(
        "validation_failed", 400, `throttle must be one of ${AWAY_THROTTLES.join(", ")}`,
      );
    }
    return v as AwayThrottle;
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

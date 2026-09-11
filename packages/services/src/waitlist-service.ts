import { asc, isNull, sql } from "drizzle-orm";
import { type Tx } from "@trafficflow/db";
import { waitlist } from "@trafficflow/db/cloud";
import type { Db } from "./context.js";
import { ServiceError } from "./errors.js";
import { reserveIpSlot } from "./ip-throttle.js";
import { issueInvite, liveInvitesFor, markInviteDelivered, revokeInvitesFor } from "./invites.js";
import { normalizeRecipient } from "./mail/port.js";
import type { MailSendResult } from "./mail/port.js";
import type { MailContext, MailService } from "./mail/mail-service.js";
import type { WaitlistTier } from "./mail/templates.js";

/**
 * The FUNNEL service: the landing's waitlist and the operator's invite mint. The only writer of
 * `waitlist` (and, with `invites.ts`, `invites`), and the only holder of a `MailService` outside
 * the alert path — a bare `MailerPort` is an unthrottled mail-bomb primitive, so composition
 * roots construct the SERVICE. Whether a mail goes out lives one layer down; this class decides
 * which mail. THE MAILER IS OPTIONAL: no `RESEND_API_KEY` means pre-launch, not broken. `join()`
 * still records the row and answers 202 — the signup is the valuable, durable half, and losing it
 * over an unconfigured provider would be the expensive failure. The response says which happened
 * (`mailed`), so a smoke test can tell the two apart.
 */
/**
 * The BODY of a public, unauthenticated POST. Every field is `unknown` except the one the
 * validator already guards (`normalizeRecipient` type-checks its own argument), because a
 * declared `string` here is a claim about a JSON document a stranger wrote. See
 * {@link asWireString}.
 */
export interface WaitlistJoinInput {
  email: string;
  tier?: unknown;
  source?: unknown;
}

export interface WaitlistJoinResult {
  /** Always `"ok"` — see {@link WaitlistService.join} on why this is not an oracle. */
  status: "ok";
  /**
   * Whether a confirmation mail was actually accepted by the transport. `false` covers both "no
   * mailer" and "the per-recipient limiter refused" — from the SIGNER's view those are the same
   * event and neither is a failure of the signup. NEVER PUT THIS ON THE WIRE: `POST /waitlist`
   * deliberately does not return it. It is a readout of the per-recipient limiter — a counter
   * about an address the caller may not own — so on a public endpoint it is an oracle: submit
   * repeatedly and the flip from `true` to `false` says how much mail we recently sent that
   * person. It exists for the operator smoke test and the suite, both inside the trust boundary.
   */
  mailed: boolean;
}

export interface MintInviteInput {
  email: string;
  /** How long the code lives. Defaults to {@link DEFAULT_INVITE_TTL_MS}. */
  ttlMs?: number;
  issuedBy?: string;
  note?: string | null;
  /** Refuse when the address already holds a live invite (default true). */
  requireNoLiveInvite?: boolean;
  /** Skip the mail and just return the code — for an operator who will deliver it by hand. */
  send?: boolean;
}

export interface MintInviteResult {
  /** The RAW code. Returned once, to the operator; never persisted in this shape. */
  code: string;
  email: string;
  expiresAt: Date;
  mail: MailSendResult | null;
  /** How many previously-live invites `--force` took back on the way in. Usually 0. */
  revoked: number;
}

export interface WaitlistEntry {
  email: string;
  tier: string;
  source: string;
  createdAt: Date;
  invitedAt: Date | null;
  registeredAt: Date | null;
}

/** Two weeks. Long enough for a holiday, short enough that a leaked mail goes stale. */
export const DEFAULT_INVITE_TTL_MS = 14 * 24 * 60 * 60_000;

/**
 * Waitlist submissions one client IP may make per {@link JOIN_WINDOW_MS}.
 *
 * Generous on purpose: an office or a household behind one NAT is a normal source of
 * several genuine signups, and a limit that refuses the fourth person in a room is a
 * self-inflicted wound on the one funnel the product has. Ten an hour still turns
 * "unbounded rows from one machine" into 240 a day, which is a number an operator can see
 * and act on rather than a table that grows while nobody is looking.
 */
export const MAX_JOINS_PER_IP_WINDOW = 10;
const JOIN_WINDOW_MS = 60 * 60_000;

/**
 * Claim one of this IP's slots, atomically. `false` ⇒ refuse.
 *
 * **THE BODY MOVED; THE BEHAVIOUR DID NOT.** The single-statement `ON CONFLICT DO UPDATE`
 * that used to live here is now `reserveIpSlot` in `ip-throttle.ts`, because
 * `AuthService.register` needed the same primitive when open signup landed and the choice
 * was to reuse this one rather than write a second limiter beside it. The key shape
 * (`waitlist:ip:<sha256(ip)>`), the window and the cap are unchanged, so no existing
 * counter row changes meaning.
 */
async function reserveJoinSlot(tx: Tx, ip: string, now: Date): Promise<boolean> {
  return reserveIpSlot(tx, {
    namespace: "waitlist:ip",
    ip,
    now,
    max: MAX_JOINS_PER_IP_WINDOW,
    windowMs: JOIN_WINDOW_MS,
  });
}

/** The tiers the landing form offers. The DB CHECK in 0020 is the same list. */
const TIERS: readonly WaitlistTier[] = ["desktop", "solo", "plus", "pro", "undecided"];

const asTx = (db: Db): Tx => db as unknown as Tx;

export interface WaitlistServiceDeps {
  /** Absent ⇒ this deployment records signups and sends nothing. See the class doc. */
  mail?: MailService;
}

export class WaitlistService {
  constructor(private readonly deps: WaitlistServiceDeps = {}) {}

  /**
   * Record a waitlist signup and send the confirmation. THE ANSWER IS ALWAYS THE SAME — a
   * distinguishable "already on the list" is a membership oracle. ONE ROW PER ADDRESS: `ON
   * CONFLICT (email) DO UPDATE`; `tier` becomes the latest answer, `created_at` is NOT touched.
   * ONE MAIL, deduplicated twice: a provider `idempotencyKey` and the per-recipient limiter
   * (`unsolicited` quota, so a stranger cannot spend an INVITE's budget). The row is written
   * FIRST, never rolled back by a mail outcome. THREE LIMITS: the mail (keyed on the ADDRESS);
   * the rows (per IP per hour, 429 keyed on the CALLER); nothing else — a distributed submitter
   * is a recorded gap. The per-IP limit is SKIPPED with no client IP.
   */
  async join(
    ctx: MailContext & { ip?: string }, input: WaitlistJoinInput,
  ): Promise<WaitlistJoinResult> {
    const email = normalizeRecipient(input.email ?? "");
    if (!email) {
      throw new ServiceError("validation_failed", 400, "a valid email address is required");
    }
    const tier = normalizeTier(input.tier);
    const source = normalizeSource(input.source);
    const now = ctx.now();

    const ip = (ctx.ip ?? "").trim();
    if (ip.length > 0 && !await reserveJoinSlot(asTx(ctx.db), ip, now)) {
      throw new ServiceError(
        "rate_limited", 429,
        "Too many signups from this connection. Try again in an hour.",
      );
    }

    await asTx(ctx.db).insert(waitlist)
      .values({ email, tier, source, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: waitlist.email,
        // `created_at` and `invited_at` are intentionally absent: re-signing up does not
        // reset when you first asked, and it does not un-invite you.
        set: { tier, updatedAt: now },
      });

    const mail = this.deps.mail
      ? await this.deps.mail.sendWaitlistConfirmation(ctx, { to: email, tier })
      : null;

    return { status: "ok", mailed: mail?.status === "sent" };
  }

  /**
   * Mint an invite for one address and mail it. THE OPERATOR PATH — no HTTP route; driven by
   * `invite-cli.ts`. `requireNoLiveInvite` (default) refuses when the address already holds a
   * live code: two working invites make "already used" a lie about the OTHER code. `--force`
   * REVOKES what it replaces — it used to only skip the check, leaving a leaked code working
   * alongside its replacement; revocation happens BEFORE the new row, one conditional UPDATE. The
   * mail is sent AFTER the row commits; a failed send leaves the code on screen. DELIVERY MAKES
   * THE INVITE CONFER VERIFICATION: issued NON-conferring, upgraded only when the transport
   * answers `sent` — a crash between the steps strands a mailed invite on the harmless side.
   */
  async mintInvite(ctx: MailContext, input: MintInviteInput): Promise<MintInviteResult> {
    const email = normalizeRecipient(input.email ?? "");
    if (!email) {
      throw new ServiceError("validation_failed", 400, "a valid email address is required");
    }
    const now = ctx.now();
    const ttlMs = input.ttlMs ?? DEFAULT_INVITE_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new ServiceError("validation_failed", 400, "the invite TTL must be a positive number of milliseconds");
    }

    let revoked = 0;
    if (input.requireNoLiveInvite !== false) {
      const live = await liveInvitesFor(asTx(ctx.db), email, now);
      if (live.length > 0) {
        throw new ServiceError(
          "invite_exists", 409,
          `${email} already holds a live invite (expires ${live[0]!.expiresAt.toISOString()}). ` +
          "Re-run with --force to revoke it and issue another.",
        );
      }
    } else {
      revoked = await revokeInvitesFor(asTx(ctx.db), {
        email, now, revokedBy: input.issuedBy, reason: "superseded by --force reissue",
      });
    }

    const expiresAt = new Date(now.getTime() + ttlMs);
    const issued = await issueInvite(asTx(ctx.db), {
      email, expiresAt, now, issuedBy: input.issuedBy, note: input.note ?? null,
      // Non-conferring until the mail is actually out — see the header. The upgrade below is
      // the only thing that makes this row prove address control.
      confersVerified: false,
    });

    const mail = input.send === false || !this.deps.mail
      ? null
      : await this.deps.mail.sendInvite(ctx, { to: email, code: issued.code, expiresAt });
    if (mail?.status === "sent") {
      await markInviteDelivered(asTx(ctx.db), issued.inviteId);
    }

    return { code: issued.code, email, expiresAt, mail, revoked };
  }

  /**
   * Take back every live invite for one address; returns how many. The remedy for a code that
   * went to the wrong inbox or was pasted somewhere it should not have been — before migration
   * 0021 the table could express "expired" and "used" but not "cancelled", so a leaked invite
   * stayed a working key for up to a fortnight. Idempotent by construction (the second call
   * answers 0) and it never touches a CONSUMED invite: `consumed_by_user_id` is how "which invite
   * opened this account" is answered, and revoking after the fact would rewrite that record
   * without closing anything. If the code is already redeemed the remedy is the account, not the
   * invite.
   */
  async revokeInvites(
    ctx: MailContext, input: { email: string; revokedBy?: string; reason?: string | null },
  ): Promise<number> {
    const email = normalizeRecipient(input.email ?? "");
    if (!email) {
      throw new ServiceError("validation_failed", 400, "a valid email address is required");
    }
    return revokeInvitesFor(asTx(ctx.db), {
      email, now: ctx.now(), revokedBy: input.revokedBy, reason: input.reason ?? null,
    });
  }

  /**
   * The funnel, for the operator script: oldest first, optionally only those not yet
   * invited. Read-only and account-less by nature — a waitlist entry belongs to nobody.
   */
  async list(
    ctx: MailContext, opts: { pending?: boolean; limit?: number } = {},
  ): Promise<WaitlistEntry[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows = await asTx(ctx.db).select({
      email: waitlist.email, tier: waitlist.tier, source: waitlist.source,
      createdAt: waitlist.createdAt, invitedAt: waitlist.invitedAt,
      registeredAt: waitlist.registeredAt,
    })
      .from(waitlist)
      .where(opts.pending ? isNull(waitlist.invitedAt) : undefined)
      .orderBy(asc(waitlist.createdAt))
      .limit(limit);
    return rows;
  }

  /** Counts for the operator: total / invited / registered. One query, three numbers. */
  async stats(ctx: MailContext): Promise<{ total: number; invited: number; registered: number }> {
    const [row] = await asTx(ctx.db).select({
      total: sql<number>`count(*)::int`,
      invited: sql<number>`count(*) filter (where ${waitlist.invitedAt} is not null)::int`,
      registered: sql<number>`count(*) filter (where ${waitlist.registeredAt} is not null)::int`,
    }).from(waitlist);
    return { total: row?.total ?? 0, invited: row?.invited ?? 0, registered: row?.registered ?? 0 };
  }
}

export function makeWaitlistService(deps: WaitlistServiceDeps = {}): WaitlistService {
  return new WaitlistService(deps);
}

/**
 * An unrecognised tier becomes `undecided` rather than a 400.
 *
 * The tier is a soft preference on a marketing form, and the DB CHECK would turn a stale
 * client build into a 500 the signer reads as "the waitlist is broken". Losing the
 * preference is a rounding error; losing the signup is not. The one thing that must not
 * happen is a value reaching the column that the CHECK — and the mail template's
 * exhaustive tier→label map — cannot represent.
 */
/**
 * `unknown`, not `string | undefined` — the whole point. The parameter TYPE is a promise about a
 * value from an unauthenticated caller, and the wire keeps no promises: `{"tier": 42}`
 * deserializes to a number, and `.trim()` on it is a `TypeError` — a 500 on a public endpoint
 * from a two-character body. `POST /auth/register` one file over already answers 400 for exactly
 * this, and the suite has a test named for it. Declaring `unknown` makes the compiler force the
 * check rather than leave it to a reviewer. A non-string is treated as ABSENT, not a 400: an
 * unrecognised tier already becomes `undecided`, and losing the preference is a rounding error
 * while losing the signup is not.
 */
function asWireString(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function normalizeTier(raw: unknown): WaitlistTier {
  const value = asWireString(raw).trim().toLowerCase();
  return (TIERS as readonly string[]).includes(value) ? (value as WaitlistTier) : "undecided";
}

/** Bounded, so a public endpoint cannot write arbitrary strings into a reporting column. */
function normalizeSource(raw: unknown): string {
  const value = asWireString(raw).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return value.length > 0 ? value.slice(0, 32) : "landing";
}

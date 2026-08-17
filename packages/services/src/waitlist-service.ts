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
 * The FUNNEL service: the landing's waitlist, and the operator's invite mint.
 *
 * It is the only thing that writes `waitlist` and (with `invites.ts`) `invites`, and it is
 * the only holder of a {@link MailService} outside the alert path — which is deliberate and
 * is the rule `mail/port.ts` states: a caller holding a bare `MailerPort` has an
 * unthrottled mail-bomb primitive, so composition roots construct the SERVICE and hand
 * that over. Everything about *whether* a mail goes out (the per-recipient limiter, the
 * link construction) already lives one layer down; this class decides only *which* mail.
 *
 * ── WHY THE MAILER IS OPTIONAL ──────────────────────────────────────────────────────
 *
 * A deployment with no `RESEND_API_KEY` is not broken, it is pre-launch (the same posture
 * `/billing/*` takes toward an absent Stripe config). `join()` still records the row and
 * still answers 202: the signup is the valuable, durable half, and losing it because the
 * mail provider is unconfigured would be the expensive failure. The response says which
 * happened (`mailed`), so a smoke test can tell the two apart and the landing does not
 * have to.
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
   * Whether a confirmation mail was actually accepted by the transport. `false` covers
   * both "this deployment has no mailer" and "the per-recipient limiter refused it",
   * because from the SIGNER's point of view those are the same event and neither is a
   * failure of the signup.
   *
   * **NEVER PUT THIS ON THE WIRE.** `POST /waitlist` deliberately does not return it, and
   * `waitlist.ts` says so at the route. It is a readout of the per-recipient mail limiter,
   * which is a counter about an address the caller may not own — so on a public endpoint it
   * is an oracle: submit repeatedly and the flip from `true` to `false` tells you how much
   * mail we have recently sent that person. It exists here for the operator smoke test and
   * for the suite, both of which are already inside the trust boundary.
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
   * Record a waitlist signup and send the confirmation.
   *
   * ── THE ANSWER IS ALWAYS THE SAME ───────────────────────────────────────────────
   *
   * A first-time signup, a re-submission, and a re-submission with a different tier all
   * answer `{status:"ok"}` with the same status code. The endpoint is public and
   * unauthenticated, so a distinguishable "you are already on the list" would be a free
   * membership oracle over any address — small stakes next to an account-existence
   * oracle, but it costs nothing to not have one, and "the response shape does not
   * depend on data the caller has no right to" is the rule the register endpoint is
   * held to two files away.
   *
   * ── ONE ROW PER ADDRESS ─────────────────────────────────────────────────────────
   *
   * `ON CONFLICT (email) DO UPDATE` — never an append. Three submissions are one entry,
   * `updated_at` moves, and the `tier` becomes the latest answer (a person who upgrades
   * their intention from "undecided" to "pro" between two visits means the second one).
   * `created_at` is deliberately NOT touched: when they first asked is a fact.
   *
   * ── AND ONE MAIL ────────────────────────────────────────────────────────────────
   *
   * The landing copy (`signup.successBody`) names both mails a signer can get — this
   * confirmation, if the deployment has a mailer at all, and later the invite — so the
   * confirmation is sent on every submission but is deduplicated twice over by the mail layer: an
   * `idempotencyKey` of `waitlist:hash(to|tier)` at the provider, and the per-recipient
   * limiter (five per hour, `unsolicited` quota) beneath it. A form submitted ten times
   * in a minute is one row and one mail.
   *
   * The quota namespace matters here and is not an implementation detail: this is the one
   * template a stranger can aim at an address they do not own, so it must not be able to
   * spend the budget that address's INVITE needs. See {@link MailQuota}.
   *
   * The row is written FIRST and is never rolled back by a mail outcome. A mail is a
   * side effect of the signup, not its purpose (the `MailerPort` doc's rule); losing the
   * signup because the mail provider had a bad minute would invert that.
   *
   * ── WHAT BOUNDS AN ANONYMOUS CALLER ─────────────────────────────────────────────
   *
   * Three limits, on three different resources, because the endpoint can do three
   * different kinds of harm and no single key bounds all of them:
   *
   *  1. **The mail** — the per-recipient limiter, keyed on the ADDRESS, because the
   *     victim of unwanted mail is the recipient and not the submitter. Since the quota
   *     split it spends the `unsolicited` budget only, so it cannot starve an invite.
   *  2. **The rows** — {@link MAX_JOINS_PER_IP_WINDOW} per client IP per hour, checked
   *     BEFORE the write. Without it one caller can write a `waitlist` row per address
   *     they can invent, forever, and the mail limiter does not bound that at all
   *     (a distinct address is a fresh budget). The refusal is 429 and is keyed on the
   *     CALLER, so it discloses nothing about any address.
   *  3. **Nothing else, and that is the residual.** A distributed submitter defeats (2)
   *     and the answer to that is a challenge (Turnstile) plus an edge limit — infra this
   *     deployment does not have yet. A known, recorded gap.
   *
   * The per-IP limit is SKIPPED when the platform gave us no client IP at all. That is
   * not laxity, it is the lesser of two bugs: keying every such request on one shared
   * empty-string bucket makes twenty requests a global lockout of the signup form. See
   * `clientIp` in `packages/api/src/context.ts` for where the value comes from and why an
   * absent one is a deployment fault rather than a request to be punished.
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
   * Mint an invite for one address and mail it (the invite template).
   *
   * The OPERATOR path — there is deliberately no HTTP route for this. Putting
   * an unauthenticated-by-nothing "make me an invite" endpoint on the public API before
   * the staff role existed would have been the single worst thing this code could ship. It is
   * driven by `invite-cli.ts` beside this file, against the production database.
   *
   * `requireNoLiveInvite` (default) refuses when the address already holds an unconsumed,
   * unexpired code: running the script twice must not put two working invites in one
   * inbox, because then "this invite has already been used" becomes a confusing lie about
   * the OTHER code. Pass `false` (`--force`) to deliberately re-issue.
   *
   * **`--force` REVOKES what it replaces**, and that is the whole point of it. It used to
   * only skip the check, so the documented remedy for a leaked or misdirected invite —
   * "re-run with --force" — left the compromised code working for the rest of its fortnight
   * alongside its replacement. Two live keys to one account, from the command whose purpose
   * was to take one away. Worse, two live invites for one address is exactly what the
   * duplicate-account race needed before migration 0021's unique index closed it.
   *
   * Revocation happens BEFORE the new row is issued, so the two never overlap, and it is a
   * single conditional UPDATE (`revokeInvitesFor`) so it cannot race a redemption in flight.
   *
   * The mail is sent AFTER the row is committed by the caller's `db` handle. If the send
   * fails the invite still exists and the operator sees the failed `MailSendResult` in
   * their terminal, which is the right outcome: the code is on screen and can be
   * delivered by hand.
   *
   * **DELIVERY IS WHAT MAKES THE INVITE CONFER VERIFICATION.** The row is issued
   * NON-conferring and upgraded (`markInviteDelivered`) only when the transport answers
   * `sent`: register stamps `email_verified_at` on the receipt argument — a mailed code
   * presented back from its bound address proves the inbox — and until the mail is out that
   * argument has not happened. So a `send: false` mint, a failed send and a skipped send all
   * leave the code fully REDEEMABLE but non-conferring: the account registers, starts
   * unverified, and proves its address through the ordinary mailed verification flow. The
   * order (issue false, upgrade on proof) is deliberate — a crash between the two steps
   * strands a mailed invite on the harmless side, never a conferring row for a code no inbox
   * received.
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
   * Take back every live invite for one address. Returns how many.
   *
   * The remedy for a code that went to the wrong inbox, was forwarded, or was pasted
   * somewhere it should not have been. Until migration 0021 there was no such remedy at all:
   * the table could express "expired" and "used" but not "cancelled", so a leaked invite
   * stayed a working key to a new account for up to a fortnight and the only advice was to
   * wait it out.
   *
   * Idempotent by construction — the second call revokes nothing and answers 0 — and it
   * never touches a CONSUMED invite: `consumed_by_user_id` is how "which invite opened this
   * account" is answered, and revoking after the fact would rewrite that record without
   * closing anything. If the code has already been redeemed the remedy is the account, not
   * the invite.
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
 * `unknown`, not `string | undefined` — and that is the whole point.
 *
 * The parameter TYPE is a promise about a value that arrived over the wire from an
 * unauthenticated caller, and the wire keeps no promises: `{"tier": 42}` deserializes to a
 * number, `{"tier": ["pro"]}` to an array, and `.trim()` on either is a `TypeError`, i.e. a
 * 500 on a public endpoint from a two-character request body. That is not hypothetical
 * politeness — `POST /auth/register` one file over already answers 400 `validation_failed`
 * for exactly this abuse, and the suite has a test named "the unauthenticated auth surface
 * answers 400, never 500, on a malformed body". Declaring the input as `unknown` is what
 * makes the compiler force the check rather than leave it to a reviewer.
 *
 * A non-string is treated as absent, not as a 400: an unrecognised tier already becomes
 * `undecided` rather than a refusal, and the argument there holds twice over here. Losing
 * the preference is a rounding error; losing the signup is not.
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

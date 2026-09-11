import { and, eq, gt, isNull, like, lt, or, sql } from "drizzle-orm";
import { users, type Tx } from "@trafficflow/db";
import { authThrottle, loginTokens } from "@trafficflow/db/cloud";
import type { Db } from "../context.js";
import { generateToken, hashToken } from "../auth/crypto.js";
import { isLoopbackHostname } from "../auth/origins.js";
import { normalizeRecipient, type MailerPort, type MailSendResult } from "./port.js";
import type { WaitlistTier } from "./templates.js";

/**
 * The narrow context the mail path needs: a DB handle and a clock.
 *
 * Deliberately NOT `ServiceContext`. Two of the four mails go to people who have no
 * account yet — a waitlist signer, an invitee — so there is no `accountId` to scope
 * by and pretending otherwise would mean inventing one. `ServiceContext` is
 * structurally assignable to this, so an account-scoped caller passes its own ctx
 * unchanged.
 */
export interface MailContext {
  db: Db;
  now: () => Date;
}

/**
 * The ONE database capability the operator-alert path needs. `sendOperatorAlert` writes nothing
 * except one `auth_throttle` row — the per-recipient limiter's slot — so that is what it gets: a
 * function that claims a slot, not a `Db`. The mail sink is constructed inside the ALERT path, a
 * staff-triggered graph, and it used to hold the unrestricted runtime handle silenced by a double
 * assertion, one `.select()` away from every account's mail. The same defect removed from the
 * `/admin/*` callbacks, the same fix: the composition root keeps the capability, the callee gets
 * a value that cannot express a row. `auth_throttle` is NOT reachable from the blind role, so
 * this cannot move onto the staff handle — what changes is who holds the connection.
 */
export interface RecipientLimiter {
  /**
   * Claim one slot in `key`'s window and answer how many are now used in it.
   *
   * The LIMIT is not a parameter: the policy lives in {@link MailService}, which compares. A
   * port that decided "allowed" would be a port that could be configured to allow everything.
   */
  claim(key: string, now: Date, windowMs: number): Promise<number>;
}

/**
 * The context {@link MailService.sendOperatorAlert} takes — and the reason it is not
 * {@link MailContext}.
 *
 * There is no `db` on it, and that absence is the mechanism:
 * type erasure stops mattering when the capability is not in scope. A sink handed one of these
 * has nothing to cast.
 */
export interface OperatorAlertContext {
  limiter: RecipientLimiter;
  now: () => Date;
}

const asTx = (ctx: MailContext): Tx => ctx.db as unknown as Tx;

/**
 * The `auth_throttle` implementation of {@link RecipientLimiter}, for a caller that legitimately
 * holds the runtime connection — a composition root, or the customer templates, which need
 * `ctx.db` for their own writes anyway. ISO strings, not `Date`s, inside the raw `sql` templates:
 * postgres-js serialises a raw template parameter against the type Postgres describes for `$n` in
 * `$n::timestamptz`, which is TEXT, and handed a `Date` it throws. PGlite binds a `Date` happily,
 * so the suite would never see it and production would 500.
 */
export function dbRecipientLimiter(db: Db): RecipientLimiter {
  return {
    async claim(key: string, now: Date, windowMs: number): Promise<number> {
      const floorIso = new Date(now.getTime() - windowMs).toISOString();
      const nowIso = now.toISOString();
      const rolled = sql`${authThrottle.windowStartedAt} < ${floorIso}::timestamptz`;

      const [row] = await (db as unknown as Tx).insert(authThrottle)
        .values({ key, failures: 1, windowStartedAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: authThrottle.key,
          set: {
            failures: sql`case when ${rolled} then 1 else ${authThrottle.failures} + 1 end`,
            windowStartedAt: sql`case when ${rolled} then ${nowIso}::timestamptz else ${authThrottle.windowStartedAt} end`,
            updatedAt: now,
          },
        })
        .returning({ failures: authThrottle.failures });

      // Fail CLOSED: a claim that answered nothing must not read as "zero used".
      return row?.failures ?? Number.MAX_SAFE_INTEGER;
    },
  };
}

/** The limiter a guarded send uses: the caller's own port, or one built from its `db`. */
const limiterOf = (ctx: MailContext | OperatorAlertContext): RecipientLimiter =>
  "limiter" in ctx ? ctx.limiter : dbRecipientLimiter(ctx.db);

/**
 * Which budget a send spends — two, and the split is a security boundary. One shared budget made
 * two things true that must not be: SUPPRESSION — five anonymous waitlist submissions naming a
 * victim exhausted their hourly budget, so the operator's invite came back `rate_limited`: a
 * stranger could silence our mail to anyone they could name; and a CROSS-TEMPLATE ORACLE — a
 * limiter's state on a public endpoint reports what other mail we sent that address. Split by who
 * can SPEND: `unsolicited` — a send an anonymous caller can cause; `transactional` — what the
 * product owes someone. Verification is `unsolicited`, and `account_exists` MUST spend the same
 * budget, or the limiter becomes the oracle. The key is `mail:<quota>:<sha256(recipient)>`.
 */
export type MailQuota = "unsolicited" | "transactional";

export interface MailServiceConfig {
  /** `https://app.ohmail.app` — where invites are redeemed and links land. */
  appUrl: string;
  /** `https://ohmail.app` — the landing, for the waitlist mail's "while you wait". */
  siteUrl: string;
  /** A mailbox a human reads. Published on the imprint as `support@ohmail.app`. */
  supportEmail: string;
  /**
   * Where the staff console lives, for the operator-alert mail's one link.
   * Defaults to {@link MailServiceConfig.appUrl}; validated at boot like every other base.
   */
  adminUrl?: string;
  /**
   * THE operator address, and the ONLY recipient `sendOperatorAlert` will accept.
   *
   * Not a parameter of the send: an alert mailer that takes a recipient is a mail-bomb
   * primitive wearing an ops hat, and this is the one template a machine triggers on its
   * own schedule. Absent ⇒ `sendOperatorAlert` skips, and the alert pass reports the
   * sink as failed rather than pretending.
   */
  operatorEmail?: string;
  /** Per-recipient window. Default 1 hour. */
  rateWindowMs?: number;
  /** Mails per recipient per window, within one {@link MailQuota}. Default 5. */
  ratePerWindow?: number;
  /** How long an email-verification link lives. Default 24 hours. */
  emailVerifyTtlMs?: number;
  /**
   * The exact origins `appUrl`/`siteUrl` are allowed to be. Defaults to
   * {@link DEFAULT_LINK_ORIGINS}. A preview deployment on a platform-generated URL has to
   * name its origin here — deliberately, because "the mail links wherever the env var
   * points" is not a property anyone should be able to acquire by accident.
   */
  allowedOrigins?: readonly string[];
}

/**
 * Where ohmail's own mail is permitted to send a reader. Loopback is included so the dev harness
 * works; everything else is the product's real origins and nothing more. This exists because
 * `safeUrl` accepts ANY https host, and the "first-party only" template test only ever fed it
 * hard-coded fixtures — so a deployment with `MAIL_APP_URL=https://evil.example` would have
 * rendered a perfectly valid-looking ohmail invite pointing at somebody else's site, with a green
 * suite. The check belongs at BOOT, where a misconfiguration is a crash an operator sees, not at
 * render time, where it is a dropped mail nobody reads.
 */
export const DEFAULT_LINK_ORIGINS = [
  // The product, and since the single-origin merge the whole of it: one origin serving the
  // marketing site to a stranger and the mail client to a session.
  "https://ohmail.app",
  // KEPT, though it no longer serves: it is a 308 to the line above. A link target and an
  // auth origin are different questions — `origins.ts` refuses this host as an auth origin
  // precisely BECAUSE it redirects (a ceremony cannot survive one), while a link that
  // redirects lands the reader exactly where it promised. Removing it would turn every
  // already-delivered invite, and any deployment still carrying
  // `MAIL_APP_URL=https://app.ohmail.app`, into a boot failure that silently stops
  // customer mail — a strictly worse outcome than one extra hop.
  "https://app.ohmail.app",
  // The staff console. It is a first-party surface of the same deployment —
  // `withRequestGuard` already treats it as one — and it is where an operator alert mail
  // has to be able to point. No customer mail links here; `operator_alert` is the only
  // template that names it.
  "https://admin.ohmail.app",
  "http://localhost",
  "http://127.0.0.1",
] as const;

const DEFAULTS = {
  rateWindowMs: 60 * 60_000,
  ratePerWindow: 5,
  emailVerifyTtlMs: 24 * 60 * 60_000,
  allowedOrigins: DEFAULT_LINK_ORIGINS as readonly string[],
  adminUrl: "",
  operatorEmail: "",
} as const;

/**
 * Validate one configured base URL, at construction.
 *
 * Rejects, in order: anything that is not an absolute URL; credentials in the authority
 * (`https://user:pass@app.ohmail.app` renders as a plausible link and phishes beautifully);
 * a query or fragment (the base is concatenated with `?token=…`, so a base that already
 * carries one silently changes the meaning of every link); a non-https scheme outside
 * loopback; and any origin not on the allow-list. Loopback matches on host, so any dev
 * port works without listing them all.
 */
function assertLinkBase(name: string, raw: string, allowed: readonly string[]): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MailService: ${name} is not an absolute URL`);
  }
  if (url.username || url.password) {
    throw new Error(`MailService: ${name} must not carry credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`MailService: ${name} must not carry a query string or fragment`);
  }
  // THE AUTH VALIDATOR'S loopback predicate, imported rather than restated: the self-host server
  // passes its ONE origin as both auth origin and link base, so any daylight between the two
  // predicates is an origin that boots sign-in and then refuses the mailer. `http://[::1]:8080`
  // and `http://app.localhost:3000` were exactly that daylight (review finding).
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`MailService: ${name} must be https (http is allowed only on loopback)`);
  }
  const ok = allowed.some((entry) => {
    let a: URL;
    try { a = new URL(entry); } catch { return false; }
    if (isLoopbackHostname(a.hostname)) {
      // Loopback: host must match, port is free (3000, 5173, whatever the harness uses).
      return a.protocol === url.protocol && a.hostname === url.hostname;
    }
    return a.origin === url.origin;
  });
  if (!ok) {
    throw new Error(
      `MailService: ${name} origin ${JSON.stringify(url.origin)} is not in allowedOrigins ` +
      `(${allowed.join(", ")}). Mail may only link to first-party origins.`,
    );
  }
}

/** `login_tokens.purpose` for the mailed verification token. Never `'login'`. */
export const EMAIL_VERIFY_PURPOSE = "email_verify";

export interface MailServiceDeps {
  mailer: MailerPort;
  config: MailServiceConfig;
}

/**
 * MailService — the POLICY layer above `MailerPort`. The port is a transport; this class decides
 * WHETHER to send, builds every URL from deployment config, and owns the verification-token
 * lifecycle. Rate limiting is per RECIPIENT, before the send, atomically: one `INSERT … ON
 * CONFLICT DO UPDATE … RETURNING` (a read-modify-write lets concurrent attempts collapse into one
 * increment). The key is `mail:<sha256(recipient)>` — hashed, because recipients include people
 * with no account. The window does not slide on refusals. Failure mode: DROP — no queue, no
 * retry: nowhere to queue, every template is human-re-triggerable, and an automatic retry is the
 * mail-bomb vector the limiter prevents. `failed.retryable` is classification, not behaviour.
 */
export class MailService {
  private readonly cfg: Required<MailServiceConfig>;

  constructor(private readonly deps: MailServiceDeps) {
    this.cfg = {
      ...DEFAULTS,
      ...deps.config,
      rateWindowMs: deps.config.rateWindowMs ?? DEFAULTS.rateWindowMs,
      ratePerWindow: deps.config.ratePerWindow ?? DEFAULTS.ratePerWindow,
      emailVerifyTtlMs: deps.config.emailVerifyTtlMs ?? DEFAULTS.emailVerifyTtlMs,
      allowedOrigins: deps.config.allowedOrigins ?? DEFAULTS.allowedOrigins,
      adminUrl: deps.config.adminUrl ?? deps.config.appUrl,
      operatorEmail: deps.config.operatorEmail ?? DEFAULTS.operatorEmail,
    };
    // BOOT-TIME, not render-time. A bad MAIL_APP_URL now fails the composition root
    // before a single token is minted; it used to fail inside `safeUrl`, after the
    // token row was already in the database.
    assertLinkBase("appUrl", this.cfg.appUrl, this.cfg.allowedOrigins);
    assertLinkBase("siteUrl", this.cfg.siteUrl, this.cfg.allowedOrigins);
    assertLinkBase("adminUrl", this.cfg.adminUrl, this.cfg.allowedOrigins);
  }

  // ── 5. Operator alert — NOT customer mail ────────────────────────────────────

  /**
   * Mail the configured operator about firing alerts. The recipient is CONFIGURATION, never an
   * argument: this mail is triggered by a machine on a timer, so a `to` parameter would be an
   * unattended mail-bomb primitive. It still goes through {@link guarded} — deliberately a
   * BACKSTOP, not the dedup: `alert_state` already collapses a standing fault into one mail per
   * hour, and if the limiter fires here the dedup has a bug, and being rate-limited is the right
   * outcome. It takes an {@link OperatorAlertContext}, not a {@link MailContext}: the limiter
   * claim is the whole of its database use, and an unneeded runtime handle behind a staff
   * credential is exactly the hazard the capability split removes.
   */
  async sendOperatorAlert(
    ctx: OperatorAlertContext,
    input: {
      alerts: ReadonlyArray<{ title: string; detail: string; severity: string }>;
      source: string;
      environment: string;
    },
  ): Promise<MailSendResult> {
    if (!this.cfg.operatorEmail) return { status: "skipped", reason: "mailer_disabled" };
    if (input.alerts.length === 0) return { status: "skipped", reason: "mailer_disabled" };
    return this.guarded(ctx, this.cfg.operatorEmail, "transactional", (to) =>
      this.deps.mailer.send(to, "operator_alert", {
        environment: input.environment,
        source: input.source,
        alerts: input.alerts.map((a) => ({ title: a.title, detail: a.detail, severity: a.severity })),
        consoleUrl: trimSlash(this.cfg.adminUrl),
      }, {
        // Keyed on WHICH alerts, WHEN and observed by WHOM. A serverless invocation the
        // platform re-drives is one alert mail; the next hour's repeat is a different one
        // because the minute differs.
        idempotencyKey: `alert:${hashToken(
          `${input.source}|${input.environment}|` +
          `${input.alerts.map((a) => a.title).sort().join(",")}|` +
          `${ctx.now().toISOString().slice(0, 16)}`,
        )}`,
      }));
  }

  // ── 1. Waitlist confirmation (called from POST /waitlist) ─────────────────────

  async sendWaitlistConfirmation(
    ctx: MailContext, input: { to: string; tier: WaitlistTier },
  ): Promise<MailSendResult> {
    // THE ONLY `unsolicited` SEND. See {@link MailQuota}: this is the one template an
    // anonymous caller can aim at an address they do not own, so it spends a budget of its
    // own and can never starve the invite an operator just minted for the same person.
    return this.guarded(ctx, input.to, "unsolicited", (to) =>
      this.deps.mailer.send(to, "waitlist_confirmation", {
        tier: input.tier,
        siteUrl: this.cfg.siteUrl,
        supportEmail: this.cfg.supportEmail,
      }, {
        // A double-submitted form, or a serverless invocation the platform re-drives,
        // is ONE signup and must be one mail. The key is a pure function of the two
        // facts that define the signup, so a genuine re-signup with a different tier
        // is a different mail (and Resend's key window expires anyway).
        idempotencyKey: `waitlist:${hashToken(`${to}|${input.tier}`)}`,
      }));
  }

  // ── 2. Invite delivery (the code that opens the gate) ────────────────────────

  async sendInvite(
    ctx: MailContext, input: { to: string; code: string; expiresAt: Date },
  ): Promise<MailSendResult> {
    return this.guarded(ctx, input.to, "transactional", (to) =>
      this.deps.mailer.send(to, "invite", {
        code: input.code,
        redeemUrl: `${trimSlash(this.cfg.appUrl)}/join?code=${encodeURIComponent(input.code)}`,
        expiresAt: formatUtc(input.expiresAt),
        supportEmail: this.cfg.supportEmail,
      }, {
        // One mail per (code, recipient), whatever the platform does to the invocation.
        idempotencyKey: `invite:${hashToken(`${input.code}|${to}`)}`,
      }));
  }

  // ── 3. New-device sign-in notice (the only security mail; passkeys remove the rest) ──

  async sendNewDeviceSignIn(
    ctx: MailContext, input: { to: string; device: string; ip?: string | null; at: Date },
  ): Promise<MailSendResult> {
    const device = input.device.trim() || "Unknown device";
    return this.guarded(ctx, input.to, "transactional", (to) =>
      this.deps.mailer.send(to, "new_device_signin", {
        device,
        ip: (input.ip ?? "").trim() || "unknown",
        at: formatUtc(input.at),
        devicesUrl: `${trimSlash(this.cfg.appUrl)}/settings/devices`,
        supportEmail: this.cfg.supportEmail,
      }, {
        // Keyed on the sign-in EVENT (recipient, device, instant), so re-executing the
        // same invocation sends once while two genuine sign-ins stay two mails. This is
        // the one mail the user cannot re-trigger, so a duplicate is the failure mode
        // that would train them to ignore it.
        idempotencyKey: `signin:${hashToken(`${to}|${device}|${input.at.toISOString()}`)}`,
      }));
  }

  // ── 4. Email verification ─────────────────────────────────────────────────────

  /**
   * Mint a single-use verification token and mail the link. Built unwired while registration was
   * invite-gated; open registration wired it — the public register path and the authenticated
   * resend both issue here. The token reuses `login_tokens` with `purpose='email_verify'`, hashed
   * at rest; `peekLoginToken` is scoped to `purpose='login'` so a mailed link is never a first
   * factor. A failed send leaves the token unused (the send is outside the DB transaction by
   * design). `to` MUST be the user's own address: the token is bound to `userId` and `to` arrives
   * independently, so without this check a caller could mail a target's live verification token
   * to an attacker-supplied inbox. Enforced at issue time against `users.email`.
   */
  async issueEmailVerification(
    ctx: MailContext, input: { userId: string; to: string },
  ): Promise<MailSendResult> {
    // `unsolicited`, not `transactional` — see {@link MailQuota}. An anonymous caller on
    // `POST /auth/register` decides who receives this, so it may not spend the budget the
    // recipient's invite and security notices depend on.
    return this.guarded(ctx, input.to, "unsolicited", async (to) => {
      const owner = (await asTx(ctx).select({ email: users.email }).from(users)
        .where(eq(users.id, input.userId)).limit(1))[0];
      if (!owner || normalizeRecipient(owner.email) !== to) {
        return { status: "skipped", reason: "recipient_mismatch" };
      }
      const raw = generateToken();
      const expiresAt = new Date(ctx.now().getTime() + this.cfg.emailVerifyTtlMs);
      await asTx(ctx).insert(loginTokens).values({
        userId: input.userId,
        tokenHash: hashToken(raw),
        methods: [],
        purpose: EMAIL_VERIFY_PURPOSE,
        expiresAt,
      });
      // NO idempotency key. Every re-execution mints a NEW credential, so deduping the
      // mail would leave the user holding a link for a token they never received. The
      // request itself has to be made idempotent one level up, by whoever calls this.
      return this.deps.mailer.send(to, "email_verification", {
        verifyUrl: `${trimSlash(this.cfg.appUrl)}/verify-email?token=${encodeURIComponent(raw)}`,
        expiresIn: humanDuration(this.cfg.emailVerifyTtlMs),
        supportEmail: this.cfg.supportEmail,
      });
    });
  }

  // ── 6. "You already have an account" — the other half of the constant 202 ────────

  /**
   * Tell an address that a signup was attempted and an account already exists — why the
   * enumeration oracle could be closed: the register path answers a byte-identical 202 either
   * way, so the "sign in instead" news goes here, where only the address owner can read it. It
   * mints NOTHING, so this is the one mail whose delivery to the wrong person costs nothing.
   * `unsolicited`, matching {@link issueEmailVerification}'s quota exactly: different budgets on
   * the two branches would recover the oracle from the limiter. Idempotency-keyed on RECIPIENT
   * and hour: a re-driven invocation is one mail; a genuine second attempt an hour later is a
   * second mail — repeated attempts are what the account should be told about.
   */
  async sendAccountExists(ctx: MailContext, input: { to: string }): Promise<MailSendResult> {
    return this.guarded(ctx, input.to, "unsolicited", (to) =>
      this.deps.mailer.send(to, "account_exists", {
        signInUrl: `${trimSlash(this.cfg.appUrl)}/login`,
        supportEmail: this.cfg.supportEmail,
      }, {
        idempotencyKey: `exists:${hashToken(`${to}|${ctx.now().toISOString().slice(0, 13)}`)}`,
      }));
  }

  /**
   * Consume a verification token. Returns the user it belonged to, or null for anything not a
   * live `email_verify` token. Single-use is enforced by the DATABASE: this was SELECT → check →
   * unconditional UPDATE — a read-modify-write two concurrent requests both pass, invisible to
   * sequential tests. Now ONE statement — `UPDATE … WHERE token_hash AND purpose AND consumed_at
   * IS NULL AND expires_at > now RETURNING user_id`; `mail-concurrency.pg.test.ts` runs 12
   * simultaneous presentations and asserts exactly one winner (PGlite is single-connection and
   * cannot fail it). The caller decides what "verified" means: stamping `users.email_verified_at`
   * is `verifyEmail`'s job, in the same transaction as the consumption.
   */
  async consumeEmailVerification(
    ctx: MailContext, token: string,
  ): Promise<{ userId: string } | null> {
    const raw = typeof token === "string" ? token.trim() : "";
    if (raw.length === 0) return null;
    const now = ctx.now();
    const [row] = await asTx(ctx).update(loginTokens)
      .set({ consumedAt: now })
      .where(and(
        eq(loginTokens.tokenHash, hashToken(raw)),
        eq(loginTokens.purpose, EMAIL_VERIFY_PURPOSE),
        isNull(loginTokens.consumedAt),
        gt(loginTokens.expiresAt, now),
      ))
      .returning({ userId: loginTokens.userId });
    return row ? { userId: row.userId } : null;
  }

  /**
   * Delete `mail:` throttle rows whose window has long since closed. The limiter's correctness
   * does not need this, but nothing else deletes these rows, and the table otherwise grows by one
   * per distinct recipient for ever (keys are `sha256(address)` — housekeeping, not privacy).
   * `like('mail:%')` matches BOTH quota namespaces. The per-IP namespaces are swept too, all
   * three: `waitlist:ip:%`; `register:ip:%` — not swept at first, a real gap: only the waitlist's
   * prefix was listed while `POST /auth/register` sat on the same public funnel; `verify:ip:%`.
   * Sequential scans by design: this runs on a schedule over a table bounded by distinct
   * recipients and callers, not traffic.
   */
  async pruneRateLimitWindows(ctx: MailContext, olderThanMs?: number): Promise<number> {
    const cutoff = new Date(ctx.now().getTime() - (olderThanMs ?? this.cfg.rateWindowMs));
    const deleted = await asTx(ctx).delete(authThrottle)
      .where(and(
        or(
          like(authThrottle.key, "mail:%"),
          like(authThrottle.key, "waitlist:ip:%"),
          like(authThrottle.key, "register:ip:%"),
          like(authThrottle.key, "verify:ip:%"),
        ),
        lt(authThrottle.windowStartedAt, cutoff),
      ))
      .returning({ key: authThrottle.key });
    return deleted.length;
  }

  // ── The guard every send goes through ────────────────────────────────────────

  private async guarded(
    ctx: MailContext | OperatorAlertContext, rawTo: string, quota: MailQuota,
    send: (to: string) => Promise<MailSendResult>,
  ): Promise<MailSendResult> {
    const to = normalizeRecipient(rawTo);
    if (!to) return { status: "skipped", reason: "invalid_recipient" };
    try {
      // INSIDE the boundary. `reserveRecipientSlot` is a database write, and it used to
      // sit outside this `try` — so a throttle-table failure (a dead pool, a lock
      // timeout, the postgres-js parameter fault that `auth-throttle.pg.test.ts` exists
      // for) escaped straight into the request handler. The worst shape of that is a
      // successful login whose best-effort security notice turns the 200 into a 500.
      // Failing here is also fail-CLOSED: if we cannot claim a slot we do not send.
      const allowed = await this.reserveRecipientSlot(ctx, to, quota);
      if (!allowed) return { status: "skipped", reason: "rate_limited" };
      return await send(to);
    } catch (e) {
      // The port promises not to throw, but `issueEmailVerification` also does DB
      // writes inside this callback, and a mail path must not be the thing that turns
      // a request into a 500. The message is scrubbed: it is log-destined, and the DB
      // driver is perfectly capable of quoting a parameter back at us.
      return { status: "failed", retryable: false, error: `mail_service: ${scrubForLog(e)}` };
    }
  }

  /**
   * Atomically claim one slot in this recipient's window. `true` ⇒ send.
   *
   * The SQL moved to {@link dbRecipientLimiter} so that a caller which needs only this
   * one write — the operator-alert sink — can be handed the write instead of the connection.
   * What stays here is the POLICY: which key, and what the limit is.
   */
  private async reserveRecipientSlot(
    ctx: MailContext | OperatorAlertContext, recipient: string, quota: MailQuota,
  ): Promise<boolean> {
    const used = await limiterOf(ctx).claim(
      `mail:${quota}:${hashToken(recipient)}`, ctx.now(), this.cfg.rateWindowMs,
    );
    return used <= this.cfg.ratePerWindow;
  }
}

export function makeMailService(deps: MailServiceDeps): MailService {
  return new MailService(deps);
}

// ── Formatting helpers — deterministic, so the snapshots are stable ────────────

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * `31 July 2026, 14:05 UTC`. Hand-rolled rather than `Intl`: `Intl` output moves with
 * the ICU build, which would make a template snapshot fail on a different Node image
 * for no product reason. UTC because we do not know the recipient's zone and guessing
 * one from an IP would be both wrong and creepy.
 */
export function formatUtc(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * The mail path's own log scrubber, for exception messages that did not come from
 * `ResendMailer` (a driver error, a template throw, anything inside the guarded
 * callback). Same shapes, same reason: this string is what a caller logs.
 */
function scrubForLog(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ");
  return text
    .replace(/\bre_[A-Za-z0-9_-]{4,}/g, "re_[redacted]")
    .replace(/\b[^\s<>@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[address]")
    .replace(/(https?:\/\/[^\s?#]*)[?#]\S*/gi, "$1?[redacted]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]")
    .slice(0, 200);
}

function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

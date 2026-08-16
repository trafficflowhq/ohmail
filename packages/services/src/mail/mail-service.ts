import { and, eq, gt, isNull, like, lt, or, sql } from "drizzle-orm";
import { users, type Tx } from "@trafficflow/db";
import { authThrottle, loginTokens } from "@trafficflow/db/cloud";
import type { Db } from "../context.js";
import { generateToken, hashToken } from "../auth/crypto.js";
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
 * THE ONE DATABASE CAPABILITY THE OPERATOR-ALERT PATH NEEDS.
 *
 * `sendOperatorAlert` reads nothing and writes nothing except one row in `auth_throttle`: the
 * per-recipient limiter's slot. Everything else it touches is configuration and a clock. So
 * that is what it gets — a function that claims a slot — instead of a `Db`.
 *
 * The reason is not tidiness. The mail sink is constructed inside the ALERT path, which is a
 * staff-triggered graph, and it used to hold `makePooledDb(cfg.databaseUrlPooled) as never` —
 * the unrestricted runtime handle, silenced by a double assertion, one `.select()` away from
 * every account's mail. A review recorded it as the reason "all three alert routes run wholly
 * on the blind connection" was false. It is the same defect that was removed from the
 * `/admin/*` callbacks and the same fix: the composition root keeps the capability, the callee
 * gets a value that cannot express a row.
 *
 * `auth_throttle` is deliberately NOT reachable from the blind `ohmail_admin` role, so this
 * cannot simply move onto the staff handle: the claim is a genuine runtime-connection write.
 * What changes is who holds the connection.
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
 * holds the runtime connection — a composition root, or any of the five customer templates,
 * which need `ctx.db` for their own writes anyway.
 *
 * ISO STRINGS, not `Date`s, inside the raw `sql` templates — the rule
 * `auth-service.ts:throttleFailure` states at length: postgres-js serialises a raw template
 * parameter against the type Postgres describes for `$n` in `$n::timestamptz`, which is TEXT,
 * and handed a `Date` it throws. PGlite binds a `Date` happily, so the suite would never see it
 * and production would 500.
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
 * WHICH BUDGET a send spends. Two, and the split is a security boundary, not tidiness.
 *
 * The per-recipient limiter used to be ONE budget shared by every template, and that made
 * two things true that must not be:
 *
 *  1. **Suppression.** `POST /waitlist` is public and takes any address a stranger types.
 *     Five anonymous submissions naming a victim exhausted the victim's whole hourly
 *     budget, so the operator's next `pnpm invite mint --email victim` came back
 *     `{"status":"skipped","reason":"rate_limited"}` — an invite burned into the table and
 *     never delivered — and a security notice for that address would have been dropped the
 *     same way. A stranger could silence our mail to anyone they could name.
 *  2. **A cross-template oracle.** Anything reporting the limiter's state on a public
 *     endpoint reports how much OTHER mail we recently sent that address, i.e. "was this
 *     person invited". (The reporting itself is gone — see `WaitlistService.join` — but the
 *     shared counter is what gave it something to report.)
 *
 * So the budgets are separated by who can SPEND them:
 *
 *  · `unsolicited` — a send an unauthenticated caller can cause by naming an address they
 *    do not control. The waitlist confirmation, and BOTH mails the public
 *    register path can produce (see below).
 *  · `transactional` — everything the product owes someone: the invite an operator minted,
 *    a security notice, an operator alert. Nothing anonymous can reach these, so nothing
 *    anonymous can starve them.
 *
 * ── EMAIL VERIFICATION MOVED FROM `transactional` TO `unsolicited` ────────────────────
 *
 * It was `transactional` while the template was unwired, on the reading that a verification
 * is something the product owes an account holder. Wiring it to `POST /auth/register`
 * falsified that: the caller is anonymous and the address is whatever they typed, which is
 * the definition of `unsolicited` two paragraphs up. Left on the transactional budget, a
 * prober naming a victim's address five times would have drained the victim's INVITE and
 * security-notice budget — reintroducing suppression (1) through the new endpoint.
 *
 * It is a property of the template rather than a parameter of the send, deliberately: every
 * verification mail goes to an address that is by definition not yet proven, including the
 * authenticated resend (a caller holding a re-entry session on an address they registered
 * but do not own must not be able to starve the real owner's mail either) and any future
 * email-CHANGE flow. A quota argument would be a decision each call site could get wrong.
 *
 * `account_exists` is `unsolicited` for the same reason and for one more: it MUST spend the
 * same budget as the verification mail it is indistinguishable from, or the limiter's
 * behaviour over repeated attempts becomes the very oracle the constant response closed.
 *
 * The key namespace is `mail:<quota>:<sha256(recipient)>`, so the two counters cannot
 * touch, and `pruneRateLimitWindows`'s `like('mail:%')` still sweeps both.
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
 * Where ohmail's own mail is permitted to send a reader. Loopback is included so the
 * dev harness works; everything else is the product's real origins and nothing more.
 *
 * This exists because the URL scheme check in `safeUrl` accepts *any* https host, and
 * the "first-party only" template test only ever fed it hard-coded fixtures — so a
 * deployment with `MAIL_APP_URL=https://evil.example` would have rendered a perfectly
 * valid-looking ohmail invite pointing at somebody else's site, with a green suite. The
 * check belongs at BOOT, where a misconfiguration is a crash an operator sees, not at
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
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`MailService: ${name} must be https (http is allowed only on loopback)`);
  }
  const ok = allowed.some((entry) => {
    let a: URL;
    try { a = new URL(entry); } catch { return false; }
    if (a.hostname === "localhost" || a.hostname === "127.0.0.1") {
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
 * MailService — the POLICY layer above `MailerPort`.
 *
 * The port is a transport: hand it a recipient and a template and it puts a message
 * on the wire. This class decides *whether* to, builds every URL from deployment
 * config so no caller can compose one, and owns the verification-token lifecycle.
 *
 * ── Rate limiting: per RECIPIENT, before the send, atomically ────────────────────
 *
 * A retry loop — a client re-POSTing the waitlist form, a serverless invocation the
 * platform re-drives, an operator's script — must not be able to mail-bomb a person
 * who never asked for any of it. So every send passes through
 * `reserveRecipientSlot`, which is ONE `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * against `auth_throttle`, the same store and the same atomic idiom as the auth
 * lockout (a read-modify-write here would let
 * concurrent attempts collapse into a single increment, which is precisely the
 * scenario the limit exists for).
 *
 * The key is `mail:<sha256(recipient)>` — HASHED, unlike the auth namespaces, because
 * these recipients include people with no account. A waitlist signer's address should
 * not accumulate in plaintext in a throttle table whose whole retention story is "it
 * gets overwritten eventually".
 *
 * The counter is shared across all four templates. Onboarding's worst legitimate hour
 * is waitlist → invite → verification → new-device notice = four; the limit is five,
 * so a real user never sees it and a loop stops at five.
 *
 * The window does not slide forward on refusals: `window_started_at` only moves when
 * the window has genuinely rolled, so a caller hammering the endpoint cannot extend
 * its own cooldown, and the bucket reopens exactly one window after the FIRST send.
 *
 * ── Failure mode: DROP. No queue, no retry. ──────────────────────────────────────
 *
 * A failed send returns `{status:"failed"}` and that is the end of it. This is a
 * decision, not an omission:
 *
 *  · There is nowhere to queue. The API is serverless and the worker may not
 *    import `packages/services` at all (pinned by the worker's dependency test),
 *    so "retry later" would mean a new table, a new cron and a new failure surface for
 *    four emails.
 *  · Every one of the four is re-triggerable by a human: submit the form again, ask
 *    for another invite, request a new verification link. The user has a retry; it is
 *    just not automatic.
 *  · An automatic retry is the mail-bomb vector we just spent a limiter preventing.
 *    A provider that 500s for ten minutes plus a retry loop is a stranger's inbox full
 *    of duplicate invites.
 *
 * `failed.retryable` is therefore CLASSIFICATION, not behaviour: it is there so a log
 * line distinguishes "Resend was down" from "our API key is wrong", and so a future
 * queue has a signal to key on. Nothing in beta reads it. The one exception to
 * drop-on-failure is the sign-in notice, which is not re-triggerable by the user — and
 * that is exactly why its failure must be logged loudly by the caller.
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
   * Mail the configured operator about firing alerts.
   *
   * **The recipient is configuration, never an argument.** Every other method on this class
   * takes a `to`, because every other mail is addressed to the person who caused it. This one
   * is triggered by a machine on a timer, so a `to` parameter would be an unattended
   * mail-bomb primitive; the address comes from `operatorEmail` and there is no override.
   *
   * It still goes through {@link guarded}, so the per-recipient limiter applies: five per
   * hour, shared with every other template. That is deliberately a BACKSTOP and not the
   * dedup mechanism — `alert_state` in `packages/db/src/alerts.ts` already collapses a
   * standing fault into one mail per hour. If the limiter ever fires here it means the
   * dedup has a bug, and being rate-limited is the right outcome of that bug.
   *
   * **It takes an {@link OperatorAlertContext} and not a {@link MailContext}.** That
   * limiter claim is the whole of its database use, so a `Db` is a capability this path does
   * not need — and it runs inside the alert graph, behind a staff credential, where an unneeded
   * runtime handle is exactly the hazard the capability split exists to remove.
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
   * Mint a single-use verification token and mail the link.
   *
   * It was built unwired, while registration was invite-gated: an invite mail delivered
   * to an address already proves that address receives mail, so a verification step on
   * top of it would be ceremony. Open registration wired it — the public register path
   * and the authenticated resend both issue through here.
   *
   * The token reuses `login_tokens` with `purpose='email_verify'` and `hashToken(raw)`
   * at rest (mirroring how the first-factor token is stored).
   * `peekLoginToken` in `auth-service.ts` is scoped to `purpose='login'` for exactly
   * this reason: a link mailed to an inbox must not be presentable as a first-factor
   * login token.
   *
   * If the send fails the token still exists and is simply never used; the user asks
   * for another one. We do not roll it back, because the send is outside the DB
   * transaction by design (a mail outage must not fail a database write).
   *
   * **`to` must be the user's own address.** The token is bound to `userId` and nothing
   * else, and `to` arrives independently — so without this check a caller (a route,
   * a future admin action, a bug in either) could mail a target user's live verification
   * token to an attacker-supplied inbox, and the attacker could then present it and have
   * the target's address marked verified. Rather than adding a column to `login_tokens`
   * for a path that is not wired, the binding is enforced where the mismatch can be
   * seen: at issue time, against `users.email`. When email-CHANGE verification is built,
   * that is the slice that adds the pending-address column and moves this check onto it.
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
   * Tell an address that a signup was attempted for it and an account already exists.
   *
   * **This method is why the enumeration oracle could be closed.** `POST /auth/register`'s
   * public path answers a byte-identical 202 for a fresh address and a taken one; the
   * "sign in instead" news therefore cannot be in the response, and this is where it went.
   * Only the address owner can read it, which is the entire point.
   *
   * It mints NOTHING. No token, no row, no credential — the account already exists and the
   * caller proved nothing, so there is nothing to issue. That makes this the one mail in the
   * set whose delivery to the wrong person costs nothing at all: the link is the public
   * sign-in page.
   *
   * `unsolicited`, and it MUST match {@link issueEmailVerification}'s quota exactly. If the two
   * branches of the register path spent different budgets, a prober who exhausted one and not
   * the other would have recovered the oracle from the limiter's behaviour — a constant
   * response with a branch-dependent side effect is not a constant response.
   *
   * Idempotency-keyed on the RECIPIENT and the hour. A serverless invocation the platform
   * re-drives is one mail; a genuine second attempt an hour later is a second mail, because
   * repeated attempts on somebody's address are exactly what they should be told about. The
   * key deliberately does not include anything about the account — the mail is a function of
   * the address and the moment, and nothing else.
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
   * Consume a verification token. Returns the user it belonged to, or null for
   * anything that is not a live `email_verify` token — expired, already used, the
   * wrong purpose, or unknown.
   *
   * **Single-use is enforced by the database, not by this process.** This was
   * SELECT → check `consumed_at` → unconditional UPDATE, which is a read-modify-write:
   * two concurrent requests carrying the same link both read `consumed_at IS NULL`, both
   * pass the check and both succeed, and the sequential test could never see it. It is
   * now ONE statement — `UPDATE … WHERE token_hash = … AND purpose = … AND consumed_at
   * IS NULL AND expires_at > now RETURNING user_id` — so the row lock decides the race
   * and exactly one caller gets a row back. `mail-concurrency.pg.test.ts` runs it against
   * real Postgres with `Promise.all` — 12 simultaneous presentations, exactly one winner —
   * because PGlite is single-connection and structurally cannot fail this test.
   *
   * The caller decides what "verified" means; this method records no user state.
   * Stamping `users.email_verified_at` is the caller's job (`verifyEmail` in
   * `auth-service.ts` does it inside the same transaction as the consumption).
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
   * Delete `mail:` throttle rows whose window has long since closed.
   *
   * The limiter's own correctness does not need this — a stale row is rolled forward on
   * the next send — but nothing else ever deletes these, and `AuthService.throttleReset`
   * only touches `email:` keys. Left alone the table grows by one row per distinct
   * recipient, forever. The keys are `sha256(address)`, so this is a housekeeping
   * concern rather than a privacy one; call it from whatever maintenance path exists.
   *
   * `like('mail:%')` matches BOTH quota namespaces (`mail:unsolicited:…` and
   * `mail:transactional:…`), so the split cost this nothing.
   *
   * THE PER-IP NAMESPACES ARE SWEPT TOO, and there are now three of them. Each writes one row
   * per distinct client address, and that set is unbounded in a way the recipient keys are not
   * — every visitor to the landing page is a new one. A limiter that quietly accumulates a row
   * per visitor forever is the same housekeeping bug as the one above, arriving faster.
   *
   *  · `waitlist:ip:%` — the landing-form limiter, swept from the start.
   *  · `register:ip:%` — the signup limiter. **This was NOT swept and that was a real gap,
   *    not a decision:** `reserveJoinSlot` was lifted into `reserveIpSlot` and given a second
   *    caller, but only the waitlist's key prefix was ever listed here. `POST /auth/register`
   *    is on the public landing funnel, so it accumulated exactly as fast as the waitlist did.
   *    Fixed in the same one-line `or(...)` as the addition below, because leaving it would
   *    have meant adding a third namespace next to a second one that was already leaking.
   *  · `verify:ip:%` — the verification-resend limiter.
   *
   * All are sequential scans by design: this runs on a schedule, over a table whose row
   * count is bounded by distinct recipients and callers, not by traffic.
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

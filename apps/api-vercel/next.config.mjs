/**
 * The API host's Next config. Minimal on purpose: this app renders nothing.
 *
 * The one thing it does beyond bundling is {@link assertAlertingArmed} — see below.
 */

/**
 * The minimum length of any shared secret on this host. Same number as
 * `src/config.ts`'s loaders, which refuse anything shorter; stated again here because
 * `next.config.mjs` cannot import TypeScript, and `test/alerting-armed.test.ts` reads both
 * files and fails if they ever disagree.
 */
export const MIN_SECRET_LENGTH = 24;

/**
 * A hand-written JS copy of `runtimeUrlReason` (`packages/db/src/session-url.ts`), for the
 * same reason `MIN_SECRET_LENGTH` is restated: this file cannot import TypeScript.
 * `test/alerting-armed.test.ts` feeds one permutation set through both copies and fails if the
 * gate ever accepts what the loader refuses.
 *
 * **Keep this in lockstep with the TS original, and read its header before editing.** The rule it
 * replaced was scoped to `*.neon.tech`, so all three copies went unconditionally true-negative the
 * day production moved to another pooler and nothing failed. It tests the parsed HOSTNAME, never the
 * whole URL — a substring test matches a password — and it FAILS OPEN on an unrecognised host,
 * which is what makes it safe for the runtime copy to throw.
 */
function runtimeUrlReason(url) {
  let host = null;
  let port = null;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase() || null;
    port = parsed.port || null;
  } catch {
    return null; // An unparseable URL is somebody else's error to report.
  }
  if (!host) return null;

  if (host.endsWith(".neon.tech") && !host.includes("-pooler.")) {
    return "the host is a DIRECT Neon endpoint (the serverless host needs the -pooler host)";
  }
  if (/^db\..+\.supabase\.co$/.test(host)) {
    return "the host is the Supabase DIRECT endpoint, which resolves IPv6-only and cannot be " +
      "reached from Vercel (use the Supavisor pooler)";
  }
  // Absent config selects the dangerous branch: Postgres defaults to 5432, so a portless
  // Supavisor URL is SESSION mode. Only 5432-or-absent is refused, never other ports.
  if (host.endsWith(".pooler.supabase.com") && (port === null || port === "5432")) {
    return "the host is Supavisor in SESSION mode (port 5432, or absent and therefore 5432); " +
      "the serverless runtime needs TRANSACTION mode on 6543";
  }
  return null;
}

/**
 * A PRODUCTION BUILD OF THIS HOST MUST BE ABLE TO PAGE A HUMAN.
 *
 * ── The failure this exists for, which is not hypothetical ────────────────────────────────
 *
 * On 2026-08-01 the sync worker died and stayed dead for over two hours and nobody was told.
 * The `worker_down` alert existed, was correct, and was tested. It could not fire, because
 * the only host that evaluates it — this one — had been deployed without `TF_ALERT_SECRET`,
 * so `/internal/alerts` answered 404 and the scheduler had nothing to call. The outage was
 * found by a human noticing that a mailbox said "Not synced yet".
 *
 * Nothing reported that state, and nothing could have: a dead-man's switch that quietly does
 * not run looks exactly like one that runs and finds nothing wrong. It is worse than having
 * no alarm at all, because it manufactures confidence. So the state is made unreachable
 * instead: a production build without a pager does not exist.
 *
 * ── Why a BUILD-TIME throw is safe when a runtime one would not be ────────────────────────
 *
 * `loadAlertsConfig` deliberately returns `null` rather than throwing, because a throw there
 * reaches `loadHostState`, which answers 503 to EVERY request — an observability feature
 * causing the outage it exists to report. That argument does not apply here and the asymmetry
 * is the whole design: a failed build produces no deployment, so the previous, armed one keeps
 * serving. The cost of this refusal is a red deploy; the cost of the alternative was measured
 * in August and it was two hours of silence.
 *
 * On Vercel, environment variables are project state and a change to them requires a redeploy
 * to take effect — so what this reads at build time IS what the functions will read at
 * runtime. The precedent is `apps/webapp/next.config.mjs:assertApiArmed`, which refuses a
 * production bundle with no API for the same reason: a deployment that looks like it works.
 *
 * ── There is deliberately NO escape hatch ─────────────────────────────────────────────────
 *
 * `assertApiArmed` has one (`NEXT_PUBLIC_DEMO=1`) because "the demo build" is a legitimate
 * product mode that a missing variable must not be allowed to select by accident. There is no
 * equivalent here: "the production API with no alarm on it" is not a mode anybody wants, it is
 * the incident. And the way out is ten seconds long — `TF_ALERT_WEBHOOK_URL` accepts any
 * endpoint that takes a JSON POST, including a free ntfy.sh topic — so a hatch would buy no
 * operational speed and would reintroduce exactly the hole it guards.
 *
 * Preview and development builds are untouched: `VERCEL_ENV` is set by the platform, and a
 * preview with no pager is a preview, not an unwatched production.
 *
 * @param {Record<string, string | undefined>} env
 * @throws when a production build has no way to observe or report a failure.
 */
export function assertAlertingArmed(env) {
  if ((env.VERCEL_ENV ?? "").trim() !== "production") return;

  /** @type {string[]} */
  const missing = [];
  const secret = (env.TF_ALERT_SECRET ?? "").trim();
  const cronSecret = (env.CRON_SECRET ?? "").trim();

  // `/internal/alerts*` answers 404 without this — the endpoint simply does not exist, and
  // both schedulers get a hard failure they cannot act on.
  if (secret.length < MIN_SECRET_LENGTH) {
    missing.push(`TF_ALERT_SECRET (>= ${MIN_SECRET_LENGTH} characters)`);
  }
  // Without this Vercel Cron sends no Authorization header at all, so the pass it schedules
  // answers 401 on every run — the single worst failure shape available here, because the
  // cron appears configured, executes on time, and observes nothing.
  if (cronSecret.length < MIN_SECRET_LENGTH) {
    missing.push(`CRON_SECRET (>= ${MIN_SECRET_LENGTH} characters, the Vercel Cron credential)`);
  }
  // THE PASS RUNS ON THE STAFF CONNECTION, so its absence darkens the pager too.
  //
  // `/internal/alerts*` reads and writes through `deps.adminDb`, the content-blind handle
  // (`ohmail_admin`), because a cross-account ops surface is a staff surface. Without
  // `DATABASE_URL_ADMIN` there is no handle, and `loadStaffDbConfig` deliberately does not fall
  // back to the runtime one — so all three routes answer 503 `alerts_db_unarmed` and the pager
  // is dark in exactly the shape of 2026-08-01. That is a state a production build must not be
  // able to reach, which is what this whole function is for.
  //
  // ── IT CHECKS EVERY REFUSAL THAT CONTROLS CONSTRUCTION, NOT JUST "NONBLANK" ──────────────
  //
  // A gate that accepts an environment the loader refuses is the SAME outage with a green
  // build log, and it was reachable: this asked only whether the string was nonempty, while
  // `loadStaffDbConfig` also refuses the runtime URL pasted in by hand and a direct Neon
  // endpoint. Both of those are statically decidable, so both are decided here.
  //
  // The three refusals are duplicated rather than imported because `next.config.mjs` cannot
  // import TypeScript. `test/alerting-armed.test.ts` therefore runs a BEHAVIOURAL PARITY check
  // over the pair — every permutation, through both, failing if the gate accepts what the
  // loader will refuse. That test, and not this comment, is what keeps the copies honest.
  //
  // What is deliberately NOT checked here is `TF_ADMIN_SECRET`. It gates the admin CONSOLE and
  // nothing else; it once also gated the construction of this handle, which was the defect.
  // Adding it back would re-couple the two through the build gate instead of the loader.
  const adminUrl = (env.DATABASE_URL_ADMIN ?? "").trim();
  if (adminUrl.length === 0) {
    missing.push("DATABASE_URL_ADMIN (the ohmail_admin connection the alert pass runs on)");
  } else if (adminUrl === (env.DATABASE_URL_POOLED ?? "").trim()) {
    missing.push(
      "DATABASE_URL_ADMIN is the RUNTIME connection string; the loader refuses it, so the " +
        "pager would be dark on a build this gate had passed",
    );
  } else if (runtimeUrlReason(adminUrl)) {
    missing.push(
      `DATABASE_URL_ADMIN is unusable (${runtimeUrlReason(adminUrl)}); the loader refuses it, so ` +
        "the pager would be dark on a build this gate had passed",
    );
  }
  // A pass with no sink evaluates correctly and delivers into nothing. `runAlertPass` reports
  // that honestly as `undeliverable`, but nobody reads a JSON field at 3am.
  const hasWebhook = (env.TF_ALERT_WEBHOOK_URL ?? "").trim().length > 0;
  const hasMailSink = (env.TF_ALERT_EMAIL ?? "").trim().length > 0
    && (env.RESEND_API_KEY ?? "").trim().length > 0
    && (env.MAIL_FROM ?? "").trim().length > 0;
  // The PUSH arm counts as a delivery path, and BOTH halves are required for the same reason
  // the mailer's are: `telegramAlertSink` builds an arm from one half, but that arm refuses
  // every delivery, so accepting a half here would pass a build whose pager cannot page.
  //
  // ── AND NONBLANK IS NOT ENOUGH, WHICH IS THE SAME LESSON `DATABASE_URL_ADMIN` ABOVE PAID ─
  //
  // Review finding. `telegramAlertSink` parses both values at build time and returns an arm
  // that refuses EVERY delivery when either is malformed — the commonest case being an env
  // value that kept its surrounding quotes. A nonblank-only check here therefore certified a
  // production host whose ONLY delivery path was an arm that cannot deliver: a green build
  // log over the exact outage this function exists to prevent, and on the one host that
  // observes a dead worker. The two refusals are statically decidable, so they are decided
  // here, exactly as the staff-connection ones are.
  //
  // The patterns are DUPLICATED from `packages/db/src/alert-push.ts` because this file cannot
  // import TypeScript. `test/alerting-armed.test.ts` runs a behavioural parity check over the
  // pair — every permutation, through both the gate and the real sink — and fails if the gate
  // ever accepts a value the sink would refuse. That test, not this comment, is the guard.
  const pushToken = (env.TF_ALERT_TELEGRAM_BOT_TOKEN ?? "").trim();
  const pushChat = (env.TF_ALERT_TELEGRAM_CHAT_ID ?? "").trim();
  const hasPushSink = /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(pushToken)
    && /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(pushChat);
  if (!hasWebhook && !hasMailSink && !hasPushSink) {
    missing.push(
      "a delivery path: TF_ALERT_WEBHOOK_URL, or TF_ALERT_EMAIL with RESEND_API_KEY + MAIL_FROM, " +
        "or TF_ALERT_TELEGRAM_BOT_TOKEN with TF_ALERT_TELEGRAM_CHAT_ID" +
        // Named separately, because "set it" is unhelpful advice to somebody who HAS set it.
        (pushToken || pushChat
          ? " (the Telegram values are set but at least one is malformed — surrounding quotes " +
            "in the value, or a chat title where a chat id belongs)"
          : ""),
    );
  }

  if (missing.length === 0) return;
  // Names the VARIABLES and never a value — the rule `src/config.ts` states for every config
  // error on this host, because build logs are not private and the habit is what matters.
  throw new Error(
    "This production API host cannot page a human, and it is the only host that can observe " +
      "a dead worker. Missing: " + missing.join("; ") + ". A worker died undetected for two " +
      "hours on 2026-08-01 in exactly this state, so it is refused at build time rather than " +
      "discovered during the next incident. There is no override.",
  );
}

assertAlertingArmed(process.env);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // These four must NOT be bundled by webpack:
  //   • imapflow / nodemailer — raw TCP + TLS clients with dynamic requires; bundling them
  //     is how you discover at runtime that a transport or an auth mechanism is missing.
  //   • mailparser — loads encoding tables lazily, for the same reason.
  //   • postgres (postgres.js) — the driver the pooled Db runs on.
  // An externalised package must resolve from the app itself (the root install hoists them),
  // or the deployed function throws MODULE_NOT_FOUND on the first send.
  serverExternalPackages: ["imapflow", "nodemailer", "mailparser", "postgres"],
  // Let the HANDLER canonicalize trailing slashes instead of the framework redirecting first.
  //
  // With Next's default, `POST /api/push/subscriptions/` never reaches `normalizePathname`: the
  // framework answers 308 to the slash-less URL, so the trailing-slash arm of our canonicalizer
  // — the one whose unit test asserts "a trailing slash is the same request too" — only ever
  // ran in-process. That is a test proving a behaviour production does not execute. A 308
  // preserves method and body, so a redirect-following client is fine, but a client that
  // refuses to follow a redirect on POST (several HTTP libraries do, by default, to avoid
  // replaying bodies) would fail a request our test says works. Skipping the redirect makes the
  // documented canonicalization the one that actually happens.
  skipTrailingSlashRedirect: true,
  webpack: (config) => {
    // The workspace packages are NodeNext TypeScript and their emitted JS carries explicit
    // `.js` specifiers; the app's own `src/*` does too. Same mapping as apps/webapp.
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    // The workspace packages from SOURCE: their exports name the compiled twin under `node`, which
    // the server compiler matches, and the deployment's build runs no `tsc` first. Same as apps/webapp.
    config.resolve.conditionNames = ["ohmail-source", ...(config.resolve.conditionNames ?? ["..."])];
    return config;
  },
};

export default nextConfig;

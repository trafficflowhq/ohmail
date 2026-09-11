/**
 * ONE definition of "is this a transaction pooler?", shared by every host that has to refuse
 * one.
 *
 * It lives in its own module rather than in `setup-prod.ts` because the worker needs it too,
 * and `setup-prod` reads the drizzle journals off disk with `node:fs` — importing it from the
 * package index to reach one predicate would pull migration-file reading into the worker's
 * runtime bundle.
 */

/**
 * Why `url` is a TRANSACTION pooler, or `null` if it is not. DDL and the journal belong on a
 * session-mode connection: a transaction pooler multiplexes statements across backends, and a
 * pooled URL that slips past is a migration whose failure mode is a partially-applied schema. The
 * old host-shape test failed open: `/-pooler\./` matched Neon's pooled endpoint and never
 * Supavisor's — and on Supabase the legitimate session URL IS a pooler host, the modes told apart
 * by PORT: 5432 session, 6543 transaction. The rule is about the MODE, asked three ways:
 * `pgbouncer=true`; port 6543; a `-pooler.` host. Returns a REASON, not a boolean: a guard that
 * only says "no" teaches the operator nothing.
 */
export function transactionPoolerReason(url: string): string | null {
  if (/pgbouncer=true/i.test(url)) return "the URL sets pgbouncer=true";
  if (/-pooler\./i.test(url)) return "the host is a Neon -pooler endpoint";
  // Port, not host: on Supavisor the session and transaction endpoints share a hostname.
  let port: string | null = null;
  try {
    port = new URL(url).port || null;
  } catch {
    // An unparseable URL is somebody else's error to report. Do not claim it is pooled —
    // answering "yes" here would turn a typo into a confusing lecture about connection modes.
    return null;
  }
  if (port === "6543") return "port 6543 is Supavisor TRANSACTION mode (session mode is 5432)";
  return null;
}

/** The message every host gives for a rejected session URL, so operators see one wording. */
export function sessionUrlRejection(reason: string): string {
  return `DATABASE_URL_SESSION must be a session-mode connection: ${reason}`;
}

/** The hostname, lowercased, or `null` if the URL does not parse. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Why `url` is unusable as the SERVERLESS RUNTIME connection, or `null` if it is fine.
 *
 * The SIBLING of {@link transactionPoolerReason}, deliberately not its inverse: the two share no
 * clause, because `pgbouncer=true` and port 6543 are *correct* here and disqualifying there. The
 * sets are not complements either — `localhost` is in neither.
 *
 * ── WHY THIS EXISTS: THE PROVIDER-SCOPED GUARD THAT STOPPED GUARDING ──────────────────────
 *
 * This logic lived at three call sites as `/\.neon\.tech\b/i.test(url) && !/-pooler\./i.test(url)`
 * — `assertPooledUrl` and `loadStaffDbConfig` in the serverless API host's database config, and
 * again in `next.config.mjs`'s build gate. Correct for a Neon-only world. **The day production moved to
 * Supabase all three became unconditionally true-negative**, and nothing failed. Across the six
 * URL families that can occur, the only shape still refused was the Neon direct endpoint,
 * which can no longer occur in production. Everything else — including the IPv6-only
 * `db.<ref>.supabase.co` that works on a laptop and fails on Vercel — was accepted.
 *
 * So the rule is expressed once, here, and each caller keeps its own verdict: `assertPooledUrl`
 * throws (product path), `loadStaffDbConfig` reports (a staff refusal must never 503 the
 * deployment).
 *
 * ── IT IS AN ALLOWLIST OF KNOWN-PROVIDER FOOTGUNS, AND IT FAILS OPEN ──────────────────────
 *
 * Not a validator. `localhost`, a docker Postgres on 5433, a Vercel preview, a self-hoster on a
 * provider neither we nor the reader has named: no clause matches, so the answer is `null` and the
 * URL passes. That property is load-bearing — `assertPooledUrl` THROWS, on the product path, so a
 * rule that refuses a legitimate URL takes ohmail down harder than the bug it prevents.
 *
 * Tested on the parsed HOSTNAME, never the whole URL. The predicate this replaces was a substring
 * test, so a PASSWORD containing `.neon.tech` or `-pooler.` flipped the verdict — on the throwing
 * path.
 */
export function runtimeUrlReason(url: string): string | null {
  const host = hostnameOf(url);
  // An unparseable URL is somebody else's error to report, exactly as above.
  if (!host) return null;

  if (host.endsWith(".neon.tech") && !host.includes("-pooler.")) {
    return "the host is a DIRECT Neon endpoint (the serverless host needs the -pooler host)";
  }
  if (/^db\..+\.supabase\.co$/.test(host)) {
    return "the host is the Supabase DIRECT endpoint, which resolves IPv6-only and cannot be " +
      "reached from Vercel (use the Supavisor pooler)";
  }
  if (host.endsWith(".pooler.supabase.com")) {
    // ABSENT CONFIG SELECTS THE DANGEROUS BRANCH: Postgres defaults to 5432, so a Supavisor URL
    // with NO port is session mode. A test for `port === "5432"` alone waves it through.
    // Only these two cases are refused — a future dedicated-pooler port must not 503 production.
    let port: string | null = null;
    try {
      port = new URL(url).port || null;
    } catch {
      return null;
    }
    if (port === null || port === "5432") {
      return "the host is Supavisor in SESSION mode (port 5432, or absent and therefore 5432); " +
        "the serverless runtime needs TRANSACTION mode on 6543";
    }
  }
  return null;
}

/**
 * Which provider family this URL belongs to — published on `/health` so the NEXT migration cannot
 * silence {@link runtimeUrlReason} the way the last one did.
 *
 * The guards above went blind for a day and nothing noticed, because every fixture in every test
 * that covered them named the old provider. A unit test cannot know production moved. This can:
 * `"unrecognized"` on the live host means the refusals are decoration again, and the runbook's
 * existing "verify `/health` twice" step becomes the tripwire instead of a thing to remember.
 */
export function providerFamily(url: string): "neon-pooler" | "supavisor-transaction" | "unrecognized" {
  const host = hostnameOf(url);
  if (!host) return "unrecognized";
  if (host.endsWith(".neon.tech") && host.includes("-pooler.")) return "neon-pooler";
  if (host.endsWith(".pooler.supabase.com")) {
    let port: string | null = null;
    try {
      port = new URL(url).port || null;
    } catch {
      return "unrecognized";
    }
    if (port === "6543") return "supavisor-transaction";
  }
  return "unrecognized";
}

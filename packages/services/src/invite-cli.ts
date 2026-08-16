/**
 * THE OPERATOR INVITE PATH.
 *
 * It lives in `packages/services/src/` rather than in `scripts/` for the same reason
 * `packages/db/src/setup-prod.ts` does: the repo ROOT has no dependency on the workspace
 * packages, so a `scripts/*.ts` importing `@trafficflow/db` resolves to nothing under tsx.
 * The command is `pnpm invite …`; the location is where its imports work.
 *
 *   pnpm invite list [--pending] [--limit 50]
 *   pnpm invite mint --email someone@example.com [--ttl 14d] [--note "…"] [--force] [--no-send]
 *   pnpm invite revoke --email someone@example.com [--note "why"]
 *   pnpm invite stats
 *
 * ── WHY THIS IS A SCRIPT AND NOT AN ENDPOINT ─────────────────────────────────────────────
 *
 * Minting an invite is the single most privileged operation while signup is invite-gated: it
 * hands a stranger the right to open an account. The only correct authentication for it is
 * a staff role plus step-up, which the invite gate predates. Shipping an HTTP route without
 * one would mean choosing between a shared-secret bearer
 * (a second, weaker auth scheme on the public API, for the one action that most needs the
 * strong one) and no gate at all. So the mint stays where the authentication is already
 * strong and already audited: an operator with the production database URL, on their own
 * machine. When an admin route takes this over, `WaitlistService.mintInvite` is what it
 * calls — the
 * logic does not move, only the door in front of it.
 *
 * ── ENVIRONMENT ──────────────────────────────────────────────────────────────────────────
 *
 * Read from the process environment (the operator's secrets file — never git):
 *
 *   DATABASE_URL_POOLED   required. The pooled URL, same as the API host uses.
 *   RESEND_API_KEY        required unless --no-send. Without it the code is printed and
 *   MAIL_FROM             required unless --no-send. nothing is mailed.
 *   MAIL_APP_URL          optional (default https://ohmail.app) — where /join lives.
 *   MAIL_SITE_URL         optional (default https://ohmail.app).
 *   MAIL_SUPPORT_EMAIL    optional (default support@ohmail.app).
 *
 * The mailer is constructed through `MailService`, never as a bare `ResendMailer`: the
 * per-recipient limiter, the link construction and the redeem URL all live there, and an
 * operator running this in a loop is exactly the caller the limiter was written for.
 *
 * ── THE CODE IS PRINTED ONCE ─────────────────────────────────────────────────────────────
 *
 * `invites.code_hash` is `sha256(code)`. There is no way to recover the raw value from the
 * database, by design — so the terminal output IS the only copy on our side, and re-issuing
 * (with --force) is the remedy for a lost one.
 */
import { pathToFileURL } from "node:url";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { MailService } from "./mail/mail-service.js";
import { ResendMailer } from "./mail/resend-mailer.js";
import { makeWaitlistService, DEFAULT_INVITE_TTL_MS } from "./waitlist-service.js";

interface Args {
  command: string;
  email?: string;
  ttlMs: number;
  note?: string;
  force: boolean;
  send: boolean;
  pending: boolean;
  limit: number;
}

/** `30m` / `12h` / `14d` / a bare number of days. Refuses anything else — no silent 0. */
function parseTtl(raw: string): number {
  const m = /^(\d+)\s*([mhd]?)$/i.exec(raw.trim());
  if (!m) throw new Error(`--ttl must look like 30m, 12h or 14d (got ${JSON.stringify(raw)})`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error("--ttl must be positive");
  const unit = (m[2] || "d").toLowerCase();
  return n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    command: argv[0] ?? "help", ttlMs: DEFAULT_INVITE_TTL_MS,
    force: false, send: true, pending: false, limit: 100,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--email") out.email = next();
    else if (a === "--ttl") out.ttlMs = parseTtl(next());
    else if (a === "--note") out.note = next();
    else if (a === "--limit") out.limit = Number(next());
    else if (a === "--force") out.force = true;
    else if (a === "--no-send") out.send = false;
    else if (a === "--pending") out.pending = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function requireEnv(key: string): string {
  const v = process.env[key]?.trim();
  if (!v) throw new Error(`missing required env var ${key} (see ~/.ohmail/secrets.env)`);
  return v;
}

/**
 * A `MailService`, or `null` when this run is not sending.
 *
 * The three link bases are validated by `MailService`'s constructor against
 * `DEFAULT_LINK_ORIGINS`, so a mistyped `MAIL_APP_URL` fails HERE, loudly, before an invite
 * row exists — rather than producing a valid-looking ohmail invite that points somewhere
 * else. No `operatorEmail`: this instance must not be able to mail the pager.
 */
function mailerOrNull(send: boolean): MailService | null {
  if (!send) return null;
  return new MailService({
    mailer: new ResendMailer({
      apiKey: requireEnv("RESEND_API_KEY"),
      from: requireEnv("MAIL_FROM"),
      replyTo: process.env.MAIL_REPLY_TO?.trim() || undefined,
    }),
    config: {
      appUrl: process.env.MAIL_APP_URL?.trim() || "https://ohmail.app",
      siteUrl: process.env.MAIL_SITE_URL?.trim() || "https://ohmail.app",
      supportEmail: process.env.MAIL_SUPPORT_EMAIL?.trim() || "support@ohmail.app",
    },
  });
}

const USAGE = `
ohmail invites

  pnpm invite list [--pending] [--limit 50]     who signed up (oldest first)
  pnpm invite stats                             total / invited / registered
  pnpm invite mint --email a@b.com [options]    mint one invite and mail it
  pnpm invite revoke --email a@b.com [--note …]  take back every live invite for an address

  --ttl 14d       how long the code lives (30m | 12h | 14d). Default 14d.
  --note "…"      free-text provenance stored on the row (mint), or the reason (revoke).
  --force         REVOKE the address's live invite and issue a replacement.
  --no-send       print the code, mail nothing (no Resend credentials needed).

Revoking is the remedy for a code that reached the wrong inbox. It is idempotent, it
never touches an invite that was already redeemed, and it cannot be undone — mint a
fresh one instead.
`.trim();

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help") {
    console.log(USAGE);
    return 0;
  }

  const owned = makeOwnedDb(requireEnv("DATABASE_URL_POOLED"));
  const svc = makeWaitlistService({ mail: mailerOrNull(args.command === "mint" && args.send) ?? undefined });
  const ctx = { db: owned.db, now: () => new Date() };

  try {
    switch (args.command) {
      case "list": {
        const rows = await svc.list(ctx, { pending: args.pending, limit: args.limit });
        if (rows.length === 0) {
          console.log(args.pending ? "nobody is waiting for an invite." : "the waitlist is empty.");
          break;
        }
        for (const r of rows) {
          const state = r.registeredAt ? "registered" : r.invitedAt ? "invited" : "waiting";
          console.log(
            `${r.createdAt.toISOString().slice(0, 10)}  ${state.padEnd(10)}  ` +
            `${r.tier.padEnd(9)}  ${r.email}`,
          );
        }
        console.log(`\n${rows.length} row(s).`);
        break;
      }

      case "revoke": {
        if (!args.email) throw new Error("revoke needs --email");
        const n = await svc.revokeInvites(ctx, { email: args.email, reason: args.note ?? null });
        console.log(
          n === 0
            ? `no live invite for ${args.email} — nothing to revoke (an already-redeemed one cannot be).`
            : `revoked ${n} live invite(s) for ${args.email}. They no longer open an account.`,
        );
        break;
      }

      case "stats": {
        const s = await svc.stats(ctx);
        console.log(`waitlist: ${s.total} total · ${s.invited} invited · ${s.registered} registered`);
        break;
      }

      case "mint": {
        if (!args.email) throw new Error("mint needs --email");
        const out = await svc.mintInvite(ctx, {
          email: args.email,
          ttlMs: args.ttlMs,
          note: args.note ?? null,
          requireNoLiveInvite: !args.force,
          send: args.send,
        });
        if (out.revoked > 0) {
          console.log(`\nrevoked ${out.revoked} previously-live invite(s) for ${out.email}.`);
        }
        console.log(`\ninvite for ${out.email}`);
        console.log(`  code:     ${out.code}`);
        console.log(`  expires:  ${out.expiresAt.toISOString()}`);
        console.log(`  redeem:   ${(process.env.MAIL_APP_URL?.trim() || "https://ohmail.app")}/join?code=${encodeURIComponent(out.code)}`);
        // The mail RESULT is printed verbatim, including a `skipped` or `failed`. An
        // operator who is not told the send failed will assume it worked, and the invite
        // that never arrived is the failure mode this whole path exists to avoid.
        console.log(`  mail:     ${out.mail ? JSON.stringify(out.mail) : "not sent (--no-send)"}`);
        console.log("\nThis code is stored hashed. It cannot be printed again — re-run with --force to reissue.\n");
        break;
      }

      default:
        console.error(`unknown command ${JSON.stringify(args.command)}\n\n${USAGE}`);
        return 2;
    }
    return 0;
  } finally {
    await owned.close();
  }
}

/**
 * Run ONLY when executed directly. This module now lives inside `packages/services/src`
 * (see the header), so it is compiled into `dist` alongside the library — and a
 * module-scope `main()` would open a database pool the moment anything imported it.
 *
 * `pathToFileURL` and NOT `` `file://${process.argv[1]}` ``: the latter is false for any
 * path that needs percent-encoding, so on a checkout under a directory with a SPACE (this
 * one) the guard silently never fires and the command exits 0 having done nothing. A lesson
 * paid for once already; `setup-prod.ts` carries the same note.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      // The message only. A stack from a driver error can quote the connection string.
      console.error(`invite: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

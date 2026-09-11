import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  describeDuplicates, findActiveAddressDuplicates, resolveActiveAddressDuplicates,
  activeAddressIndexExists,
} from "./mailbox-dedup.js";
import { assertExpectedHost, assertSessionUrl, PROD_DB_HOST_ENV } from "./setup-prod.js";
import { onNotice } from "./notices.js";

/**
 * `pnpm db:mailboxes:dedup` — the operator's half of {@link findActiveAddressDuplicates}. Default
 * mode REPORTS: prints every duplicate group with its evidence and exits 1 if any exist, writing
 * nothing; `--keep <id>` RESOLVES — disables every other active row in the group and deletes the
 * losers' credentials. Naming the keepers IS the confirmation — no `--yes`, no automatic winner:
 * a rule that picks for you is how mail 0021 came to prefer a dead row over a working one. Its
 * own file keeps the module graph acyclic. The target database comes from the ENVIRONMENT, not
 * `--url`: `assertSessionUrl` refuses a pooler and `TF_PROD_DB_HOST` pins the hostname, while a
 * DSN on argv would land in shell history and `ps` — the same two guards `db:setup:prod` uses.
 */

export interface DedupCliArgs {
  keeps: string[];
}

/** `--keep <id>` and `--keep=<id>`, repeatable. Anything else is a usage error. */
export function parseDedupArgs(argv: readonly string[]): DedupCliArgs {
  const keeps: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--keep") {
      const v = argv[++i];
      if (!v) throw new Error("--keep needs a mailbox id");
      keeps.push(v);
    } else if (a.startsWith("--keep=")) {
      const v = a.slice("--keep=".length);
      if (!v) throw new Error("--keep needs a mailbox id");
      keeps.push(v);
    } else {
      throw new Error(`unknown argument '${a}' — usage: db:mailboxes:dedup [--keep <mailbox-id> …]`);
    }
  }
  const dupes = keeps.filter((k, i) => keeps.indexOf(k) !== i);
  if (dupes.length > 0) throw new Error(`--keep ${dupes[0]} was given twice`);
  return { keeps };
}

async function main(): Promise<number> {
  const url = assertSessionUrl(process.env.DATABASE_URL_SESSION);
  const expectedHost = process.env[PROD_DB_HOST_ENV]?.trim();
  if (!expectedHost) {
    console.error(
      `[db:mailboxes:dedup] FAILED: ${PROD_DB_HOST_ENV} is required — set it to the endpoint ` +
        `hostname you intend to modify (it is compared to DATABASE_URL_SESSION before anything ` +
        `is written; this command DELETES mailbox credentials)`,
    );
    return 1;
  }
  assertExpectedHost(url, expectedHost);

  const { keeps } = parseDedupArgs(process.argv.slice(2));
  const client = postgres(url, { max: 1, onnotice: onNotice });
  const db = drizzle(client);
  const now = new Date();
  try {
    // `client.ts#ROLE_DEFAULT_TIMEOUTS` is a ROLE-ONLY default (every database this role opens,
    // not only production's), so this scan across the real mailbox/message tables must not
    // silently inherit a 55 s ceiling.
    await client.unsafe(`set statement_timeout = 0`);
    await client.unsafe(`set idle_in_transaction_session_timeout = 0`);
    console.log(`[db:mailboxes:dedup] target host=${new URL(url).hostname}`);
    const groups = await findActiveAddressDuplicates(db);
    if (groups.length === 0) {
      const indexed = await activeAddressIndexExists(db);
      console.log(
        `[db:mailboxes:dedup] no duplicate active mailbox addresses` +
          (indexed ? " (and mailboxes_active_address_uq is installed, so there cannot be)" : ""),
      );
      return 0;
    }

    console.log(
      `[db:mailboxes:dedup] ${groups.length} duplicate group(s), ` +
        `${groups.reduce((n, g) => n + g.rows.length, 0)} active rows:\n` +
        // WITH addresses: this is an interactive operator terminal at the same trust level as
        // the database, and the address is what makes the choice intelligible. The migrator's
        // refusal omits them because that one lands in a deploy log.
        describeDuplicates(groups, now, { withAddress: true }),
    );

    if (keeps.length === 0) {
      // The candidates are listed as a CHOICE, never pre-composed into a runnable line. A
      // ready-made command is a default, and the only default available here is "the first row",
      // which is 0021's rule — the exact judgement this tool exists to take away from software.
      console.error(
        `\n[db:mailboxes:dedup] REPORT ONLY — nothing was changed.\n` +
          `Name exactly one survivor per group and re-run. The candidates:\n` +
          groups
            .map((g) => `  account ${g.accountId} · "${g.key}": ` +
              g.rows.map((r) => `--keep ${r.id}`).join("   OR   "))
            .join("\n"),
      );
      return 1;
    }

    const outcomes = await resolveActiveAddressDuplicates(db, keeps, now);
    for (const o of outcomes) {
      console.log(
        `[db:mailboxes:dedup] account ${o.accountId} · "${o.key}": kept ${o.kept}, disabled ` +
          `${o.disabled.join(", ")} (${o.credentialsDeleted} credential row(s) deleted)`,
      );
    }
    console.log(`[db:mailboxes:dedup] OK — ${outcomes.length} group(s) resolved. Re-run the migration.`);
    return 0;
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * `pathToFileURL`, NOT `file://${process.argv[1]}`: the latter is false for any path needing
 * percent-encoding — a checkout under a directory with a SPACE exits 0 having done nothing;
 * `setup-prod.ts` carries the same note. `process.exitCode`, NOT `process.exit()`: `console.log`
 * QUEUES when the destination is a pipe, and `process.exit` discards what has not drained —
 * measured: `node -e 'console.log("x".repeat(120000)); process.exit(0)' | wc -c` emits 65536 of
 * 120001. The line lost is the one naming the duplicate group. `tsx` masks this today (its
 * esbuild subprocess puts the pipe back into blocking mode); `test/cli-exit-drain.test.ts`
 * switches the masking off. `.then`, not top-level `await` — see `setup-prod.ts`.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
    .catch((err: unknown) => {
      console.error(`[db:mailboxes:dedup] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    })
    .then((code) => { process.exitCode = code; });
}

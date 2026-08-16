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
 * `pnpm db:mailboxes:dedup` — the operator's half of {@link findActiveAddressDuplicates}.
 *
 * Two modes, and the default is the harmless one:
 *
 *   pnpm db:mailboxes:dedup                          → REPORT. Prints every duplicate group with
 *                                                      the evidence for each row and exits 1 if
 *                                                      any exist. Writes nothing.
 *   pnpm db:mailboxes:dedup --keep <id> [--keep …]   → RESOLVE. Disables every active row in a
 *                                                      group except the one named, and deletes
 *                                                      the losers' credentials.
 *
 * Naming the keepers IS the confirmation — there is no `--yes` and no automatic winner. The
 * reasoning is in `mailbox-dedup.ts`: a rule that picks for you is how mail migration 0021 came
 * to prefer a dead row over a working one, and the improvement over "keep the oldest" is not a
 * better guess but no guess.
 *
 * It lives in its OWN file rather than at the bottom of `mailbox-dedup.ts` to keep the module
 * graph acyclic: `migrate.ts` imports the checker, this imports the checker AND `setup-prod.ts`
 * (for the two URL guards), and `setup-prod.ts` imports `migrate.ts`.
 *
 * ── THE TARGET DATABASE COMES FROM THE ENVIRONMENT, NOT FROM `--url` ────────────────────
 *
 * An architecture review asked for an explicit `--url` here, to keep this away from the trap
 * `migrate.ts` records: the deleted `pnpm --filter @trafficflow/db migrate` read a generic
 * ambient `DATABASE_URL`, accepted a POOLER string, and provisioned quietly wrong databases.
 * That trap is real and it is closed here by a different mechanism — `assertSessionUrl`
 * (pooler refused) plus a REQUIRED `TF_PROD_DB_HOST` pin compared to the URL's hostname before
 * a connection is opened. `--url` was not adopted because it collides with an explicit standing
 * decision one file over (`setup-prod.ts`): a connection string on argv lands in shell history
 * and in `ps` output, and this command needs a superuser-ish DSN for a production database. So:
 * the specific hazard the review named is handled, and the credential does not go on the
 * command line. Both guards are the same two `db:setup:prod` uses, deliberately.
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
 * `pathToFileURL` and NOT `file://${process.argv[1]}`: the latter is false for any path needing
 * percent-encoding, so on a checkout under a directory with a SPACE (this one) the script would
 * exit 0 having done nothing at all — a lesson already paid for once; `setup-prod.ts` carries the same note.
 *
 * `process.exitCode` and NOT `process.exit()`, which is the shape `provision-staff-role.ts`
 * already uses. `console.log`/`console.error` QUEUE when the destination is a pipe, and
 * `process.exit` discards whatever has not drained — measured, not assumed:
 * `node -e 'console.log("x".repeat(120000)); process.exit(0)' | wc -c` emits 65536 of 120001 here.
 * On a terminal nobody sees it; under `db:mailboxes:dedup 2>&1 | tee cutover.log` the line lost is
 * the one naming the duplicate group or the failure. Setting the code instead of forcing the exit
 * leaves the pending write holding the loop open until it has actually left the process.
 *
 * `.then`, NOT top-level `await`, and that is deliberate — see the note in `setup-prod.ts`.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
    .catch((err: unknown) => {
      console.error(`[db:mailboxes:dedup] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    })
    .then((code) => { process.exitCode = code; });
}

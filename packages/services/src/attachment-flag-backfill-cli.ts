/**
 * THE OPERATOR BACKFILL FOR `has_attachments` / `attachment_count`.
 *
 * The ingest half (`mime.ts#isRealFile`, `pipeline.ts`) is forward-looking only. This corrects
 * mail already on disk:
 *
 *   pnpm -F @trafficflow/services exec tsx src/attachment-flag-backfill-cli.ts plan
 *   pnpm -F @trafficflow/services exec tsx src/attachment-flag-backfill-cli.ts apply [--mailbox <uuid>]
 *
 * ── RUN `plan` FIRST, AND READ IT ──────────────────────────────────────────────────────────
 *
 * `plan` is READ-ONLY. It prints, per mailbox, how many flagged messages hold no downloadable
 * part at all (the paperclips that open an empty strip), how many hold files but carry a count
 * that includes their embedded images, and how many are already correct and will not be touched.
 * A plan whose `already correct` column is zero is a plan worth questioning before applying —
 * this pass is a correction, not a rewrite, and most flagged mail is flagged correctly.
 *
 * ── WHY A COMMAND AND NOT A SCHEDULED PASS ────────────────────────────────────────────────
 *
 * The same wall `sensitive-rescreen-cli.ts` documents: the worker's dependency test
 * (`FORBIDDEN_IN_SRC`) forbids anything under `apps/worker/src` from importing
 * `@trafficflow/services`, because services is an API-host concern and is not installed in the
 * worker's image — an accidental import resolves through the vitest alias, passes the whole
 * suite, and fails only in production. So there is no attach seam this can be called from, and
 * moving it into `packages/core` would put a one-time historical correction into the library
 * both engines share for ever.
 *
 * ── DEPLOY ORDER MATTERS, AND IT IS NOT THE USUAL ONE ─────────────────────────────────────
 *
 * **Deploy the worker BEFORE running this.** The pipeline lives in shared core and runs on the
 * worker; until the worker carries the ingest fix it keeps minting rows under the old semantic,
 * so a backfill run first leaves fresh drift behind it. Nothing breaks — the pass is idempotent
 * and a second run mops up — but the intended sequence is: deploy worker, run `plan`, run
 * `apply`, re-run `plan` and see zeroes.
 *
 * ── IT MOVES NO MAIL AND OPENS NO IMAP ────────────────────────────────────────────────────
 *
 * It writes two integer/boolean columns on `messages`, one `change_log` row per corrected
 * message, and audit rows. No folder, no routing, no `folder_state`, no socket. The mailbox is
 * the master and nothing here has an opinion about it.
 *
 * ── ENVIRONMENT ───────────────────────────────────────────────────────────────────────────
 *
 *   OHMAIL_BACKFILL_DB_URL   required. A SESSION-mode connection string.
 *
 * Deliberately its OWN variable, never an ambient `DATABASE_URL`. A retired database that
 * answers happily and holds a different, plausible dataset is worse than one that errors —
 * nothing fails, and every number the pass reports is a coherent answer to the wrong question.
 * A pass that rewrites thousands of rows of somebody's live mail must not inherit a variable
 * that can silently name the wrong database, so the operator names it explicitly:
 *
 *   OHMAIL_BACKFILL_DB_URL="$YOUR_SESSION_URL" pnpm … plan
 *
 * SESSION mode and not the pooled URL: this walks the table in a paged transaction loop holding
 * `FOR UPDATE` locks, which is exactly the shape a transaction pooler mishandles.
 */
import { pathToFileURL } from "node:url";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { createLogger } from "@trafficflow/core";
import {
  runAttachmentFlagBackfill, planAttachmentFlagBackfill, ATTACHMENT_FLAG_BATCH,
} from "./attachment-flag-backfill.js";
import type { Db } from "./context.js";

/**
 * Structured, through the same logger the worker uses — `packages/core/src/log.ts` is where the
 * secret-value redaction lives, and an operator command whose fields include message ids is
 * exactly the caller that must not route around it.
 */
const log = createLogger({ service: "attachment-flag-backfill" });

const USAGE = `
ohmail attachment-flag backfill (no migration)

  plan                        READ-ONLY. Per mailbox: flagged, inline-only, miscounted, correct.
  apply [--mailbox <uuid>]    Correct the mismatched rows. Idempotent — re-running writes nothing.

  --mailbox <uuid>   restrict to one mailbox. Default: every mailbox.

  OHMAIL_BACKFILL_DB_URL must be set to a SESSION-mode URL, explicitly — this pass never
  inherits an ambient DATABASE_URL, because a stale one answers happily with the wrong dataset.

  Deploy the worker (which carries the ingest fix) BEFORE running apply.
`;

interface Args { command: string; mailboxId?: string }

function parseArgs(argv: string[]): Args {
  const out: Args = { command: argv[0] ?? "help" };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mailbox") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--mailbox needs a value");
      out.mailboxId = v;
    } else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function plan(db: Db): Promise<void> {
  const rows = await planAttachmentFlagBackfill(db);
  if (rows.length === 0) {
    console.log("no message carries has_attachments — nothing to plan.");
    return;
  }
  let flagged = 0, inlineOnly = 0, miscounted = 0, correct = 0;
  for (const r of rows) {
    flagged += r.flagged; inlineOnly += r.inlineOnly;
    miscounted += r.miscounted; correct += r.correct;
    console.log(
      `mailbox ${r.mailboxId}\n` +
      `  flagged                 ${r.flagged}\n` +
      `  inline-only (clear)     ${r.inlineOnly}   paperclip, nothing to download\n` +
      `  miscounted (recount)    ${r.miscounted}   real files, count includes embedded images\n` +
      `  already correct         ${r.correct}   NOT touched\n`,
    );
  }
  console.log(
    `TOTAL  flagged ${flagged}  ·  would clear ${inlineOnly}  ·  would recount ${miscounted}  ` +
    `·  untouched ${correct}\n\n` +
    `apply writes ${inlineOnly + miscounted} rows, the same number of change_log entries, and\n` +
    "one audit_log row per corrected message carrying the prior pair as its inverse.\n",
  );
}

async function apply(db: Db, args: Args): Promise<void> {
  const r = await runAttachmentFlagBackfill({ db, mailboxId: args.mailboxId, log });
  console.log(
    `examined ${r.examined}  cleared ${r.cleared}  recounted ${r.recounted}  ` +
    `truncated ${r.truncated}`,
  );
  if (r.truncated) {
    console.warn(
      `  the pass stopped at the page cap (${ATTACHMENT_FLAG_BATCH} rows/page). Re-run apply to\n` +
      "  resume — it picks up exactly where it stopped.",
    );
    return;
  }
  console.log(
    "\nRe-run `plan`: inline-only and miscounted should both be 0. Clients pick the correction\n" +
    "up on their next /sync page; nothing needs to be purged or re-fetched.\n",
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "help" || args.command === "--help") { console.log(USAGE); return 0; }
  if (args.command !== "plan" && args.command !== "apply") {
    console.error(`unknown command ${JSON.stringify(args.command)}\n${USAGE}`);
    return 2;
  }
  const url = process.env.OHMAIL_BACKFILL_DB_URL?.trim();
  if (!url) {
    throw new Error(
      "missing required env var OHMAIL_BACKFILL_DB_URL. Set it to a SESSION-mode connection " +
      "string explicitly — this pass never inherits an ambient DATABASE_URL.",
    );
  }

  const owned = makeOwnedDb(url);
  try {
    if (args.command === "plan") await plan(owned.db as unknown as Db);
    else await apply(owned.db as unknown as Db, args);
    return 0;
  } finally {
    await owned.close();
  }
}

/**
 * Run ONLY when executed directly — `pathToFileURL` and not `` `file://${process.argv[1]}` ``,
 * because the latter is false for any path needing percent-encoding and this checkout lives
 * under a directory with a SPACE. `sensitive-rescreen-cli.ts` carries the same note.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      // The message only. A stack from a driver error can quote the connection string.
      console.error(`attachment-flag-backfill: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

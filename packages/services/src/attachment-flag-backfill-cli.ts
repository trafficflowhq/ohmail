/**
 * The operator backfill for `has_attachments`/`attachment_count`; the ingest half
 * (`mime.ts#isRealFile`, `pipeline.ts`) is forward-looking only. Run `plan` first — read-only,
 * per-mailbox counts. A command, not a scheduled pass: the worker's dependency test
 * (`FORBIDDEN_IN_SRC`) forbids importing `@trafficflow/services` from worker src. Deploy the
 * worker FIRST — until it carries the ingest fix it keeps minting rows under the old semantic. It
 * moves no mail and opens no IMAP. `OHMAIL_BACKFILL_DB_URL` is required and deliberately its OWN
 * variable, session-mode: an ambient URL can silently name a retired database that answers
 * happily, and the loop holds `FOR UPDATE` locks a transaction pooler mishandles.
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

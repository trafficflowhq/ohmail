/**
 * The operator backfill that makes a part the stored html references by `cid:` inline on rows
 * ingested before `mime.ts` promoted such parts; the ingest half is forward-looking only. Run
 * `plan` first — read-only, per-mailbox counts. A command, not a scheduled pass (the worker may
 * not import `@trafficflow/services`). It moves no mail and opens no IMAP. Run it after the
 * paperclip backfill, never beside it. `OHMAIL_INLINE_CID_BACKFILL_DB_URL` is required and its
 * OWN variable, session-mode: an ambient URL can name a retired database that answers happily,
 * and the loop holds `FOR UPDATE` and advisory locks a transaction pooler mishandles.
 */
import { pathToFileURL } from "node:url";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { createLogger } from "@trafficflow/core";
import { runInlineCidBackfill, planInlineCidBackfill } from "./inline-cid-backfill.js";
import { bridgeDb, type Db } from "./context.js";

/** Structured, through the logger that carries the secret-value redaction. */
const log = createLogger({ service: "inline-cid-backfill" });

const USAGE = `
ohmail inline-cid backfill (no migration)

  plan [--mailbox <uuid>]                READ-ONLY. Per mailbox: cid parts stored as files, by class.
  apply [--mailbox <uuid>] [--after <id>] Promote the parts the stored html references. Idempotent.

  --mailbox <uuid>   restrict to one mailbox. Default: every mailbox.
  --after <id>       start after this message id — the resume point a truncated apply prints.

  OHMAIL_INLINE_CID_BACKFILL_DB_URL must be set to a SESSION-mode URL, explicitly — this pass
  never inherits an ambient DATABASE_URL, because a stale one answers happily with the wrong data.

  Run it after the paperclip backfill (attachment-flag-backfill-cli), one at a time.
`;

interface Args { command: string; mailboxId?: string; afterId?: string }

function parseArgs(argv: string[]): Args {
  const out: Args = { command: argv[0] ?? "help" };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mailbox" || a === "--after") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (a === "--mailbox") out.mailboxId = v;
      else out.afterId = v;
    } else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function plan(db: Db, args: Args): Promise<void> {
  const rows = await planInlineCidBackfill(db, { mailboxId: args.mailboxId });
  if (rows.length === 0) {
    console.log("no part with a Content-ID is stored as a file — nothing to plan.");
    return;
  }
  const t = { parts: 0, referenced: 0, notReferenced: 0, noBody: 0, noHtml: 0, cut: 0, messages: 0 };
  for (const r of rows) {
    t.parts += r.parts; t.referenced += r.referenced; t.notReferenced += r.notReferenced;
    t.noBody += r.noBodyOrWithheld; t.noHtml += r.noHtmlStored; t.cut += r.truncatedNotReferenced;
    t.messages += r.messagesToCorrect;
    console.log(
      `mailbox ${r.mailboxId}\n` +
      `  cid parts stored as files     ${r.parts}\n` +
      `  REFERENCED (promote)          ${r.referenced}   in ${r.messagesToCorrect} message(s)\n` +
      `  NOT REFERENCED                ${r.notReferenced}   stays a file\n` +
      `  NO BODY / WITHHELD            ${r.noBodyOrWithheld}   body not held, untouched\n` +
      `  NO HTML STORED                ${r.noHtmlStored}   untouched\n` +
      `  TRUNCATED, NOT REFERENCED     ${r.truncatedNotReferenced}   reference may sit past the cap, untouched\n`,
    );
  }
  console.log(
    `TOTAL  parts ${t.parts}  ·  would promote ${t.referenced} in ${t.messages} message(s)  ·  ` +
    `not referenced ${t.notReferenced}  ·  unreadable ${t.noBody + t.noHtml + t.cut} ` +
    `(no body/withheld ${t.noBody}, no html ${t.noHtml}, truncated ${t.cut})\n\n` +
    `apply writes ${t.messages} message rows, the same number of change_log entries, and one\n` +
    "audit_log row per corrected message carrying the prior state as its inverse.\n",
  );
}

async function apply(db: Db, args: Args): Promise<void> {
  const r = await runInlineCidBackfill({ db, mailboxId: args.mailboxId, afterId: args.afterId, log });
  console.log(
    `examined ${r.examined}  corrected ${r.corrected}  promoted ${r.promoted}  truncated ${r.truncated}`,
  );
  if (r.truncated) {
    console.warn(
      `  the pass stopped at the page cap. Continue with: apply --after ${r.lastExaminedId}` +
      (args.mailboxId ? ` --mailbox ${args.mailboxId}` : ""),
    );
    return;
  }
  console.log(
    "\nRe-run `plan`: REFERENCED should be 0. Clients pick the correction up on their next /sync\n" +
    "page; nothing needs to be purged or re-fetched.\n",
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "help" || args.command === "--help") { console.log(USAGE); return 0; }
  if (args.command !== "plan" && args.command !== "apply") {
    console.error(`unknown command ${JSON.stringify(args.command)}\n${USAGE}`);
    return 2;
  }
  const url = process.env.OHMAIL_INLINE_CID_BACKFILL_DB_URL?.trim();
  if (!url) {
    throw new Error(
      "missing required env var OHMAIL_INLINE_CID_BACKFILL_DB_URL. Set it to a SESSION-mode " +
      "connection string explicitly — this pass never inherits an ambient DATABASE_URL.",
    );
  }
  const owned = makeOwnedDb(url);
  try {
    if (args.command === "plan") await plan(bridgeDb(owned.db), args);
    else await apply(bridgeDb(owned.db), args);
    return 0;
  } finally {
    await owned.close();
  }
}

/** Run ONLY when executed directly; `pathToFileURL` because a checkout path can need escaping. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      // The message only. A stack from a driver error can quote the connection string.
      console.error(`inline-cid-backfill: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

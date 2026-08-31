/**
 * THE OPERATOR RE-SCREEN PATH (mail 0030).
 *
 * The forward fix stopped `pipeline.ts:393` letting a sender-chosen subject or body carry a
 * stranger past the consent gate. It is forward-looking only. This runs the correction over mail
 * that was already filed:
 *
 *   pnpm -F @trafficflow/services exec tsx src/sensitive-rescreen-cli.ts plan
 *   pnpm -F @trafficflow/services exec tsx src/sensitive-rescreen-cli.ts apply [--mailbox <uuid>]
 *
 * ── WHY A COMMAND AND NOT A SCHEDULED PASS ────────────────────────────────────────────────
 *
 * Two reasons, and the first is a wall rather than a preference.
 *
 * The worker's dependency test (`FORBIDDEN_IN_SRC`) forbids every file under `apps/worker/src`
 * from importing `@trafficflow/services`: a load-bearing boundary, not a stylistic one — services is
 * an API-host concern and is **not installed in the worker's image**, so an accidental import
 * resolves through the vitest alias, passes the whole suite, and fails only in production. The
 * pass lives in this package, so there is no attach seam it can be called from. Moving it into
 * `packages/core` to get around that would put a one-time historical correction into the library
 * both engines share for ever.
 *
 * The second: this is one-time work over somebody's everyday mailbox. It should be run
 * deliberately, with `plan` read first, by somebody who can see the counts before and after —
 * not discovered mid-attach by a worker that then reports it in a log line. `invite-cli.ts` is
 * here for the same reason.
 *
 * ── IT MOVES NO MAIL ──────────────────────────────────────────────────────────────────────
 *
 * `apply` writes `folder_state.desired_folder` and a `move` change and stops. No IMAP connection
 * is opened by this process, by the pass, or by anything either of them calls — the mailbox is
 * the master: the worker's reconcile pass performs the physical move on its next cycle. If the worker is
 * down, nothing happens until it is back — which is the correct failure mode, not a bug.
 *
 * ── ENVIRONMENT ───────────────────────────────────────────────────────────────────────────
 *
 *   DATABASE_URL_SESSION   required (from the operator's secrets file — never git). The SESSION URL and
 *                          not the pooled one: this walks the whole Ohbox in a paged
 *                          transaction loop, which is exactly the shape a transaction pooler
 *                          mishandles.
 *
 * `plan` is READ-ONLY and is the command to run first. It reports, per mailbox, how many rows the
 * pass would examine and what the re-evaluation decides for each — including how many STAY,
 * because a known sender's login code belongs in the Ohbox and a plan that reports zero of those
 * is a plan worth questioning before applying.
 */
import { pathToFileURL } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { mailboxes, messages, folderState } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { createLogger } from "@trafficflow/core";
import { mailboxProviderAuthservIds } from "@trafficflow/core/adapters/drizzle-repo";
import { runSensitiveRescreen, SENSITIVE_RESCREEN_BATCH } from "./sensitive-rescreen.js";
import type { Db } from "./context.js";

/**
 * The pass's own log lines, on stdout, through the SAME structured logger the worker uses.
 *
 * Not a hand-rolled `{ info: console.log }` object: `packages/core/src/log.ts` is where the
 * secret-value redaction lives (`SECRET_VALUE_PATTERNS`), and an operator command whose fields
 * include a mailbox address and a message id is exactly the caller that must not route around it.
 */
const log = createLogger({ service: "rescreen" });

const USAGE = `
ohmail sensitive re-screen (mail 0030)

  plan                          READ-ONLY. Per mailbox: Ohbox size, candidates, marker state.
  apply [--mailbox <uuid>]      Run the pass. Idempotent; the marker is stamped LAST.

  --mailbox <uuid>   restrict to one mailbox. Default: every mailbox with a NULL marker.
  --force            re-run a mailbox whose marker is already stamped. It IGNORES the marker and
                     nothing else: the candidate query is unchanged, so an UNCHANGED mailbox
                     moves no mail and records no move change — which is what this exists to
                     demonstrate. A mailbox that has changed since (a rule deleted, a folder
                     intent restored on the server) has candidates again and they WILL move.
                     Either way the run records its own completion row in the audit log.

  DATABASE_URL_SESSION must be set. Nothing here opens IMAP: the pass writes the desired
  folder and the worker's reconciler performs the move.
`;

interface Args { command: string; mailboxId?: string; force: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { command: argv[0] ?? "help", force: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mailbox") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--mailbox needs a value");
      out.mailboxId = v;
    } else if (a === "--force") out.force = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

interface Target { id: string; address: string; marker: Date | null }

/**
 * The mailboxes a command will touch — ONE query, shared by `plan` and `apply`.
 *
 * Shared rather than duplicated because the two commands disagreeing about their target set is
 * the same class of defect as their disagreeing about a count: the operator reads one and
 * authorises the other. `--mailbox` names a mailbox regardless of its marker; otherwise the
 * default is every mailbox the pass has never run on, and `--force` widens that to all of them.
 */
async function selectTargets(db: Db, args: Args): Promise<Target[]> {
  const filters = args.mailboxId ? [eq(mailboxes.id, args.mailboxId)] : [];
  if (!args.force && !args.mailboxId) filters.push(sql`${mailboxes.sensitiveRescreenAt} is null`);
  return db.select({
    id: mailboxes.id, address: mailboxes.address, marker: mailboxes.sensitiveRescreenAt,
  }).from(mailboxes)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(mailboxes.address);
}

/**
 * The old one-statement aggregate, kept as CONTEXT and no longer as the answer.
 *
 * `candidates` counts the Ohbox rows the pass could look at BEFORE the five user-intent
 * exclusions in `selectCandidates`, so it is an upper bound and nothing more. It stays because
 * the ratio between it and `examined` is informative — a large gap means the user has acted on a
 * lot of this mail — but it is labelled every time it is printed, because it being unlabelled and
 * alone is the defect this command was rewritten to fix.
 */
async function upperBounds(db: Db): Promise<Map<string, { ohbox: number; sensitive: number; candidates: number }>> {
  const rows = await db.select({
    id: mailboxes.id,
    ohbox: sql<number>`count(*) filter (where ${folderState.desiredFolder} = 'INBOX')::int`,
    sensitive: sql<number>`count(*) filter (
      where ${folderState.desiredFolder} = 'INBOX' and ${messages.sensitivityCategory} is not null)::int`,
    candidates: sql<number>`count(*) filter (
      where ${folderState.desiredFolder} = 'INBOX'
        and ${folderState.lastSetBy} = 'us'
        and ${messages.sensitivityCategory} is not null)::int`,
  }).from(mailboxes)
    .leftJoin(messages, eq(messages.mailboxId, mailboxes.id))
    .leftJoin(folderState, eq(folderState.messageId, messages.id))
    .groupBy(mailboxes.id);
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * `plan` and `apply` — ONE function, because they are one call with `dryRun` between them.
 *
 * There is no second code path here to drift, and that is the entire design: the numbers a plan
 * prints were produced by running the pass, so the only way for them to be wrong about the apply
 * is for the mailbox to change in between.
 */
async function run(db: Db, args: Args, dryRun: boolean): Promise<void> {
  const targets = await selectTargets(db, args);
  if (targets.length === 0) {
    console.log("nothing to do — every mailbox carries a marker (use --force to include one).");
    return;
  }
  const bounds = await upperBounds(db);

  for (const mb of targets) {
    const b = bounds.get(mb.id);
    const r = await runSensitiveRescreen({
      db, mailboxId: mb.id, force: args.force, dryRun, log,
      // Whose `Authentication-Results` this mailbox may believe, off its own credential
      // row's IMAP host — the same canonical resolver every other re-derivation pass uses.
      trustedAuthservIdsFor: mailboxProviderAuthservIds,
    });

    const head =
      `${mb.address}\n  mailbox      ${mb.id}\n` +
      `  marker       ${mb.marker ? mb.marker.toISOString() : "NULL (never re-screened)"}\n` +
      `  ohbox        ${b?.ohbox ?? "?"}\n` +
      `  sensitive    ${b?.sensitive ?? "?"}\n` +
      `  candidates   ${b?.candidates ?? "?"}  UPPER BOUND — counted before the user-intent\n` +
      "               exclusions, which the pass applies per page. Not the number to decide on.\n";

    if (!r.ran) {
      // The marker is set and `--force` was not given, so `apply` would skip this mailbox. Say
      // so rather than printing a row of zeroes that reads like "there is nothing to move".
      console.log(`${head}  ${dryRun ? "plan" : "apply"}        SKIPPED — the marker is stamped. ` +
        "Re-run with --force to include it.\n");
      continue;
    }

    // 13-wide labels, as above — the numbers are meant to be read down a column, and a plan and
    // an apply printed one after the other are meant to be comparable at a glance.
    const move = (dryRun ? "would MOVE" : "MOVE").padEnd(13);
    const stay = (dryRun ? "would STAY" : "STAY").padEnd(13);
    const moved = Object.entries(r.destinations).sort((a, b2) => b2[1] - a[1]);
    const dest = moved.length === 0
      ? "               (nothing moved)\n"
      : moved.map(([to, n]) => `               ${String(n).padStart(6)} → ${to}\n`).join("");

    // WHAT THESE NUMBERS ARE ABOUT. A resumed run's counts describe the REMAINDER, and the
    // difference matters most in exactly the case the operator is least likely to notice: a
    // plan that resumes near the end prints small numbers, which read like a nearly clean
    // mailbox rather than like the tail of a long one.
    const from = r.resumedFrom === null
      ? "  from         the beginning of the mailbox\n"
      : `  from         RESUMED after message ${r.resumedFrom}\n` +
        "               the counts below are the REMAINDER, not the whole mailbox.\n";

    console.log(
      `${head}${from}` +
      `  examined     ${r.examined}  the candidate set AFTER the exclusions\n` +
      `  ${move}${r.rescreened}\n` +
      `  ${stay}${r.kept}  a known sender's code, a user rule, a header answer\n` +
      `  destination  read back from the move changes the run wrote:\n${dest}` +
      `  truncated    ${r.truncated}`,
    );

    // THE SUM IS CHECKED, NOT ASSUMED. `destinations` comes from `change_log`; `rescreened` is
    // counted in JS. They are two different measurements of the same thing, so a disagreement
    // means one of them is wrong and the operator needs to know BEFORE authorising the apply —
    // silently printing whichever number came last is how a plan lies.
    const total = Object.values(r.destinations).reduce((a, n) => a + n, 0);
    if (total !== r.rescreened) {
      console.warn(
        `  !! ${r.rescreened} rows were counted as moved but ${total} move changes were found.\n` +
        "     Do not apply on these numbers. Re-run the plan; if it persists, the pass and the\n" +
        "     change log disagree and that is the bug to chase first.",
      );
    }
    if (r.truncated) {
      // TWO REASONS, AND THEY TELL THE OPERATOR DIFFERENT THINGS ABOUT THE NEXT RUN. Collapsing
      // them into one "run it again to resume" line was a false statement in the second case:
      // a disturbed run DISCARDS its position on purpose, so the next run starts at the top.
      const next = r.stoppedBecause === "disturbed"
        ? "  A message behind the walk became a candidate again while the walk was past it —\n" +
          "  most likely a folder move completing on the mail server. The resume point was\n" +
          `  DISCARDED, so the next ${dryRun ? "plan" : "apply"} starts from the beginning of the mailbox.`
        : dryRun
          // A plan commits nothing, its cursor UPDATE included, so "run it again" resumes at
          // the same place it started — saying "again to resume" without this would be the
          // plan claiming an apply's progress.
          ? "  A plan stores no position: the next plan starts where this one did."
          // …and a `--force` run over an ALREADY stamped mailbox stores none either, by the same
          // rule that keeps a finished mailbox from carrying a stale one. Saying "continues from
          // this page" there would be wrong in the one mode an operator reaches deliberately.
          : args.force
            ? "  --force over a stamped mailbox stores no position: the next run starts from the\n" +
              "  beginning. Clear the marker if you mean to re-run it as a repair."
            : "  The resume point is stored, so the next apply continues from this page.";
      console.warn(
        (r.stoppedBecause === "disturbed"
          ? "  the pass reached the end of the mailbox but did NOT finish it. The marker is\n" +
            "  NOT written.\n"
          : `  the pass stopped at the page cap (${SENSITIVE_RESCREEN_BATCH} rows/page). The marker\n` +
            "  is NOT written.\n") + next,
      );
    }
  }

  console.log(dryRun
    ? "\nNOTHING WAS WRITTEN. Every page above ran for real and was rolled back, so these are\n" +
      "the numbers the same command with `apply` will produce against an unchanged mailbox.\n"
    : "\nNothing has moved on the server yet. The worker's reconcile pass applies the desired\n" +
      "folder on its next cycle — check /health on the worker if the Ohbox does not change.\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "help" || args.command === "--help") { console.log(USAGE); return 0; }
  if (args.command !== "plan" && args.command !== "apply") {
    console.error(`unknown command ${JSON.stringify(args.command)}\n${USAGE}`);
    return 2;
  }
  const url = process.env.DATABASE_URL_SESSION?.trim();
  if (!url) throw new Error("missing required env var DATABASE_URL_SESSION (see ~/.ohmail/secrets.env)");

  const owned = makeOwnedDb(url);
  try {
    // The ONLY difference between the two commands, and it is deliberately this small.
    await run(owned.db as unknown as Db, args, args.command === "plan");
    return 0;
  } finally {
    await owned.close();
  }
}

/**
 * Run ONLY when executed directly — `pathToFileURL` and not `` `file://${process.argv[1]}` ``,
 * because the latter is false for any path needing percent-encoding and this checkout lives under
 * a directory with a SPACE. `invite-cli.ts` carries the same note and the same reason.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (err: unknown) => {
      // The message only. A stack from a driver error can quote the connection string.
      console.error(`rescreen: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

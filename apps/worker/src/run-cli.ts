import { eq } from "drizzle-orm";
import { mailboxes, type Tx } from "@trafficflow/db";
import type { ImapAdapter } from "@trafficflow/core/adapters/imap";
import {
  CLOUD_DISPLAY_NAME, LeaseUnavailableError, OrganizerStandDownError, acquireLeasePermit,
  assertNoLiveTwin, mailboxHasRequestKey, resolveCloudInstallId, type LeasePermit,
} from "./lease.js";

/**
 * WHAT THE ONE-OFF MAILBOX RUNNERS SHARE — the scaffold around a bounded operator command.
 *
 * `run-junk-sweep.ts` and `run-redacted-restore.ts` do different work on one named mailbox and
 * reach it identically: parse the flags, read the mailbox row, refuse a mailbox that has been
 * asked to stop being organized here, and take the organizer lease before the first write. All of
 * it stood twice. Each runner keeps its own verb and its own closing sentence, which is all an
 * operator reads; a shared test holds both to the words the runners printed
 * before this module existed.
 */

/** `--flag` and `--opt value` off a runner's argv — the whole of what these commands parse. */
export function cliArgs(argv: string[]): {
  flag: (n: string) => boolean;
  opt: (n: string) => string | null;
} {
  return {
    flag: (n) => argv.includes(`--${n}`),
    opt: (n) => {
      const i = argv.indexOf(`--${n}`);
      return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : null;
    },
  };
}

/** The mailbox a runner was pointed at, as much of it as one of these commands needs. */
export interface RunnerMailbox {
  id: string;
  accountId: string;
  address: string;
  releaseRequestedAt: Date | null;
}

/**
 * "STOP ORGANIZING THIS MAILBOX" IS A REFUSAL FOR THESE TOOLS TOO (mail 0088). The lease gate
 * cannot answer it: a pending release leaves the row `organizer` on purpose — the claim is in the
 * customer's IMAP folder and expunging it belongs to the process holding that connection — so
 * every lease-shaped check passes and a runner would take the permit, renew the very claim the
 * person asked removed, and move their mail. REFUSED rather than honoured, on the reconcile
 * backstop's reasoning: releasing means expunging a claim, writing the row and closing
 * appointments, and a second copy of that sequence is a second answer to what stopping means.
 */
export const RELEASE_REQUESTED_REFUSAL = (mailboxId: string): string =>
  `mailbox ${mailboxId} has been asked to stop being organized here — refusing to write to it. `
  + "The organizer's next pass releases the claim; run this again afterwards if it is still needed.";

/**
 * The mailbox row, or the reason this command may not touch it. `null` ⇒ no such mailbox;
 * a string ⇒ the sentence to print before exiting. The caller closes its own handle.
 */
export async function readRunnerMailbox(
  db: Tx, mailboxId: string,
): Promise<{ mailbox: RunnerMailbox } | { refusal: string } | null> {
  const [mb] = await db.select({
    id: mailboxes.id, accountId: mailboxes.accountId, address: mailboxes.address,
    releaseRequestedAt: mailboxes.releaseRequestedAt,
  }).from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
  if (!mb) return null;
  if (mb.releaseRequestedAt !== null) return { refusal: RELEASE_REQUESTED_REFUSAL(mailboxId) };
  return { mailbox: mb as RunnerMailbox };
}

/** What an operator reads when a runner declines: its verb, and what it leaves behind. */
export interface RunnerVoice {
  /** The word after "refusing to" — `sweep`, `restore`. */
  verb: string;
  /** The closing sentence, which is the runner's own account of what did not happen. */
  nothingDone: string;
}

/** The stand-down sentence, exactly as each runner printed it before this module existed. */
export function standDownRefusal(voice: RunnerVoice, err: OrganizerStandDownError): string {
  return `refusing to ${voice.verb}: ${err.message}\n`
    + `  held by: ${err.heldBy ?? "(unnamed)"} — ${err.state === "held" ? "still renewing" : "stopped, but not ours to take"}\n`
    + `  reason:  ${err.reason}\n`
    + voice.nothingDone;
}

/** NOT a stand-down: our problem or the connection's, never evidence about who holds the mailbox. */
export function leaseUnreadableRefusal(voice: RunnerVoice, err: LeaseUnavailableError): string {
  return `refusing to ${voice.verb}: the organizer lease could not be read — ${err.message}`;
}

/**
 * THE ORGANIZER LEASE, TAKEN BEFORE THE FIRST WRITE. Exactly one active organizer per mailbox is
 * enforced in `ohmail/_meta`, so a runner that writes without one has both organizers filing the
 * same mail. `assertNoLiveTwin` goes FIRST and the gate cannot replace it: a runner shares the
 * worker's install id and arms no nonce, which tells `decideLease` to adopt the worker's own fresh
 * claim as this process's and expunge it. Both refusals set an exit code and RETHROW, so the
 * caller's `finally` closes what it opened and nothing reads a refusal as a completed run.
 */
export async function takeRunnerLease(opts: {
  adapter: ImapAdapter;
  mailboxId: string;
  mailbox: Pick<RunnerMailbox, "address">;
  auth: Parameters<typeof mailboxHasRequestKey>[0]["auth"];
  env: NodeJS.ProcessEnv;
  voice: RunnerVoice;
  log: (line: string) => void;
}): Promise<LeasePermit> {
  try {
    await assertNoLiveTwin({
      adapter: opts.adapter,
      installId: resolveCloudInstallId(opts.env),
      now: new Date(),
    });

    return await acquireLeasePermit({
      adapter: opts.adapter,
      mailboxId: opts.mailboxId,
      // The SAME set the worker and the backstop advertise: this command RENEWS that shared claim,
      // so a narrower set here would make `requests` blink out for readers for the length of a run.
      hasRequestKey: mailboxHasRequestKey({ auth: opts.auth, address: opts.mailbox.address }),
      self: {
        // The SAME identity the always-on worker and the reconcile backstop claim with. A
        // per-process id would read as a new organizer arriving and stand the worker down.
        installId: resolveCloudInstallId(opts.env),
        kind: "cloud",
        displayName: CLOUD_DISPLAY_NAME,
        // `null` stands, and only because of the check above — a fresh process trusts its own
        // install id exactly once, which is what lets a command repair a stale Cloud claim.
        lastNonce: null,
      },
      takeover: null,
      log: (event, detail) => { opts.log(`${event} ${JSON.stringify(detail)}`); },
    });
  } catch (err) {
    if (err instanceof OrganizerStandDownError) {
      console.error(standDownRefusal(opts.voice, err));
      process.exitCode = 3;
    } else if (err instanceof LeaseUnavailableError) {
      console.error(leaseUnreadableRefusal(opts.voice, err));
      process.exitCode = 4;
    }
    throw err;
  }
}

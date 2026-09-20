import { eq } from "drizzle-orm";
import { mailboxes, type Tx } from "@trafficflow/db";

/**
 * WHAT EVERY ONE-OFF OPERATOR RUNNER SHARES. The `run-*.ts` tools are separate commands with
 * separate passes, but the door each opens onto a customer's mailbox is one door, and it was
 * copied per file until 0.21 — so a fix to one copy left the other one writing.
 */

/** `--name` present. */
export function cliFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** `--name <value>`, or `null` when absent or immediately followed by another flag. */
export function cliOpt(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : null;
}

/** The three fields every runner reads off the mailbox it was pointed at. */
export interface OperatorMailbox { id: string; accountId: string; address: string }

/**
 * THE MAILBOX A ONE-OFF TOOL MAY WRITE TO — or the sentence to print before exiting 2.
 *
 * "STOP ORGANIZING THIS MAILBOX" IS A REFUSAL FOR THESE TOOLS TOO (mail 0088). The lease gate
 * cannot answer it: a pending release leaves the row `organizer` on purpose (the claim is in the
 * customer's IMAP folder and expunging it belongs to the process holding that connection), so
 * every lease-shaped check passes and a runner would take the permit, renew the very claim the
 * person asked removed, and move their mail. REFUSED rather than honoured, on the reconcile
 * backstop's reasoning: releasing means expunging a claim, writing the row and closing
 * appointments, and a second copy of that sequence is a second answer to what stopping means.
 * The always-on gate performs it; these tools decline to act past a request they can see.
 *
 * A REFUSAL IS RETURNED, NOT THROWN AND NOT EXITED: the caller owns the database handle it must
 * close before it exits, and a helper that called `process.exit` would leave that connection to
 * the runtime.
 */
export async function readOperatorMailbox(
  db: Tx, mailboxId: string,
): Promise<{ mailbox: OperatorMailbox } | { refusal: string }> {
  const [mb] = await db.select({
    id: mailboxes.id, accountId: mailboxes.accountId, address: mailboxes.address,
    releaseRequestedAt: mailboxes.releaseRequestedAt,
  })
    .from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);

  if (!mb) return { refusal: `no mailbox ${mailboxId}` };
  if (mb.releaseRequestedAt !== null) {
    return {
      refusal:
        `mailbox ${mailboxId} has been asked to stop being organized here — refusing to write to it. `
        + "The organizer's next pass releases the claim; run this again afterwards if it is still needed.",
    };
  }
  return { mailbox: { id: mb.id, accountId: mb.accountId, address: mb.address } };
}

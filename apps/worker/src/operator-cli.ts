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
 * "Stop organizing this mailbox" is a refusal for these tools too (mail 0088), and the LEASE
 * cannot answer it: a pending release leaves the row `organizer` on purpose, so every
 * lease-shaped check passes and a runner would renew the claim the person asked removed.
 *
 * The refusal is RETURNED, never thrown or exited: the caller owns the database handle it must
 * close first.
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

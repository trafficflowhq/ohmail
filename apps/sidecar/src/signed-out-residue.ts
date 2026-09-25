import { and, eq } from "drizzle-orm";
import { mailboxCredentials, mailboxes } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { signedOutMetaOf } from "@trafficflow/services/mail";
import type { LocalDb } from "./db.js";

/*
 * WHAT AN EARLIER BUILD'S SIGN-OUT LEFT BEHIND. Before mail 0127 a sign-out removed the `imap`
 * credential row only, so a mailbox with an outgoing server kept its `smtp` row — the password,
 * encrypted, beside this install's key — for as long as nobody signed in again. A mailbox with no
 * `imap` row is signed out whatever build did it; every other row it holds is that residue.
 */

/**
 * Remove the residue, moving its non-secret half into `signed_out_meta` FIRST, in the same
 * transaction and through the one allow-list builder, so "Sign in again" can still name the
 * outgoing server and login. A row's coordinates win over what the column already kept: a row
 * that exists was written after that sign-out. False once done, so a mailbox is named once. Run
 * at the start, before any route serves, so nothing can seal a row between the read and the write.
 */
export async function removeSignedOutResidue(
  db: LocalDb, accountId: string,
): Promise<Array<{ mailboxId: string; count: number }>> {
  const held = await db.select({ mailboxId: mailboxCredentials.mailboxId, transport: mailboxCredentials.transport })
    .from(mailboxCredentials)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxCredentials.mailboxId))
    .where(eq(mailboxes.accountId, accountId));
  const incoming = new Set(held.filter((r) => r.transport === "imap").map((r) => r.mailboxId));
  const candidates = [...new Set(held.map((r) => r.mailboxId))].filter((id) => !incoming.has(id));
  /* `count`: rows removed — each one carried an encrypted password. */
  const out: Array<{ mailboxId: string; count: number }> = [];
  for (const mailboxId of candidates) {
    const removed = await db.transaction(async (tx) => {
      const [mb] = await dialect(tx).forUpdate(
        tx.select({ kept: mailboxes.signedOutMeta }).from(mailboxes)
          .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId))));
      const rows = await tx.select({ transport: mailboxCredentials.transport, meta: mailboxCredentials.meta })
        .from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mailboxId));
      const column = (mb?.kept ?? {}) as Record<string, unknown>;
      await tx.update(mailboxes).set({
        signedOutMeta: signedOutMetaOf([
          ...rows,
          { transport: "imap", meta: column.imap },
          { transport: "smtp", meta: column.smtp },
        ]),
      }).where(eq(mailboxes.id, mailboxId));
      await tx.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mailboxId));
      return rows.length;
    }) as number;
    if (removed > 0) out.push({ mailboxId, count: removed });
  }
  return out;
}

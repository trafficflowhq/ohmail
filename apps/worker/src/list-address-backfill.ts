import { and, eq, sql } from "drizzle-orm";
import {
  accountPass, fencedAccountWrite, LIST_ADDRESS_CHUNK, messageBodies, messages, notFailedAuthSql, readPassProgress,
  writePassProgress, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
/* The mail leaf, never the barrel: the local engines bundle this pass, and a value import from the
   barrel carries the model half into them (the engine census refuses the build). */
import { listPostAddresses, silentLogger, type Logger } from "@trafficflow/core/mail";

/**
 * THE LIST-ADDRESS BACKFILL (mail 0150) — once per account on each store: every stored message's
 * `List-Post` that did not fail authentication, read through the one parser and recorded through
 * ingest's own door, then the stamp, LAST. Sound as "once": nothing deletes a list address, and mail
 * stored after the stamp is ingest's to record. Counts only in the log; it moves no mail.
 */

export interface ListAddressBackfillDeps {
  accountId: string;
  log?: Logger;
  now?: () => Date;
}

export interface ListAddressBackfillResult {
  /** False ⇒ the account was already stamped and nothing was read. */
  ran: boolean;
  /** Distinct `List-Post` values read. */
  values: number;
  /** Distinct list addresses recorded. */
  addresses: number;
}

export async function listAddressBackfillPass(
  db: Tx, deps: ListAddressBackfillDeps,
): Promise<ListAddressBackfillResult> {
  const { accountId } = deps;
  const log = deps.log ?? silentLogger;
  const pass = accountPass("list_address_backfill", accountId);
  if ((await readPassProgress(db, pass)).doneAt !== null) return { ran: false, values: 0, addresses: 0 };

  const d = dialect(db);
  const rows = await db.selectDistinct({
    // Aliased: the device store returns rows positionally and refuses two same-named columns.
    value: sql<unknown>`${d.jsonGet(messageBodies.headers, "list-post")}`.as("lb_list_post"),
  }).from(messages)
    .innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(eq(messages.accountId, accountId), d.jsonHasAny(messageBodies.headers, ["list-post"]),
      notFailedAuthSql(messages)));
  const found = new Set<string>();
  for (const r of rows) {
    for (const a of listPostAddresses({ "list-post": headerLines(r.value) })) found.add(a);
  }
  const addresses = [...found].sort();
  for (let at = 0; at < addresses.length; at += LIST_ADDRESS_CHUNK) {
    const chunk = addresses.slice(at, at + LIST_ADDRESS_CHUNK);
    await fencedAccountWrite(db, { accountId }, (tx) => makeDrizzleRepo(tx as never).recordListAddresses(accountId, chunk));
  }
  const now = deps.now?.() ?? new Date();
  await fencedAccountWrite(db, { accountId }, async (tx) => {
    await writePassProgress(tx as unknown as Tx, pass, { doneAt: now }, { now });
  });
  log.info("list_address_backfill", { accountId, scanned: rows.length, written: addresses.length });
  return { ran: true, values: rows.length, addresses: addresses.length };
}

/** A stored header's values — a JSON array on the server, JSON text on the device store. */
function headerLines(value: unknown): string[] {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return [v as string]; }
  }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

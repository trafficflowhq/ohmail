/**
 * The operator half of the 0.25.9 repair: a Screener rule a person moved to the Ohbox before 0.25.9
 * becomes theirs (`@trafficflow/db#applyInferredPressRepair`). Run `plan` first, read-only, then
 * `apply`, then `plan` again, which reads 0. Metadata only: it moves no mail and opens no IMAP.
 * Prints account and rule ids and counts, never an address. `OHMAIL_INFERRED_PRESS_REPAIR_DB_URL`
 * is required and its OWN variable, session-mode: an ambient URL can name a retired database.
 */
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { applyInferredPressRepair, planInferredPressRepair, rules, type Tx } from "@trafficflow/db";
import { bridgeDb, bridgeTx } from "./context.js";

const USAGE = `
ohmail inferred-press repair (no migration)

  plan    READ-ONLY. Per account: the Screener rules a person moved to the Ohbox that are still inferred.
  apply   Make those rules the person's (provenance manual). Idempotent: a re-run plans 0.

  OHMAIL_INFERRED_PRESS_REPAIR_DB_URL must be set to a SESSION-mode URL, explicitly.
`;

/** The accounts holding a candidate at all — a promoted rule at the Ohbox. */
async function accountsToRead(db: Tx): Promise<string[]> {
  const rows = await db.selectDistinct({ a: rules.accountId }).from(rules)
    .where(and(eq(rules.provenance, "promoted"), eq(rules.destination, "INBOX")));
  return rows.map((r) => r.a).sort();
}

export async function planAll(db: Tx, out: (line: string) => void): Promise<number> {
  let total = 0;
  for (const accountId of await accountsToRead(db)) {
    const { ruleIds } = await planInferredPressRepair(db, accountId);
    if (ruleIds.length === 0) continue;
    total += ruleIds.length;
    out(`account ${accountId}  rules ${ruleIds.length}  ${ruleIds.join(" ")}`);
  }
  out(`TOTAL  rules ${total}`);
  return total;
}

export async function applyAll(db: Tx, out: (line: string) => void): Promise<number> {
  let written = 0;
  let accounts = 0;
  for (const accountId of await accountsToRead(db)) {
    const r = await applyInferredPressRepair(db, accountId);
    if (r.written === 0) continue;
    accounts++;
    written += r.written;
    out(`account ${accountId}  written ${r.written}`);
  }
  out(`TOTAL  written ${written} in ${accounts} account(s). Re-run plan: it should read TOTAL  rules 0.`);
  return written;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help") { console.log(USAGE); return 0; }
  if ((command !== "plan" && command !== "apply") || argv.length > 1) {
    console.error(`unknown arguments ${JSON.stringify(argv)}\n${USAGE}`);
    return 2;
  }
  const url = process.env.OHMAIL_INFERRED_PRESS_REPAIR_DB_URL?.trim();
  if (!url) {
    throw new Error("missing required env var OHMAIL_INFERRED_PRESS_REPAIR_DB_URL. Set it to a "
      + "SESSION-mode connection string explicitly — this repair never inherits an ambient DATABASE_URL.");
  }
  const owned = makeOwnedDb(url);
  try {
    const db = bridgeTx(bridgeDb(owned.db));
    if (command === "plan") await planAll(db, (l) => console.log(l));
    else await applyAll(db, (l) => console.log(l));
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
      console.error(`inferred-press-repair: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

/**
 * ONE-OFF RUNNER for the KEK re-wrap pass (`@trafficflow/db/cloud` → `kek-rewrap.ts`). DB-ONLY, dry-run by
 * default. It moves every stored envelope — IMAP/SMTP/Graph credentials, TOTP secrets, the staff second
 * factor, live PKCE verifiers, the OAuth client secret — onto the host's CURRENT KEK version, so an old
 * version can be retired. It never opens IMAP. Rotation is three steps: (1) add `TF_KEK_V{n+1}` to BOTH
 * hosts and redeploy; (2) run with `--apply` until it reports `0 outstanding`; (3) run with no flags and
 * read the census — only when nothing references V<n> may V<n> be removed. Safe to re-run and kill:
 * resumability IS `key_version` (a finished row leaves the candidate query); nothing is written until the
 * new envelope has been decrypted back and compared in the same transaction, and a value that will not
 * decrypt is reported and SKIPPED. A ring missing a historical version reports those rows `no_kek_for_version`. */
import { makeOwnedDb, runKekRewrap, formatCensus, kekRewrapCensus } from "@trafficflow/db/cloud";
import { type Tx } from "@trafficflow/db";
import { createLogger, keyProviderFromEnv } from "@trafficflow/core";

const apply = process.argv.slice(2).includes("--apply");
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }

// Throws when no `TF_KEK_V*` is configured, which is the correct end for this pass: a re-wrap
// with no keys would report every row as undecryptable and look like a catastrophe.
const keyProvider = keyProviderFromEnv();

const owned = makeOwnedDb(dbUrl);
const log = createLogger({ service: "kek-rewrap" });

const r = await runKekRewrap({
  db: owned.db as unknown as Tx,
  keyProvider,
  apply,
  // Failures are logged as they happen rather than only in the summary: a pass over thousands of
  // rows that dies on the way should still have named what it could not do. Labels and reasons
  // only — `RewrapEvent` carries no value, by construction.
  onEvent: (e) => {
    if (e.kind === "failed") {
      log.error("kek re-wrap: row skipped", {
        site: e.site, row: e.row, reason: e.reason, keyVersion: e.keyVersion,
      });
    }
  },
});

console.log(`KEK re-wrap — target V${r.target}, ${apply ? "APPLY" : "DRY RUN"}`);
console.log("Before:");
for (const line of formatCensus(r.census)) console.log(line);

if (!apply) {
  console.log(r.census.outstanding === 0
    ? "Nothing to do. Every stored envelope is already on the current version."
    : `Re-run with --apply to re-wrap ${r.census.outstanding} row(s).`);
} else {
  console.log(`Re-wrapped ${r.rewrapped}` +
    `${r.raced > 0 ? `, ${r.raced} already current when locked (the live path got there first)` : ""}` +
    `${r.failed > 0 ? `, ${r.failed} SKIPPED and unchanged — see the log lines above` : ""}` +
    `${r.truncated ? " — batch limit reached, RUN AGAIN" : ""}.`);
  // The after-census is the answer step 3 of the procedure reads, and taking it here means the
  // operator does not have to trust the counts above to know whether a version can be retired.
  const after = await kekRewrapCensus(owned.db as unknown as Tx, r.target);
  console.log("After:");
  for (const line of formatCensus(after)) console.log(line);
  if (after.outstanding === 0 && r.failed === 0) {
    console.log(`Nothing references a version below V${r.target}. ` +
      `Versions below V${r.target} may now be removed from BOTH hosts and from secret history.`);
  } else {
    console.log("Do NOT remove any KEK version yet — rows below the target remain.");
  }
}

await owned.close();
// A pass that skipped rows finished, and a zero exit is how a wrapper decides nothing needs
// doing. Truncation is the same shape: the run was correct and another is owed.
if (r.failed > 0 || r.truncated) process.exitCode = 1;

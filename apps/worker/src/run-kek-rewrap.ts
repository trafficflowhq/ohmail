/**
 * ONE-OFF RUNNER for the KEK re-wrap pass (`@trafficflow/db/cloud` → `kek-rewrap.ts`).
 *
 * DB-ONLY and dry-run by default. It moves every stored envelope — IMAP/SMTP/Graph credentials,
 * TOTP secrets, the staff second factor, live PKCE verifiers and the OAuth client secret — onto
 * the host's CURRENT KEK version, so an old version can actually be retired. It never opens IMAP.
 *
 * ── THE PROCEDURE THIS RUNNER EXISTS FOR ───────────────────────────────────────────────────
 *
 * Incident rotation is three steps, and this runner is the
 * middle one and the instrument for the third:
 *
 *   1. add `TF_KEK_V{n+1}` to BOTH hosts (API and worker) and redeploy — new writes land on it;
 *   2. run this with `--apply` until it reports `0 outstanding`;
 *   3. run it again with no flags and read the census — only when it says nothing references
 *      V<n> may V<n> be removed from the hosts and from secret history.
 *
 * Step 3 is a plain read and is the whole reason step 1 is not already a revocation.
 *
 * ── SAFE TO RE-RUN, SAFE TO KILL ───────────────────────────────────────────────────────────
 *
 * Resumability is `key_version` itself: a finished row no longer matches the candidate query, so
 * a killed run resumes by being run again and a run over a finished database is two SELECTs per
 * site. Nothing is written until the new envelope has been decrypted back and compared, inside
 * the same transaction as the write. A value that will not decrypt is reported and SKIPPED —
 * never blanked, never dropped.
 *
 *   TF_DB_URL=… tsx apps/worker/src/run-kek-rewrap.ts            # census only, writes nothing
 *   TF_DB_URL=… tsx apps/worker/src/run-kek-rewrap.ts --apply    # re-wrap
 *
 * `TF_KEK_V1…Vn` must be set exactly as they are on the hosts: the pass can only re-wrap what it
 * can decrypt, and a ring missing a historical version reports those rows as
 * `no_kek_for_version` and leaves them alone.
 */
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

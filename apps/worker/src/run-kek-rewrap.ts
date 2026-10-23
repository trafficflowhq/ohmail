/**
 * ONE-OFF RUNNER for the KEK re-wrap pass (`@trafficflow/db/cloud` → `kek-rewrap.ts`). DB-ONLY, dry-run by
 * default. It moves every stored envelope — IMAP/SMTP/Graph credentials, TOTP secrets, the staff second
 * factor, live PKCE verifiers, the OAuth client secret — onto the host's CURRENT KEK version, so an old
 * version can be retired. It never opens IMAP. Rotation is four steps: (1) add `TF_KEK_V{n+1}` to BOTH
 * hosts and redeploy; (2) run with `--apply` until it reports `0 outstanding`; (3) run with no flags and
 * read the census; (4) retire: the last lines name the exact change, `TF_KEK_RETIRED` and the versions to
 * delete, made on BOTH hosts in one deploy each (`packages/core/src/crypto.ts`). Run it with the hosts'
 * own ring: the second line prints this run's ring fingerprint, which must equal the `kek.fingerprint`
 * both hosts' `/health` publish, or the pass seals rows under a key the hosts do not hold. Safe to re-run
 * and kill: resumability IS `key_version` (a finished row leaves the candidate query); nothing is written
 * until the new envelope has been decrypted back and compared in the same transaction, and a value that
 * will not decrypt is reported and SKIPPED. A ring missing a historical version reports those rows
 * `no_kek_for_version`. The last line is one machine-readable summary for a wrapper. */
import { makeOwnedDb, runKekRewrap, formatCensus, formatRetireStep, kekRewrapCensus } from "@trafficflow/db/cloud";
import { type Tx } from "@trafficflow/db";
import { keyProviderFromEnv, kekEnvIdentity, kekRetiredThroughFromEnv } from "@trafficflow/core";

const apply = process.argv.slice(2).includes("--apply");
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }

// Throws when no `TF_KEK_V*` is configured, which is the correct end for this pass: a re-wrap
// with no keys would report every row as undecryptable and look like a catastrophe.
const keyProvider = keyProviderFromEnv();
// Defined, because the provider above loaded: the same loader, the same environment.
const ring = kekEnvIdentity()!;
const retiredThrough = kekRetiredThroughFromEnv();

const owned = makeOwnedDb(dbUrl);

console.log(`KEK re-wrap — target V${keyProvider.currentKeyVersion()}, ${apply ? "APPLY" : "DRY RUN"}`);
console.log(`Ring: ${ring.count} version(s) loaded, active V${ring.active}, fingerprint ${ring.fingerprint}` +
  `${retiredThrough > 0 ? `, versions up to V${retiredThrough} retired (TF_KEK_RETIRED=${retiredThrough})` : ""}` +
  " — both hosts' /health kek must read the same.");

const r = await runKekRewrap({
  db: owned.db as unknown as Tx,
  keyProvider,
  apply,
  // A skipped row is printed as it happens, not only counted in the summary: a pass over thousands of
  // rows that dies on the way should still have named what it could not do. Site, row label, version
  // and reason only — `RewrapEvent` carries no value, by construction, and a row whose key is itself a
  // secret is labelled by a digest. (Plain lines: the structured logger keeps only fields on its census.)
  onEvent: (e) => {
    if (e.kind === "failed") {
      console.log(`  SKIPPED ${e.site} ${e.row} version ${e.keyVersion < 0 ? "unread" : e.keyVersion}: ${e.reason}`);
    }
  },
});

console.log("Before:");
for (const line of formatCensus(r.census)) console.log(line);

let final = r.census;
if (!apply) {
  console.log(r.census.outstanding === 0
    ? "Nothing to do. Every stored envelope is already on the current version."
    : `Re-run with --apply to re-wrap ${r.census.outstanding} row(s).`);
} else {
  console.log(`Re-wrapped ${r.rewrapped}` +
    `${r.raced > 0 ? `, ${r.raced} already current when locked (the live path got there first)` : ""}` +
    `${r.failed > 0 ? `, ${r.failed} SKIPPED and unchanged — see the SKIPPED lines above` : ""}` +
    `${r.truncated ? " — batch limit reached, RUN AGAIN" : ""}.`);
  // The after-census is the answer step 3 of the procedure reads, and taking it here means the
  // operator does not have to trust the counts above to know whether a version can be retired.
  final = await kekRewrapCensus(owned.db as unknown as Tx, r.target);
  console.log("After:");
  for (const line of formatCensus(final)) console.log(line);
}
for (const line of formatRetireStep({ census: final, retiredThrough, failed: r.failed })) console.log(line);
console.log(`KEK_REWRAP ${apply ? "apply" : "dry"} target=V${r.target} outstanding=${final.outstanding} ` +
  `failed=${r.failed} truncated=${r.truncated ? 1 : 0} fingerprint=${ring.fingerprint}`);

await owned.close();
// A pass that skipped rows finished, and a zero exit is how a wrapper decides nothing needs
// doing. Truncation is the same shape: the run was correct and another is owed.
if (r.failed > 0 || r.truncated) process.exitCode = 1;

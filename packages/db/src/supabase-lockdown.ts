/**
 * Close the Supabase Data API on an ohmail-hosted database — grants first, endpoint second,
 * then prove it from OUTSIDE with the same public key an attacker would use.
 *
 * Rationale, measurements and the reason RLS is the wrong tool live in the header of
 * `scripts/supabase-lockdown.sql`. This file is the runner, and it lives in `packages/db` for
 * the same reason `provision-staff-role.ts` does: it must import `transactionPoolerReason`
 * rather than re-implement it (twice already, a copied predicate rotted alone).
 *
 * ── WHY THE EXTERNAL RE-PROBE IS THE POINT ──────────────────────────────────────────────
 *
 * The in-database postcondition proves the ACLs are gone. It does NOT prove the product is
 * safe, and treating it as though it did is exactly the mistake that let this ship: the
 * staff-role pre-flight and the `staff-grants.ts` boot attestation both stayed green through all 443
 * privileges, because one tests `grantee = 0` and the other measures `ohmail_admin`. Neither
 * can see a named role called `anon`.
 *
 * So the verdict here is a live HTTP request to `https://<ref>.supabase.co/rest/v1/<table>`
 * carrying the anon key. That is the actual threat model — a public key, an internet-facing
 * endpoint, no VPN, no session. **A 200 with `[]` is a FAILURE, not a pass**: an empty array
 * means the SELECT succeeded against an empty table, and the tables are empty only until
 * cutover. A refusal is 401.
 *
 * ── --prove ─────────────────────────────────────────────────────────────────────────────
 *
 * A guard nobody has watched fail is not evidence. After a lockdown the census
 * reads zero, and a census that reads zero because it is broken looks identical. `--prove`
 * creates a scratch table, grants it to `anon`, re-runs the census, and requires it to go RED —
 * then drops the table and requires it to go clean again. It runs against the real database
 * because a mutation proven somewhere else proves nothing here.
 *
 * Usage (all three envs required for the API half; the SQL half needs only the URL):
 *   SUPABASE_DB_URL=... pnpm --filter @trafficflow/db supabase:lockdown
 *   SUPABASE_DB_URL=... SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... \
 *     pnpm --filter @trafficflow/db supabase:lockdown -- --apply --close-api --prove
 */
import { argv, env } from "node:process";
import postgres from "postgres";
import { transactionPoolerReason } from "./session-url.js";
import {
  HOST_ROLES, applySupabaseLockdown, lockdownCensus, supabaseHostRoles,
} from "./supabase-lockdown-core.js";

const APPLY = argv.includes("--apply");
const CLOSE_API = argv.includes("--close-api");
const PROVE = argv.includes("--prove");

/**
 * Probed by name from outside. Deliberately the worst cases rather than a sample: message
 * content (the very thing the isolation rules protect), envelope-encrypted credentials (a
 * decryption target), identity,
 * and the money table. If any of these answers 200 the lockdown did not work, whatever the
 * database says.
 */
const PROBE_TABLES = [
  "messages",
  "message_bodies",
  "mailbox_credentials",
  "users",
  "accounts",
  "credit_ledger",
];

type Sql = ReturnType<typeof postgres>;

/**
 * The census, the statement batch and the role detection all live in
 * `supabase-lockdown-core.ts` now, shared with `setupProdDatabase` — which runs the grant half
 * on every provisioning pass and fails closed on this same census. This file keeps what only an
 * operator ceremony can do: the Management-API `--close-api` half, the external anon-key
 * re-probe, and `--prove`.
 */

/**
 * What does a table created RIGHT NOW, by this role, actually inherit?
 *
 * This is the only question that matters about default privileges, and the only one answered by
 * measurement instead of by reasoning about which grantor's rule fires for whom. Before the
 * lockdown it returned 24 privileges on this project; after, it must return none.
 */
async function newTableInherits(sql: Sql): Promise<string[]> {
  await sql.unsafe(`CREATE TABLE public._lockdown_inherit_probe (id int)`);
  try {
    const rows = await sql<Array<{ grantee: string; privilege_type: string }>>`
      SELECT a.grantee::regrole::text AS grantee, a.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace,
             LATERAL aclexplode(c.relacl) a
       WHERE n.nspname = 'public'
         AND c.relname = '_lockdown_inherit_probe'
         AND a.grantee::regrole::text = ANY(${[...HOST_ROLES]})`;
    return rows.map((r) => `${r.grantee}:${r.privilege_type}`);
  } finally {
    await sql.unsafe(`DROP TABLE IF EXISTS public._lockdown_inherit_probe`);
  }
}

/**
 * The external verdict. Returns the tables that ANSWERED — i.e. the ones still exposed.
 *
 * A network error is NOT treated as a pass. "The request failed so we must be safe" is how a
 * DNS hiccup becomes a security sign-off; an unreachable probe is reported as UNKNOWN and the
 * caller fails on it.
 */
async function probeRest(
  ref: string,
  anonKey: string,
): Promise<{ exposed: string[]; unknown: string[] }> {
  const exposed: string[] = [];
  const unknown: string[] = [];
  for (const t of PROBE_TABLES) {
    try {
      const res = await fetch(`https://${ref}.supabase.co/rest/v1/${t}?select=*&limit=1`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      });
      // 200 is the only outcome that means "the SELECT ran". 401/403/404 all mean refused or
      // not routed, which is what we want. An empty body does not soften a 200.
      if (res.status === 200) exposed.push(`${t} (200)`);
    } catch (e) {
      unknown.push(`${t} (${(e as Error).message})`);
    }
  }
  return { exposed, unknown };
}

async function main(): Promise<number> {
  const url = (env.SUPABASE_DB_URL ?? "").trim();
  if (!url) {
    console.error("REFUSING: SUPABASE_DB_URL is required (the SESSION url, port 5432).");
    return 2;
  }
  const pooler = transactionPoolerReason(url);
  if (pooler) {
    console.error(`REFUSING: DDL must not run on a transaction pooler — ${pooler}`);
    return 2;
  }

  const notices: string[] = [];
  const sql = postgres(url, {
    ssl: "require",
    max: 1,
    // §2 of the SQL reports an unrevokable default-privilege rule as a WARNING and lets the
    // postcondition decide. An operator who cannot see the warning cannot tell which it was.
    onnotice: (n) => notices.push(`${n.severity}: ${n.message}`),
  });

  let failed = false;
  try {
    const who = (await sql<Array<{ db: string; usr: string }>>`
      SELECT current_database() AS db, current_user AS usr`)[0]!;
    console.log(`database : ${who.db}\nconnected: ${who.usr}\n`);

    // Detect BEFORE touching anything: a REVOKE naming an absent role is an error, so on a
    // host with none of the roles (a plain Postgres) there is nothing to close and running the
    // batch would only die confusingly partway.
    const roles = await supabaseHostRoles(sql);
    if (roles.length === 0) {
      console.error(
        "REFUSING: no anon/authenticated/service_role roles on this host — not a Supabase-shaped " +
        "database, so there is no Data API grant to close. (setupProdDatabase reaches the same " +
        "verdict and skips.)",
      );
      return 2;
    }
    console.log(`host roles: ${roles.join(", ")}\n`);

    const before = await lockdownCensus(sql);
    console.log(
      `before   : ${before.grants} privileges to anon/authenticated/service_role in public, ` +
      `${before.rules} reachable default-privilege rules, ${before.residual} residual` +
      `${before.detail ? ` (e.g. ${before.detail})` : ""}`,
    );
    // The red half of the mutation, recorded on the way in rather than asserted after the fact.
    const inheritedBefore = await newTableInherits(sql);
    console.log(`before   : a new table inherits ${inheritedBefore.length} anon-class privileges`);

    if (!APPLY) {
      console.log("\nDRY RUN — nothing written. Re-run with --apply.");
      return 0;
    }

    // The shared batch — `.simple()` inside, because it carries its own BEGIN/COMMIT. Scoped to
    // the roles that exist, which on any real Supabase is all three.
    await applySupabaseLockdown(sql, roles);
    for (const n of notices) console.log(`  ${n}`);

    const after = await lockdownCensus(sql);
    console.log(
      `after    : ${after.grants} privileges, ${after.rules} reachable rules, ` +
      `${after.residual} residual (unreachable grantor — see the SQL header)`,
    );
    if (after.grants !== 0 || after.rules !== 0) {
      console.error("FAILED: the lockdown did not reach zero.");
      failed = true;
    }

    // The green half. Paired with `inheritedBefore` this is a before/after mutation on the real
    // database: the same probe that inherited a full grant now inherits nothing.
    const inheritedAfter = await newTableInherits(sql);
    console.log(
      `after    : a new table inherits ${inheritedAfter.length} anon-class privileges ` +
      `(was ${inheritedBefore.length})`,
    );
    if (inheritedAfter.length !== 0) {
      console.error(`FAILED: a newly created table STILL inherits ${inheritedAfter.join(", ")}`);
      failed = true;
    } else if (inheritedBefore.length === 0) {
      // Both zero proves nothing — the probe may simply not work. Say so rather than bank it.
      console.log(
        "  note: the before-probe was already 0, so this run did not demonstrate the change.",
      );
    }

    // ── the guard is watched failing, on this database, against this census ────────────────
    if (PROVE && !failed) {
      await sql.unsafe(`CREATE TABLE public._lockdown_probe (id int)`);
      try {
        await sql.unsafe(`GRANT SELECT ON public._lockdown_probe TO anon`);
        const red = await lockdownCensus(sql);
        if (red.grants === 0) {
          console.error(
            "FAILED --prove: granted a scratch table to anon and the census still read 0. " +
            "The census cannot see what it is supposed to catch, so its zero means nothing.",
          );
          failed = true;
        } else {
          console.log(`prove    : census went RED as required (${red.grants} privileges)`);
        }
      } finally {
        await sql.unsafe(`DROP TABLE IF EXISTS public._lockdown_probe`);
      }
      const restored = await lockdownCensus(sql);
      if (restored.grants !== 0) {
        console.error(`FAILED --prove: census did not return to clean (${restored.grants}).`);
        failed = true;
      }
    }
  } catch (e) {
    console.error(`FAILED: ${(e as Error).message}`);
    for (const n of notices) console.error(`  ${n}`);
    failed = true;
  } finally {
    // An aborted batch otherwise leaves a pooled client inside a failed transaction.
    try {
      await sql.unsafe("ROLLBACK");
    } catch {
      /* nothing open — expected on the success path */
    }
    await sql.end();
  }

  // ── the endpoint half, and the verdict from outside ──────────────────────────────────────
  const ref = (env.SUPABASE_PROJECT_REF ?? "").trim();
  const token = (env.SUPABASE_ACCESS_TOKEN ?? "").trim();
  const anonKey = (env.SUPABASE_ANON_KEY ?? "").trim();

  if (CLOSE_API) {
    if (!ref || !token) {
      console.error("REFUSING --close-api: SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN needed.");
      failed = true;
    } else {
      // Drop `public` from PostgREST's exposed schemas. `graphql_public` is left because it
      // exposes only the GraphQL entrypoint, not our tables — and removing every schema makes
      // the service error rather than serve nothing, which reads as an outage.
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/postgrest`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ db_schema: "graphql_public", db_extra_search_path: "public" }),
      });
      console.log(`postgrest: db_schema -> graphql_public (HTTP ${res.status})`);
      if (!res.ok) failed = true;
    }
  }

  if (anonKey && ref) {
    // Config changes propagate; a probe fired the same instant can read the old state and call
    // an unfixed database safe. This waits, then probes, and reports the timing so a reader can
    // judge the result rather than trust it.
    await new Promise((r) => setTimeout(r, 15_000));
    const { exposed, unknown } = await probeRest(ref, anonKey);
    console.log(`\nexternal probe (anon key, +15s), ${PROBE_TABLES.length} tables:`);
    if (unknown.length) {
      console.error(`  UNKNOWN — not a pass: ${unknown.join("; ")}`);
      failed = true;
    }
    if (exposed.length) {
      console.error(`  STILL EXPOSED: ${exposed.join("; ")}`);
      failed = true;
    } else if (!unknown.length) {
      console.log("  refused on every table — no 200 answered");
    }
  } else {
    console.log("\nexternal probe SKIPPED (SUPABASE_ANON_KEY unset) — the database half is not a verdict.");
  }

  return failed ? 1 : 0;
}

/**
 * `process.exitCode` and NOT `process.exit()`, matching `provision-staff-role.ts`.
 * `console.log`/`console.error` queue when stdout is a pipe and `process.exit` drops whatever
 * has not drained — 65536 of 120001 bytes, measured on this platform. This command's whole
 * output is a verdict an operator reads, and it is exactly the kind of thing that gets run as
 * `supabase:lockdown 2>&1 | tee lockdown.log`, so the verdict must not be the part that is lost.
 *
 * Checked rather than assumed, because this file is the one that makes HTTP requests: Node's
 * `fetch` keep-alive sockets do not hold the loop open, so dropping the forced exit does not
 * delay this script.
 *
 * `.then`, NOT top-level `await` — one grammar with the other two CLIs, and the reason they
 * cannot use `await` is recorded in `setup-prod.ts`.
 */
void main()
  .catch((e: unknown) => {
    console.error(e);
    return 1;
  })
  .then((code) => { process.exitCode = code; });

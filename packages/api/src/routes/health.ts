import { sql } from "drizzle-orm";
/* THE SEAM THAT DECIDES WHETHER THE SCHEMA CENSUS BELOW CAN BE ASKED AT ALL. Branched on the
   handle's own brand rather than on a `typeof` probe or an environment variable — the same rule
   every other reader of the two stores follows, and the only one a caller cannot get wrong by
   forgetting to set something. */
import { dialect, dialectOf, pgOnly } from "@trafficflow/db/dialect";
import { staffChannelWord } from "@trafficflow/db";
import { kekEnvIdentity } from "@trafficflow/core/mail";
import { fullSchemaCensus, type SchemaCensus } from "./health-census.js";
/* The mail tier through ONE door, never a list by name: the phone engine substitutes a twin that
   exports only a throwing `mailTierMarkers`, so a list read here would fail the phone's build. */
import { mailTierMarkers } from "./health-markers.js";
import { API_VERSION } from "../version.js";
import type { ApiDeps } from "../deps.js";
import type { Route } from "../router.js";

/**
 * `GET /health` — liveness + identity. `public` (a probe has no credential), `anonymous` (an
 * ambient cookie once cost a query outside this try/catch, turning a database outage into a
 * generic 500), `raw` (no envelope above — this handler never throws). It must not lie in either
 * direction: database unreachable ⇒ 503 `database_unreachable`; schema incomplete ⇒ 503
 * `schema_incomplete`; missing `pg_trgm` ⇒ 200 with `pgTrgm: false`; a KEK fault or no build
 * identity in production ⇒ 503 with the reason. One round trip: the probes are one statement.
 * `cookieAuth` reports this request's cookie/bearer split; `alertSinks`/`alertPasses` mirror the
 * worker's keys. A database error forwards the code, never the driver's message.
 */


/**
 * One round trip, run once and read twice. `GET /admin/overview` has to publish the same
 * `ApiHealth` a probe would see — the console's claim is that it renders what `/health` says, not
 * a second opinion — and the only way for two endpoints to agree is to execute the same statement
 * and the same verdict; a copy of this SQL in `admin-service.ts` would drift on the first schema
 * marker added, invisibly, both endpoints still 200. It returns the raw probe rather than a
 * rendered body because the two callers need different shapes: `/health` has a published body
 * this may not alter by a single key, and the console needs `ApiHealth` — the rendering stays
 * with each caller.
 */
export type HealthProbe =
  | { kind: "unreachable"; dbLatencyMs: number; errorCode: string | null }
  | { kind: "empty"; dbLatencyMs: number }
  /**
   * Reachable, and the schema census does not apply to this store. The census reads four Postgres
   * catalogs; a device store has none of them — its catalog is `sqlite_master`, a different
   * question, and its schema is guaranteed by a different journal run by a different migrator.
   * This arm exists because the store read as unreachable, measured on a working phone: `/health`
   * answered 503 `database_unreachable` while the same composition served mail — the census
   * statement throws on the device store, and "the query did not run" was indistinguishable from
   * "the database is gone". Liveness is asked first, in a way both stores answer; the census runs
   * only where its catalogs exist. `ok` on this arm means the store answered.
   */
  | { kind: "live"; dbLatencyMs: number }
  | { kind: "probed"; dbLatencyMs: number; pgTrgm: boolean; schemaOk: boolean; markersFound: number };

/**
 * WHAT A FAILED PROBE MAY SAY IT WAS. The staff console prints this string under the red banner
 * on `/reliability`, and until now it was `err.code` verbatim — the driver's word, or, one hop
 * further out, the host's. `api_health.error_code` is the closed set of driver codes this
 * codebase already names for these failures plus our own acquire timeout; anything else reads
 * `other`, which is what "the database threw something we cannot name" honestly looks like.
 *
 * The one runtime-composed member of the staff-channel registry, which is why it is in it.
 */
function probeErrorCode(err: unknown): string | null {
  return staffChannelWord("api_health.error_code", (err as { code?: unknown } | null)?.code);
}

export async function probeDatabase(
  db: ApiDeps["db"],
  /**
   * What a Postgres host is probed against. Absent ⇒ the mail tier, which is a local engine's whole
   * schema. A hosted caller passes its census: `markers`, `checkDefinitions` and
   * `functionDefinitions` REPLACE the mail tier's lists (so they carry both tiers), while
   * `indexMarkers` and `foreignKeys` EXTEND the shared mail lists.
   */
  census?: Pick<SchemaCensus,
    "markers" | "checkDefinitions" | "indexMarkers" | "functionDefinitions" | "foreignKeys">,
): Promise<HealthProbe> {
  const started = Date.now();
  /**
   * The device store's arm, deliberately before everything else. The Postgres path below stays
   * byte-for-byte as it was, including its single statement and what `dbLatencyMs` measures: the
   * hosted `/health` body is published and its test must stay identical, so the safest shape is
   * one that executes no new code on a Postgres host — this branch returns before any of it.
   * `select 1` and nothing else, through the dialect seam so it renders on either store: "does
   * the store answer" is the only question a health endpoint can ask a store whose schema it
   * cannot census.
   */
  /**
   * The test is "is it the device store", not "is it not Postgres", and the control said so:
   * written first as `dialectOf(db) !== "pg"`, which fails on an unbranded handle — `dialectOf`
   * refuses one by design — and the hosted `/health` suite hands this function hand-built fakes
   * carrying no brand; six of its cases went red, which is what that suite is for. So the
   * Postgres path is the default, and only a handle that positively identifies itself as the
   * device store takes the branch. Fail-open is right here: the decision is whether to ask five
   * Postgres catalogs a question, and an unbranded handle reaching a store at all is a violation
   * the seam refuses in its own right.
   */
  let deviceStore = false;
  try {
    deviceStore = dialectOf(db) === "sqlite";
  } catch {
    /* Unbranded: not this branch's business to diagnose. The seam refuses it at the first
       statement it composes, with a message naming the factory that owes the brand. */
    deviceStore = false;
  }
  if (deviceStore) {
    try {
      const alive = await dialect(db).exec(db, sql`select 1 as one`);
      const dbLatencyMs = Date.now() - started;
      /**
       * READ POSITIONALLY, because that is what the seam guarantees on this store.
       *
       * The device arm of `exec` answers an array of ARRAYS — the column names are gone by the time
       * a caller sees them, which is the same positional contract the device store's whole binding
       * rests on. Written first as `row.one`, it read `undefined`, `Number(undefined)` is `NaN`,
       * and a live store reported `database_probe_empty`: a false state, arrived at by asking a
       * named question of an unnamed answer. The object arm is kept as the fallback so this stays
       * correct if it is ever reached with a handle whose `exec` answers rows by name.
       */
      const first = rowsOf<unknown>(alive)[0];
      const one = Array.isArray(first) ? first[0] : (first as { one?: unknown } | undefined)?.one;
      if (Number(one) !== 1) return { kind: "empty", dbLatencyMs };
      return { kind: "live", dbLatencyMs };
    } catch (err) {
      return {
        kind: "unreachable",
        dbLatencyMs: Date.now() - started,
        errorCode: probeErrorCode(err),
      };
    }
  }
  /* The tier is read HERE: after the device arm has returned, and outside the `try` below, so a
     phone that ever reaches this arm throws its twin's refusal out of this function by name rather
     than reporting the store `unreachable`. */
  const tier = mailTierMarkers();
  const columnMarkers = census?.markers ?? tier.columns;
  const checkDefinitionMarkers = census?.checkDefinitions ?? tier.checkDefinitions;
  const functionDefinitionMarkers = census?.functionDefinitions ?? tier.functions;
  const indexMarkers = [...tier.indexes, ...(census?.indexMarkers ?? [])];
  const fkMarkers = [...tier.foreignKeys, ...(census?.foreignKeys ?? [])];
  const expected =
    columnMarkers.length + indexMarkers.length + tier.checks.length +
    checkDefinitionMarkers.length + functionDefinitionMarkers.length + fkMarkers.length +
    tier.columnTypes.length;
  try {
    /* A DECLARED POSTGRES-ONLY ARM, and the declaration is the honest form of what this already
       was. The whole statement asks four Postgres CATALOGS in seven subselects —
       `information_schema.columns`, `pg_indexes`, `pg_constraint`, `pg_proc` — whether this deployment's schema and its
       extension are what the code expects. There is no second spelling of that question: the
       device store's catalog is `sqlite_master` and `pragma table_info`, which is a different
       question, and the branch above answers it and RETURNS on every path, so nothing reaches
       here except a server. Marking it says so at the site instead of leaving a reader to derive
       it, and the census pins how many such arms this file has. */
    // scoped-by: reads Postgres catalogs only — schema facts, no account rows
    const result = await db.execute(
      pgOnly(sql`select 1 as one,
                 to_regprocedure('word_similarity(text,text)') is not null as pg_trgm,
                 (select count(*) from information_schema.columns
                   where table_schema = 'public'
                     and (table_name, column_name) in (${sql.join(
                       columnMarkers.map(([t, c]) => sql`(${t}, ${c})`),
                       sql`, `,
                     )})) as schema_markers,
                 -- The TYPE half: the same view, asked for udt_name too, because a pair cannot
                 -- tell int4 from int8 (mail 0131). Mail tables only, so always asked.
                 (select count(*) from information_schema.columns
                   where table_schema = 'public'
                     and (table_name, column_name, udt_name) in (${sql.join(
                       tier.columnTypes.map(([t, c, u]) => sql`(${t}, ${c}, ${u})`),
                       sql`, `,
                     )})) as type_markers,
                 -- The index half: pg_indexes, because information_schema has no view of
                 -- indexes at all. Scoped to public, like the column probe above. The list is
                 -- the shared mail markers plus whatever the host registered (see the
                 -- census's indexMarkers). By DEFINITION: the name alone certified a
                 -- same-named index over other columns.
                 (select count(*) from pg_indexes
                   where schemaname = 'public'
                     and (${sql.join(
                       indexMarkers.map(([name, needle]) =>
                         pgOnly(sql`(indexname = ${name} and position(${needle} in indexdef) > 0)`)),
                       sql` or `,
                     )})) as index_markers,
                 -- The CHECK half: a third catalog again, because neither view above can see a
                 -- constraint. contype = 'c' excludes FK/unique/PK constraints, whose names
                 -- share the same namespace, and the join to pg_namespace scopes it to public
                 -- exactly like the other two.
                 (select count(*) from pg_constraint c
                    join pg_class t on t.oid = c.conrelid
                    join pg_namespace n on n.oid = t.relnamespace
                   where n.nspname = 'public' and c.contype = 'c'
                     and c.conname in (${sql.join(
                       tier.checks.map((n) => sql`${n}`),
                       sql`, `,
                     )})) as check_markers,
                 -- The CHECK-DEFINITION half: the same catalog again, asking a different
                 -- question. A migration that REPLACES a constraint under its existing name is
                 -- invisible to the name probe above — both names are present on a database that
                 -- never ran it — so this reads the rendered definition and looks for the
                 -- vocabulary the migration added. A literal FALSE when the list is empty keeps
                 -- the subselect valid and its count at 0 for a host that passes none.
                 (select count(*) from pg_constraint c
                    join pg_class t on t.oid = c.conrelid
                    join pg_namespace n on n.oid = t.relnamespace
                   where n.nspname = 'public' and c.contype = 'c'
                     and (${checkDefinitionMarkers.length > 0
                       ? sql.join(
                         checkDefinitionMarkers.map(([name, needle]) =>
                           pgOnly(sql`(c.conname = ${name} and position(${needle} in pg_get_constraintdef(c.oid)) > 0)`)),
                         sql` or `,
                       )
                       : sql`false`
                     })) as check_def_markers,
                 -- The FUNCTION-BODY half: the FIFTH probe and a fourth catalog, because one whose
                 -- content is a CREATE OR REPLACE FUNCTION changes nothing the four probes
                 -- above can see — not a column, not an index, not a constraint name, and not
                 -- a constraint DEFINITION (a function is pg_proc). prosrc is the body as
                 -- written. Scoped to public like the rest; a literal FALSE when the list is
                 -- empty keeps the subselect valid at 0 for a host that passes none.
                 (select count(*) from pg_proc p
                    join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and (${functionDefinitionMarkers.length > 0
                       ? sql.join(
                         functionDefinitionMarkers.map(([name, needle]) =>
                           pgOnly(sql`(p.proname = ${name} and position(${needle} in p.prosrc) > 0)`)),
                         sql` or `,
                       )
                       : sql`false`
                     })) as function_def_markers,
                 -- The FOREIGN-KEY half: a SIXTH question, and the same catalog as the two CHECK
                 -- probes above, which are scoped contype = 'c' and so cannot see a key at all —
                 -- a migration whose whole DDL is foreign keys was invisible to every other
                 -- class. Read by DEFINITION, never by name: a key recreated under its own name
                 -- over fewer columns is the account scope gone with the name still present.
                 -- A literal FALSE when the list is empty, like the two probes above.
                 (select count(*) from pg_constraint c
                    join pg_class t on t.oid = c.conrelid
                    join pg_namespace n on n.oid = t.relnamespace
                   where n.nspname = 'public' and c.contype = 'f'
                     and (${fkMarkers.length > 0
                       ? sql.join(
                         fkMarkers.map(([name, needle]) =>
                           pgOnly(sql`(c.conname = ${name} and position(${needle} in pg_get_constraintdef(c.oid)) > 0)`)),
                         sql` or `,
                       )
                       : sql`false`
                     })) as fk_markers`),
    );
    const dbLatencyMs = Date.now() - started;
    const row = rowsOf<{
      one: number; pg_trgm: boolean; schema_markers: number | string; index_markers: number | string;
      type_markers: number | string;
      check_markers: number | string; check_def_markers: number | string;
      function_def_markers: number | string; fk_markers: number | string;
    }>(result)[0];
    if (!row || Number(row.one) !== 1) return { kind: "empty", dbLatencyMs };
    // One total across all seven probes — see `SCHEMA_INDEX_MARKERS` (`health-markers.ts`) for why
    // they are not seven.
    const markersFound =
      Number(row.schema_markers) + Number(row.index_markers) + Number(row.check_markers) +
      Number(row.check_def_markers) + Number(row.function_def_markers) + Number(row.fk_markers) +
      Number(row.type_markers);
    return {
      kind: "probed",
      dbLatencyMs,
      pgTrgm: Boolean(row.pg_trgm),
      schemaOk: markersFound === expected,
      markersFound,
    };
  } catch (err) {
    return {
      kind: "unreachable",
      dbLatencyMs: Date.now() - started,
      errorCode: probeErrorCode(err),
    };
  }
}

/**
 * The fault a probed database has, ordered by severity — or null when the host is healthy.
 *
 * Ordered by blast radius: a wrong/unmigrated database first (nothing works at all), then the
 * KEK (credentials undecryptable), then build identity (unidentifiable deploy).
 */
export function healthFault(input: {
  schemaOk: boolean;
  markersFound: number;
  kekError: string | null;
  buildError: string | null;
  /** What this host expects. Absent ⇒ the mail tier's count (`mailTierMarkers().expected`). */
  expected?: number;
  /** Which journal entries that count was reconciled to. Absent ⇒ the mail journal alone. */
  through?: string;
}): { error: string; detail: string } | null {
  if (!input.schemaOk) {
    return {
      error: "schema_incomplete",
      detail:
        `expected ${input.expected ?? mailTierMarkers().expected} schema markers ` +
        `(through ${input.through ?? mailTierMarkers().through}), found ${input.markersFound} — run ` +
        `'pnpm db:setup:prod' against this database`,
    };
  }
  if (input.kekError !== null) return { error: "kek_env_invalid", detail: input.kekError };
  if (input.buildError !== null) return { error: "build_identity_unknown", detail: input.buildError };
  return null;
}

export const healthRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/health",
    relay: true,
    cost: "unauthenticated",
    options: { public: true, raw: true, anonymous: true },
    handler: async (_req, deps) => {
      const injected = deps.health;
      const version = injected?.version ?? API_VERSION;
      // An injected `health` is AUTHORITATIVE: the host already parsed its own environment
      // (and may have captured a KEK failure there). Without one — the test harness, and
      // any host that forgets to inject — read the environment here so the endpoint still
      // reports truthfully rather than silently claiming "no KEK".
      let kek: ReturnType<typeof kekEnvIdentity> | null = injected?.kek ?? null;
      let kekError: string | null = injected?.kekError ?? null;
      if (!injected) {
        try {
          kek = kekEnvIdentity() ?? null;
        } catch (err) {
          // Captured: the fault is published beside the verdict as `kekError`.
          kekError = err instanceof Error ? err.message : "invalid KEK environment";
        }
      }
      // A production deployment with no commit sha and no `TF_BUILD_VERSION` is a deployment
      // nobody can identify: the moment two of them behave differently, "which build is
      // this?" has no answer, and the KEK/schema comparisons lose their anchor. The host
      // still serves — this is a reporting fault, not a fatal one — but it is NOT healthy.
      const buildError = injected?.buildError ?? null;
      // Where `version` came from — see {@link BuildIdentitySource}. Published beside
      // `version`/`buildError` on every branch, like `dbProvider`, so a consumer never has to
      // infer provenance from the presence or absence of a fault.
      const buildSource = injected?.buildSource ?? null;
      // The artifact's own commit, where the host was handed one — the desktop shell's, baked at
      // build time and passed at spawn. Published only when it is there: a hosted deployment is
      // identified by `version`, and a null key would read as "this host reports a build commit
      // and has none". `unknown` IS published, because a build that cannot name itself is a
      // different state from one nobody asked.
      const buildCommit = injected?.buildCommit?.trim() || null;
      const artifact = buildCommit ? { buildCommit } : {};
      // NOT a `healthFault` — see `HealthConfig.adminError` for why an unarmed staff
      // console must not darken the product host. It is published because with the surface
      // unarmed there is no `/admin/*` endpoint left that could report its own absence.
      const adminError = injected?.adminError ?? null;
      // A SECOND, SEPARATE key, and the separation is the finding. `adminFault` says
      // "the staff console is unarmed"; this says "the pager is configured and has no database,
      // so nothing is watching the worker". The old code could only say the first, and said it
      // about hosts whose real problem was the second. Also 200: an observability fault must
      // never darken the product — see `HealthConfig.alertsError`.
      const alertsError = injected?.alertsError ?? null;
      // RUN THE CONTENT-BLIND ATTESTATION, non-fatally. `adminFault` names the static
      // console refusals; this names the one they cannot see — a plausible over-privileged
      // `DATABASE_URL_ADMIN` — which otherwise surfaced only as a per-request 503. Awaited (the
      // memoised factory pays the round trips once per cold instance), never allowed to throw:
      // a dark console must not take the product host out of rotation. Absent on hosts with no
      // blind connection, so this is a no-op for desktop and unarmed deployments.
      let staffDbFault: string | null = null;
      if (injected?.staffDbAttestation) {
        try {
          staffDbFault = await injected.staffDbAttestation();
        } catch {
          // The capability itself is contracted not to throw; this is belt-and-braces so a
          // future edit to it can never darken `/health`.
          staffDbFault = null;
        }
      }
      const staffFaults = {
        ...(adminError ? { adminFault: adminError } : {}),
        ...(alertsError ? { alertsFault: alertsError } : {}),
        ...(staffDbFault ? { staffDbFault } : {}),
      };
      // Not a fault, and never 503: it is the tripwire for the NEXT provider migration.
      // `unrecognized` here means the connection guards have gone silent again. Emitted beside
      // `kek` on every branch, including the unhealthy ones, because a host that cannot reach its
      // database is exactly when knowing which family it dialled is worth most.
      const dbProvider = injected?.dbProvider ?? null;
      // THE ENTITLEMENTS COMPOSITION MARKER, on dbProvider's exact pattern: a fixed string,
      // injected by the host, never a fault. It is the tripwire for a configuration change whose
      // failure mode is camouflaged — a host that lost its entitlements URL reads as a
      // legitimately unmetered one. Emitted on every branch, like dbProvider and for its reason.
      const entitlements = injected?.entitlements ?? null;
      // The price's source, on the same every-branch terms: a deploy gate reads it, and a host
      // whose database is down is still a host that may or may not be able to quote.
      let aiPricing: "plane" | "unpriced" | "unmetered" | null = null;
      if (injected?.aiPricing) {
        try {
          aiPricing = await injected.aiPricing();
        } catch {
          // Contracted not to throw; a reading that faults is published as no reading, never a 503.
          aiPricing = null;
        }
      }

      // The pager's arms — the worker's boot announcement, in the idiom a serverless host has. A
      // memory read (`HealthConfig.alertSinks` says why it is a capability), so it costs no round
      // trip and is published on every branch below, beside `dbProvider` and `entitlements`: a
      // host that cannot reach its database is exactly when "can this deployment still page
      // anybody?" is worth most. Two keys from one call: `alertSinks` is the same key, shape and
      // closed codes the worker publishes, so the two are a literal JSON diff; `alertPasses` is
      // what stops the counters lying on a cold instance.
      let pager: Record<string, unknown> = {};
      if (injected?.alertSinks) {
        try {
          const summary = injected.alertSinks();
          pager = { alertSinks: summary.arms, alertPasses: summary.passes };
        } catch {
          // Contracted not to throw — it reads memory. Belt-and-braces for the same reason
          // `staffDbAttestation`'s catch exists: an observability surface may never darken the
          // host it reports on, and `raw` means there is no error envelope above this handler.
          pager = {};
        }
      }

      // WHICH SCHEMA THIS HOST IS SUPPOSED TO HAVE. A desktop install ran the mail journal alone
      // and has no billing ledger to find; probed against both, it would answer
      // `schema_incomplete` on every request for ever — which reads as "somebody forgot to
      // migrate" about a database that is complete.
      const mailOnly = injected?.schemaTier === "mail";
      // THE FULL-TIER CENSUS IS THE HOST'S TO SUPPLY, because its entries are Cloud table and
      // column names and this module ships in the desktop engine (`health-cloud.ts`). A host that
      // claims the full tier and hands over no census is a CONFIGURATION FAULT, not a host that
      // silently probes the mail half: answering "healthy" off a narrower probe is exactly the
      // "somebody forgot to migrate, and nothing said so" failure this route exists to catch.
      const fullCensus = mailOnly ? null : fullSchemaCensus();
      // A mail-tier host passes no census: the probe reads the mail tier itself, on its Postgres
      // arm only, so a device store never reaches the lists.
      const probe = await probeDatabase(deps.db, fullCensus ?? undefined);
      // BOTH TRANSPORT HOPS (`HealthConfig.dbTls`), read after the probe so its handshake is counted.
      // Contracted not to throw; a reading that faults is published as no reading, never a 503.
      let transport: Record<string, unknown> = {};
      if (injected?.dbTls) {
        try {
          transport = { ...(await injected.dbTls(probe.kind !== "unreachable")) };
        } catch {
          // A reading that faults is published as no reading: `/health` must never darken on it.
          transport = {};
        }
      }
      if (probe.kind === "unreachable") {
        return healthResponse(503, {
          ok: false,
          version,
          buildSource,
          ...artifact,
          dbLatencyMs: probe.dbLatencyMs,
          error: "database_unreachable",
          errorCode: probe.errorCode,
          kek,
          dbProvider,
          ...transport,
          entitlements,
          aiPricing,
          ...pager,
          ...staffFaults,
        });
      }
      if (probe.kind === "empty") {
        return healthResponse(503, {
          ok: false, version, buildSource, ...artifact, dbLatencyMs: probe.dbLatencyMs, error: "database_probe_empty", kek,
          dbProvider,
          ...transport,
          entitlements,
          aiPricing,
          ...pager,
          ...staffFaults,
        });
      }

      /**
       * The device store answered, and there is no schema census to report for it. `schemaOk` and
       * the marker counts are Postgres-catalog readings, so they are absent rather than zero — a
       * `found: 0, expected: 47` body would read as a broken schema on a store whose schema is
       * fine, the false state this arm exists to stop being shown; `pgTrgm` is absent for the
       * same reason. The key faults that are not store-shaped still apply, which is why this goes
       * through `healthFault` rather than returning 200 flat: a missing install key or a broken
       * build is as wrong on a phone as anywhere else.
       */
      if (probe.kind === "live") {
        const liveFault = healthFault({
          schemaOk: true, markersFound: 0, kekError, buildError, expected: 0,
        });
        return healthResponse(liveFault ? 503 : 200, {
          ok: liveFault === null,
          version,
          buildSource,
          ...artifact,
          dbLatencyMs: probe.dbLatencyMs,
          cookieAuth: deps.allowCookieAuth !== false,
          kek,
          dbProvider,
          ...transport,
          ...pager,
          ...staffFaults,
          ...(liveFault ?? {}),
        });
      }

      // The counts this host is held to, read only now that the probe was a Postgres one.
      const through = fullCensus?.through ?? mailTierMarkers().through;
      const expectedMarkers = fullCensus?.expected ?? mailTierMarkers().expected;
      const fault = healthFault({
        schemaOk: probe.schemaOk, markersFound: probe.markersFound, kekError, buildError,
        expected: expectedMarkers, through,
      });
      return healthResponse(fault ? 503 : 200, {
        ok: fault === null,
        version,
        buildSource,
        ...artifact,
        dbLatencyMs: probe.dbLatencyMs,
        pgTrgm: probe.pgTrgm,
        schemaOk: probe.schemaOk,
        schemaMarkers: {
          found: probe.markersFound, expected: expectedMarkers, through,
        },
        // Same default as `withSession`: absent means the historical "cookies allowed".
        cookieAuth: deps.allowCookieAuth !== false,
        kek,
        dbProvider,
        ...transport,
        entitlements,
        aiPricing,
        ...pager,
        ...staffFaults,
        ...(fault ?? {}),
      });
    },
  },
];

/**
 * Normalize the driver-specific `execute` shape: postgres-js returns an ARRAY, PGlite
 * returns `{ rows }`. Same helper as `search-service.ts` / `kb-service.ts` — and it is
 * not optional here: reading `result[0]` directly makes `/health` report
 * `database_probe_empty` against PGlite, i.e. the endpoint would answer 503 in the very
 * harness that is supposed to prove it answers 200.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** Always `no-store`: a cached health response is a lie about the present. */
function healthResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

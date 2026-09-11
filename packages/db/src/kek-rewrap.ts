import { createHash } from "node:crypto";
import { and, eq, is, isNotNull, isNull, lt, sql, Column, type SQL } from "drizzle-orm";
import { type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import type { Tx, LedgerTx } from "./change-log.js";
import { mailboxCredentials } from "./schema-mail.js";
import {
  totpSecrets, staffUsers, mailboxOauthCeremonies, mailboxOauthDeviceCeremonies, oauthProviderConfig,
} from "./schema-cloud.js";

/**
 * The KEK re-wrap pass — what makes rotation a revocation instead of a gesture. Env-var rotation
 * protects new writes only: unchanged rows keep the old envelope, so the leaked key cannot be
 * removed. {@link kekRewrapCensus} answers "anything still on N?"; {@link runKekRewrap} moves
 * rows off it. A runner, not a journal migration: the keys live in the host's environment, and a
 * migration cannot report or resume. Resumability is `key_version` itself: one transaction per
 * row, each wholly old or wholly new, the new envelope verified BEFORE the old is overwritten.
 * The snapshot race is closed twice — a `FOR UPDATE` re-read and a compare-and-swap,
 * mutation-tested as peers on real Postgres. `updated_at` is untouched. Never log key material.
 */

/**
 * The envelope operations this pass needs — structurally, so `@trafficflow/db` does not grow a
 * dependency on `@trafficflow/core`.
 *
 * It is `KeyProvider` from `core/src/crypto.ts`, and it is spelled out here for the same reason
 * `oauth-config.ts` spells out its `Decrypt`: the db package has never imported core, the
 * direction of that edge is load-bearing for the desktop engine's bundle, and the shape is three
 * methods.
 */
export interface RewrapKeyProvider {
  encrypt(plaintext: string): Promise<{ ciphertext: string; keyVersion: number }>;
  decrypt(ciphertext: string, keyVersion: number): Promise<string>;
  currentKeyVersion(): number;
}

/**
 * ONE place a secret is stored under an envelope, declared by PROPERTY NAME.
 *
 * The property names are the single source of truth and the column objects are derived from them
 * at module load ({@link resolveColumn}), rather than both being written out and drifting. A
 * typo'd property is a throw the first time this module is imported — including in every test
 * that imports it — not a site silently missing from the pass.
 */
export interface WrappedSecretSite {
  /** Stable identifier for reports and logs: `<table>.<ciphertext column>`. */
  readonly site: string;
  readonly table: PgTable;
  /** Drizzle property holding the envelope (a `text` column). */
  readonly ciphertext: string;
  /** Drizzle property holding its KEK version (an `integer` column). */
  readonly keyVersion: string;
  /** Drizzle properties that identify a row uniquely. */
  readonly key: readonly string[];
  /**
   * True when a key column's VALUE is itself secret, so it must be hashed before it appears in
   * any report or log line. Today only `mailbox_oauth_ceremonies.state`.
   */
  readonly keyIsSecret: boolean;
}

/**
 * EVERY column in the hosted database that holds a KEK envelope.
 *
 * Completeness is not maintained by care. `kek-rewrap.test.ts` walks the drizzle schema and
 * `kek-rewrap.pg.test.ts` walks `information_schema` for any column whose name ends `_enc`, and
 * both fail on one this list does not name — so a sixth encrypted column added next year cannot
 * be quietly excluded from rotation. If a `_enc` column is deliberately NOT a KEK envelope, the
 * test is where the exemption gets named and argued, not here.
 */
export const WRAPPED_SECRET_SITES: readonly WrappedSecretSite[] = [
  {
    // The IMAP/SMTP/Graph password or refresh token. The row the finding is really about: it is
    // the one whose leak reaches a user's mail, and the one the live system rewrites most.
    site: "mailbox_credentials.secret_enc",
    table: mailboxCredentials,
    ciphertext: "secretEnc", keyVersion: "keyVersion",
    key: ["mailboxId", "transport"], keyIsSecret: false,
  },
  {
    site: "totp_secrets.secret_enc",
    table: totpSecrets,
    ciphertext: "secretEnc", keyVersion: "keyVersion",
    key: ["id"], keyIsSecret: false,
  },
  {
    // Nullable pair — "Null iff the secret is null" per the schema. A half-null row is an
    // anomaly this pass reports rather than repairs; see `mismatched` on the census.
    site: "staff_users.totp_secret_enc",
    table: staffUsers,
    ciphertext: "totpSecretEnc", keyVersion: "totpKeyVersion",
    key: ["id"], keyIsSecret: false,
  },
  {
    // Short-lived PKCE rows. Included deliberately: they are as decryptable by a leaked old key
    // as anything else while they live, and "it expires soon" is not a retirement criterion for
    // a key you are trying to prove nothing references.
    site: "mailbox_oauth_ceremonies.code_verifier_enc",
    table: mailboxOauthCeremonies,
    ciphertext: "codeVerifierEnc", keyVersion: "codeVerifierKeyVersion",
    key: ["state"], keyIsSecret: true,
  },
  {
    // The DEVICE-CODE ceremony's bearer credential (cloud 0027), and it is here for the PKCE row's
    // reason verbatim: short-lived is not a retirement criterion for a key you are trying to prove
    // nothing references. A live device ceremony lasts about fifteen minutes, and a rotation that
    // skipped it would let an operator observe zero old-key references, retire the old KEK, and
    // leave somebody mid-sign-in holding a `device_code` this deployment can no longer open —
    // which presents as the ceremony simply never completing.
    //
    // `keyIsSecret` because the key IS the ceremony handle, exactly as `state` is next door.
    site: "mailbox_oauth_device_ceremonies.device_code_enc",
    table: mailboxOauthDeviceCeremonies,
    ciphertext: "deviceCodeEnc", keyVersion: "deviceCodeKeyVersion",
    key: ["state"], keyIsSecret: true,
  },
  {
    site: "oauth_provider_config.client_secret_enc",
    table: oauthProviderConfig,
    ciphertext: "clientSecretEnc", keyVersion: "clientSecretKeyVersion",
    key: ["provider"], keyIsSecret: false,
  },
];

/**
 * Resolve a declared property to its drizzle column, or throw at import time. The question is
 * about the DECLARATION — does this property name a column — asked of a table compiled into two
 * twins, one per store. `instanceof PgColumn` answered a different question (which STORE the
 * table belongs to) and threw at module load in the test run that substitutes the device twin,
 * for a module a device never loads, naming a column instead of the substitution. `Column` is the
 * class both twins descend from, so a typo, a missing column and a non-column property are all
 * still refused at import. The cast is safe on the only store this module runs against: every
 * deployment with a KEK to rotate has Postgres.
 */
function resolveColumn(site: WrappedSecretSite, prop: string): PgColumn {
  const c = (site.table as unknown as Record<string, unknown>)[prop];
  if (!is(c, Column)) {
    throw new Error(`${site.site}: "${prop}" is not a column on this table`);
  }
  return c as PgColumn;
}

interface ResolvedSite extends WrappedSecretSite {
  readonly ctCol: PgColumn;
  readonly kvCol: PgColumn;
  readonly keyCols: readonly PgColumn[];
}

/** Resolved once, at import, so a bad declaration cannot survive to a production run. */
const RESOLVED: readonly ResolvedSite[] = WRAPPED_SECRET_SITES.map((s) => ({
  ...s,
  ctCol: resolveColumn(s, s.ciphertext),
  kvCol: resolveColumn(s, s.keyVersion),
  keyCols: s.key.map((k) => resolveColumn(s, k)),
}));

/** Domain separator so a row label can never collide with any other digest in the system. */
const ROW_LABEL_DOMAIN = "tf-kek-rewrap-row/1\n";

/**
 * How a row is named in a report. Non-secret keys print; a secret key ({@link
 * WrappedSecretSite.keyIsSecret}) becomes a domain-separated digest prefix — correlatable across
 * two log lines, useless as a credential.
 */
function rowLabel(site: ResolvedSite, values: readonly unknown[]): string {
  const parts = values.map((v) => (v === null || v === undefined ? "" : String(v)));
  if (!site.keyIsSecret) return parts.join("/");
  const h = createHash("sha256").update(ROW_LABEL_DOMAIN, "ascii");
  for (const p of parts) h.update(`${p}\n`, "utf8");
  return `#${h.digest("hex").slice(0, 12)}`;
}

/** Every way one row can fail to be re-wrapped. A CLOSED set — see the logging paragraph. */
export type RewrapFailureReason =
  /** The row's `key_version` names a KEK this host has not loaded. */
  | "no_kek_for_version"
  /** The stored envelope is not parseable, or its GCM tag did not authenticate. */
  | "decrypt_failed"
  /** The freshly written envelope did not decrypt back to the same plaintext. NEVER written. */
  | "roundtrip_mismatch"
  /** The row could not be locked, or the database refused the write. Re-runnable. */
  | "database_error";

export interface RewrapFailure {
  readonly site: string;
  /** {@link rowLabel} — hashed when the key is itself a secret. */
  readonly row: string;
  readonly reason: RewrapFailureReason;
  /** The version the row named. Non-secret, and the field an operator needs most. */
  readonly keyVersion: number;
}

export interface SiteCensus {
  readonly site: string;
  /** Rows holding an envelope (a non-null ciphertext). */
  readonly total: number;
  /** `key_version` → row count, for the rows holding an envelope. */
  readonly byVersion: Readonly<Record<number, number>>;
  /** Rows below the target version — what a re-wrap pass would visit. */
  readonly outstanding: number;
  /**
   * Rows whose `key_version` is ABOVE the target: written by a host holding a KEK this one does
   * not. Never touched, always reported — it means the ring is mid-rotation and this host is the
   * one that is behind, which is the state that must not be mistaken for "nothing left to do".
   */
  readonly ahead: number;
  /**
   * Rows where exactly one of the ciphertext / version pair is null. The schema's stated
   * invariant is "null iff", so any count here is a defect. Reported, never repaired: a
   * ciphertext with no version cannot be decrypted, and inventing one would be a guess.
   */
  readonly mismatched: number;
}

export interface KekRewrapCensus {
  /** The version new secrets are written under — `keyProvider.currentKeyVersion()`. */
  readonly target: number;
  readonly sites: readonly SiteCensus[];
  /** Total rows below `target` across every site. Zero ⇒ no old version is referenced. */
  readonly outstanding: number;
  /** Every version still referenced by at least one row, ascending. */
  readonly versionsInUse: readonly number[];
}

/**
 * WHAT STILL REFERENCES AN OLD KEK — the read half of incident-rotation, and the check that
 * licenses removing a version.
 *
 * Read-only and safe to run against a live database at any time. It is what a dry run prints, and it
 * is what an operator re-runs after `--apply` to confirm the answer is zero before deleting
 * `TF_KEK_V<n>` from the hosts and from secret history.
 */
export async function kekRewrapCensus(db: Tx, target: number): Promise<KekRewrapCensus> {
  const sites: SiteCensus[] = [];
  const versions = new Set<number>();

  for (const site of RESOLVED) {
    const counts = await db
      .select({ v: site.kvCol, n: sql<number>`count(*)::int` })
      .from(site.table)
      .where(and(isNotNull(site.ctCol), isNotNull(site.kvCol)))
      .groupBy(site.kvCol);

    const byVersion: Record<number, number> = {};
    let total = 0, outstanding = 0, ahead = 0;
    for (const r of counts as Array<{ v: number; n: number }>) {
      const v = Number(r.v), n = Number(r.n);
      byVersion[v] = n;
      total += n;
      if (v < target) outstanding += n;
      if (v > target) ahead += n;
      versions.add(v);
    }

    // The half-null rows, counted in both directions with one query per direction. Cheap, and
    // the alternative — folding them into the grouped count above — cannot distinguish "no
    // version" from "version 0".
    const [ctNoVer] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(site.table)
      .where(and(isNotNull(site.ctCol), isNull(site.kvCol)));
    const [verNoCt] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(site.table)
      .where(and(isNull(site.ctCol), isNotNull(site.kvCol)));
    const mismatched = Number(ctNoVer?.n ?? 0) + Number(verNoCt?.n ?? 0);

    sites.push({ site: site.site, total, byVersion, outstanding, ahead, mismatched });
  }

  return {
    target,
    sites,
    outstanding: sites.reduce((a, s) => a + s.outstanding, 0),
    versionsInUse: [...versions].sort((a, b) => a - b),
  };
}

/**
 * Crash-injection seams, and they exist ONLY so the resume and atomicity properties can be
 * PROVEN rather than asserted.
 *
 * A pass whose recovery story is "it is idempotent, trust the transaction" is a guard nobody has
 * watched fail. These two hooks let `kek-rewrap.pg.test.ts` stop the pass at the two instants
 * that matter — with a row selected but not yet visited, and with a row written but not yet
 * committed — against real Postgres, and check what the database holds afterwards. Both are
 * `undefined` in every production path.
 */
export interface RewrapHooks {
  /**
   * Called before each row's transaction opens, with the row's {@link rowLabel}. Throwing
   * simulates a kill between rows; awaiting simulates a pass paused with the row SELECTED but
   * not yet locked — the window in which the live system can rewrite it.
   */
  beforeRow?(site: string, row: string, index: number): Promise<void>;
  /** Called INSIDE the transaction, after the UPDATE. Throwing must leave the row untouched. */
  afterUpdate?(site: string, row: string, index: number): Promise<void>;
}

export interface KekRewrapDeps {
  db: Tx;
  keyProvider: RewrapKeyProvider;
  /** False ⇒ census only: read, report, write nothing. */
  apply: boolean;
  /** Per-site ceiling on rows visited in one pass. A further run picks up the remainder. */
  batchLimit?: number;
  hooks?: RewrapHooks;
  /** Called once per outcome. Receives labels and reasons only — never a value. */
  onEvent?(e: RewrapEvent): void;
}

export type RewrapEvent =
  | { kind: "rewrapped"; site: string; row: string; from: number; to: number }
  | { kind: "raced"; site: string; row: string }
  | ({ kind: "failed" } & RewrapFailure);

export interface KekRewrapResult {
  readonly target: number;
  /** The census taken before any write. On a dry run this is the whole answer. */
  readonly census: KekRewrapCensus;
  /** Rows re-wrapped to `target`. Always 0 on a dry run. */
  readonly rewrapped: number;
  /** Candidates that had already reached `target` when locked — the live path got there first. */
  readonly raced: number;
  /** Candidates left exactly as they were. Each one is in {@link failures}. */
  readonly failed: number;
  readonly failures: readonly RewrapFailure[];
  /** True when a site hit `batchLimit`, so another pass is owed. */
  readonly truncated: boolean;
}

/** Default ceiling. High enough for the whole hosted population, low enough to be a bound. */
export const REWRAP_BATCH_LIMIT = 5_000;

/**
 * Move every stored envelope onto the current KEK version. ONE TRANSACTION PER ROW (see the
 * header): recoverability rests on every row being wholly old or wholly new at every instant, and
 * a single transaction over the population would destroy that and hold row locks on
 * `mailbox_credentials` against a live worker for the length of the run. A row that fails does
 * NOT stop the pass — isolation, not tolerance: the alternative is one undecryptable row denying
 * rotation to every row after it, the failure this pass exists to remove. Every failure is
 * counted, labelled and reported; the run finishes and says what it could not do.
 */
export async function runKekRewrap(deps: KekRewrapDeps): Promise<KekRewrapResult> {
  const { db, keyProvider, apply } = deps;
  const limit = deps.batchLimit ?? REWRAP_BATCH_LIMIT;
  const target = keyProvider.currentKeyVersion();

  const census = await kekRewrapCensus(db, target);
  const failures: RewrapFailure[] = [];
  let rewrapped = 0, raced = 0, truncated = false;

  if (!apply) {
    return { target, census, rewrapped: 0, raced: 0, failed: 0, failures, truncated: false };
  }

  for (const site of RESOLVED) {
    // The candidate query names WHICH rows to visit and nothing more — every value it returns
    // besides the key is discarded. See "the snapshot is a lost update" in the header.
    const candidates = await db
      .select(Object.fromEntries(site.keyCols.map((c, i) => [`k${i}`, c])))
      .from(site.table)
      .where(and(isNotNull(site.ctCol), isNotNull(site.kvCol), lt(site.kvCol, target)))
      .limit(limit + 1);

    const rows = candidates as Array<Record<string, unknown>>;
    if (rows.length > limit) { truncated = true; rows.length = limit; }

    for (const [index, row] of rows.entries()) {
      const keyValues = site.keyCols.map((_, i) => row[`k${i}`]);
      const label = rowLabel(site, keyValues);
      if (deps.hooks?.beforeRow) await deps.hooks.beforeRow(site.site, label, index);

      const outcome = await rewrapOneRow(deps, site, keyValues, label, target, index);
      if (outcome.kind === "rewrapped") rewrapped++;
      else if (outcome.kind === "raced") raced++;
      else failures.push(outcome);
      deps.onEvent?.(outcome);
    }
  }

  return {
    target,
    census,
    rewrapped,
    raced,
    failed: failures.length,
    failures,
    truncated,
  };
}

/**
 * One row, one transaction: lock, re-read, decrypt, re-encrypt, VERIFY, write.
 *
 * The order is the contract. The verify sits between the encrypt and the UPDATE because the
 * plaintext exists nowhere but inside this function — an envelope this ring cannot reopen,
 * written over the only copy, is unrecoverable by any backup that does not predate the run.
 */
async function rewrapOneRow(
  deps: KekRewrapDeps,
  site: ResolvedSite,
  keyValues: readonly unknown[],
  label: string,
  target: number,
  index: number,
): Promise<RewrapEvent> {
  const keyEq: SQL | undefined = and(...site.keyCols.map((c, i) => eq(c, keyValues[i])));
  let sawVersion = -1;

  try {
    return await deps.db.transaction(async (tx: LedgerTx) => {
      const locked = await tx
        .select({ ct: site.ctCol, kv: site.kvCol })
        .from(site.table)
        .where(keyEq)
        .for("update");
      const current = (locked as Array<{ ct: string | null; kv: number | null }>)[0];

      // Deleted between selection and now — an expired ceremony pruned, a mailbox removed. Not a
      // failure: the row this pass was going to fix no longer exists to be leaked.
      if (!current || current.ct === null || current.kv === null) {
        return { kind: "raced", site: site.site, row: label } as const;
      }
      const fromVersion = Number(current.kv);
      sawVersion = fromVersion;
      // Already current: the live path rewrote this secret while the pass was running, or a
      // concurrent copy of the pass reached it first. Either way it is done, and the plaintext
      // this pass would have written back is the STALE one.
      if (fromVersion >= target) {
        return { kind: "raced", site: site.site, row: label } as const;
      }

      const plaintext = await deps.keyProvider.decrypt(current.ct, fromVersion);
      const sealed = await deps.keyProvider.encrypt(plaintext);

      // THE ROUND TRIP. Not a sanity check — the only thing standing between a bad envelope and
      // the permanent loss of a secret that exists in no other place.
      const proof = await deps.keyProvider.decrypt(sealed.ciphertext, sealed.keyVersion);
      if (proof !== plaintext) {
        throw new RoundTripError();
      }

      const written = await tx
        .update(site.table)
        .set({ [site.ciphertext]: sealed.ciphertext, [site.keyVersion]: sealed.keyVersion })
        // COMPARE-AND-SWAP, and it is a peer of the `FOR UPDATE` above rather than a flourish
        // beneath it: mutation against real Postgres shows each one alone prevents the lost
        // update and only removing both reproduces it. Under READ COMMITTED this predicate is
        // re-evaluated against the committed row version, so a concurrent password change makes
        // it match nothing and the pass reports `raced` instead of reverting the new secret.
        .where(and(keyEq, eq(site.ctCol, current.ct), eq(site.kvCol, fromVersion)))
        .returning({ k: site.kvCol });

      if (deps.hooks?.afterUpdate) await deps.hooks.afterUpdate(site.site, label, index);

      if ((written as unknown[]).length === 0) {
        return { kind: "raced", site: site.site, row: label } as const;
      }
      return {
        kind: "rewrapped", site: site.site, row: label, from: fromVersion, to: sealed.keyVersion,
      } as const;
    });
  } catch (err) {
    // The transaction has already rolled back; the row is exactly as it was. All this decides is
    // how the failure is NAMED — and the name is drawn from a closed set rather than from the
    // error's message, so no driver string can carry a value into a report. See the header.
    return {
      kind: "failed",
      site: site.site,
      row: label,
      reason: classifyFailure(err),
      keyVersion: sawVersion,
    };
  }
}

/** Thrown by the round-trip check. Its own class so `classifyFailure` cannot confuse it. */
class RoundTripError extends Error {
  constructor() { super("re-wrapped envelope did not decrypt back to the original plaintext"); }
}

/**
 * Map a thrown value onto {@link RewrapFailureReason}.
 *
 * Matching on message text is done HERE and only here, on two strings this repository owns
 * (`crypto.ts`'s `no KEK for version N`) or that node's own cipher layer emits. The result is an
 * enum member; the message itself never leaves this function.
 */
function classifyFailure(err: unknown): RewrapFailureReason {
  if (err instanceof RoundTripError) return "roundtrip_mismatch";
  const msg = err instanceof Error ? err.message : String(err);
  if (/^no KEK for version /.test(msg)) return "no_kek_for_version";
  // GCM authentication failure, a truncated/garbled envelope, or JSON that is not one.
  if (/unable to authenticate data|Unsupported state|JSON|base64|Invalid|wrong final block/i.test(msg)) {
    return "decrypt_failed";
  }
  return "database_error";
}

/**
 * A one-line summary per site, for the runner's stdout. Counts and versions only.
 *
 * Separated from the runner so the exact wording an operator reads during an incident is covered
 * by the suite rather than by a template literal in a script nobody tests.
 */
export function formatCensus(census: KekRewrapCensus): string[] {
  const lines = census.sites.map((s) => {
    const spread = Object.keys(s.byVersion).length === 0
      ? "empty"
      : Object.entries(s.byVersion)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([v, n]) => `V${v}=${n}`).join(" ");
    const flags = [
      s.outstanding > 0 ? `${s.outstanding} outstanding` : null,
      s.ahead > 0 ? `${s.ahead} AHEAD of this host's ring` : null,
      s.mismatched > 0 ? `${s.mismatched} HALF-NULL (defect)` : null,
    ].filter(Boolean).join(", ");
    return `  ${s.site}: ${s.total} row(s) [${spread}]${flags ? ` — ${flags}` : ""}`;
  });
  lines.push(
    census.outstanding === 0
      ? `  ⇒ nothing references a version below V${census.target}. ` +
        `Versions in use: ${census.versionsInUse.map((v) => `V${v}`).join(", ") || "none"}.`
      : `  ⇒ ${census.outstanding} row(s) still below V${census.target}. ` +
        `Versions in use: ${census.versionsInUse.map((v) => `V${v}`).join(", ")}.`,
  );
  return lines;
}

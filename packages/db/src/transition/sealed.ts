import { sql } from "drizzle-orm";
import type { Executor } from "../baseline.js";
import type { MapJournal, StoreKind } from "./expected-counts.js";
import { holds } from "./expected-counts.js";
import type { Verdict } from "./report.js";

/**
 * EVERY SEALED VALUE IS UNTOUCHED AND STILL OPENS. The transition rewrites every row of six tables
 * and re-keys seven more, and a sealed value that came out different, or sealed under a key the
 * ring no longer holds, is a mailbox nobody can open and no count shows. So each one is
 * fingerprinted before the first entry and again after the last, row by row, and every one is
 * opened under the key ring inside the transaction.
 *
 * The places are `kek-rewrap.ts`'s `WRAPPED_SECRET_SITES`, said again here in the store's own
 * column names, because that module reaches the Cloud's schema and this one runs in a desktop's
 * engine. `transition-map.test.ts` holds the two lists equal, key columns included.
 *
 * NOTHING SEALED LEAVES THIS MODULE: a fingerprint is an md5 held in a temporary table and
 * compared there, an envelope is handed to the opener and dropped, and what is reported is a
 * place's name and three counts.
 */
export interface SealedSite {
  /** `<table>.<envelope column>`, the registry's own identifier. */
  readonly site: string;
  readonly journal: MapJournal;
  readonly table: string;
  readonly ciphertext: string;
  readonly keyVersion: string;
  /** The columns that identify a row. */
  readonly key: readonly string[];
}

export const SEALED_SITES: readonly SealedSite[] = [
  { site: "mailbox_credentials.secret_enc", journal: "mail", table: "mailbox_credentials", ciphertext: "secret_enc", keyVersion: "key_version", key: ["mailbox_id", "transport"] },
  { site: "cal_credentials.secret_enc", journal: "mail", table: "cal_credentials", ciphertext: "secret_enc", keyVersion: "key_version", key: ["account_id", "connection_id", "kind"] },
  { site: "totp_secrets.secret_enc", journal: "cloud", table: "totp_secrets", ciphertext: "secret_enc", keyVersion: "key_version", key: ["id"] },
  { site: "totp_secrets.pending_secret_enc", journal: "cloud", table: "totp_secrets", ciphertext: "pending_secret_enc", keyVersion: "pending_key_version", key: ["id"] },
  { site: "staff_users.totp_secret_enc", journal: "cloud", table: "staff_users", ciphertext: "totp_secret_enc", keyVersion: "totp_key_version", key: ["id"] },
  { site: "staff_users.totp_pending_secret_enc", journal: "cloud", table: "staff_users", ciphertext: "totp_pending_secret_enc", keyVersion: "totp_pending_key_version", key: ["id"] },
  { site: "mailbox_oauth_ceremonies.code_verifier_enc", journal: "cloud", table: "mailbox_oauth_ceremonies", ciphertext: "code_verifier_enc", keyVersion: "code_verifier_key_version", key: ["state"] },
  { site: "mailbox_oauth_device_ceremonies.device_code_enc", journal: "cloud", table: "mailbox_oauth_device_ceremonies", ciphertext: "device_code_enc", keyVersion: "device_code_key_version", key: ["state"] },
  { site: "oauth_provider_config.client_secret_enc", journal: "cloud", table: "oauth_provider_config", ciphertext: "client_secret_enc", keyVersion: "client_secret_key_version", key: ["provider"] },
  { site: "scheduled_send_files.dek_enc", journal: "mail", table: "scheduled_send_files", ciphertext: "dek_enc", keyVersion: "dek_key_version", key: ["account_id", "draft_id", "file_no", "seq"] },
];

/** How one envelope fared under the ring. A closed set: the opener's own error never travels. */
export type Opened = "opened" | "no_kek_for_version" | "decrypt_failed";

/** Opens one sealed value and says only whether it opened. */
export interface SealedOpener {
  open(site: string, ciphertext: string, keyVersion: number): Promise<Opened>;
}

/** The one method of a key provider the transition needs (`RewrapKeyProvider`, `KeyProvider`). */
export interface Decrypts {
  decrypt(ciphertext: string, keyVersion: number): Promise<string>;
}

/**
 * A key provider as an opener. The plaintext is dropped here; a failure is classed by the one
 * message this repository owns (`no KEK for version N`), and anything else is "did not open".
 */
export function sealedOpener(provider: Decrypts): SealedOpener {
  return {
    async open(_site, ciphertext, keyVersion) {
      try {
        await provider.decrypt(ciphertext, keyVersion);
        return "opened";
      } catch (err) {
        return /^no KEK for version /.test(err instanceof Error ? err.message : "") ? "no_kek_for_version" : "decrypt_failed";
      }
    },
  };
}

/** An opener for a store that must hold nothing sealed: every value it is shown fails. */
export const NOTHING_OPENS: SealedOpener = { open: async () => "decrypt_failed" };

const FINGERPRINTS = "pg_temp.ohmail_transition_sealed";

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? result as T[] : (((result as { rows?: T[] } | null)?.rows) ?? []);
}

/** The places a store of `kind` holds, among those whose table stands right now. */
async function standing(tx: Executor, kind: StoreKind): Promise<SealedSite[]> {
  const out: SealedSite[] = [];
  for (const s of SEALED_SITES) {
    if (!holds(kind, s.journal)) continue;
    const [r] = rowsOf<{ there: boolean }>(await tx.execute(sql`select to_regclass(${`public.${s.table}`}) is not null as there`));
    if (r?.there === true) out.push(s);
  }
  return out;
}

/** One fingerprint per sealed row, under `phase`. The names are this module's own constants. */
export async function fingerprintSealed(tx: Executor, kind: StoreKind, phase: "before" | "after"): Promise<void> {
  if (phase === "before") {
    await tx.execute(sql.raw(`create temporary table ohmail_transition_sealed
      (phase text not null, site text not null, ident text not null, fingerprint text not null) on commit drop`));
  }
  for (const s of await standing(tx, kind)) {
    const ident = s.key.map((k) => `"${k}"::text`).join(` || '|' || `);
    await tx.execute(sql.raw(`insert into ${FINGERPRINTS}
      select '${phase}', '${s.site}', md5(${ident}), md5("${s.ciphertext}" || ':' || coalesce("${s.keyVersion}"::text, ''))
        from "${s.table}" where "${s.ciphertext}" is not null`));
  }
}

/** Before against after, row by row: a value changed, lost or added is red. */
export async function compareSealed(tx: Executor): Promise<Verdict[]> {
  const [d] = rowsOf<{ differ: string; before: string; after: string }>(await tx.execute(sql.raw(`
    select (select count(*) from (
              (select site, ident, fingerprint from ${FINGERPRINTS} where phase = 'before'
               except select site, ident, fingerprint from ${FINGERPRINTS} where phase = 'after')
              union all
              (select site, ident, fingerprint from ${FINGERPRINTS} where phase = 'after'
               except select site, ident, fingerprint from ${FINGERPRINTS} where phase = 'before')) x)::text as differ,
           (select count(*) from ${FINGERPRINTS} where phase = 'before')::text as before,
           (select count(*) from ${FINGERPRINTS} where phase = 'after')::text as after`)));
  return [
    { check: "sealed values changed, lost or added", subject: "every sealed place", expected: "0", found: d!.differ, ok: d!.differ === "0" },
    { check: "sealed values compared", subject: "every sealed place", expected: d!.before, found: d!.after, ok: d!.before === d!.after },
  ];
}

/** Every sealed value of every place, opened under the ring. One verdict per place: its rows, and how many failed. */
export async function openSealed(
  tx: Executor, kind: StoreKind, opener: SealedOpener,
): Promise<{ site: string; rows: number; opened: number; failed: number }[]> {
  const out: { site: string; rows: number; opened: number; failed: number }[] = [];
  for (const s of await standing(tx, kind)) {
    const rows = rowsOf<{ c: string; v: number }>(await tx.execute(sql.raw(
      `select "${s.ciphertext}" as c, "${s.keyVersion}" as v from "${s.table}" where "${s.ciphertext}" is not null`)));
    let opened = 0;
    for (const r of rows) if (await opener.open(s.site, r.c, Number(r.v)) === "opened") opened += 1;
    out.push({ site: s.site, rows: rows.length, opened, failed: rows.length - opened });
  }
  return out;
}

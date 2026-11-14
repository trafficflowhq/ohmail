import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { COUNTER_KEY_FAMILIES } from "../src/counter-keys.js";
import { PG_TEST_URL, type ThrowawayDb } from "../src/testing.js";
import type { Decrypts } from "../src/transition/index.js";
import { COUNTER_SAMPLES } from "./_counter-samples.js";
import { plantAccount, plantLetter, plantPassMarks, type MovedPassRow } from "./_store-at-old-heads.js";

type Sql = ReturnType<typeof postgres>;

/**
 * ROWS FOR A STORE IN 1.0.11'S SHAPE, written in 1.0's columns in plain SQL: what the 2.0 entries
 * move, fill and re-key, and what the transition's checks read. Invented, on `.test` addresses;
 * every count a test asserts is one it can compute from what is planted here.
 *
 * It covers the tables the window touches (the thirteen that borrowed their account, the passes'
 * marks, the counters of every family, the alerts' three key shapes, the sealed places). It does
 * NOT put a row in every table of the store: the others are counted at zero.
 */

/** A toy key ring: the envelope's format is `crypto.ts`'s business, that every value is opened is the transition's. */
export function testRing(versions: readonly number[] = [1]): Decrypts & { seal(plain: string, version?: number): { ciphertext: string; keyVersion: number } } {
  return {
    seal: (plain, version = versions.at(-1)!) => ({ ciphertext: `v${version}:${Buffer.from(plain).toString("base64url")}`, keyVersion: version }),
    async decrypt(ciphertext, keyVersion) {
      if (!versions.includes(keyVersion)) throw new Error(`no KEK for version ${keyVersion}`);
      const m = /^v(\d+):(.*)$/.exec(ciphertext);
      if (!m || Number(m[1]) !== keyVersion) throw new Error("unable to authenticate data");
      return Buffer.from(m[2]!, "base64url").toString();
    },
  };
}

export interface Planted {
  /** The account that holds mail, people and sign-in rows. */
  readonly main: { accountId: string; mailboxId: string; userId: string };
  /** A second account with one user, so "another account's parent" is a real row. */
  readonly other: { accountId: string; mailboxId: string; userId: string };
  /** `pass_progress` afterwards, value by value. */
  readonly passRows: MovedPassRow[];
  readonly letters: number;
  /** Counter keys that must be in `account_counters` afterwards, and those that must stay. */
  readonly countersMoved: string[];
  readonly countersStayed: string[];
  /** Sealed values planted, by place. */
  readonly sealed: Record<string, number>;
}

const LATER = "2031-01-01T00:00:00Z";

/** One account's user, in 1.0's columns. */
async function plantUser(sql: Sql, accountId: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`insert into users (account_id, email)
    values (${accountId}, ${`${accountId.slice(0, 8)}@iso.test`}) returning id`;
  return u!.id;
}

export async function plant1011(
  sql: Sql, o: { cloud: boolean; ring?: ReturnType<typeof testRing>; lettersOnlyTheOldSearchFinds?: number },
): Promise<Planted> {
  const ring = o.ring ?? testRing();
  const passRows = await plantPassMarks(sql);
  // The first of those three accounts carries every mark, the search's included: its letters are
  // found by the document search, so the old search may go.
  const [whole] = await sql<{ account_id: string; id: string }[]>`
    select b.account_id, b.id from mailboxes b join account_settings s on s.account_id = b.account_id
     where s.search_index_built_at is not null and b.kickstart_at is not null limit 1`;
  const main = { accountId: whole!.account_id, mailboxId: whole!.id, userId: await plantUser(sql, whole!.account_id) };
  const second = await plantAccount(sql, randomUUID());
  const other = { ...second, userId: await plantUser(sql, second.accountId) };

  // Letters with bodies, and the two tables whose triggers kept a copy of the account.
  let letters = 0;
  for (let i = 0; i < 4; i++) {
    const id = await plantLetter(sql, main, { subject: `planted ${i}`, text: `body of the planted letter ${i}` });
    letters += 1;
    await sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by, reconcile_status)
      values (${id}, 'ohmail/News', 'INBOX', 'us', ${i % 2 === 0 ? "pending" : "synced"})`;
    await sql`insert into flag_state (message_id, desired_seen, observed_seen, last_set_by, reconcile_status)
      values (${id}, true, false, 'us', ${i % 2 === 0 ? "pending" : "synced"})`;
  }
  // Letters no document search finds, in an account whose search pass never ran: the old search's own.
  if ((o.lettersOnlyTheOldSearchFinds ?? 0) > 0) {
    for (let i = 0; i < o.lettersOnlyTheOldSearchFinds!; i++) {
      await plantLetter(sql, other, { subject: `old ${i}`, text: `only the old search finds letter ${i}` });
      letters += 1;
    }
  }

  const sealed: Record<string, number> = {};
  const seal = (site: string, plain: string) => { sealed[site] = (sealed[site] ?? 0) + 1; return ring.seal(plain); };
  for (const who of [main, other]) {
    const s = seal("mailbox_credentials.secret_enc", `imap secret of ${who.mailboxId}`);
    await sql`insert into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
      values (${who.mailboxId}, 'imap', ${s.ciphertext}, ${s.keyVersion})`;
    await sql`insert into mailbox_folders (mailbox_id, folder) values (${who.mailboxId}, 'INBOX'), (${who.mailboxId}, 'ohmail/News')`;
    await sql`insert into pairing_tokens ("grant", token_hash, expires_at, created_by_user_id)
      values ('device-pair', ${`pt-${randomUUID()}`}, ${LATER}, ${who.userId})`;
  }
  // A pairing token nobody is recorded as having made: it names no user and must name no account.
  await sql`insert into pairing_tokens ("grant", token_hash, expires_at) values ('device-pair', ${`pt-${randomUUID()}`}, ${LATER})`;

  const countersMoved: string[] = [];
  const countersStayed: string[] = [];
  if (!o.cloud) return { main, other, passRows, letters, countersMoved, countersStayed, sealed };

  // ── the hosted half ───────────────────────────────────────────────────────────────────────────
  for (const who of [main, other]) {
    await sql`insert into credentials (user_id, password_hash) values (${who.userId}, 'scrypt$planted')`;
    const t = seal("totp_secrets.secret_enc", `totp of ${who.userId}`);
    await sql`insert into totp_secrets (user_id, secret_enc, key_version) values (${who.userId}, ${t.ciphertext}, ${t.keyVersion})`;
    await sql`insert into recovery_codes (user_id, code_hash, batch_id) values (${who.userId}, ${`rc-${randomUUID()}`}, ${randomUUID()})`;
    await sql`insert into webauthn_credentials (user_id, credential_id, public_key) values (${who.userId}, ${`cred-${randomUUID()}`}, 'pk')`;
    await sql`insert into oauth_auth_codes (user_id, client_id, code_hash, code_challenge, redirect_uri, expires_at)
      values (${who.userId}, 'desktop', ${`ch-${randomUUID()}`}, 'cc', 'ohmail://cb', ${LATER})`;
    await sql`insert into login_tokens (user_id, token_hash, expires_at) values (${who.userId}, ${`lt-${randomUUID()}`}, ${LATER})`;
    await sql`insert into webauthn_challenges (user_id, challenge, type, rp_id, origin, expires_at)
      values (${who.userId}, ${`wc-${randomUUID()}`}, 'registration', 'iso.test', 'https://iso.test', ${LATER})`;
    // An event that names its user and no account: cloud 0100 gives it the user's.
    await sql`insert into auth_events (user_id, event) values (${who.userId}, 'login')`;
    await sql`insert into push_subscriptions (account_id, transport, endpoint) values (${who.accountId}, 'unifiedpush', ${`https://push.iso.test/${randomUUID()}`})`;
    const c = seal("mailbox_oauth_ceremonies.code_verifier_enc", `verifier of ${who.accountId}`);
    await sql`insert into mailbox_oauth_ceremonies (state, account_id, provider, code_verifier_enc, code_verifier_key_version)
      values (${`state-${randomUUID()}`}, ${who.accountId}, 'microsoft', ${c.ciphertext}, ${c.keyVersion})`;
  }
  // A desktop approval nobody confirmed, and the ceremony that names a login token: no user, so no account.
  const [approval] = await sql<{ id: string }[]>`insert into login_tokens (token_hash, expires_at, purpose)
    values (${`lt-${randomUUID()}`}, ${LATER}, 'desktop_approval') returning id`;
  await sql`insert into webauthn_challenges (login_token_id, challenge, type, rp_id, origin, expires_at)
    values (${approval!.id}, ${`wc-${randomUUID()}`}, 'authentication', 'iso.test', 'https://iso.test', ${LATER})`;

  // One counter of every family, with numbers a move must keep; then the rows cloud 0101 deletes.
  const ids = { userId: main.userId, mailboxId: main.mailboxId, accountId: main.accountId };
  for (const f of COUNTER_KEY_FAMILIES) {
    const key = COUNTER_SAMPLES[f.prefix]!(ids);
    await sql`insert into auth_throttle (key, failures, locked_until, window_started_at) values (${key}, 3, ${LATER}, '2026-03-01T00:00:00Z')`;
    (f.class === "moves" ? countersMoved : f.class === "stays" ? countersStayed : []).push(key);
  }
  // A counter whose user is gone, the form with an address in it, and a notice owed on a hashed address.
  const owedNotice = `notice:ceiling:${"0".repeat(32)}`;
  for (const [key, failures] of [[`user:${randomUUID()}`, 1], ["email:someone@iso.test", 2], [owedNotice, 1]] as const) {
    await sql`insert into auth_throttle (key, failures) values (${key}, ${failures})`;
  }
  countersStayed.push(owedNotice);

  // Alerts about a subject, in the three shapes of key, and one about the service.
  const [device] = await sql<{ id: string }[]>`insert into devices (account_id, user_id, kind) values (${main.accountId}, ${main.userId}, 'web') returning id`;
  const [session] = await sql<{ id: string }[]>`insert into sessions (account_id, user_id, family_id, access_expires_at, refresh_expires_at)
    values (${main.accountId}, ${main.userId}, ${randomUUID()}, ${LATER}, ${LATER}) returning id`;
  for (const key of [`session_reuse_revoked:${main.accountId}`, `device_sync_stale:${device!.id}`, `session_sync_stale:${session!.id}`, "worker_down:0"]) {
    await sql`insert into alert_state (alert_key, kind) values (${key}, ${key.split(":")[0]!})`;
  }
  return { main, other, passRows, letters, countersMoved, countersStayed, sealed };
}

/** `into` as a copy of `base`, by the server's own copy of a database: a planted store, once per case. */
export async function cloneStore(base: ThrowawayDb, into: ThrowawayDb): Promise<void> {
  // Both names are `throwawayDb`'s own (lower-case, digits and `_`).
  const admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => { /* quiet */ } });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${into.name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${into.name}" TEMPLATE "${base.name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Every table of `public` with its count, and both ledgers' rows: what "as it was" means. */
export async function fingerprintOf(sql: Sql): Promise<{ catalog: string; counts: Record<string, number>; ledgers: string }> {
  const columns = await sql<{ line: string }[]>`
    select table_name || '.' || column_name || ' #' || ordinal_position || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as line
      from information_schema.columns where table_schema = 'public' order by 1`;
  const constraints = await sql<{ line: string }[]>`
    select c.conrelid::regclass::text || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid) || ' ' || c.convalidated as line
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public' order by 1`;
  const indexes = await sql<{ line: string }[]>`select indexdef as line from pg_indexes where schemaname = 'public' order by 1`;
  const triggers = await sql<{ line: string }[]>`
    select t.tgrelid::regclass::text || ' ' || t.tgname as line from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal order by 1`;
  const functions = await sql<{ line: string }[]>`
    select p.proname || ' ' || md5(p.prosrc) as line from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1`;
  const tables = await sql<{ name: string }[]>`
    select c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`;
  const counts: Record<string, number> = {};
  // A name is whatever its owner made it: quoted as an identifier, never pasted.
  for (const t of tables) counts[t.name] = Number((await sql.unsafe(`select count(*)::int as n from public."${t.name.replaceAll('"', '""')}"`))[0]!.n);
  const ledger = async (schema: string): Promise<string> => {
    const [there] = await sql<{ there: boolean }[]>`select to_regclass(${`${schema}.__drizzle_migrations`}) is not null as there`;
    if (!there!.there) return `${schema}: none`;
    const rows = await sql.unsafe(`select hash || ':' || created_at as line from "${schema}"."__drizzle_migrations" order by created_at, hash`);
    return `${schema}: ${rows.map((r) => r.line as string).join(",")}`;
  };
  const statistics = await sql<{ line: string }[]>`
    select x.stxname || ' on ' || x.stxrelid::regclass::text as line from pg_statistic_ext x join pg_namespace n on n.oid = x.stxnamespace
     where n.nspname = 'public' order by 1`;
  return {
    catalog: [...columns, ...constraints, ...indexes, ...triggers, ...functions, ...statistics].map((r) => r.line).join("\n"),
    counts,
    ledgers: `${await ledger("drizzle_mail")}\n${await ledger("drizzle_cloud")}`,
  };
}

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { StaticKeyProvider } from "@trafficflow/core/mail";
import { MAIL_JOURNAL, OLD_HEADS, readJournalOf } from "@trafficflow/db/journal";
import { journalThrough } from "../../../packages/db/src/testing-journal.js";
import { LOCAL_STORE_EXTENSIONS, PGDATA_SUBDIR } from "../src/db.js";
import { templateKey } from "./_datadir.js";

/**
 * A DATA FOLDER A 1.0 DESKTOP LEFT, for the tests of the store's update. Its store stands at
 * 1.0.11's head, made the way that release made it: the mail journal as it stood at that head,
 * by drizzle's own migrator, with the engine's extensions. One account, two mailboxes with a
 * password each, sealed under {@link OLD_STORE.keks}, and one letter, all in 1.0's columns.
 * Built once per journal and copied, like the template of `_datadir.ts`.
 */
export const OLD_STORE = {
  accountId: "00000000-0000-4000-8000-000000000001",
  mailboxId: "00000000-0000-4000-8000-000000000002",
  secondMailboxId: "00000000-0000-4000-8000-000000000003",
  letterId: "00000000-0000-4000-8000-000000000004",
  address: "desk@planted.test",
  password: "the-planted-password",
  subject: "the planted letter",
  words: "words a 1.0 store held before its update",
  /** The install's key ring: every launch of a case takes the same one. */
  keks: { 1: Buffer.alloc(32, 7) } as Record<number, Buffer>,
} as const;

/** 1.0.11's head, and the head a store stands at once this tree's journal has run. */
export const OLD_HEAD = OLD_HEADS.mail.when;
export const NEW_HEAD = readJournalOf(MAIL_JOURNAL).at(-1)!.when;

/** The install's key ring as a provider: what the engine hands the store's update. */
export const ring = (): StaticKeyProvider => new StaticKeyProvider(OLD_STORE.keks);

let template: Promise<string> | null = null;

async function build(): Promise<string> {
  const shared = join(realpathSync(tmpdir()), `ohmail-old-head-template-${templateKey()}-${OLD_HEAD}`);
  if (existsSync(join(shared, "PG_VERSION"))) return shared;
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-old-head-build-"));
  try {
    const client = new PGlite(join(scratch, PGDATA_SUBDIR), { extensions: LOCAL_STORE_EXTENSIONS });
    const cut = journalThrough(MAIL_JOURNAL, OLD_HEAD);
    try {
      await migrate(drizzle(client), { migrationsFolder: cut.spec.dir, migrationsSchema: cut.spec.migrationsSchema });
    } finally { cut.dispose(); }
    const sealed = await ring().encrypt(OLD_STORE.password);
    await client.query(`insert into accounts (id, name) values ($1, 'desk')`, [OLD_STORE.accountId]);
    await client.query(
      `insert into mailboxes (id, account_id, provider, address, kickstart_at) values ($1, $2, 'imap', $3, now()), ($4, $2, 'imap', 'second@planted.test', null)`,
      [OLD_STORE.mailboxId, OLD_STORE.accountId, OLD_STORE.address, OLD_STORE.secondMailboxId]);
    await client.query(
      `insert into mailbox_credentials (mailbox_id, transport, secret_enc, key_version) values ($1, 'imap', $3, $4), ($2, 'imap', $3, $4)`,
      [OLD_STORE.mailboxId, OLD_STORE.secondMailboxId, sealed.ciphertext, sealed.keyVersion]);
    await client.query(
      `insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, date) values ($1, $2, $3, 'h', 'planted:1', $4, now())`,
      [OLD_STORE.letterId, OLD_STORE.accountId, OLD_STORE.mailboxId, OLD_STORE.subject]);
    await client.query(`insert into message_bodies (message_id, text) values ($1, $2)`, [OLD_STORE.letterId, OLD_STORE.words]);
    await client.close();
    try {
      renameSync(join(scratch, PGDATA_SUBDIR), shared);
    } catch {
      // Another worker published first; take theirs.
      if (!existsSync(join(shared, "PG_VERSION"))) throw new Error("[old-head] no template after the rename");
    }
    return shared;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A new data folder holding a copy of the 1.0.11 store, and nothing else. */
export async function folderAtOldHead(prefix = "ohmail-old-head-"): Promise<string> {
  template ??= build();
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  cpSync(await template, join(dir, PGDATA_SUBDIR), { recursive: true });
  return dir;
}

/** What a store at `pgdata` holds of the planted mailbox, read the way 1.0 reads it: its head, its letter, its password. */
export async function readAsOneOh(pgdata: string): Promise<{ head: number; subject: string | null; words: string | null; password: string | null }> {
  const client = new PGlite(pgdata, { extensions: LOCAL_STORE_EXTENSIONS });
  try {
    const one = async <T>(text: string, params: unknown[] = []): Promise<T | undefined> => (await client.query<T>(text, params)).rows[0];
    const head = Number((await one<{ head: string }>(`select max(created_at)::text as head from "drizzle_mail"."__drizzle_migrations"`))!.head);
    const letter = await one<{ subject: string; text: string }>(
      `select m.subject, b.text from messages m join message_bodies b on b.message_id = m.id where m.id = $1`, [OLD_STORE.letterId]);
    const cred = await one<{ secret_enc: string; key_version: number }>(
      `select secret_enc, key_version from mailbox_credentials where mailbox_id = $1 and transport = 'imap'`, [OLD_STORE.mailboxId]);
    const password = cred ? await ring().decrypt(cred.secret_enc, cred.key_version).catch(() => null) : null;
    return { head, subject: letter?.subject ?? null, words: letter?.text ?? null, password };
  } finally {
    await client.close();
  }
}

/** Every file under `dir` with its bytes and (`ino`) its inode: what "byte-equal" and "no shared inode" are read from. */
export function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string): void => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(at, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(at, e.name), "latin1");
    }
  };
  walk(dir, "");
  return out;
}

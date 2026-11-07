import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { accounts, mailboxes, messages, messageBodies } from "@trafficflow/db";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE DESKTOP'S STORE CARRIES THE BOUNDED BODY VECTOR (mail 0140). Every sidecar test copies one
 * migrated PGDATA template, so a stale template would keep the generated column and this suite
 * would stay green on the old shape. This opens the store a desktop opens and asks it: the vector
 * is kept by the trigger, a body past the bound stores whole, and a store limit still reaches the
 * engine carrying its SQLSTATE, the code the shared classifier reads.
 */
describe("the local store's body vector (mail 0140)", () => {
  let opened: OpenLocalDb;
  let dir: string;
  beforeAll(async () => {
    dir = await freshDataDir("ohmail-body-vector-");
    opened = await openLocalDb(dir);
  }, 120_000);
  afterAll(async () => {
    await opened?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const rows = async <T,>(q: SQL): Promise<T[]> => {
    const r = await opened.db.execute(q);
    return ((r as { rows?: T[] }).rows ?? (r as unknown as T[]));
  };
  /** `prefix0x prefix1x …` to at least `chars` characters, distinct words. */
  const distinctWords = (prefix: string, chars: number): string => {
    const words: string[] = []; let len = 0;
    for (let n = 0; len < chars; n++) { const w = `${prefix}${n.toString(36)}x`; words.push(w); len += w.length + 1; }
    return words.join(" ");
  };

  it("keeps the vector by its trigger, never as a generated column", async () => {
    const [t] = await rows<{ n: number }>(sql`select count(*)::int as n from pg_trigger
      where tgname = 'message_bodies_body_tsv_tg' and tgrelid = 'message_bodies'::regclass`);
    const [c] = await rows<{ g: string }>(sql`select attgenerated as g from pg_attribute
      where attrelid = 'message_bodies'::regclass and attname = 'body_tsv'`);
    expect([Number(t!.n), c!.g]).toEqual([1, ""]);
  });

  it("keeps the bounded vector and its index: only a server's setup retires them, a paired desktop searches by them", async () => {
    const [r] = await rows<{ f: string; ix: boolean }>(sql`select p.proname as f,
        to_regclass('public.message_bodies_body_tsv_idx') is not null as ix
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgname = 'message_bodies_body_tsv_tg' and t.tgrelid = 'message_bodies'::regclass`);
    expect([r!.f, r!.ix]).toEqual(["message_bodies_body_tsv_bounded", true]);
  });

  it("stores a 2 MiB body of distinct words whole and finds it by its first part", async () => {
    const accountId = randomUUID();
    await opened.db.insert(accounts).values({ id: accountId, name: "vector" });
    const [mb] = await opened.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: "me@ohmail.test" }).returning();
    const [m] = await opened.db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `${accountId}:0`, subject: "s", date: new Date(),
    }).returning();
    const text = distinctWords("b", 2 * 1024 * 1024);
    await opened.db.insert(messageBodies).values({ messageId: m!.id, text, html: null, headers: {} });
    const [r] = await rows<{ chars: number; head: boolean; tail: boolean }>(sql`
      select char_length(text) as chars,
             body_tsv @@ plainto_tsquery('english', 'b1x') as head,
             body_tsv @@ plainto_tsquery('english', ${text.slice(-12).split(" ").pop()!}) as tail
        from message_bodies where message_id = ${m!.id}`);
    expect([Number(r!.chars), r!.head, r!.tail]).toEqual([text.length, true, false]);
  });

  it("hands the engine a store limit with its SQLSTATE, inside a transaction as ingest runs one", async () => {
    const big = distinctWords("d", 2 * 1024 * 1024);
    const err = await opened.db.transaction(async (tx) => {
      await tx.execute(sql`select to_tsvector('english', ${big})`);
    }).then(() => null, (e: unknown) => e);
    expect((err as { code?: unknown } | null)?.code).toBe("54000");
  });
});

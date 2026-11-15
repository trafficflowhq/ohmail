import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { dialect } from "../src/dialect/index.js";
import { sweepMailboxData } from "../src/mailbox-erasure.js";
import type { LedgerTx } from "../src/change-log.js";

/**
 * A MAILBOX'S ERASURE TAKES THE CALENDAR THAT RIDES IT: a connection whose sign-in is the
 * mailbox's goes with its whole family, and the links and suggestions the mailbox's letters made
 * go too; a connection on its own and a sibling mailbox's rows stay. Each record taken is sent as
 * its own deletion, children first, before the mailbox's receipt. Run through the real sweep.
 */
async function world() {
  const db = await makeTestDb();
  const client = (db as unknown as { $client: { query(t: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const q = async (t: string, p: unknown[] = []) => (await client.query(t, p)).rows;
  const accountId = randomUUID();
  const [gone, kept] = [randomUUID(), randomUUID()];
  await q(`insert into accounts (id, name) values ($1, 'cal-erase')`, [accountId]);
  for (const [id, n] of [[gone, 1], [kept, 2]] as const) {
    await q(`insert into mailboxes (id, account_id, provider, address) values ($1, $2, 'imap', $3)`, [id, accountId, `m${n}-${id}@example.test`]);
  }
  const family = async (mailboxId: string | null, events: number) => {
    const conn = randomUUID();
    const cal = randomUUID();
    await q(`insert into cal_connections (id, account_id, provider, mailbox_id) values ($1, $2, 'google', $3)`, [conn, accountId, mailboxId]);
    await q(`insert into cal_credentials (account_id, connection_id, kind, secret_enc, key_version) values ($1, $2, 'oauth', 'sealed', 1)`, [accountId, conn]);
    await q(`insert into cal_calendars (id, account_id, connection_id, provider_id) values ($1, $2, $3, $4)`, [cal, accountId, conn, `p-${cal}`]);
    await q(`insert into cal_alarms (account_id, calendar_id, minutes_before) values ($1, $2, 10)`, [accountId, cal]);
    await q(`insert into cal_writes (account_id, calendar_id, op, payload, idempotency_key) values ($1, $2, 'create', '{}'::jsonb, $3)`, [accountId, cal, randomUUID()]);
    for (let i = 0; i < events; i++) {
      const ev = randomUUID();
      await q(`insert into cal_events (id, account_id, calendar_id, provider_id, uid, start_kind, start_local, starts_at, ends_at)
        values ($1, $2, $3, $4, 'u', 'date', '20261114', now(), now())`, [ev, accountId, cal, `e-${ev}`]);
      await q(`insert into cal_attendees (account_id, event_id, address) values ($1, $2, 'a@example.test')`, [accountId, ev]);
      await q(`insert into cal_alarms (account_id, event_id, minutes_before) values ($1, $2, 5)`, [accountId, ev]);
    }
    return conn;
  };
  const riding = await family(gone, 3);
  const alone = await family(null, 2);
  const elsewhere = await family(kept, 1);
  for (const mb of [gone, kept]) {
    await q(`insert into cal_suggestions (account_id, message_id, mailbox_id, evidence, proposed) values ($1, $2, $3, 'dates', '{}'::jsonb)`, [accountId, randomUUID(), mb]);
    await q(`insert into cal_links (account_id, message_id, mailbox_id, uid, kind) values ($1, $2, $3, 'u', 'invitation')`, [accountId, randomUUID(), mb]);
  }
  await q(`update mailboxes set status = 'disabled' where id = $1`, [gone]);
  return { db, q, accountId, gone, kept, riding, alone, elsewhere };
}

const counts = async (q: (t: string, p?: unknown[]) => Promise<Record<string, unknown>[]>, where: string, p: unknown[]) =>
  Number((await q(`select count(*)::int as n from ${where}`, p))[0]!.n);

describe("a mailbox's erasure and the calendar that rides it", () => {
  it("takes the riding connection's whole family and the mailbox's letters' words, and nothing else", async () => {
    const w = await world();
    await w.db.transaction((tx) => sweepMailboxData(tx as unknown as LedgerTx, dialect(w.db), { accountId: w.accountId, mailboxId: w.gone, now: new Date() }));
    expect(await counts(w.q, "cal_connections where id = $1", [w.riding])).toBe(0);
    expect(await counts(w.q, "cal_connections where id = any($1::uuid[])", [[w.alone, w.elsewhere]])).toBe(2);
    expect(await counts(w.q, "cal_calendars", [])).toBe(2);
    expect(await counts(w.q, "cal_events", [])).toBe(3);
    expect(await counts(w.q, "cal_attendees", [])).toBe(3);
    expect(await counts(w.q, "cal_credentials", [])).toBe(2);
    expect(await counts(w.q, "cal_writes", [])).toBe(2);
    expect(await counts(w.q, "cal_alarms", [])).toBe(5);
    expect(await counts(w.q, "cal_suggestions where mailbox_id = $1", [w.gone])).toBe(0);
    expect(await counts(w.q, "cal_links where mailbox_id = $1", [w.gone])).toBe(0);
    expect(await counts(w.q, "cal_suggestions where mailbox_id = $1", [w.kept])).toBe(1);
    expect(await counts(w.q, "cal_links where mailbox_id = $1", [w.kept])).toBe(1);
    // The finish stamp is set only once the calendar is done, and after its deletions.
    const [mb] = await w.q(`select erasure_done_at from mailboxes where id = $1`, [w.gone]);
    expect(mb!.erasure_done_at).not.toBeNull();
    const log = await w.q(`select entity_type::text as t, op::text as op from change_log where account_id = $1 order by seq`, [w.accountId]);
    const kinds = log.map((r) => `${r.t}:${r.op}`);
    expect(kinds.filter((k) => k === "calendar_event:delete")).toHaveLength(3);
    expect(kinds.indexOf("calendar:delete")).toBeGreaterThan(kinds.lastIndexOf("calendar_event:delete"));
    expect(kinds.indexOf("calendar_connection:delete")).toBeGreaterThan(kinds.indexOf("calendar:delete"));
    expect(kinds.indexOf("calendar_suggestion:delete")).toBeGreaterThan(-1);
    expect(kinds[kinds.length - 1]).toBe("mailbox:delete");
  });
});

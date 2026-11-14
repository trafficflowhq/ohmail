import { accountOfMailbox } from "@trafficflow/db";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, asc, eq, inArray } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, attachments, mailboxes, mailboxFolders, messageBodies, messageFailures, messages } from "@trafficflow/db";
import { MAX_BIND_PARAMETERS, schema, withBindLimit } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { normalizeMime, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { markDatabaseFaults } from "../src/db-fault.js";
import { DatabaseFaultError, classifyIngestFault, isSharedDatabaseFault } from "../src/dead-letter.js";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet, rawOf } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ONE CRAFTED MESSAGE CANNOT HOLD A FOLDER, on real Postgres through the worker's real ingest.
 * Each shape below met a store limit (`54000`, or the driver's parameter ceiling) before ingest or
 * the schema bounded it: the message's transaction rolled back, the fault read as a shared database
 * outage, the cursor held and the message came back every cycle. Each case delivers the crafted
 * message with an ordinary one behind it and runs five cycles: no cycle throws, and the stored rows
 * say what the bound did. The planted case is the net for a limit nobody has bounded yet; the
 * References flood and the commit-time 54000 are the two ways a fault that is NOT this message's
 * once read as this message's, and both now leave every message stored.
 */
const PG_UP = await realPgAvailable();
const CYCLES = 5;

/** `prefix0x prefix1x …` to at least `bytes` characters, distinct words, built in one pass. */
function distinctWords(prefix: string, bytes: number): string {
  const words: string[] = []; let len = 0;
  for (let n = 0; len < bytes; n++) { const w = `${prefix}${n.toString(36)}x`; words.push(w); len += w.length + 1; }
  return words.join(" ");
}

/** The same words, ten to a CRLF line, as a sender's body would carry them. */
function distinctLines(prefix: string, bytes: number): string {
  const lines: string[] = []; let len = 0;
  for (let n = 0; len < bytes;) {
    const words: string[] = [];
    for (let k = 0; k < 10; k++, n++) words.push(`${prefix}${n.toString(36)}x`);
    const line = words.join(" "); lines.push(line); len += line.length + 2;
  }
  return lines.join("\r\n");
}

/** A multipart of one text part and `n` empty `attachment` parts, ~42 bytes each. */
function manyParts(n: number): { contentType: string; body: string } {
  const parts = ["--p", "Content-Type: text/plain", "", "hello"];
  for (let i = 0; i < n; i++) parts.push("--p", "Content-Disposition: attachment", "", "");
  parts.push("--p--", "");
  return { contentType: 'multipart/mixed; boundary="p"', body: parts.join("\r\n") };
}

const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

/** A cycle's verdict in our own words: the tagged call and the store's code, never the cause's text. */
function verdictOf(e: unknown): string {
  const cause = e instanceof DatabaseFaultError ? e.cause : e;
  const code = (cause as { code?: unknown } | null)?.code;
  const where = e instanceof DatabaseFaultError ? e.message : ((e as { name?: unknown } | null)?.name ?? "a throw");
  return `threw ${String(where)}${typeof code === "string" ? ` [${code}]` : ""}` +
    `${isSharedDatabaseFault(e) ? " (shared database fault)" : ""}`;
}

/** Parameters per INSERT statement into these tables, read off each statement the driver built. */
const attachmentStatements: number[] = [];
const contactStatements: number[] = [];

describe.skipIf(!PG_UP)("one crafted message is stored and the folder keeps moving", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const made: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, {
      max: 3, onnotice: () => {},
      // Called as each statement is built, BEFORE the driver's parameter ceiling is checked.
      debug: (_c: number, text: string, params: unknown[]) => {
        if (text.startsWith('insert into "attachments"')) attachmentStatements.push(params.length);
        if (text.startsWith('insert into "contacts"')) contactStatements.push(params.length);
      },
    });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 180_000);

  // Every row this file wrote, by its accounts: tables are retried until the foreign keys allow it.
  afterAll(async () => {
    if (sql && made.length > 0) {
      const tables = await sql<{ t: string }[]>`select table_name as t from information_schema.columns
        where table_schema = 'public' and column_name = 'account_id' group by table_name`;
      let left = tables.map((r) => r.t);
      for (let pass = 0; pass < 8 && left.length > 0; pass++) {
        const next: string[] = [];
        for (const t of left) {
          try { await sql.unsafe(`delete from "${t}" where account_id = any($1::uuid[])`, [made]); }
          catch { next.push(t); }
        }
        left = next;
      }
      await sql`delete from accounts where id = any(${made}::uuid[])`.catch(() => {});
    }
    await sql?.end({ timeout: 5 });
  });

  async function cycles(poison: { from: string; subject: string; messageId: string; contentType?: string; body?: string }) {
    const accountId = randomUUID();
    made.push(accountId);
    await db.insert(accounts).values({ id: accountId, name: `hb-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `hb-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
    );
    const behind = { from: "Anna <anna@example.com>", subject: "behind it", messageId: `hb-behind-${randomUUID()}@example.com` };
    fleet.behave(mb!.id, { deliver: [poison, behind] });
    const repo = markDatabaseFaults(makeDrizzleRepo(db as never), "repo");
    const outcomes: string[] = [];
    const stored: number[] = [];
    for (let i = 0; i < CYCLES; i++) {
      const r = await runSyncCycle({
        writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId: mb!.id,
        storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
      }).then(() => "ok", verdictOf);
      outcomes.push(r);
      stored.push((await db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, mb!.id))).length);
    }
    const rows = await db.select({
      fromAddress: messages.fromAddress, fromName: messages.fromName, subject: messages.subject,
      messageIdHeader: messages.messageIdHeader,
    }).from(messages).where(inArray(messages.accountId, [accountId])).orderBy(asc(messages.subject));
    // Counts and outcomes only: what the five cycles did, readable in a run's log.
    console.log(`CYCLES ${poison.subject.slice(0, 18)} outcomes=${outcomes.join(",")} stored=${stored.join(",")}`);
    return { outcomes, stored, rows, mailboxId: mb!.id };
  }

  const expectMoving = (r: Awaited<ReturnType<typeof cycles>>) => {
    expect(r.outcomes).toEqual(Array(CYCLES).fill("ok"));
    expect(r.stored).toEqual(Array(CYCLES).fill(2));
  };

  const idOf = async (mailboxId: string, subject: string): Promise<string> => {
    const [m] = await db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.subject, subject)));
    return m!.id;
  };

  it("an address over 254 characters is stored as no address, its display name kept", async () => {
    const local = randomBytes(1400).toString("hex");
    const r = await cycles({ from: `Crafted Sender <${local}@example.com>`, subject: "a crafted address", messageId: `hb-${randomUUID()}@example.com` });
    expectMoving(r);
    const crafted = r.rows.find((x) => x.subject === "a crafted address")!;
    expect([crafted.fromAddress, crafted.fromName]).toEqual(["", "Crafted Sender"]);
  }, 180_000);

  it("a Message-ID over 998 bytes is stored as none", async () => {
    const r = await cycles({ from: "Anna <anna@example.com>", subject: "a crafted id", messageId: `${randomBytes(1500).toString("hex")}@example.com` });
    expectMoving(r);
    expect(r.rows.find((x) => x.subject === "a crafted id")!.messageIdHeader).toBeNull();
  }, 180_000);

  it("a subject over 4096 characters is stored cut at 4096", async () => {
    const subject = distinctWords("w", 900 * 1024);
    const r = await cycles({ from: "Anna <anna@example.com>", subject, messageId: `hb-${randomUUID()}@example.com` });
    expectMoving(r);
    const crafted = r.rows.find((x) => x.subject.startsWith("w0x"))!;
    expect(crafted.subject).toBe(subject.slice(0, 4096));
  }, 180_000);

  it("a display name of 900 KiB of distinct words is stored whole and searched by its first part", async () => {
    const name = distinctWords("n", 900 * 1024);
    const r = await cycles({ from: `"${name}" <anna@example.com>`, subject: "a crafted name", messageId: `hb-${randomUUID()}@example.com` });
    expectMoving(r);
    const crafted = r.rows.find((x) => x.subject === "a crafted name")!;
    expect([crafted.fromAddress, crafted.fromName?.length]).toEqual(["anna@example.com", name.length]);
  }, 180_000);

  it("a body of 2 MiB of distinct words is stored whole", async () => {
    const poison = {
      from: "Anna <anna@example.com>", subject: "a crafted body", messageId: `hb-${randomUUID()}@example.com`,
      body: distinctLines("b", 2 * 1024 * 1024),
    };
    // Every word sent, line ends as the parser normalizes them; compared by digest, so a failing
    // log carries no 2 MiB diff.
    const sent = poison.body.replace(/\r\n/g, "\n");
    const parsed = (await normalizeMime(rawOf(poison))).textBody;
    expect([parsed.length, sha(parsed)]).toEqual([sent.length, sha(sent)]);
    const r = await cycles(poison);
    expectMoving(r);
    const [row] = await db.select({ text: messageBodies.text }).from(messageBodies)
      .where(eq(messageBodies.messageId, await idOf(r.mailboxId, "a crafted body")));
    expect([row!.text.length, sha(row!.text)]).toEqual([sent.length, sha(sent)]);
  }, 180_000);

  // The parser admits hundreds of empty parts beside one text part (mailsplit's node ceiling); one
  // statement of them carried thousands of parameters, under the driver's ceiling. Chunked into small statements, no
  // per-message statement grows with what a sender attached.
  it("a message at the parser's attachment-part limit is stored with every part, a bounded batch of rows to a statement", async () => {
    const poison = {
      from: "Anna <anna@example.com>", subject: "a crafted part count", messageId: `hb-${randomUUID()}@example.com`,
      ...manyParts(998),
    };
    const parts = (await normalizeMime(rawOf(poison))).attachments.length;
    attachmentStatements.length = 0;
    const r = await cycles(poison);
    console.log(`PARTS parsed=${parts} parameters per statement=${attachmentStatements.join(",")}`);
    expectMoving(r);
    const listed = await db.select({ id: attachments.id }).from(attachments)
      .where(eq(attachments.messageId, await idOf(r.mailboxId, "a crafted part count")));
    expect([parts, listed.length]).toEqual([998, 998]);
    expect(attachmentStatements).toEqual([...Array(9).fill(900), 98 * 9]);
  }, 180_000);

  it("a message past the parser's node cap is that message's write-off, never a shared fault", async () => {
    const poison = {
      from: "Anna <anna@example.com>", subject: "past the node cap", messageId: `hb-${randomUUID()}@example.com`,
      ...manyParts(8_000),
    };
    const r = await cycles(poison);
    expect(r.outcomes).toEqual(Array(CYCLES).fill("ok"));
    expect(r.stored).toEqual(Array(CYCLES).fill(1));
    const rows = await db.select({ code: messageFailures.code }).from(messageFailures)
      .where(eq(messageFailures.mailboxId, r.mailboxId));
    expect(rows.map((x) => x.code)).toEqual(["mime_unparseable"]);
  }, 180_000);

  it("a value past an index's ceiling is that message's write-off, never a shared fault", async () => {
    // A narrow btree over this fixture's body alone: past the btree ceiling it raises `54000` from an
    // index routine the classifier names, inside the ingest transaction — the shape of an index on a
    // sender's value nobody has bounded yet. Dropped whatever happens.
    await sql.unsafe(`create index if not exists hb_planted_54000 on message_bodies (text) where text like 'hb-planted-54000 %'`);
    try {
      const poison = {
        from: "Anna <anna@example.com>", subject: "a planted limit", messageId: `hb-${randomUUID()}@example.com`,
        body: `hb-planted-54000 ${randomBytes(8_000).toString("hex")}`,
      };
      const r = await cycles(poison);
      expect(r.outcomes).toEqual(Array(CYCLES).fill("ok"));
      expect(r.stored).toEqual(Array(CYCLES).fill(1));
      const rows = await db.select({
        uid: messageFailures.uid, code: messageFailures.code, attempts: messageFailures.attempts,
        next: messageFailures.nextAttemptAt, version: messageFailures.attemptedVersion,
      }).from(messageFailures).where(eq(messageFailures.mailboxId, r.mailboxId));
      // The poison is UID 1000, the fixture's first: written off once, owed to the next build only.
      expect(rows.map((x) => [x.uid, x.code, x.attempts, x.next])).toEqual([[1000, "data_too_large", 1, null]]);
      expect(rows[0]!.version).toBeTruthy();
    } finally {
      await sql.unsafe(`drop index if exists hb_planted_54000`);
    }
  }, 180_000);

  it("reads the server's limit by its routine, our client's refusal as the message's, the driver's as shared", async () => {
    // Read off postgres.js on the lane database rather than built by hand, each tagged the way the
    // worker's repo tags a throw. The driver's own ceiling can land on another caller's query on a
    // busy connection (bind-limit-guard.pg.test.ts), so it names no message; ours is thrown in the
    // caller's own call. Each on its own idle connection, ended after.
    const one = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    try {
      const over = Array.from({ length: MAX_BIND_PARAMETERS + 1 }, () => 1);
      const limit = await one`select to_tsvector('english', ${distinctWords("d", 2 * 1024 * 1024)})`.then(() => null, (e: unknown) => e);
      const driver = await one.unsafe("select 1", over).then(() => null, (e: unknown) => e);
      const ours = await Promise.resolve().then(() => withBindLimit(one).unsafe("select 1", over)).then(() => null, (e: unknown) => e);
      expect([limit, driver, ours].map((e) => (e as { code?: unknown } | null)?.code))
        .toEqual(["54000", "MAX_PARAMETERS_EXCEEDED", "OHMAIL_BIND_LIMIT"]);
      expect((limit as { routine?: unknown }).routine, "the routine the allow-list names").toBe("make_tsvector");
      for (const e of [limit, ours]) {
        const fault = new DatabaseFaultError("repo.transaction", e);
        expect(classifyIngestFault(fault)).toEqual({ domain: "message", code: "data_too_large", deterministic: true });
        expect(isSharedDatabaseFault(fault)).toBe(false);
      }
      const fault = new DatabaseFaultError("repo.transaction", driver);
      expect(classifyIngestFault(fault)).toEqual({ domain: "infrastructure" });
      expect(isSharedDatabaseFault(fault)).toBe(true);
    } finally {
      await Promise.race([one.end({ timeout: 1 }), new Promise((r) => setTimeout(r, 2000))]);
    }
  }, 60_000);

  it("a References flood of 70,000 ids on a busy connection: no statement grows with it, nobody else's query is touched", async () => {
    // The reviewer's shape: a stranger's message naming tens of thousands of ids, in an account with a Sent folder
    // (so the gate asks the reply arm), on ONE connection another caller keeps busy. Through the
    // guarded client every handle is built on. Before the bound one statement carried that many
    // parameters and the driver's refusal landed on the other caller's query.
    const params: number[] = [];
    const busy = withBindLimit(postgres(PG_TEST_URL, {
      max: 1, onnotice: () => {}, debug: (_c: number, _t: string, p: unknown[]) => { params.push(p.length); },
    }));
    const bdb = brandDialect(drizzle(busy, { schema }), "pg");
    try {
      const accountId = randomUUID();
      made.push(accountId);
      await bdb.insert(accounts).values({ id: accountId, name: `hb-${accountId.slice(0, 8)}` });
      const [mb] = await bdb.insert(mailboxes).values({ accountId, provider: "imap", address: `hb-${accountId.slice(0, 8)}@ohmail.test` }).returning();
      await bdb.insert(mailboxFolders).values({ mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), folder: "Sent" } as never);
      const ids = Array.from({ length: 70_000 }, (_, i) => `<f${i.toString(36)}@x.test>`);
      const lines: string[] = [];
      for (let i = 0; i < ids.length; i += 60) lines.push(ids.slice(i, i + 60).join(" "));
      const fleet = new FakeAdapterFleet();
      const adapter = fleet.factory({ host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
        { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } });
      fleet.behave(mb!.id, { deliver: [
        { from: "Stranger <stranger@elsewhere.test>", subject: "a references flood", messageId: `hb-f-${randomUUID()}@elsewhere.test`,
          headers: [`References: ${lines.join("\r\n ")}`] },
        { from: "Anna <anna@example.com>", subject: "behind it", messageId: `hb-behind-${randomUUID()}@example.com` },
      ] });
      const repo = markDatabaseFaults(makeDrizzleRepo(bdb as never), "repo");
      // The other caller: short queries, each checked for its own row.
      let stop = false; let n = 0; let hung = 0; const wrong: string[] = []; const errs: string[] = [];
      const noise = (async () => {
        while (!stop && hung < 3) {
          const tag = `noise-${n++}`;
          const r = await Promise.race([
            busy`select pg_sleep(0.02), ${tag}::text as tag`.then((rows) => ({ rows }), (e: unknown) => ({ e })),
            new Promise<{ hung: true }>((res) => setTimeout(() => res({ hung: true }), 5000)),
          ]);
          if ("hung" in r) { hung++; continue; }
          if ("e" in r) { errs.push(String((r.e as { code?: unknown })?.code ?? (r.e as Error)?.name)); continue; }
          const got = r.rows as unknown as Array<Record<string, unknown>>;
          if (!(got.length === 1 && got[0]!.tag === tag)) wrong.push(got.length === 0 ? "0 rows" : `cols=${Object.keys(got[0]!).join("|")}`);
        }
      })();
      await new Promise((r) => setTimeout(r, 100));
      params.length = 0;
      const cycle = await Promise.race([
        runSyncCycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId: mb!.id,
          storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>() }).then(() => "ok", verdictOf),
        new Promise<string>((r) => setTimeout(() => r("PENDING after 60 s"), 60_000)),
      ]);
      const widest = Math.max(0, ...params);
      stop = true;
      await Promise.race([noise, new Promise((r) => setTimeout(r, 8000))]);
      const stored = (await bdb.select({ subject: messages.subject }).from(messages).where(eq(messages.mailboxId, mb!.id))).map((x) => x.subject).sort();
      const failures = (await bdb.select({ code: messageFailures.code }).from(messageFailures).where(eq(messageFailures.mailboxId, mb!.id))).map((x) => x.code);
      console.log(`FLOOD cycle=${cycle} widest statement=${widest} params; other caller ${n} queries, errors=${errs.length} wrong=${wrong.length} hung=${hung}`);
      expect({ cycle, errs, wrong, hung }).toEqual({ cycle: "ok", errs: [], wrong: [], hung: 0 });
      expect(n, "the other caller kept running").toBeGreaterThan(5);
      expect(widest, "no statement grows with the sender's id list").toBeLessThan(1_000);
      expect([stored, failures]).toEqual([["a references flood", "behind it"], []]);
    } finally {
      await Promise.race([busy.end({ timeout: 1 }), new Promise((r) => setTimeout(r, 3000))]);
    }
  }, 180_000);

  it("a shared commit-time 54000 stops the pass and writes nothing off; both messages are stored once it clears", async () => {
    // A full NOTIFY queue fails every commit that notified with 54000 (PreCommit_Notify), whatever
    // the message. Stood in for by a deferred constraint trigger on change_log, scoped to this
    // fixture's account, for three cycles; then the queue "drains" and three more cycles run.
    const accountId = randomUUID();
    made.push(accountId);
    await db.insert(accounts).values({ id: accountId, name: `hb-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `hb-${accountId.slice(0, 8)}@ohmail.test` }).returning();
    const fn = `hb_commit_54000_${accountId.slice(0, 8)}`;
    await sql.unsafe(`create or replace function ${fn}() returns trigger language plpgsql as $$
      begin
        if new.account_id = '${accountId}'::uuid then
          raise exception 'too many notifications in the NOTIFY queue' using errcode = '54000';
        end if;
        return null;
      end $$`);
    await sql.unsafe(`create constraint trigger ${fn} after insert on change_log
      deferrable initially deferred for each row execute function ${fn}()`);
    try {
      const fleet = new FakeAdapterFleet();
      const adapter = fleet.factory({ host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
        { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } });
      fleet.behave(mb!.id, { deliver: [
        { from: "Anna <anna@example.com>", subject: "ordinary one", messageId: `hb-1-${randomUUID()}@example.com` },
        { from: "Ben <ben@example.com>", subject: "ordinary two", messageId: `hb-2-${randomUUID()}@example.com` },
      ] });
      const repo = markDatabaseFaults(makeDrizzleRepo(db as never), "repo");
      const outcomes: string[] = []; const stored: number[] = []; const failures: number[] = [];
      for (let i = 0; i < 6; i++) {
        if (i === 3) await sql.unsafe(`drop trigger if exists ${fn} on change_log`);
        outcomes.push(await runSyncCycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId: mb!.id,
          storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>() })
          .then(() => "ok", (e: unknown) => isSharedDatabaseFault(e) ? "shared" : verdictOf(e)));
        stored.push((await db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, mb!.id))).length);
        failures.push((await db.select({ code: messageFailures.code }).from(messageFailures).where(eq(messageFailures.mailboxId, mb!.id))).length);
      }
      console.log(`COMMIT-54000 outcomes=${outcomes.join(",")} stored=${stored.join(",")} failures=${failures.join(",")}`);
      expect({ outcomes, stored, failures }).toEqual({
        outcomes: ["shared", "shared", "shared", "ok", "ok", "ok"], stored: [0, 0, 0, 2, 2, 2], failures: [0, 0, 0, 0, 0, 0],
      });
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on change_log`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
  }, 180_000);

  it("learns more correspondents than one statement holds, in bounded statements, and only once", async () => {
    // Fed by the account's own Sent copies rather than a sender, and chunked all the same: no
    // statement's parameter count grows with a recipient list. An address over 254 characters is
    // no correspondent and never reaches a statement.
    const accountId = randomUUID();
    made.push(accountId);
    await db.insert(accounts).values({ id: accountId, name: `hb-${accountId.slice(0, 8)}` });
    const repo = makeDrizzleRepo(db as never);
    const addresses = Array.from({ length: 250 }, (_, i) => `r${i}@example.com`);
    addresses.splice(120, 0, `${"a".repeat(250)}@example.com`);
    contactStatements.length = 0;
    expect(await repo.upsertContacts(accountId, addresses, "person")).toBe(250);
    // Three parameters a row since mail 0148 (`account_id`, `address`, `source`), still the chunk's rows a statement.
    expect(contactStatements).toEqual([300, 300, 150]);
    expect(await repo.upsertContacts(accountId, addresses, "person")).toBe(0);
  }, 60_000);
});

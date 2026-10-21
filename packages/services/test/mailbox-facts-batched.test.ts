import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import {
  accounts, folderState, mailboxCredentials, mailboxFolders, mailboxes, messageFailures, messages,
} from "@trafficflow/db";
import {
  ACCOUNT_MAILBOXES_MAX_READ, makeMailboxService, type MailboxDTO, type ServiceContext,
} from "@trafficflow/services";

/**
 * GET /mailboxes is polled every 30 s per open tab. Beside each row it reads four facts: the
 * set-aside count, the folders, the incoming credential's meta and the filing aggregate. Read per
 * mailbox, that was 1 + 4N statements; read for all of the account's mailboxes at once it is five,
 * whatever N is. The answer stays byte for byte what it was (the golden file was written by the
 * per-mailbox reads), and every statement that reads a fact binds the caller's account.
 * Counted at the store's own client, on both stores.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const NOW = new Date("2026-10-21T10:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const id = (tail: string): string => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

const A = id("a0");
const B = id("b0");
// A's and B's mailboxes interleave by id, the order `list` reads them in.
const organizer = id("1"), theirFirst = id("2"), inError = id("3"), theirSecond = id("4");
const heldReader = id("5"), theirThird = id("6"), erasing = id("7"), erased = id("9"), gapReader = id("b");

const svc = makeMailboxService({
  installId: "install-here",
  lastOrganizerCycleAt: async () => "2026-10-21T09:59:00.000Z",
});

const ctxFor = (db: Db, accountId: string, now: () => Date = () => NOW): ServiceContext =>
  ({ db, accountId, userId: null, now, requestId: "r" });

let seq = 0;

/** A message, and its filing unless `row` is null. */
async function filing(db: Db, accountId: string, mailboxId: string, row: null | {
  updatedAt: Date; attempts?: number; nextAttemptAt?: Date | null; lastErrorClass?: string | null;
  by?: "us" | "external"; desired?: string; observed?: string; status?: "pending" | "reconciled";
}): Promise<void> {
  seq += 1;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, dedupKey: `mid:<mfb-${seq}@example.test>`, messageIdHeader: `<mfb-${seq}@example.test>`,
    fromAddress: "stranger@example.test", subject: `s${seq}`, date: NOW, bodyHash: `mfb-hash-${seq}`,
  }).returning();
  if (row === null) return;
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: row.desired ?? "ohmail/News", observedFolder: row.observed ?? "INBOX",
    reconcileStatus: row.status ?? "pending", lastSetBy: row.by ?? "us", updatedAt: row.updatedAt,
    attempts: row.attempts ?? 0, nextAttemptAt: row.nextAttemptAt ?? null, lastErrorClass: row.lastErrorClass ?? null,
  });
}

async function failure(db: Db, accountId: string, mailboxId: string, uid: number, resolved: boolean): Promise<void> {
  await db.insert(messageFailures).values({
    accountId, mailboxId, folder: "INBOX", uidvalidity: 1n, uid, code: "mime_unparseable",
    resolvedAt: resolved ? at(-MIN) : null,
  });
}

async function cred(db: Db, mailboxId: string, transport: "imap" | "smtp", meta: unknown): Promise<void> {
  await db.insert(mailboxCredentials).values({ mailboxId, transport, secretEnc: "sealed", keyVersion: 1, meta });
}

async function folder(db: Db, mailboxId: string, f: {
  folder: string; updatedAt: Date; highestmodseq?: bigint; serverExists?: number; budgetStopUid?: bigint;
}): Promise<void> {
  await db.insert(mailboxFolders).values({
    mailboxId, folder: f.folder, updatedAt: f.updatedAt, highestmodseq: f.highestmodseq ?? null,
    serverExists: f.serverExists ?? null, budgetStopUid: f.budgetStopUid ?? null,
    budgetStopUidvalidity: f.budgetStopUid === undefined ? null : 9n,
  });
}

/** Account A: six mailboxes in different states, one a finished erasure; account B beside it. */
async function seed(db: Db): Promise<void> {
  await db.insert(accounts).values([{ id: A, name: "mfb-a" }, { id: B, name: "mfb-b" }]);

  // An organizer with every kind of filing, failures, both credentials and folders out of order.
  await db.insert(mailboxes).values({
    id: organizer, accountId: A, provider: "imap", address: "a1@example.test", displayName: "Alpha",
    createdAt: at(-3 * DAY), lastSyncAt: at(-MIN), initialImportCompletedAt: at(-DAY),
    organizeConsentedAt: at(-2 * DAY), junkFolder: "Spam", smtpMaxSizeBytes: 26_214_400,
    inboundQuietSince: at(-HOUR), inboundQuietDismissedAt: at(-30 * MIN), organizerEventAt: at(-2 * HOUR),
    organizerEventSeenAt: at(-90 * MIN), gapSince: at(-DAY), gapLetters: 7,
  });
  await cred(db, organizer, "imap", { host: "imap.gmail.com", port: 993, secure: true, smtpUnsettled: "auth" });
  await cred(db, organizer, "smtp", { host: "smtp.gmail.com", port: 465, smtpUnsettled: "tls" });
  await folder(db, organizer, { folder: "Sent", highestmodseq: 7n, serverExists: 30, updatedAt: at(-2 * MIN) });
  await folder(db, organizer, { folder: "Archive", updatedAt: at(-5 * MIN), budgetStopUid: 12n });
  await folder(db, organizer, { folder: "INBOX", highestmodseq: 100n, serverExists: 120, updatedAt: at(-MIN) });
  await filing(db, A, organizer, { updatedAt: at(-10_000) });
  await filing(db, A, organizer, { updatedAt: at(-2 * MIN), attempts: 1, nextAttemptAt: at(HOUR), lastErrorClass: "no_such_folder" });
  await filing(db, A, organizer, {
    updatedAt: at(-HOUR), attempts: 1, nextAttemptAt: at(-MIN), lastErrorClass: "read_only", desired: "Receipts",
  });
  await filing(db, A, organizer, { updatedAt: at(-HOUR), by: "external", desired: "X", observed: "Y" });
  await filing(db, A, organizer, { updatedAt: at(-HOUR), status: "reconciled" });
  await filing(db, A, organizer, { updatedAt: at(-HOUR), desired: "INBOX", observed: "INBOX" });
  await filing(db, A, organizer, null);
  await failure(db, A, organizer, 1, false);
  await failure(db, A, organizer, 2, false);
  await failure(db, A, organizer, 3, true);

  // In error, signed in with OAuth, blocked, and a credential naming no host.
  await db.insert(mailboxes).values({
    id: inError, accountId: A, provider: "imap", address: "a3@example.test", createdAt: at(-2 * DAY), status: "error",
    errorCode: "timeout", errorDetail: "ETIMEDOUT", failedAt: at(-5 * MIN), retryCount: 3, authKind: "oauth",
    syncBlockedReason: "lease_unreadable", syncBlockedSince: at(-10 * MIN),
  });
  await cred(db, inError, "imap", { host: "" });
  await failure(db, A, inError, 1, false);

  // A disabled reader whose holder is this install, with a release that was refused.
  await db.insert(mailboxes).values({
    id: heldReader, accountId: A, provider: "imap", address: "a5@example.test", createdAt: at(-DAY), status: "disabled",
    disabledReason: "organized_elsewhere:local", organizerRole: "reader", organizedByKind: "local",
    organizedByName: "Office laptop", organizedByInstallId: "install-here", organizedSince: at(-7 * DAY),
    organizerState: "held", organizedByCapabilities: "requests,profiles", releaseRequestedAt: at(-HOUR),
    releaseRefusal: "sibling_lapse", takeoverAuthorizedAt: at(-3 * HOUR), organizerParkedAt: at(-4 * HOUR),
    lastSyncAt: at(-2 * HOUR), gapSince: at(-DAY), gapLetters: 3,
  });
  await cred(db, heldReader, "imap", { host: "imap.mail.me.com" });
  await folder(db, heldReader, { folder: "INBOX", highestmodseq: 3n, serverExists: 0, updatedAt: at(-3 * MIN) });
  await filing(db, A, heldReader, { updatedAt: at(-20 * MIN), lastErrorClass: "refused" });

  // Still being erased, two letters left; and an erasure that finished, which is not listed.
  await db.insert(mailboxes).values({
    id: erasing, accountId: A, provider: "imap", address: "a7@example.test", createdAt: at(-HOUR), status: "disabled",
    erasedAt: at(-MIN),
  });
  await filing(db, A, erasing, null);
  await filing(db, A, erasing, null);
  await db.insert(mailboxes).values({
    id: erased, accountId: A, provider: "imap", address: "a9@example.test", createdAt: at(-30 * DAY), status: "disabled",
    erasedAt: at(-DAY), erasureDoneAt: at(-23 * HOUR),
  });

  // A reader with a gap and no credential at all.
  await db.insert(mailboxes).values({
    id: gapReader, accountId: A, provider: "imap", address: "ab@example.test", createdAt: at(-MIN), organizerRole: "reader",
    gapSince: at(-DAY), gapLetters: 2,
  });

  // B's mailboxes carry every fact too, and a refusal with more attempts than any of A's.
  for (const [mb, address] of [[theirFirst, "b2@example.test"], [theirSecond, "b4@example.test"], [theirThird, "b6@example.test"]] as const) {
    await db.insert(mailboxes).values({
      id: mb, accountId: B, provider: "imap", address, createdAt: at(-DAY), lastSyncAt: at(-MIN),
    });
    await cred(db, mb, "imap", { host: "imap.gmail.com", smtpUnsettled: "tls" });
    await folder(db, mb, { folder: "Zzz", updatedAt: at(-MIN) });
    await folder(db, mb, { folder: "INBOX", highestmodseq: 9n, serverExists: 999, updatedAt: at(-MIN), budgetStopUid: 1n });
    await filing(db, B, mb, { updatedAt: at(-2 * HOUR), attempts: 5, nextAttemptAt: at(HOUR), lastErrorClass: "refused" });
    await filing(db, B, mb, { updatedAt: at(-MIN) });
    await failure(db, B, mb, 1, false);
    await failure(db, B, mb, 2, false);
  }
}

/** An account with `n` connected mailboxes, each with a credential, two folders, a filing and a failure. */
async function seedPlain(db: Db, accountId: string, n: number): Promise<void> {
  await db.insert(accounts).values({ id: accountId, name: `mfb-${n}` });
  for (let i = 0; i < n; i++) {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `p${n}-${i}@example.test`, createdAt: at(-DAY), lastSyncAt: at(-MIN),
    }).returning();
    await cred(db, mb!.id, "imap", { host: "imap.example.test" });
    await folder(db, mb!.id, { folder: "INBOX", highestmodseq: 1n, serverExists: 10, updatedAt: at(-MIN) });
    await folder(db, mb!.id, { folder: "Archive", updatedAt: at(-MIN) });
    await filing(db, accountId, mb!.id, { updatedAt: at(-MIN) });
    await failure(db, accountId, mb!.id, 1, false);
  }
}

interface Sent { text: string; params: readonly unknown[] }
interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }
type StatementDoor = "all" | "get" | "run";

/** Every statement the store is handed during `run`, with its parameters: PGlite's doors, or SQLite's prepare. */
async function measured<T>(db: Db, run: () => Promise<T>): Promise<{ value: T; sent: Sent[] }> {
  const sent: Sent[] = [];
  let restore: () => void;
  if (dialect(db).name === "sqlite") {
    const sqlite = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: { prototype: { prepare: (...a: unknown[]) => object } };
      StatementSync: { prototype: Record<StatementDoor, (...a: unknown[]) => unknown> };
    };
    const conn = sqlite.DatabaseSync.prototype;
    const stmt = sqlite.StatementSync.prototype;
    const prepare = conn.prepare;
    const doors = { all: stmt.all, get: stmt.get, run: stmt.run };
    const of = new WeakMap<object, Sent>();
    conn.prepare = function (this: unknown, ...a: unknown[]) {
      const statement = prepare.apply(this, a);
      const s: Sent = { text: String(a[0]), params: [] };
      sent.push(s);
      of.set(statement, s);
      return statement;
    };
    for (const door of ["all", "get", "run"] as const) {
      stmt[door] = function (this: object, ...p: unknown[]) {
        const s = of.get(this);
        if (s) s.params = p;
        return doors[door].apply(this, p);
      };
    }
    restore = () => { conn.prepare = prepare; Object.assign(stmt, doors); };
  } else {
    const client = (db as unknown as { $client: Doors }).$client;
    const doors = { query: client.query, exec: client.exec };
    client.query = (...a: unknown[]) => {
      sent.push({ text: String(a[0]), params: (a[1] as unknown[] | undefined) ?? [] });
      return doors.query.apply(client, a);
    };
    client.exec = (...a: unknown[]) => {
      sent.push({ text: String(a[0]), params: [] });
      return doors.exec.apply(client, a);
    };
    restore = () => { client.query = doors.query; client.exec = doors.exec; };
  }
  try {
    return { value: await run(), sent };
  } finally {
    restore();
  }
}

/** Each `"<table>"."account_id" = <placeholder>` in a statement, with the value bound to it. */
function accountBindings(s: Sent): Array<{ table: string; value: unknown }> {
  const out: Array<{ table: string; value: unknown }> = [];
  for (const m of s.text.matchAll(/"(\w+)"\."account_id" = (\$\d+|\?)/g)) {
    const ph = m[2]!;
    const index = ph === "?"
      ? (s.text.slice(0, m.index! + m[0].length - 1).match(/\?/g) ?? []).length
      : Number(ph.slice(1)) - 1;
    out.push({ table: m[1]!, value: s.params[index] });
  }
  return out;
}

const FACT_TABLES = /"(message_failures|mailbox_folders|mailbox_credentials|folder_state)"/;

describe("GET /mailboxes reads every mailbox's facts in a fixed number of statements", () => {
  it("costs the same statements for 1, 3 and 10 mailboxes, at most five", async () => {
    const db = await makeTestDb();
    const cost: number[] = [];
    for (const [i, n] of [1, 3, 10].entries()) {
      const acct = id(`c${i}`);
      await seedPlain(db, acct, n);
      const { value, sent } = await measured(db, () => svc.list(ctxFor(db, acct)));
      expect(value).toHaveLength(n);
      cost.push(sent.length);
    }
    expect(cost[0]).toBeLessThanOrEqual(5);
    expect(cost, "statements for 1, 3 and 10 mailboxes").toEqual([cost[0], cost[0], cost[0]]);
    // An account with no mailbox reads its list and nothing else.
    const empty = await measured(db, () => svc.list(ctxFor(db, id("e0"))));
    expect(empty.value).toEqual([]);
    expect(empty.sent).toHaveLength(1);
  });

  it("an account past one slice of ids gets every mailbox's facts, four statements a slice", async () => {
    const db = await makeTestDb();
    const acct = id("f0");
    await db.insert(accounts).values({ id: acct, name: "mfb-slices" });
    const ids = Array.from({ length: ACCOUNT_MAILBOXES_MAX_READ + 1 }, (_x, i) => id((0xf0000 + i).toString(16)));
    for (let from = 0; from < ids.length; from += 200) {
      const part = ids.slice(from, from + 200);
      await db.insert(mailboxes).values(part.map((mb) => ({
        id: mb, accountId: acct, provider: "imap", address: `${mb.slice(-5)}@example.test`, createdAt: at(-DAY),
      })));
      await db.insert(messageFailures).values(part.map((mb) => ({
        accountId: acct, mailboxId: mb, folder: "INBOX", uidvalidity: 1n, uid: 1, code: "mime_unparseable",
      })));
    }
    // The last mailbox is the second slice's only one.
    await folder(db, ids.at(-1)!, { folder: "INBOX", highestmodseq: 1n, serverExists: 4, updatedAt: at(-MIN) });

    const { value, sent } = await measured(db, () => svc.list(ctxFor(db, acct)));
    expect(value.map((m) => m.id)).toEqual(ids);
    expect(value.every((m) => m.setAside === 1), "a mailbox lost its set-aside count").toBe(true);
    expect(value.at(-1)!.serverMessageCount).toBe(4);
    expect(value.at(-1)!.folders?.map((f) => f.folder)).toEqual(["INBOX"]);
    // The list read, then four statements for each of the two slices.
    expect(sent).toHaveLength(1 + 4 * 2);
  }, 60_000);

  it("one mailbox's read is still five statements: its row and its four facts", async () => {
    const db = await makeTestDb();
    await seed(db);
    const { sent } = await measured(db, () => svc.get(ctxFor(db, A), organizer));
    expect(sent).toHaveLength(5);
  });

  it("answers byte for byte what the per-mailbox reads answered", async () => {
    const db = await makeTestDb();
    await seed(db);
    const list = await svc.list(ctxFor(db, A));
    const answer = {
      list,
      counts: await svc.list(ctxFor(db, A), { counts: true }),
      otherAccount: await svc.list(ctxFor(db, B)),
      empty: await svc.list(ctxFor(db, id("e0"))),
    };
    await expect(`${JSON.stringify(answer, null, 2)}\n`)
      .toMatchFileSnapshot("./__snapshots__/mailbox-facts-batched.golden.json");
    // A single mailbox's read answers what the list says about it.
    for (const row of list) expect(await svc.get(ctxFor(db, A), row.id)).toEqual(row);
  });

  it("takes the counts and `asOf` at one reading of the clock", async () => {
    const db = await makeTestDb();
    const acct = id("d0");
    await db.insert(accounts).values({ id: acct, name: "mfb-clock" });
    for (const mb of [id("d1"), id("d2")]) {
      await db.insert(mailboxes).values({ id: mb, accountId: acct, provider: "imap", address: `${mb.slice(-2)}@example.test` });
      await filing(db, acct, mb, {
        updatedAt: at(-MIN), attempts: 1, nextAttemptAt: at(5_000), lastErrorClass: "refused",
      });
    }
    // Each reading of this clock is ten seconds after the last; the deferral is due five seconds in.
    let readings = 0;
    const rows = await svc.list(ctxFor(db, acct, () => at(10_000 * readings++)));
    const deferred = rows.filter((r) => r.filing!.deferred > 0);
    expect(deferred.length).toBeGreaterThan(0);
    for (const r of deferred) {
      expect(Date.parse(r.filing!.nextAttemptAt!), "a deferral already past at its own asOf")
        .toBeGreaterThan(Date.parse(r.filing!.asOf));
    }
  });

  it("another account's facts never reach this account's answer", async () => {
    const db = await makeTestDb();
    await seed(db);
    const before = await svc.list(ctxFor(db, A));
    expect(before.map((m) => m.id)).toEqual([organizer, inError, heldReader, erasing, gapReader]);

    for (const mb of [theirFirst, theirSecond, theirThird]) {
      await failure(db, B, mb, 7, false);
      await folder(db, mb, { folder: "Aaa", highestmodseq: 1n, serverExists: 5, updatedAt: at(-MIN) });
      await filing(db, B, mb, { updatedAt: at(-DAY), attempts: 9, nextAttemptAt: at(DAY), lastErrorClass: "over_quota" });
      await cred(db, mb, "smtp", { host: "smtp.gmail.com", smtpUnsettled: "auth" });
    }
    expect(JSON.stringify(await svc.list(ctxFor(db, A)))).toBe(JSON.stringify(before));

    // A fact of A's own moves A's answer, by exactly that fact.
    await failure(db, A, organizer, 9, false);
    const after = await svc.list(ctxFor(db, A));
    expect(before[0]!.setAside).toBe(2);
    expect(after[0]!.setAside).toBe(3);
    const without = (rows: MailboxDTO[]) => rows.map((r, i) => (i === 0 ? { ...r, setAside: 0 } : r));
    expect(without(after)).toEqual(without(before));
  });

  it("every statement that reads a fact binds the caller's account and reads no secret", async () => {
    const db = await makeTestDb();
    await seed(db);
    const { sent } = await measured(db, () => svc.list(ctxFor(db, A)));
    const facts = sent.filter((s) => FACT_TABLES.test(s.text));
    expect(facts.length).toBeGreaterThan(0);
    for (const s of facts) {
      expect(s.text).not.toContain("secret_enc");
      const bound = accountBindings(s);
      expect(bound.some((b) => b.table === "mailboxes"), s.text).toBe(true);
      for (const b of bound) expect(b.value, s.text).toBe(A);
    }
  });
});

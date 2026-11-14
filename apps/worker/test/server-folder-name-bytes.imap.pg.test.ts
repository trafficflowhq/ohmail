import { accountOfMailbox, accountOfMessage } from "@trafficflow/db";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { folderState, junkRescues, mailboxFolders, mailboxes, messageFailures, messageInstances, messages } from "@trafficflow/db";
import { IMAP_FOLDER_PATH_MAX_BYTES } from "@trafficflow/core/adapters/imap";
import { runMigrations } from "@trafficflow/db/admin";
import { realPgAvailable } from "@trafficflow/db/testing";
import { runSyncCycle, type SyncDeps } from "../src/sync.js";
import { imapCfg, makeHarness, rawClient, DB_URL, ORGANIZER_CONSENT } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A FOLDER NAME FROM THE ACCOUNT'S OWN SERVER CANNOT STOP THE MAILBOX, on real Postgres through the
 * worker's real cycle. A path of three-byte characters inside the character bound is
 * past every folder column's btree in bytes (and past the locators'): before the byte
 * bound the folder's INSERT raised `54000` and every cycle of the mailbox failed. Random characters,
 * because Postgres compresses a long index key and a repeated one would fit. Controls: the other
 * folders' letters are stored, a path AT the byte bound syncs, and fits every folder column's btree.
 */

const AVAILABLE = await realPgAvailable(DB_URL);
const CYCLES = 6;

/** Random CJK to exactly `bytes` UTF-8 bytes (3 per character, ASCII for the remainder). */
function cjk(bytes: number): string {
  let s = "";
  for (let n = 0; n + 3 <= bytes; n += 3) s += String.fromCodePoint(0x4e00 + randomInt(0x5000));
  return s + "a".repeat(bytes % 3);
}

function eml(o: { to: string; subject: string; messageId: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, "From: anna@x.example", `To: ${o.to}`, `Subject: ${o.subject}`,
    "Content-Type: text/plain; charset=utf-8", "", "the letter",
  ].join("\r\n");
}

describe.skipIf(!AVAILABLE)("a folder name past the btree in bytes is dropped, and the mailbox keeps syncing (GreenMail + real Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  async function run(extraFolder: string) {
    // The folders exist before the adapter connects, as they do for a mailbox being added.
    const cfg = imapCfg();
    const c = await rawClient(cfg);
    closers.push(async () => { await c.logout().catch(() => undefined); });
    const tag = randomUUID().slice(0, 8);
    await c.mailboxCreate("Projects").catch(() => undefined);
    await c.mailboxCreate(extraFolder);
    const listed = (await c.list()).map((f) => f.path);
    expect(listed.includes(extraFolder), "the precondition: the server holds the folder").toBe(true);
    const headers = { inbox: `inbox-${tag}@x.example`, projects: `projects-${tag}@x.example`, extra: `extra-${tag}@x.example` };
    await c.append("INBOX", eml({ to: cfg.auth.user, subject: `inbox ${tag}`, messageId: headers.inbox }));
    await c.append("Projects", eml({ to: cfg.auth.user, subject: `projects ${tag}`, messageId: headers.projects }));
    await c.append(extraFolder, eml({ to: cfg.auth.user, subject: `extra ${tag}`, messageId: headers.extra }));
    const h = await makeHarness(cfg);
    closers.push(() => h.adapter.close());
    await h.db.update(mailboxes).set(ORGANIZER_CONSENT).where(eq(mailboxes.id, h.mailboxId));
    const deps: SyncDeps = {
      repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId,
      storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      role: "organizer", trustedAuthservIds: new Set<string>(),
    };
    const outcomes: string[] = [];
    for (let i = 0; i < CYCLES; i++) {
      outcomes.push(await runSyncCycle(deps).then(() => "ok", (e: unknown) => `threw ${(e as { code?: string }).code ?? "?"}`));
    }
    const stored = async (header: string) => (await h.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.mailboxId, h.mailboxId), eq(messages.messageIdHeader, header)))).length;
    const widest = (await h.db.select({ n: sql<number>`coalesce(max(octet_length(${mailboxFolders.folder})), 0)::int` })
      .from(mailboxFolders).where(eq(mailboxFolders.mailboxId, h.mailboxId)))[0]!.n;
    // Counts and outcomes only — never the name.
    console.log(`CYCLES bytes=${new TextEncoder().encode(extraFolder).length} outcomes=${outcomes.join(",")} widest=${widest}`);
    return {
      outcomes, widest,
      inbox: await stored(headers.inbox), projects: await stored(headers.projects), extra: await stored(headers.extra),
    };
  }

  it("a folder name past the byte limit is dropped; INBOX and the other folders sync every cycle", async () => {
    const r = await run(cjk(3000));
    expect(r.outcomes, "a cycle failed over one folder's name").toEqual(Array(CYCLES).fill("ok"));
    expect([r.inbox, r.projects], "the other folders' letters").toEqual([1, 1]);
    expect(r.extra, "the over-long folder was read").toBe(0);
    expect(r.widest).toBeLessThanOrEqual(2600);
  }, 120_000);

  it("CONTROL — a folder name AT the byte bound syncs like any other", async () => {
    const r = await run(cjk(IMAP_FOLDER_PATH_MAX_BYTES));
    expect(r.outcomes).toEqual(Array(CYCLES).fill("ok"));
    expect([r.inbox, r.projects, r.extra]).toEqual([1, 1, 1]);
    expect(r.widest).toBe(IMAP_FOLDER_PATH_MAX_BYTES);
  }, 120_000);

  it("a path at the bound fits every btree a server-named folder is keyed in", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const f = cjk(IMAP_FOLDER_PATH_MAX_BYTES);
    const [m] = await h.db.insert(messages).values({
      accountId: h.accountId, mailboxId: h.mailboxId, bodyHash: "h", dedupKey: `k-${randomUUID()}`,
    }).returning({ id: messages.id });
    await h.db.insert(mailboxFolders).values({ mailboxId: h.mailboxId, accountId: accountOfMailbox(h.mailboxId), folder: f });
    await h.db.insert(messageInstances).values({ accountId: h.accountId, mailboxId: h.mailboxId, messageId: m!.id, folder: f, uidvalidity: 1n, uid: 1 });
    await h.db.insert(messageFailures).values({ accountId: h.accountId, mailboxId: h.mailboxId, folder: f, uidvalidity: 1n, uid: 1, code: "unclassified" });
    await h.db.insert(junkRescues).values({ accountId: h.accountId, mailboxId: h.mailboxId, folder: f, uidvalidity: 1n, uid: 1 });
    await h.db.insert(folderState).values({ messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: f, observedFolder: "INBOX", lastSetBy: "external" });
    // CONTROL — 61 bytes past the bound is past the narrowest of them, so this arm can fail.
    const over = await h.db.insert(messageInstances).values({
      accountId: h.accountId, mailboxId: h.mailboxId, messageId: m!.id, folder: cjk(IMAP_FOLDER_PATH_MAX_BYTES + 61), uidvalidity: 1n, uid: 2,
    }).then(() => "stored", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
    expect(over).toBe("54000");
  }, 60_000);
});

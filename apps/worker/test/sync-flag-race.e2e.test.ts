import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { UNMETERED_STORAGE_CAP, createLogger } from "@trafficflow/core/mail";
import { accounts, contacts, mailboxes, messageInstances, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";
import { startFaultProxy, type CommandHold } from "../../../packages/core/test/adapters/_fault-proxy.js";
import {
  CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore,
} from "../../../packages/core/test/adapters/_imapenv.js";

/**
 * A LETTER MARKED READ ON THE PHONE DURING A MULTI-PAGE IMPORT IS IMPORTED, AND STAYS IN INBOX
 * (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS), end to end: the real adapter, `runSyncCycle` as
 * organizer and the store on PGlite, on GreenMail and on Dovecot.
 *
 * Four letters from known contacts, pages of two. While page 1's body fetch is parked, another session
 * marks a letter read and the server sends that flag change inside the reply. On the old adapter, in
 * the servers' own order, the not-yet-imported letter 0 was stored as an empty message at its UID,
 * never imported, and moved INBOX → ohmail/Screener on the server, every cycle reporting ok; with the
 * change ahead of the reply, a page letter was stored blank the same way. Now every letter is stored
 * once under its own Message-ID, nothing is blank, and the server keeps all four in INBOX. The
 * positive control: a stranger's letter is still gated into the Screener.
 */

const CONDSTORE = await probeCondstore();

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });

interface Server { host: string; port: number; pass: string }

function letter(i: number, to: string, from: string): string {
  return [
    `Message-ID: <letter-${i}-${to}>`, `From: ${from}`, `To: ${to}`, `Subject: letter ${i}`,
    "Content-Type: text/plain; charset=utf-8", "", `body ${i}`,
  ].join("\r\n");
}

async function world(server: Server, senders: readonly string[], known: readonly string[]) {
  const user = `race-${randomUUID()}@trafficflow.test`;
  const auth = { user, pass: server.pass };
  const other = new ImapFlow({ host: server.host, port: server.port, secure: false, auth, logger: false });
  await other.connect();
  closers.push(() => other.logout());
  for (const [i, from] of senders.entries()) {
    await other.append("INBOX", letter(i, user, from), [], new Date(Date.UTC(2026, 0, 1 + i)));
  }
  const l0 = await other.getMailboxLock("INBOX");
  const uids = (await other.search({ all: true }, { uid: true }) as number[]).sort((a, b) => a - b);
  l0.release();

  const proxy = await startFaultProxy({ host: server.host, port: server.port });
  closers.push(() => proxy.close());
  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: "flag-race" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: user }).returning();
  const mailboxId = mb!.id;
  for (const address of known) await db.insert(contacts).values({ accountId, address });
  const repo = makeDrizzleRepo(db);
  const cfg: ImapConfig = { host: "127.0.0.1", port: proxy.port, secure: false, auth };
  const adapter = new ImapAdapter(cfg, { maxBatchMessages: 2 });
  await adapter.connect();
  closers.push(() => adapter.close());
  await adapter.ensureFolders(FIXTURE_DOOR);

  const lines: string[] = [];
  const cycle = () => runSyncCycle({
    repo, adapter, accountId, mailboxId, role: "organizer",
    writeAuthority: FIXTURE_LEASE, storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
    log: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(l) }),
  });
  /** Cycles until the import is done and filed; every outcome, an `ok` or the first words of a throw. */
  const drain = async (): Promise<string[]> => {
    const outcomes: string[] = [];
    for (let i = 0; i < 8; i++) {
      try {
        const o = await cycle();
        outcomes.push("ok");
        if (!o.hasBacklog && !o.owesFiling) break;
      } catch (e) { outcomes.push(`threw ${(e as Error).message.slice(0, 60)}`); }
    }
    return outcomes;
  };
  const markSeen = async (uid: number): Promise<void> => {
    const l = await other.getMailboxLock("INBOX");
    try { await other.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }); } finally { l.release(); }
  };
  /** The Message-IDs a server folder holds now, read on the other session. */
  const onServer = async (canonical: string): Promise<string[]> => {
    const l = await other.getMailboxLock(adapter.toServerPath(canonical)).catch(() => null);
    if (!l) return [];
    try {
      const found = await other.search({ all: true }, { uid: true }) as number[];
      const ids: string[] = [];
      if (found.length > 0) {
        for await (const m of other.fetch(found, { uid: true, envelope: true }, { uid: true })) {
          if (m.envelope?.messageId) ids.push(m.envelope.messageId);
        }
      }
      return ids.sort();
    } finally { l.release(); }
  };
  const stored = async () => {
    const rows = await db.select({ id: messages.id, mid: messages.messageIdHeader, subject: messages.subject, from: messages.fromAddress })
      .from(messages).where(eq(messages.mailboxId, mailboxId));
    const places = await db.select({ messageId: messageInstances.messageId, folder: messageInstances.folder })
      .from(messageInstances).where(eq(messageInstances.mailboxId, mailboxId));
    return { rows, places };
  };
  const ids = senders.map((_, i) => `<letter-${i}-${user}>`);
  return { proxy, uids, ids, drain, markSeen, onServer, stored, lines };
}

const BODY = (c: string, a: string): boolean => c === "UID FETCH" && /BODY\.PEEK\[\]/i.test(a);
const KNOWN = ["anna0@x.example", "anna1@x.example", "anna2@x.example", "anna3@x.example"];

const servers: Array<[string, Server | null]> = [
  ["GreenMail", (() => { const g = greenmailConfig(); return { host: g.host, port: g.port, pass: (g.auth as { pass: string }).pass }; })()],
  [CONDSTORE.ok ? "Dovecot" : `Dovecot — SKIPPED: ${CONDSTORE.ok ? "" : CONDSTORE.why}`,
    CONDSTORE.ok ? { host: CONDSTORE_HOST, port: CONDSTORE_PORT, pass: process.env.IMAP_CONDSTORE_PASS ?? "testpass-password" } : null],
];

describe.each(servers)("a flag change during the import's body fetch, through runSyncCycle (%s)", (_name, server) => {
  const run = server ? it : it.skip;

  const cases: Array<[string, (w: Awaited<ReturnType<typeof world>>) => CommandHold]> = [
    ["the servers' own order: letter 0, not yet imported, marked read during page 1", (w) => ({
      when: BODY, run: () => w.markSeen(w.uids[0]!),
    })],
    ["the change ahead of the reply: a page letter marked read during page 1", (w) => ({
      when: BODY, unsolicitedFirst: true, run: () => w.markSeen(w.uids.at(-1)!),
    })],
  ];

  for (const [label, hold] of cases) {
    run(`${label}: every letter once under its own Message-ID, none blank, all four still in INBOX`, async () => {
      const w = await world(server!, KNOWN, KNOWN);
      w.proxy.hold = hold(w);
      const outcomes = await w.drain();
      expect(w.proxy.hold, "the hold never fired, so nothing raced").toBe(null);
      expect(w.proxy.unsolicited + w.proxy.reordered, "the flag change never came back inside the reply").toBeGreaterThan(0);
      const { rows, places } = await w.stored();
      expect(rows.filter((r) => r.mid === null && r.subject === "" && r.from === ""), "a blank message").toEqual([]);
      expect(rows.map((r) => `<${r.mid}>`).sort()).toEqual([...w.ids].sort());
      expect(places.map((p) => p.folder)).toEqual(["INBOX", "INBOX", "INBOX", "INBOX"]);
      expect(await w.onServer("INBOX")).toEqual([...w.ids].sort());
      expect(await w.onServer("ohmail/Screener")).toEqual([]);
      expect(outcomes.every((o) => o === "ok"), outcomes.join(" | ")).toBe(true);
      expect(w.lines.filter((l) => l.includes("ingest_empty_source_refused"))).toEqual([]);
    }, 120_000);
  }

  run("POSITIVE CONTROL: a stranger's letter is still gated into the Screener", async () => {
    const senders = [KNOWN[0]!, KNOWN[1]!, "stranger@elsewhere.example", KNOWN[3]!];
    const w = await world(server!, senders, KNOWN);
    await w.drain();
    const { rows } = await w.stored();
    expect(rows.map((r) => `<${r.mid}>`).sort()).toEqual([...w.ids].sort());
    expect(await w.onServer("ohmail/Screener")).toEqual([w.ids[2]]);
    expect(await w.onServer("INBOX")).toEqual([w.ids[0], w.ids[1], w.ids[3]].sort());
  }, 120_000);
});

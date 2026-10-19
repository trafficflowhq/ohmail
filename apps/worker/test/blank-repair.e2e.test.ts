import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import {
  UNMETERED_STORAGE_CAP, commitChange, createLogger, planChange, type BlankRepairMode, type Change,
} from "@trafficflow/core/mail";
import {
  accounts, contacts, folderState, mailboxes, messageFailures, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";
import {
  CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore,
} from "../../../packages/core/test/adapters/_imapenv.js";

/**
 * THE BLANK REPAIR, END TO END (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS): the real adapter,
 * `runSyncCycle` as organizer and the store on PGlite, on GreenMail and on Dovecot.
 *
 * The damage an older build left, seeded as it stored it: one blank row holding three places. Its
 * primary is in ohmail/Screener, where its own move filed letter 0 from a known contact; a hidden place
 * in INBOX holds letter 1; a place in Sent, below the Sent watermark once a cycle has run, holds the
 * person's own letter 2. Letter 3 is ordinary mail. An off visit runs nothing; a dry visit reads each
 * place once, counts and writes nothing; apply visits send letter 0 back to INBOX, release the other
 * places with a re-read owed, the reaper takes the blank, and the following cycles import every
 * letter once under its own Message-ID, routed by the person's rules — letter 0 and 1 stay in INBOX,
 * letter 2 in Sent.
 */

const CONDSTORE = await probeCondstore();

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });

interface Server { host: string; port: number; pass: string }

function letter(n: number, from: string, to: string, owner: string): string {
  return [
    `Message-ID: <letter-${n}-${owner}>`, `From: ${from}`, `To: ${to}`, `Subject: letter ${n}`,
    "Content-Type: text/plain; charset=utf-8", "", `body ${n}`,
  ].join("\r\n");
}

async function world(server: Server) {
  const user = `blank-${randomUUID()}@trafficflow.test`;
  const auth = { user, pass: server.pass };
  const cfg: ImapConfig = { host: server.host, port: server.port, secure: false, auth };
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  closers.push(() => adapter.close());
  await adapter.ensureFolders(FIXTURE_DOOR);
  const other = new ImapFlow({ host: server.host, port: server.port, secure: false, auth, logger: false });
  await other.connect();
  closers.push(() => other.logout());
  await other.mailboxCreate("Sent").catch(() => undefined);
  const screenerPath = adapter.toServerPath("ohmail/Screener");
  /** Append one letter and answer where it landed, epoch and UID, as the server numbers it. */
  const put = async (path: string, raw: string): Promise<{ uidValidity: string; uid: number }> => {
    await other.append(path, raw, [], new Date(Date.UTC(2026, 0, 1)));
    const l = await other.getMailboxLock(path);
    try {
      const uids = await other.search({ all: true }, { uid: true }) as number[];
      return { uidValidity: String((other.mailbox as { uidValidity: bigint }).uidValidity), uid: Math.max(...uids) };
    } finally { l.release(); }
  };
  const ids = [0, 1, 2, 3].map((n) => `<letter-${n}-${user}>`);
  const l0 = await put(screenerPath, letter(0, "anna0@x.example", user, user));
  const l1 = await put("INBOX", letter(1, "anna1@x.example", user, user));
  const s2 = await put("Sent", letter(2, user, "friend@x.example", user));
  await put("INBOX", letter(3, "anna2@x.example", user, user));

  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: "blank-repair-e2e" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: user }).returning();
  const mailboxId = mb!.id;
  for (const address of ["anna0@x.example", "anna1@x.example", "anna2@x.example"]) {
    await db.insert(contacts).values({ accountId, address });
  }
  const repo = makeDrizzleRepo(db);

  // THE DAMAGE, as an older build stored it: what an empty source parses to (a one-blank-line letter
  // is the same row) at letter 0's place, filed there by ohmail, and the two later blanks as places.
  const blankId = await db.transaction(async (tx) => {
    const r = makeDrizzleRepo(tx as never);
    const change: Change = {
      type: "create", locator: { folder: "ohmail/Screener", ref: `${l0.uidValidity}:${l0.uid}` }, raw: Buffer.from("\r\n"), seen: false,
    };
    const plan = await planChange(change, { repo: r, accountId, mailboxId, readerMode: false });
    return (await commitChange(plan, { storageCap: UNMETERED_STORAGE_CAP, repo: r, accountId, mailboxId })).messageId;
  });
  await repo.recordInstance(blankId, { folder: "INBOX", ref: `${l1.uidValidity}:${l1.uid}` });
  await repo.recordInstance(blankId, { folder: "Sent", ref: `${s2.uidValidity}:${s2.uid}` });
  await repo.upsertFolderState(blankId, { desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us" });
  // Sent was scanned when the blank landed there, so its watermark stands above letter 2.
  await repo.upsertMailboxFolders(mailboxId, [
    { folder: "Sent", cursor: { uidValidity: s2.uidValidity, uidNext: s2.uid + 1, highestModseq: "0" } },
  ]);

  const lines: string[] = [];
  const cycle = (blankRepair: BlankRepairMode) => runSyncCycle({
    repo, adapter, accountId, mailboxId, role: "organizer", blankRepair,
    writeAuthority: FIXTURE_LEASE, storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
    log: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(l) }),
  });
  const drain = async (mode: BlankRepairMode, max = 6): Promise<string[]> => {
    const outcomes: string[] = [];
    for (let i = 0; i < max; i++) {
      try {
        const o = await cycle(mode);
        outcomes.push("ok");
        if (!o.hasBacklog && !o.owesFiling) break;
      } catch (e) { outcomes.push(`threw ${(e as Error).message.slice(0, 60)}`); }
    }
    return outcomes;
  };
  const onServer = async (path: string): Promise<string[]> => {
    const l = await other.getMailboxLock(path);
    try {
      const found = await other.search({ all: true }, { uid: true }) as number[];
      const out: string[] = [];
      if (found.length > 0) {
        for await (const m of other.fetch(found, { uid: true, envelope: true }, { uid: true })) {
          if (m.envelope?.messageId) out.push(m.envelope.messageId);
        }
      }
      return out.sort();
    } finally { l.release(); }
  };
  const live = async () => db.select({ id: messages.id, mid: messages.messageIdHeader }).from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), isNull(messages.deletedAt)));
  const blankPlaces = async () => db.select().from(messageInstances).where(eq(messageInstances.messageId, blankId));
  const repairLines = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "blank_repair");
  /** What the repair writes: the blank's places and its desire, and the re-reads owed. */
  const repairRows = async (): Promise<string> => JSON.stringify(await Promise.all([
    db.select({ folder: messageInstances.folder, uidvalidity: messageInstances.uidvalidity, uid: messageInstances.uid })
      .from(messageInstances).where(eq(messageInstances.messageId, blankId)).orderBy(messageInstances.folder, messageInstances.uid),
    db.select({ desired: folderState.desiredFolder, observed: folderState.observedFolder, by: folderState.lastSetBy })
      .from(folderState).where(eq(folderState.messageId, blankId)),
    db.select({ folder: messageFailures.folder, uid: messageFailures.uid }).from(messageFailures)
      .where(eq(messageFailures.mailboxId, mailboxId)),
  ]), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  return { ids, blankId, screenerPath, drain, onServer, live, blankPlaces, repairLines, repairRows, db };
}

const servers: Array<[string, Server | null]> = [
  ["GreenMail", (() => { const g = greenmailConfig(); return { host: g.host, port: g.port, pass: (g.auth as { pass: string }).pass }; })()],
  [CONDSTORE.ok ? "Dovecot" : `Dovecot — SKIPPED: ${CONDSTORE.ok ? "" : CONDSTORE.why}`,
    CONDSTORE.ok ? { host: CONDSTORE_HOST, port: CONDSTORE_PORT, pass: process.env.IMAP_CONDSTORE_PASS ?? "testpass-password" } : null],
];

describe.each(servers)("the blank repair through runSyncCycle (%s)", (_name, server) => {
  const run = server ? it : it.skip;

  run("off runs nothing; dry counts and writes nothing; apply returns letter 0, and the next cycles import every letter once", async () => {
    const w = await world(server!);
    const untouched = await w.repairRows();

    const off = await w.drain("off", 2);
    expect(off.every((o) => o === "ok"), off.join(" | ")).toBe(true);
    expect(w.repairLines(), "off ran the repair").toEqual([]);
    expect(await w.onServer(w.screenerPath), "off moved a letter").toEqual([w.ids[0]]);
    expect(await w.repairRows(), "off wrote a repair row").toBe(untouched);

    // Two dry cycles, each its own drain: a drain stops at its first quiet cycle.
    const dry = [...await w.drain("dry", 1), ...await w.drain("dry", 1)];
    expect(dry, dry.join(" | ")).toEqual(["ok", "ok"]);
    // Said once: the two dry cycles read each place once, and the count was whole after the first.
    expect(w.repairLines()).toHaveLength(1);
    expect(w.repairLines()[0]).toMatchObject({ mode: "dry", blanks: 1, places: 3, read: 3, returned: 1, released: 2, owed: 2, remaining: 0 });
    expect(await w.onServer(w.screenerPath), "dry moved a letter").toEqual([w.ids[0]]);
    expect(await w.blankPlaces(), "dry let go of a place").toHaveLength(3);
    expect(await w.repairRows(), "dry wrote a repair row").toBe(untouched);

    const outcomes = await w.drain("apply");
    expect(outcomes.every((o) => o === "ok"), outcomes.join(" | ")).toBe(true);
    // Letter 2 is behind the Sent watermark now: only its owed re-read reaches it.
    await w.drain("apply", 2);

    expect(await w.onServer("INBOX")).toEqual([w.ids[0], w.ids[1], w.ids[3]].sort());
    expect(await w.onServer(w.screenerPath)).toEqual([]);
    expect(await w.onServer("Sent")).toEqual([w.ids[2]]);
    const live = await w.live();
    expect(live.map((r) => `<${r.mid}>`).sort(), "every letter once, and no blank").toEqual([...w.ids].sort());
    const [blank] = await w.db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.id, w.blankId));
    expect(blank!.deletedAt, "the reaper took the blank once it held no place").not.toBe(null);

    // A further apply has nothing left to repair.
    const before = w.repairLines().length;
    await w.drain("apply", 1);
    expect(w.repairLines().slice(before).filter((l) => (l.places as number) > 0)).toEqual([]);
  }, 180_000);
});

import { accountOfMailbox } from "@trafficflow/db";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import { mailboxCredentials, mailboxFolders, mailboxes, messageInstances, messages } from "@trafficflow/db";
import { acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import type { ApiDeps } from "../src/deps.js";

/**
 * THE SELF-CHECK AGAINST A REAL SERVER — the fixture half both server twins share. It writes only
 * to the fixture server (folders and appended letters, before the read under test) and to a PGlite
 * store standing in for the mirror. The swallowing proxy is how an honest server is made to leave
 * one STATUS unanswered: it relays every byte except that command's line.
 */

export interface Shape { name: string; host: string; port: number; user: () => string; pass: string }

export type Db = Awaited<ReturnType<typeof makeTestDb>>;

const eml = (n: number, folder: string): string => [
  `Message-ID: <rc-${n}-${randomUUID()}@selfcheck.test>`, "From: s@selfcheck.test", "To: r@selfcheck.test",
  `Subject: letter ${n} in ${folder}`, "Content-Type: text/plain; charset=utf-8", "", "hello",
].join("\r\n");

/** The slice of imapflow the fixture drives — the adapter's own client, from core's dependency. */
interface FixtureClient {
  mailbox: unknown;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  mailboxCreate(path: string): Promise<unknown>;
  mailboxRename(from: string, to: string): Promise<unknown>;
  append(path: string, raw: string, flags: string[]): Promise<unknown>;
  getMailboxLock(path: string, opts?: { readOnly?: boolean }): Promise<{ release(): void }>;
  search(q: { all: true }, o: { uid: true }): Promise<number[] | false>;
  messageDelete(range: string, o: { uid: true }): Promise<boolean>;
}
type FixtureCtor = new (o: Record<string, unknown>) => FixtureClient;
const { ImapFlow } = createRequire(new URL("../../core/package.json", import.meta.url))("imapflow") as { ImapFlow: FixtureCtor };

/** One fixture connection, logged in; closed by the caller's `finally`. */
async function fixture(shape: Shape, user: string): Promise<FixtureClient> {
  const c = new ImapFlow({ host: shape.host, port: shape.port, secure: false, auth: { user, pass: shape.pass }, logger: false });
  await c.connect();
  return c;
}

/** Folder → { epoch, uids } as the server states them now. */
export async function serverState(shape: Shape, user: string, folders: readonly string[]): Promise<Record<string, { epoch: string; uids: number[]; next: number }>> {
  const c = await fixture(shape, user);
  try {
    const out: Record<string, { epoch: string; uids: number[]; next: number }> = {};
    for (const f of folders) {
      const lock = await c.getMailboxLock(f, { readOnly: true });
      try {
        const mb = c.mailbox as { uidValidity: bigint; uidNext: number; exists: number };
        const uids = mb.exists === 0 ? [] : (await c.search({ all: true }, { uid: true })) || [];
        out[f] = { epoch: String(mb.uidValidity), uids: [...uids].sort((a, b) => a - b), next: mb.uidNext };
      } finally {
        lock.release();
      }
    }
    return out;
  } finally {
    await c.logout().catch(() => c.close());
  }
}

/** Create each folder that is not INBOX and append `count` letters to it. */
export async function seedServer(shape: Shape, user: string, counts: Record<string, number>): Promise<void> {
  const c = await fixture(shape, user);
  try {
    let n = 0;
    for (const [folder, count] of Object.entries(counts)) {
      if (folder !== "INBOX") await c.mailboxCreate(folder);
      for (let i = 0; i < count; i++) await c.append(folder, eml(n++, folder), ["\\Seen"]);
    }
  } finally {
    await c.logout().catch(() => c.close());
  }
}

/**
 * Move one folder aside and create a fresh one under its name, with `count` letters — the server
 * states a new UIDVALIDITY for it, read back by the caller. RENAME and not DELETE: GreenMail drops
 * the connection on a DELETE of a folder that has held mail (measured), and both take a RENAME.
 */
export async function recreateFolder(shape: Shape, user: string, folder: string, count: number): Promise<void> {
  const c = await fixture(shape, user);
  try { await c.mailboxRename(folder, `${folder}-aside`); } finally { await c.logout().catch(() => c.close()); }
  // Both servers stamp an epoch from the clock; a second apart keeps the new one distinct.
  await new Promise((ok) => setTimeout(ok, 1_100));
  await seedServer(shape, user, { [folder]: count });
}

/** Expunge one letter on the server — the other direction of a difference. */
export async function expungeOne(shape: Shape, user: string, folder: string, uid: number): Promise<void> {
  const c = await fixture(shape, user);
  try {
    const lock = await c.getMailboxLock(folder);
    try { await c.messageDelete(String(uid), { uid: true }); } finally { lock.release(); }
  } finally {
    await c.logout().catch(() => c.close());
  }
}

export interface World { db: Db; deps: ApiDeps; accountId: string; mailboxId: string }

/** A store whose one mailbox dials `endpoint` with the fixture login. */
export async function world(shape: Shape, user: string, endpoint: { host: string; port: number } = shape): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `rc-${randomUUID().slice(0, 8)}@selfcheck.test`,
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "sealed", keyVersion: 1,
    meta: { host: endpoint.host, port: endpoint.port, secure: false, user },
  });
  const pass = shape.pass;
  const deps = {
    db,
    keyProvider: { decrypt: async () => pass },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } },
    now: () => new Date(),
  } as unknown as ApiDeps;
  return { db, deps, accountId, mailboxId: mb!.id };
}

/** Record a folder in the mirror at `epoch`, holding an instance for each of `uids`. */
export async function mirrorFolder(w: World, folder: string, epoch: string, uids: readonly number[]): Promise<void> {
  await w.db.insert(mailboxFolders).values({ mailboxId: w.mailboxId, accountId: accountOfMailbox(w.mailboxId), folder, uidvalidity: BigInt(epoch) });
  for (const uid of uids) {
    const key = `rc-${folder}-${uid}-${randomUUID()}`;
    const [m] = await w.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: key, bodyHash: key, dedupKey: key,
      subject: "s", fromAddress: "s@selfcheck.test", snippet: "",
    }).returning({ id: messages.id });
    await w.db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder, uidvalidity: BigInt(epoch), uid,
    });
  }
}

/** Row counts of the mirror's three tables — the read must leave all three as they were. */
export async function storeCounts(w: World): Promise<[number, number, number]> {
  const a = await w.db.select({ id: messages.id }).from(messages);
  const b = await w.db.select({ id: messageInstances.id }).from(messageInstances);
  const c = await w.db.select({ id: mailboxFolders.id }).from(mailboxFolders);
  return [a.length, b.length, c.length];
}

export interface Swallow { port: number; swallowed(): number; close(): Promise<void> }

/**
 * A relay that forwards every client line but a STATUS naming `folder`, so the server never sees
 * that one command and never answers it. Lines are forwarded whole; nothing is read or kept.
 */
export async function swallowStatusOf(target: { host: string; port: number }, folder: string): Promise<Swallow> {
  const sockets = new Set<net.Socket>();
  let swallowed = 0;
  const hit = new RegExp(`^\\S+ STATUS "?${folder}"? `, "i");
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client); sockets.add(upstream);
    let pending = Buffer.alloc(0);
    client.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let nl = pending.indexOf("\r\n"); nl !== -1; nl = pending.indexOf("\r\n")) {
        const line = pending.subarray(0, nl + 2);
        pending = pending.subarray(nl + 2);
        if (hit.test(line.toString("latin1"))) { swallowed += 1; continue; }
        upstream.write(line);
      }
    });
    upstream.on("data", (chunk: Buffer) => { if (!client.destroyed) client.write(chunk); });
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on("close", end); upstream.on("close", end);
    client.on("error", end); upstream.on("error", end);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    port: (server.address() as net.AddressInfo).port,
    swallowed: () => swallowed,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

/** The folder names the fixture server lists — the read must add none, `ohmail/_meta` above all. */
export async function listed(shape: Shape, user: string): Promise<string[]> {
  const c = await fixture(shape, user);
  try {
    const rows = await (c as unknown as { list(): Promise<Array<{ path: string }>> }).list();
    return rows.map((r) => r.path).sort();
  } finally {
    await c.logout().catch(() => c.close());
  }
}

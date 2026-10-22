import { MAX_RAW_MESSAGE_BYTES, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { accounts, contacts, mailboxes, messageFailures, messages, type Tx } from "@trafficflow/db";
import { makeTestDb, serviceUp } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import type { ChangeBatch, ImapConfig } from "@trafficflow/core/adapters/imap-types";
import { MessageService, SearchService, type ServiceContext } from "@trafficflow/services";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";
import { greenmailPorts } from "./_greenmail-ports.js";

/**
 * A MESSAGE OVER THE DOWNLOAD CEILING IS STILL IN THE LIST (OVERSIZE-MESSAGE-IS-STORED-NOWHERE).
 *
 * The real adapter over GreenMail and the worker's cycle on this project's store (PGlite here, the
 * phone's SQLite under `test:sqlite`). A message past `MAX_RAW_MESSAGE_BYTES` was a failure row
 * and nothing else, so no surface showed it. It must be listed, found by subject and by sender,
 * open to its sentence, and move, flag and delete by UID, while no full-body FETCH ever names it.
 * The wire is read through a relay that keeps only FETCH and SELECT lines (never a LOGIN).
 */

const BIG_BYTES = MAX_RAW_MESSAGE_BYTES + 2 * 1024 * 1024;

function bigEml(me: string): string {
  const head = [
    "Message-ID: <too-large@big.test>", "From: Petra Plans <plans@big.test>", `To: ${me}`,
    "Subject: floorplans overlong", "Date: Sun, 27 Sep 2026 10:00:00 +0000", "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=b1", "", "--b1", "Content-Type: text/plain", "",
    "The plans are attached.", "--b1", "Content-Type: application/octet-stream; name=plans.bin",
    "Content-Transfer-Encoding: base64", "", "",
  ].join("\r\n");
  const line = "A".repeat(76) + "\r\n";
  return head + line.repeat(Math.ceil(BIG_BYTES / line.length)) + "--b1--\r\n";
}

function smallEml(me: string): string {
  return [
    "Message-ID: <small@x.test>", "From: anna@x.test", `To: ${me}`, "Subject: a small note",
    "Date: Sun, 27 Sep 2026 09:00:00 +0000", "Content-Type: text/plain", "", "hello",
  ].join("\r\n");
}

/** `3,5:7` → the UIDs it names; `*` never appears in the adapter's UID sets. */
function uidsOf(set: string): number[] {
  return set.split(",").flatMap((p) => {
    const [a, b] = p.split(":").map(Number);
    if (b === undefined) return [a!];
    const out: number[] = [];
    for (let u = Math.min(a!, b); u <= Math.max(a!, b); u++) out.push(u);
    return out;
  });
}

interface FullFetch { folder: string; uids: number[] }

/** A relay that records every full-body FETCH (folder, UIDs) and the largest body literal served. */
async function startFetchTap(target: { host: string; port: number }) {
  const fullFetches: FullFetch[] = [];
  let largestBodyLiteral = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client); sockets.add(upstream);
    let folder = "";
    let pending = "";
    client.on("data", (chunk: Buffer) => {
      pending += chunk.toString("latin1");
      for (let nl = pending.indexOf("\r\n"); nl !== -1; nl = pending.indexOf("\r\n")) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 2);
        const sel = /^\S+ (?:SELECT|EXAMINE) (?:"([^"]+)"|(\S+))/i.exec(line);
        if (sel) folder = sel[1] ?? sel[2]!;
        const f = /^\S+ UID FETCH (\S+) (.*)$/i.exec(line);
        if (f && /(BODY(\.PEEK)?\[\]|BINARY(\.PEEK)?\[\]|RFC822(?![.])|BODY(\.PEEK)?\[TEXT\])/i.test(f[2]!)) {
          fullFetches.push({ folder, uids: uidsOf(f[1]!) });
        }
      }
      if (pending.length > 65536) pending = "";
      upstream.write(chunk);
    });
    let tail = "";
    upstream.on("data", (chunk: Buffer) => {
      const text = tail + chunk.toString("latin1", 0, Math.min(chunk.length, 1 << 20));
      for (const m of text.matchAll(/(?:BODY|BINARY)\[\] \{(\d+)\}/g)) {
        largestBodyLiteral = Math.max(largestBodyLiteral, Number(m[1]));
      }
      tail = chunk.toString("latin1", Math.max(0, chunk.length - 64));
      client.write(chunk);
    });
    for (const [a, b] of [[client, upstream], [upstream, client]] as const) {
      a.on("close", () => b.destroy());
      a.on("error", () => b.destroy());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    fullFetches,
    get largestBodyLiteral() { return largestBodyLiteral; },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });

/* The run's one probe (test/setup/services.global.ts), at the address this file dials. */
const GM = serviceUp("greenmail", `${greenmailPorts().imapHost}:${greenmailPorts().imapPort}`);
const skip = GM.up ? "" : ` (SKIPPED: ${GM.why})`;

describe("a message over the download ceiling", () => {
  it.skipIf(skip !== "")(`is listed, found, opens to its sentence and moves, flags and deletes by UID${skip}`, async () => {
    const p = greenmailPorts();
    const me = `t-${randomUUID()}@trafficflow.test`;
    const direct: ImapConfig = { host: p.imapHost, port: p.imapPort, secure: false, auth: { user: me, pass: "test" } };
    const c = new ImapFlow({ ...direct, logger: false });
    await c.connect();
    closers.push(() => c.logout());
    await c.mailboxCreate("Trash").catch(() => undefined);
    await c.append("INBOX", smallEml(me));
    await c.append("INBOX", bigEml(me));

    const tap = await startFetchTap({ host: p.imapHost, port: p.imapPort });
    closers.push(() => tap.close());
    const db = (await makeTestDb()) as unknown as Tx;
    const [a] = await db.insert(accounts).values({ name: "too-large" }).returning();
    const accountId = a!.id;
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: me, trashFolder: "Trash" }).returning();
    const mailboxId = mb!.id;
    await db.insert(contacts).values({ accountId, address: "anna@x.test" });
    const repo = makeDrizzleRepo(db);
    const adapter = new ImapAdapter({ ...direct, port: tap.port });
    await adapter.connect();
    closers.push(() => adapter.close());
    await adapter.ensureFolders(FIXTURE_DOOR);

    /** Where the big message is on the server, read directly: every (folder, UID) it has had. */
    const seenAt: Array<{ folder: string; uid: number }> = [];
    const whereIsBig = async (): Promise<{ folder: string; uid: number; seen: boolean } | null> => {
      for (const box of await c.list()) {
        if (box.flags.has("\\Noselect")) continue;
        const l = await c.getMailboxLock(box.path);
        try {
          const r = await c.search({ header: { "message-id": "too-large@big.test" } }, { uid: true });
          const uid = Array.isArray(r) && r.length ? r[0]! : 0;
          if (uid > 0) {
            const m = await c.fetchOne(String(uid), { flags: true }, { uid: true });
            seenAt.push({ folder: box.path, uid });
            const folder = box.delimiter ? box.path.split(box.delimiter).join("/") : box.path;
            return { folder, uid, seen: m ? (m.flags?.has("\\Seen") ?? false) : false };
          }
        } finally { l.release(); }
      }
      return null;
    };
    const drain = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) {
        const out = await runSyncCycle({
          repo, adapter, accountId, mailboxId, role: "organizer", writeAuthority: FIXTURE_LEASE,
          storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
        });
        if (!out.hasBacklog && !out.owesFiling) break;
      }
      await whereIsBig();
    };
    const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => new Date(), requestId: "too-large" };
    const found = async (q: string) => (await new SearchService().search(ctx, { q, limit: 20 })).items.map((m) => m.id);

    await drain();
    const [row] = await db.select({ id: messages.id, locator: messages.nativeLocator }).from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, "too-large@big.test")));
    expect(row, "the message over the ceiling has no row: no surface can show it").toBeDefined();
    const id = row!.id;
    expect(await found("floorplans"), "not found by its subject").toContain(id);
    expect(await found("plans@big.test"), "not found by its sender").toContain(id);
    const body = await new MessageService().getBody(ctx, id);
    expect(body.withheld).toBe("too_large");
    expect(body.text).toBe("");
    // A stranger's first message: held at the Screener like any other, moved there by UID.
    expect((await whereIsBig())?.folder).toBe("ohmail/Screener");

    await new MessageService().move(ctx, id, { folder: "ohmail/Receipts" });
    await drain();
    expect((await whereIsBig())?.folder, "the move did not reach the server").toBe("ohmail/Receipts");
    await new MessageService().markSeen(ctx, { ids: [id], unread: false });
    await drain();
    expect((await whereIsBig())?.seen, "the read flag did not reach the server").toBe(true);
    await new MessageService().delete(ctx, id);
    await drain();
    expect((await whereIsBig())?.folder, "the delete did not reach the server").toBe("Trash");

    // The body never moved: no full-body FETCH named it anywhere, and no body literal that large
    // was served. The small message's own body fetch is the positive control for the relay.
    const named = (f: FullFetch, at: { folder: string; uid: number }) => f.folder === at.folder && f.uids.includes(at.uid);
    const smallUid = 1;
    expect(tap.fullFetches.some((f) => named(f, { folder: "INBOX", uid: smallUid })), "the relay read no body fetch at all").toBe(true);
    expect(seenAt.length).toBeGreaterThan(0);
    expect(tap.fullFetches.filter((f) => seenAt.some((at) => named(f, at)))).toEqual([]);
    expect(tap.largestBodyLiteral).toBeGreaterThan(0);
    expect(tap.largestBodyLiteral).toBeLessThan(MAX_RAW_MESSAGE_BYTES);
  }, 180_000);

  it.skipIf(skip !== "")(`one an earlier build wrote off appears on the fixing build's first cycle${skip}`, async () => {
    const p = greenmailPorts();
    const me = `t-${randomUUID()}@trafficflow.test`;
    const cfg: ImapConfig = { host: p.imapHost, port: p.imapPort, secure: false, auth: { user: me, pass: "test" } };
    const c = new ImapFlow({ ...cfg, logger: false });
    await c.connect();
    closers.push(() => c.logout());
    await c.append("INBOX", smallEml(me));
    await c.append("INBOX", bigEml(me));
    const db = (await makeTestDb()) as unknown as Tx;
    const [a] = await db.insert(accounts).values({ name: "too-large-heal" }).returning();
    const accountId = a!.id;
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: me }).returning();
    const mailboxId = mb!.id;
    await db.insert(contacts).values({ accountId, address: "plans@big.test" });
    const repo = makeDrizzleRepo(db);
    const adapter = new ImapAdapter(cfg);
    await adapter.connect();
    closers.push(() => adapter.close());
    await adapter.ensureFolders(FIXTURE_DOOR);
    /* The earlier build's batch: the header-only create was not there, the UID was on `oversize`. */
    const earlier = new Proxy(adapter, {
      get(t, k) {
        if (k === "changesSince") {
          return async (...args: Parameters<ImapAdapter["changesSince"]>): Promise<ChangeBatch> => {
            const b = await t.changesSince(...args);
            const heads = b.creates.filter((x) => x.oversizeBytes !== undefined);
            return {
              ...b,
              creates: b.creates.filter((x) => x.oversizeBytes === undefined),
              oversize: [...(b.oversize ?? []), ...heads.map((h) => {
                const [uidValidity, uid] = h.locator.ref.split(":");
                return { folder: h.locator.folder, uidValidity: uidValidity!, uid: Number(uid), size: h.oversizeBytes! };
              })],
            };
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const drain = async (on: ImapAdapter, buildVersion: string): Promise<void> => {
      for (let i = 0; i < 10; i++) {
        const out = await runSyncCycle({
          repo, adapter: on, accountId, mailboxId, role: "organizer", writeAuthority: FIXTURE_LEASE,
          storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(), buildVersion,
        });
        if (!out.hasBacklog && !out.owesFiling) break;
      }
    };
    const bigRow = async () => (await db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, "too-large@big.test"))))[0];
    const failures = async () => (await db.select({ code: messageFailures.code }).from(messageFailures)
      .where(and(eq(messageFailures.mailboxId, mailboxId), isNull(messageFailures.resolvedAt)))).map((r) => r.code);

    await drain(earlier as ImapAdapter, "earlier-build");
    expect(await bigRow(), "the precondition: the earlier build stored no row").toBeUndefined();
    expect(await failures(), "the precondition: the earlier build wrote it off").toEqual(["mime_too_large"]);

    await drain(adapter, "fixing-build");
    const row = await bigRow();
    expect(row, "the written-off message is still missing after the update").toBeDefined();
    const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => new Date(), requestId: "too-large-heal" };
    expect((await new MessageService().getBody(ctx, row!.id)).withheld).toBe("too_large");
    expect(await failures(), "the failure row is closed once the message is a row").toEqual([]);
  }, 180_000);
});

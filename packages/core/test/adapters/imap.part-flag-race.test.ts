import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore } from "./_imapenv.js";
import { startFaultProxy, type FaultProxy } from "./_fault-proxy.js";

/**
 * A PART READ IS WHOLE WHEN ANOTHER SESSION CHANGES A FLAG WHILE IT RUNS (the forward refused on
 * 2026-10-19). imapflow reads a part as 64 KiB partial FETCHes, and its FETCH command collects
 * EVERY untagged FETCH that arrives while it runs: the answer it asked for, and the flag update the
 * server sends because another session (the sync worker setting \Seen on a message somebody just
 * opened) changed a flag in the selected mailbox. `fetchOne` answered with the first of them, so a
 * server that sends the update first made a chunk read as "no chunk" and the part end there,
 * without an error: a 268 662-byte PDF came back short, missed its sha256, and the forward was
 * refused. The proxy parks one FETCH while the other session marks a message read, then hands the
 * reply back with the server's own flag update ahead of it.
 * Mutation watched: `answerForTheAskedMessage(this.client)` removed from `connect()` ⇒ the four race
 * cases fail (the control stays whole).
 */

const DOVECOT = await probeCondstore();
/** The forwarded PDF's size, byte for byte. */
const PDF = randomBytes(268_662);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function letter(messageId: string, attachment: Buffer): string {
  return [
    `Message-ID: <${messageId}>`, "From: anna@x.example", "To: mila@lichtgrat.example", "Subject: newsletter",
    "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="B"', "",
    "--B", "Content-Type: text/html; charset=utf-8", "", `<p>${"Dear readers ".repeat(80)}</p>`,
    "--B", 'Content-Type: application/pdf; name="list.pdf"', 'Content-Disposition: attachment; filename="list.pdf"',
    "Content-Transfer-Encoding: base64", "",
    attachment.toString("base64").replace(/.{76}/g, "$&\r\n"), "--B--", "",
  ].join("\r\n");
}

const open: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of open.splice(0)) await c().catch(() => { /* already down */ }); });

/** The second and later chunks of a part read — the FETCH a flag update can cut. */
const LATER_CHUNK = (command: string, args: string): boolean => command === "UID FETCH" && /<[1-9]\d*\./.test(args);

async function world(server: { host: string; port: number; pass: string }) {
  const auth = { user: `t-${randomUUID()}@trafficflow.test`, pass: server.pass };
  const proxy: FaultProxy = await startFaultProxy({ host: server.host, port: server.port });
  open.push(() => proxy.close());
  // The OTHER session — the sync worker's connection, which never goes through the proxy.
  const other = new ImapFlow({ host: server.host, port: server.port, secure: false, auth, logger: false });
  await other.connect();
  open.push(() => other.logout());
  await other.append("INBOX", letter(`${randomUUID()}@x.example`, PDF));
  await other.append("INBOX", letter(`${randomUUID()}@x.example`, randomBytes(1024)));
  const lock = await other.getMailboxLock("INBOX");
  const uids = (await other.search({ all: true }, { uid: true }) as number[]).sort((a, b) => a - b);
  const epoch = String((other.mailbox as { uidValidity: bigint }).uidValidity);
  lock.release();
  const [uid, neighbour] = [uids.at(-2)!, uids.at(-1)!];
  const cfg: ImapConfig = { host: "127.0.0.1", port: proxy.port, secure: false, auth };
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  open.push(() => adapter.close());
  const locator = { folder: "INBOX", ref: `${epoch}:${uid}` };
  /** Park the first FETCH `when` matches until the other session has marked `target` read. */
  const markReadDuring = (target: number, when = LATER_CHUNK): void => {
    proxy.hold = {
      when,
      unsolicitedFirst: true,
      run: async () => {
        const l = await other.getMailboxLock("INBOX");
        try { await other.messageFlagsAdd(String(target), ["\\Seen"], { uid: true }); } finally { l.release(); }
      },
    };
  };
  return { adapter, locator, uid, neighbour, proxy, markReadDuring, held: (): boolean => proxy.hold === null };
}

const servers: Array<[string, () => { host: string; port: number; pass: string } | null]> = [
  ["GreenMail", () => { const g = greenmailConfig(); return { host: g.host, port: g.port, pass: (g.auth as { pass: string }).pass }; }],
  [DOVECOT.ok ? "Dovecot" : `Dovecot — SKIPPED: ${DOVECOT.ok ? "" : DOVECOT.why}`,
    () => (DOVECOT.ok ? { host: CONDSTORE_HOST, port: CONDSTORE_PORT, pass: process.env.IMAP_CONDSTORE_PASS ?? "testpass-password" } : null)],
];

describe.each(servers)("a read while another session changes a flag (%s)", (_name, server) => {
  const run = server() ? it : it.skip;

  run("an undisturbed read is the whole part (the control)", async () => {
    const { adapter, locator } = await world(server()!);
    const got = await adapter.fetchPart(locator, "2");
    expect(sha(got.body)).toBe(sha(PDF));
  });

  run("the message itself marked read between two chunks: the part is whole", async () => {
    const { adapter, locator, uid, proxy, markReadDuring, held } = await world(server()!);
    markReadDuring(uid);
    const got = await adapter.fetchPart(locator, "2");
    // The rig did what it says: the hold fired and the server's flag update reached us first.
    expect(held()).toBe(true);
    expect(proxy.reordered).toBeGreaterThanOrEqual(1);
    expect(got.body.byteLength, "a flag update read as the end of the part").toBe(PDF.byteLength);
    expect(sha(got.body)).toBe(sha(PDF));
  });

  run("another message of the folder marked read between two chunks: the part is whole", async () => {
    const { adapter, locator, neighbour, proxy, markReadDuring } = await world(server()!);
    markReadDuring(neighbour);
    const got = await adapter.fetchPart(locator, "2");
    expect(proxy.reordered).toBeGreaterThanOrEqual(1);
    expect(sha(got.body)).toBe(sha(PDF));
  });

  run("a streamed read raced the same way is whole, and its size and sha are the file's", async () => {
    const { adapter, locator, uid, proxy, markReadDuring } = await world(server()!);
    markReadDuring(uid);
    const sunk: Buffer[] = [];
    const got = await adapter.fetchPartTo(locator, "2", (c) => { sunk.push(Buffer.from(c)); });
    expect(proxy.reordered).toBeGreaterThanOrEqual(1);
    expect([got.bytes, got.sha256]).toEqual([PDF.byteLength, sha(PDF)]);
    expect(sha(Buffer.concat(sunk))).toBe(sha(PDF));
  });

  run("the tree read during the race is the message's own, never a flag update's nothing", async () => {
    const { adapter, locator, uid, proxy, markReadDuring } = await world(server()!);
    markReadDuring(uid, (command, args) => command === "UID FETCH" && /BODYSTRUCTURE/i.test(args));
    const tree = await adapter.fetchStructure(locator);
    expect(proxy.reordered).toBeGreaterThanOrEqual(1);
    expect(tree?.children.map((n) => n.type)).toEqual(["text/html", "application/pdf"]);
  });
});

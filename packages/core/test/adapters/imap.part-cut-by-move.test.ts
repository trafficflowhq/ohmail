import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapAdapter, MessageGoneError } from "../../src/adapters/imap.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore } from "./_imapenv.js";
import { startFaultProxy, type FaultProxy } from "./_fault-proxy.js";

/**
 * A PART READ CUT BY A MOVE IS GONE, NEVER SHORT. imapflow reads a part as 64 KiB partial FETCHes
 * and ends the stream without an error when one comes back empty, which is what both servers
 * answer once another session has moved the UID away. The proxy parks the second chunk's FETCH
 * while a second session moves the message, so the cut lands between two chunks on every run.
 * Mutation watched: the post-read UID check in `streamPart` removed ⇒ the cut reads resolve short.
 */

const DOVECOT = await probeCondstore();
const DEST = "Dest";
const PICTURE = randomBytes(300 * 1024);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function letter(messageId: string): string {
  return [
    `Message-ID: <${messageId}>`, "From: anna@x.example", "To: mila@lichtgrat.example", "Subject: pictures",
    "MIME-Version: 1.0", 'Content-Type: multipart/related; boundary="B"', "",
    "--B", "Content-Type: text/html; charset=utf-8", "", '<p><img src="cid:p1@x"></p>',
    "--B", "Content-Type: image/png", "Content-ID: <p1@x>", "Content-Transfer-Encoding: base64", "",
    PICTURE.toString("base64").replace(/.{76}/g, "$&\r\n"), "--B--", "",
  ].join("\r\n");
}

const open: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of open.splice(0)) await c().catch(() => { /* already down */ }); });

async function world(server: { host: string; port: number; pass: string }) {
  const auth = { user: `t-${randomUUID()}@trafficflow.test`, pass: server.pass };
  const proxy: FaultProxy = await startFaultProxy({ host: server.host, port: server.port });
  open.push(() => proxy.close());
  const other = new ImapFlow({ host: server.host, port: server.port, secure: false, auth, logger: false });
  await other.connect();
  open.push(() => other.logout());
  await other.mailboxCreate(DEST).catch(() => { /* there already */ });
  await other.append("INBOX", letter(`${randomUUID()}@x.example`));
  const lock = await other.getMailboxLock("INBOX");
  const uid = Math.max(...(await other.search({ all: true }, { uid: true }) as number[]));
  const epoch = String((other.mailbox as { uidValidity: bigint }).uidValidity);
  lock.release();
  const cfg: ImapConfig = { host: "127.0.0.1", port: proxy.port, secure: false, auth };
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  open.push(() => adapter.close());
  const locator = { folder: "INBOX", ref: `${epoch}:${uid}` };
  /** Park the first FETCH past the part's first chunk until the other session has moved it. */
  const moveMidRead = (): { moved: Promise<{ folder: string; ref: string }> } => {
    let done!: (l: { folder: string; ref: string }) => void;
    const moved = new Promise<{ folder: string; ref: string }>((r) => { done = r; });
    proxy.hold = {
      when: (command, args) => command === "UID FETCH" && /<[1-9]\d*\./.test(args),
      run: async () => {
        const l = await other.getMailboxLock("INBOX");
        let to: number | undefined;
        try {
          const r = await other.messageMove(String(uid), DEST, { uid: true });
          to = r && r.uidMap ? r.uidMap.get(uid) : undefined;
        } finally { l.release(); }
        const dl = await other.getMailboxLock(DEST);
        const destEpoch = String((other.mailbox as { uidValidity: bigint }).uidValidity);
        dl.release();
        done({ folder: DEST, ref: `${destEpoch}:${to}` });
      },
    };
    return { moved };
  };
  return { adapter, locator, moveMidRead, parked: (): boolean => proxy.hold === null };
}

const servers: Array<[string, () => { host: string; port: number; pass: string } | null]> = [
  ["GreenMail", () => { const g = greenmailConfig(); return { host: g.host, port: g.port, pass: "test" }; }],
  [DOVECOT.ok ? "Dovecot" : `Dovecot — SKIPPED: ${DOVECOT.ok ? "" : DOVECOT.why}`,
    () => (DOVECOT.ok ? { host: CONDSTORE_HOST, port: CONDSTORE_PORT, pass: process.env.IMAP_CONDSTORE_PASS ?? "testpass-password" } : null)],
];

describe.each(servers)("a part read while its message moves (%s)", (_name, server) => {
  const run = server() ? it : it.skip;

  run("an uncut read is the whole part (the control)", async () => {
    const { adapter, locator } = await world(server()!);
    const got = await adapter.fetchPart(locator, "2");
    expect(sha(got.body)).toBe(sha(PICTURE));
  });

  run("a buffered read cut by the move refuses as gone, and the part reads whole where it went", async () => {
    const { adapter, locator, moveMidRead, parked } = await world(server()!);
    const { moved } = moveMidRead();
    const err = await adapter.fetchPart(locator, "2").then((p) => p.body.byteLength, (e: unknown) => e);
    expect(parked()).toBe(true);
    expect(err, "a cut read must never resolve, short or not").toBeInstanceOf(MessageGoneError);
    const there = await adapter.fetchPart(await moved, "2");
    expect(sha(there.body)).toBe(sha(PICTURE));
  });

  run("a streamed read cut by the move refuses as gone", async () => {
    const { adapter, locator, moveMidRead, parked } = await world(server()!);
    moveMidRead();
    let sunk = 0;
    const err = await adapter.fetchPartTo(locator, "2", (c) => { sunk += c.byteLength; })
      .then((p) => p.bytes, (e: unknown) => e);
    expect(parked()).toBe(true);
    expect(err).toBeInstanceOf(MessageGoneError);
    expect(sunk).toBeLessThan(PICTURE.length);
  });
});

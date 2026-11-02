import net from "node:net";
import { ImapFlow } from "imapflow";

/**
 * A MAIL SERVER THAT FILES ITS OWN SUBMISSIONS, the way Gmail does — over a real GreenMail.
 *
 * Two loopback servers in front of one GreenMail user. The IMAP half relays to GreenMail and adds
 * `X-GM-EXT-1` to every `* CAPABILITY` line (and strips the `X-GM-*` fetch items imapflow then asks
 * for, which GreenMail would refuse). The SMTP half accepts a submission and APPENDs it, with a
 * `Received:` line of its own, into the user's Sent folder `fileDelayMs` after answering 250 —
 * Gmail's saved copy, whose bytes are not the client's. `announce`/`files` off give the ordinary
 * server. Nothing here logs: the relay carries a LOGIN and the sink an AUTH.
 */
export interface GmailLikeOptions {
  upstream: { host: string; port: number };
  auth: { user: string; pass: string };
  /** Add `X-GM-EXT-1` to the capability lines. Default true. */
  announce?: boolean;
  /** File each accepted submission into Sent. Default true. */
  files?: boolean;
  /** How long after the 250 the copy is filed. Default 0. */
  fileDelayMs?: number;
  /** The folder the copy is filed into. Default `Sent`, the name the adapter resolves here. */
  sentFolder?: string;
  /** Swallow every SEARCH the client sends — a server that never answers the look. */
  hangSearch?: boolean;
  /** Announce `AUTH=XOAUTH2` and sign in with its bearer token as the password (an OAuth mailbox). */
  xoauth2?: boolean;
}

export interface GmailLikePair {
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
  /** Submissions the sink accepted (DATA answered 250). */
  readonly submissions: number;
  /** The Sent uids the sink filed, in order. */
  readonly filedUids: readonly number[];
  /** Fetch items the relay stripped — proof imapflow saw the announcement. */
  readonly strippedGmailItems: number;
  /** Resolves once `n` copies have been filed (or rejects after `ms`). */
  whenFiled(n: number, ms?: number): Promise<void>;
  close(): Promise<void>;
}

const GM_ITEM = / X-GM-(MSGID|THRID|LABELS)\b/gi;

/** `AUTHENTICATE XOAUTH2 <b64>` as the `LOGIN` GreenMail speaks: the bearer token is the password. */
function asLogin(line: string): string {
  const m = /^(\S+) AUTHENTICATE XOAUTH2 (\S+)$/i.exec(line);
  if (!m) return line;
  const fields = Buffer.from(m[2]!, "base64").toString("utf8").split("\x01");
  const user = fields.find((f) => f.startsWith("user="))?.slice(5) ?? "";
  const token = fields.find((f) => f.startsWith("auth=Bearer "))?.slice(12) ?? "";
  const q = (v: string): string => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return `${m[1]} LOGIN ${q(user)} ${q(token)}`;
}

const LITERAL_AT_END = /\{(\d+)\+?\}$/;

/**
 * Line-wise rewrite of an IMAP byte stream that passes literal payloads through untouched: a
 * line ending `{n}` / `{n+}` is followed by exactly n bytes that are never parsed as lines.
 */
function lineRewriter(rewrite: (line: string) => string | null): (chunk: Buffer, out: (b: Buffer) => void) => void {
  let pending = Buffer.alloc(0);
  let literal = 0;
  return (chunk, out) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (literal > 0) {
        if (pending.length === 0) return;
        const take = Math.min(literal, pending.length);
        out(pending.subarray(0, take));
        pending = pending.subarray(take);
        literal -= take;
        continue;
      }
      const nl = pending.indexOf("\r\n");
      if (nl < 0) return;
      const line = pending.subarray(0, nl).toString("latin1");
      pending = pending.subarray(nl + 2);
      const m = LITERAL_AT_END.exec(line);
      if (m) literal = Number(m[1]);
      const next = rewrite(line);
      if (next !== null) out(Buffer.from(`${next}\r\n`, "latin1"));
    }
  };
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

export async function startGmailLikePair(o: GmailLikeOptions): Promise<GmailLikePair> {
  const announce = o.announce ?? true;
  const files = o.files ?? true;
  const delay = o.fileDelayMs ?? 0;
  const sentFolder = o.sentFolder ?? "Sent";
  const sockets = new Set<net.Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const filedUids: number[] = [];
  const waiters: Array<() => void> = [];
  let submissions = 0;
  let stripped = 0;

  const imapServer = net.createServer((client) => {
    const upstream = net.connect(o.upstream.port, o.upstream.host);
    sockets.add(client); sockets.add(upstream);
    const toServer = lineRewriter((line) => o.hangSearch && /^\S+ (UID )?SEARCH /i.test(line)
      ? null : o.xoauth2 ? asLogin(line).replace(GM_ITEM, () => { stripped++; return ""; })
        : line.replace(GM_ITEM, () => { stripped++; return ""; }));
    const toClient = lineRewriter((line) => {
      const caps = /^\* CAPABILITY /i.test(line) || /^\* OK \[CAPABILITY /i.test(line);
      const withAuth = o.xoauth2 && caps ? line.replace(/^(\* (?:OK \[)?CAPABILITY )/i, "$1AUTH=XOAUTH2 ") : line;
      return announce && /^\* CAPABILITY /i.test(withAuth) && !/\bX-GM-EXT-1\b/i.test(withAuth) ? `${withAuth} X-GM-EXT-1` : withAuth;
    });
    client.on("data", (c: Buffer) => toServer(c, (b) => upstream.write(b)));
    upstream.on("data", (c: Buffer) => toClient(c, (b) => client.write(b)));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });

  const file = async (raw: Buffer): Promise<void> => {
    const c = new ImapFlow({ host: o.upstream.host, port: o.upstream.port, secure: false, auth: o.auth, logger: false });
    await c.connect();
    try {
      try { await c.mailboxCreate(sentFolder); } catch { /* already there */ }
      const stamp = Buffer.from(`Received: from client by gmail-like.test; ${new Date().toUTCString()}\r\n`);
      const res = await c.append(sentFolder, Buffer.concat([stamp, raw]), ["\\Seen"]);
      if (res && typeof res !== "boolean" && typeof res.uid === "number") filedUids.push(res.uid);
      else filedUids.push(-1);
    } finally {
      await c.logout().catch(() => undefined);
    }
    for (const w of waiters.splice(0)) w();
  };

  const smtpServer = net.createServer((socket) => {
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    let inData = false;
    socket.write("220 gmail-like.test ESMTP\r\n");
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          const body = buf.subarray(0, end + 2).toString("latin1").replace(/^\.\./gm, ".");
          buf = buf.subarray(end + 5);
          inData = false;
          submissions++;
          socket.write("250 2.0.0 OK accepted\r\n");
          if (files) {
            const t = setTimeout(() => { timers.delete(t); void file(Buffer.from(body, "latin1")); }, delay);
            timers.add(t);
          }
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const upper = buf.subarray(0, nl).toString("latin1").toUpperCase();
        buf = buf.subarray(nl + 2);
        if (upper.startsWith("EHLO")) socket.write("250-gmail-like.test\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (upper.startsWith("HELO")) socket.write("250 gmail-like.test\r\n");
        else if (upper.startsWith("AUTH")) socket.write("235 2.7.0 Accepted\r\n");
        else if (upper.startsWith("DATA")) { inData = true; socket.write("354 go ahead\r\n"); }
        else if (upper.startsWith("QUIT")) { socket.write("221 bye\r\n"); socket.end(); return; }
        else socket.write("250 OK\r\n");
      }
    });
    socket.on("error", () => { /* the client hangs up after QUIT */ });
  });

  const imapPort = await listen(imapServer);
  const smtpPort = await listen(smtpServer);
  return {
    imap: { host: "127.0.0.1", port: imapPort },
    smtp: { host: "127.0.0.1", port: smtpPort },
    get submissions() { return submissions; },
    get filedUids() { return filedUids; },
    get strippedGmailItems() { return stripped; },
    whenFiled(n, ms = 15_000) {
      return new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`the sink filed ${filedUids.length} of ${n} within ${ms} ms`)), ms);
        const check = (): void => {
          if (filedUids.length >= n) { clearTimeout(t); resolve(); } else waiters.push(check);
        };
        check();
      });
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.destroy();
      await Promise.all([imapServer, smtpServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}

/** The Sent uids carrying `messageId`, read over a fresh connection straight to GreenMail. */
export async function sentUidsFor(
  upstream: { host: string; port: number }, auth: { user: string; pass: string },
  messageId: string, sentFolder = "Sent",
): Promise<number[]> {
  const c = new ImapFlow({ host: upstream.host, port: upstream.port, secure: false, auth, logger: false });
  await c.connect();
  try {
    const lock = await c.getMailboxLock(sentFolder);
    try {
      const hits = await c.search({ header: { "message-id": messageId.replace(/[<>]/g, "") } }, { uid: true });
      return Array.isArray(hits) ? [...hits].sort((a, b) => a - b) : [];
    } finally {
      lock.release();
    }
  } finally {
    await c.logout().catch(() => undefined);
  }
}

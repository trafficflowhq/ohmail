/**
 * THE PHONE-OFFLINE RIG: the real phone engine over `node:sqlite`, dialling a real IMAP server (and
 * SMTP, when asked) through cables a test can cut. Shared by the two files that measure what the
 * phone does across an outage: mail arriving, and mail being sent. Not a test file.
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { expect } from "vitest";
import { ImapFlow } from "imapflow";
import {
  startPhoneEngine,
  startPhoneEngineFromSealed,
  type PhoneEngine,
  type PhoneSqlExecutor,
  type PhoneSqlRows,
} from "../src/mobile.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
      columns?(): { column?: string | null; name?: string }[];
    };
  };
};

/** The repo's own variables, which a lane GreenMail sets (`test/setup/lane-greenmail.ts`). */
export const HOST = process.env.OHMAIL_PHONE_IMAP_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.OHMAIL_PHONE_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);
export const SMTP_PORT = Number(process.env.OHMAIL_PHONE_SMTP_PORT ?? process.env.SMTP_PORT ?? 3025);
/* The other shapes this was measured in are chosen by environment: a CONDSTORE/MOVE server (the
   repo's Dovecot fixture, its password by env file, never a literal here) and a longer outage. */
export const PASS = process.env.OHMAIL_OFFLINE_IMAP_PASS ?? "test";
export const DELIVER_AT_MS = Number(process.env.OHMAIL_OFFLINE_DELIVER_MS ?? 20_000);
export const OUTAGE_MS = Number(process.env.OHMAIL_OFFLINE_OUTAGE_MS ?? 25_000);

export const EXPECTED_DIALECT = process.env.OHMAIL_EXPECT_DIALECT;
export const ON_DEVICE_STORE = EXPECTED_DIALECT === "sqlite";

/** `node:sqlite` behind the phone's statement-runner contract, with a real yield in every call. */
export function nodeExecutor(file: string): PhoneSqlExecutor {
  const raw = new sqlite.DatabaseSync(file);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(async () => {
        await yielded();
        const st = raw.prepare(sql);
        const columns = (st.columns ? st.columns() : []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...params) as Record<string, unknown>[];
        const rows = columns.length > 0
          ? objects.map((o) => columns.map((c) => o[c]))
          : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => { await yielded(); raw.prepare(sql).run(...params); });
    },
    async batch(statements: readonly { sql: string; params?: readonly unknown[] }[]): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...params);
          raw.exec("COMMIT");
        } catch (err) {
          try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ }
          throw err;
        }
      });
    },
    async close(): Promise<void> { try { raw.close(); } catch { /* already closed */ } },
  };
}

/** The sibling rig files' dialect seam, for their reason: the ingest path still carries raw pg. */
export function dialectSeam(exec: PhoneSqlExecutor): PhoneSqlExecutor {
  const rules: [RegExp, (...a: string[]) => string][] = [
    [/(^|[^A-Za-z0-9_.])now\(\)/gi, (_m, pre) => `${pre}CAST(unixepoch('subsec')*1000 AS INTEGER)`],
    [/::\s*(timestamptz|timestamp|uuid|text|jsonb|json|int|integer|bigint|numeric|boolean|date)\b/gi, () => ""],
    [/\bgreatest\s*\(/gi, () => "max("],
    [/\bleast\s*\(/gi, () => "min("],
    [/\s+for\s+update(\s+skip\s+locked)?/gi, () => ""],
  ];
  const rewrite = (sql: string): string => {
    let out = String(sql);
    for (const [re, to] of rules) {
      re.lastIndex = 0;
      out = out.replace(re, to as (substring: string, ...args: unknown[]) => string);
    }
    return out;
  };
  return {
    all: (sql, params) => exec.all(rewrite(sql), params),
    run: (sql, params) => exec.run(rewrite(sql), params),
    batch: (st) => exec.batch(st.map((q) => ({ sql: rewrite(q.sql), params: q.params }))),
    close: () => exec.close(),
  };
}

/**
 * THE PHONE'S NETWORK, as a cable between the engine and the server. `cut()` is the interface
 * going away. In `reset` mode every open connection ends and a new one is refused at once, as a
 * phone refuses a connect in airplane mode; in `stall` mode open connections go silent and keep
 * their bytes, and heal on `mend()`, as a NAT that outlives the radio does. The verdict clients
 * dial the server directly, so they are never on this cable. With a `rate` (bytes a second) it is a
 * slow link: each chunk waits its share of time, and the sender is held back meanwhile.
 */
export class Cable {
  private server: Server | null = null;
  private live = new Set<Socket>();
  private held: Array<() => void> = [];
  up = true;
  port = 0;
  constructor(
    private readonly mode: "reset" | "stall" = "reset",
    private readonly target: { host: string; port: number } = { host: HOST, port: PORT },
    private readonly rate: number | null = null,
  ) {}
  async open(): Promise<void> {
    this.server = createServer((inbound) => {
      if (!this.up) { inbound.destroy(); return; }
      const outbound = netConnect(this.target);
      this.live.add(inbound);
      this.live.add(outbound);
      const end = (): void => {
        inbound.destroy();
        outbound.destroy();
        this.live.delete(inbound);
        this.live.delete(outbound);
      };
      inbound.on("error", end).on("close", end);
      outbound.on("error", end).on("close", end);
      const carry = (from: Socket, to: Socket): void => {
        const pass = (b: Buffer): void => {
          if (this.up) { to.write(b); return; }
          this.held.push(() => to.write(b));
        };
        from.on("data", (b: Buffer) => {
          if (this.rate === null) { pass(b); return; }
          from.pause();
          setTimeout(() => { if (!to.destroyed) pass(b); from.resume(); }, (b.length / this.rate) * 1000);
        });
      };
      carry(inbound, outbound);
      carry(outbound, inbound);
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr !== null ? addr.port : 0;
  }
  cut(): void {
    this.up = false;
    if (this.mode === "stall") return;
    for (const s of [...this.live]) s.destroy();
    this.live.clear();
  }
  mend(): void {
    this.up = true;
    const held = this.held;
    this.held = [];
    for (const write of held) { try { write(); } catch { /* the socket ended meanwhile */ } }
  }
  async close(): Promise<void> {
    this.up = false;
    for (const s of [...this.live]) s.destroy();
    this.live.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

export interface Line { event: string; detail: Record<string, unknown> }
export interface Phone { engine: PhoneEngine; lines: Line[]; exec: PhoneSqlExecutor; installId: string; file: string }

export const open: PhoneEngine[] = [];
export const cables: Cable[] = [];
export const dirs: string[] = [];

export async function bootPhone(o: { user: string; file: string; cable: Cable; smtp?: { port: number } }): Promise<Phone> {
  const lines: Line[] = [];
  const installId = `install-${randomUUID()}`;
  const exec = dialectSeam(nodeExecutor(o.file));
  const engine = await startPhoneEngine({
    exec,
    imap: {
      host: "127.0.0.1", port: o.cable.port, secure: false,
      /* GreenMail runs with authentication disabled and makes the user at first login, so its
         default is a fixture constant rather than a credential — the sibling rig files' idiom. */
      auth: { user: o.user, pass: PASS },
      smtp: o.smtp ? { host: "127.0.0.1", port: o.smtp.port, secure: false } : { host: HOST, port: SMTP_PORT, secure: false },
      sentDomain: "trafficflow.test",
    },
    machineName: "the offline phone",
    installId,
    keks: { 1: "b".repeat(64) },
    log: (event, detail) => { lines.push({ event, detail }); },
  });
  open.push(engine);
  return { engine, lines, exec, installId, file: o.file };
}

/** The app relaunched cold: the same install on the same store, from what the last launch sealed. */
export async function relaunch(prior: Phone): Promise<Phone> {
  const lines: Line[] = [];
  const exec = dialectSeam(nodeExecutor(prior.file));
  const started = await startPhoneEngineFromSealed({
    exec,
    machineName: "the offline phone",
    installId: prior.installId,
    keks: { 1: "b".repeat(64) },
    log: (event, detail) => { lines.push({ event, detail }); },
  });
  expect(started.kind, "the relaunch found no sealed mailbox").toBe("started");
  if (started.kind !== "started") throw new Error("unreachable");
  open.push(started.engine);
  return { engine: started.engine, lines, exec, installId: prior.installId, file: prior.file };
}

export function seedMailboxId(p: Phone): string {
  const ids = Object.keys(p.engine.runtimes().organizer);
  expect(ids, "the composition seeds exactly one mailbox from its config").toHaveLength(1);
  return ids[0]!;
}

/** A press on the phone's door. A CONSENT press here is the person's Connect, so it carries
 *  `consent: "person"` exactly as `apps/mobile/src/net/mailboxes.ts#organizeHere` sends it. */
export async function post(p: Phone, path: string): Promise<number> {
  const person = path.endsWith("/organize");
  const res = await p.engine.handle(new Request(`http://sidecar${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${p.engine.sessionToken}`,
      ...(person ? { "content-type": "application/json" } : {}),
    },
    ...(person ? { body: JSON.stringify({ consent: "person" }) } : {}),
  }));
  return res.status;
}

/** A client this engine knows nothing about, straight to the server. */
export async function withServer<T>(user: string, fn: (c: ImapFlow) => Promise<T>, at = { host: HOST, port: PORT }): Promise<T> {
  const c = new ImapFlow({ host: at.host, port: at.port, secure: false, auth: { user, pass: PASS }, logger: false });
  c.on("error", () => undefined); // a reset socket's error event, else uncaught; the pending op rejects anyway
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => undefined); }
}

/** A stranger's letter, delivered into INBOX as the server would. */
export async function deliver(user: string, from: string, subject: string): Promise<void> {
  const raw = [
    `From: ${from}`, `To: ${user}`, `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@stranger.example>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", `The body of ${subject}.`, "",
  ].join("\r\n");
  await withServer(user, (c) => c.append("INBOX", Buffer.from(raw, "utf8")));
}

/** Which server folder holds the letter with this subject, or `null` when none does. */
export async function folderOnServer(user: string, subject: string, at = { host: HOST, port: PORT }): Promise<string | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withServer(user, async (c) => {
        for (const box of await c.list()) {
          if (box.flags.has("\\Noselect")) continue;
          const lock = await c.getMailboxLock(box.path);
          try {
            const hits = await c.search({ header: { subject } }, { uid: true });
            if (Array.isArray(hits) && hits.length > 0) return box.path.replace(/\./g, "/");
          } finally { lock.release(); }
        }
        return null;
      }, at);
    } catch (err) {
      // GreenMail 2.1.3 drops a connection whose SELECT races a write to that folder; read again on a fresh one.
      if ((err as { code?: unknown }).code !== "NoConnection" || attempt === 3) throw err;
    }
  }
}

/** Wait until the letter sits in `ohmail/Screener` on the server, or answer where it is. */
export async function untilScreened(user: string, subject: string, deadlineMs: number): Promise<{ at: string | null; ms: number }> {
  const t0 = Date.now();
  for (;;) {
    const at = await folderOnServer(user, subject);
    if (at === "ohmail/Screener" || Date.now() - t0 >= deadlineMs) return { at, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** The organizer's own record of the letter — what the phone's Screener lists it by. */
export async function rowOf(p: Phone, subject: string): Promise<Record<string, unknown> | null> {
  const r = await p.exec.all(
    "select fs.desired_folder, fs.observed_folder, fs.last_set_by, fs.reconcile_status, fs.attempts, "
      + "fs.next_attempt_at, fs.last_error_class, m.native_locator "
      + "from messages m join folder_state fs on fs.message_id = m.id where m.subject = ?",
    [subject],
  );
  const first = r.rows[0];
  return first === undefined ? null : Object.fromEntries(r.columns.map((c, i) => [c, first[i]]));
}

/** Wait until the engine has this letter in its store at all. */
export async function untilIngested(p: Phone, subject: string, deadlineMs: number): Promise<Record<string, unknown> | null> {
  const t0 = Date.now();
  for (;;) {
    const row = await rowOf(p, subject);
    if (row !== null || Date.now() - t0 >= deadlineMs) return row;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function eventsSince(p: Phone, from: number): string {
  return p.lines.slice(from).map((l) => l.event).join(", ");
}

/**
 * AN SMTP SERVER THIS FILE SCRIPTS: it greets, offers AUTH, and answers AUTH and the end of DATA
 * when it is told to, after the delays it is given. Nothing it hears is logged or kept but a
 * count of messages it was handed, because what it is handed carries the rig's credential.
 */
export class SmtpSink {
  private server: Server | null = null;
  private readonly live = new Set<Socket>();
  port = 0;
  /** Messages the sink took to the end of DATA — what a delivery count reads. */
  messages = 0;
  /** Each message's DATA as the sink took it, in order — what a reading of WHICH words went reads. */
  readonly bodies: string[] = [];
  private answered: () => void = () => undefined;
  /** Settles when the sink has answered the end of a DATA — the event a wait reads, not a clock. */
  readonly dataAnswered = new Promise<void>((r) => { this.answered = r; });
  /**
   * `line` is a refusal's own reply (a 454 "not now"); absent, a refused AUTH answers 535. `dataEnd`
   * `"drop"` takes the message and drops the connection before its 250; `dropInData` true drops it
   * at DATA, so nothing of the message is taken.
   */
  constructor(private readonly script: {
    auth: () => { ok: boolean; afterMs: number; line?: string };
    dataAfterMs?: () => number;
    dataEnd?: () => "answer" | "drop";
    dropInData?: () => boolean;
  }) {}
  async open(): Promise<void> {
    this.server = createServer((sock) => {
      this.live.add(sock);
      sock.on("close", () => this.live.delete(sock)).on("error", () => sock.destroy());
      const say = (line: string): void => { if (!sock.destroyed) sock.write(`${line}\r\n`); };
      const later = (ms: number, line: string): void => { setTimeout(() => say(line), ms); };
      let buf = "";
      let inData = false;
      let data: string[] = [];
      let loginStep = 0;
      const authAnswer = (): void => {
        const a = this.script.auth();
        later(a.afterMs, a.ok ? "235 2.7.0 accepted" : (a.line ?? "535 5.7.8 authentication refused"));
      };
      say("220 sink.test ESMTP");
      sock.on("data", (chunk: Buffer) => {
        buf += chunk.toString("latin1");
        for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              this.messages += 1;
              this.bodies.push(data.join("\n"));
              data = [];
              if (this.script.dataEnd?.() === "drop") { sock.destroy(); return; }
              setTimeout(() => { say("250 2.0.0 queued"); this.answered(); }, this.script.dataAfterMs?.() ?? 0);
            } else data.push(line);
            continue;
          }
          if (loginStep > 0) {
            loginStep = loginStep === 1 ? 2 : 0;
            if (loginStep === 2) say("334 UGFzc3dvcmQ6");
            else authAnswer();
            continue;
          }
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === "EHLO") say("250-sink.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME");
          else if (verb === "HELO") say("250 sink.test");
          else if (verb === "AUTH") {
            if (/^AUTH LOGIN\s*$/i.test(line)) { loginStep = 1; say("334 VXNlcm5hbWU6"); }
            else if (/^AUTH PLAIN\s*$/i.test(line)) { loginStep = 2; say("334 "); }
            else authAnswer();
          } else if (verb === "MAIL" || verb === "RCPT" || verb === "RSET" || verb === "NOOP") say("250 2.0.0 ok");
          else if (verb === "DATA") {
            if (this.script.dropInData?.() === true) { sock.destroy(); return; }
            inData = true;
            say("354 go ahead");
          }
          else if (verb === "QUIT") { say("221 2.0.0 bye"); sock.end(); }
          else say("502 5.5.2 not here");
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr !== null ? addr.port : 0;
  }
  async close(): Promise<void> {
    for (const s of [...this.live]) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

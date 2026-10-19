/**
 * THE DEVICE ENGINE IMPORTS A LETTER MARKED READ ELSEWHERE MID-IMPORT, WHOLE
 * (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS) — the shared engine (`engine.ts`, composed by the
 * phone's root over `node:sqlite`) against GreenMail, through the fault proxy.
 *
 * Four letters, pages of two. While the import's first INBOX body fetch is parked, another session
 * marks letter 0 — not yet imported — read, and GreenMail sends that flag change inside the reply.
 * On the old adapter the engine stored an empty message at letter 0's UID and never imported the
 * letter; now all four are stored once under their own Message-IDs and nothing is blank. The worker's
 * cycle on the same race, both servers, is `apps/worker/test/sync-flag-race.e2e.test.ts`.
 *
 * Runs under the SQLite project (`vitest.sqlite.config.ts`), like every file that composes the phone
 * engine over the device store; under the default project it says so in its name and skips.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";
import { startFaultProxy, type FaultProxy } from "../../../packages/core/test/adapters/_fault-proxy.js";

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

const HOST = process.env.OHMAIL_PHONE_IMAP_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OHMAIL_PHONE_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.OHMAIL_PHONE_SMTP_PORT ?? process.env.SMTP_PORT ?? 3025);
const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";

function imapAnswers(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: boolean): void => { if (settled) return; settled = true; sock.destroy(); resolve(v); };
    const sock = netConnect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.on("data", (b: Buffer) => finish(/^\* (OK|PREAUTH)/im.test(b.toString("utf8"))));
    sock.once("close", () => finish(false));
  });
}
const SERVER_UP = ON_DEVICE_STORE ? await imapAnswers(HOST, PORT) : false;

/** `node:sqlite` behind the phone's statement-runner contract, one statement at a time. */
function nodeExecutor(file: string): PhoneSqlExecutor {
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
        const rows = columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o));
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

const engines: PhoneEngine[] = [];
const closers: Array<() => Promise<unknown>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop().catch(() => undefined);
  for (const c of closers.splice(0)) await c().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!ON_DEVICE_STORE)("the device engine's import while another session marks a letter read", () => {
  it.skipIf(!SERVER_UP)(`every letter is stored once, none blank — needs IMAP on ${HOST}:${PORT}`, async () => {
    const user = `race-${randomUUID()}@trafficflow.test`;
    const other = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, logger: false });
    await other.connect();
    closers.push(() => other.logout());
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(`letter-${i}-${randomUUID()}@x.example`);
      await other.append("INBOX", [
        `Message-ID: <${ids[i]}>`, `From: Anna <anna${i}@x.example>`, `To: <${user}>`, `Subject: letter ${i}`,
        "Content-Type: text/plain; charset=utf-8", "", `body ${i}`, "",
      ].join("\r\n"), [], new Date(Date.UTC(2026, 0, 1 + i)));
    }
    const l0 = await other.getMailboxLock("INBOX");
    const uids = (await other.search({ all: true }, { uid: true }) as number[]).sort((a, b) => a - b);
    l0.release();

    const proxy: FaultProxy = await startFaultProxy({ host: HOST, port: PORT });
    closers.push(() => proxy.close());
    // The import's first page, INBOX's body fetch, parked while the phone (the other session) reads letter 0.
    proxy.hold = {
      when: (c, a, mailbox) => mailbox === "INBOX" && c === "UID FETCH" && /BODY\.PEEK\[\]/i.test(a),
      run: async () => {
        const l = await other.getMailboxLock("INBOX");
        try { await other.messageFlagsAdd(String(uids[0]), ["\\Seen"], { uid: true }); } finally { l.release(); }
      },
    };

    const dir = mkdtempSync(join(tmpdir(), "ohmail-flag-race-"));
    dirs.push(dir);
    const exec = nodeExecutor(join(dir, "engine.sqlite"));
    const engine = await startPhoneEngine({
      exec,
      imap: {
        host: HOST, port: PORT, secure: false, auth: { user, pass: "test" },
        smtp: { host: HOST, port: SMTP_PORT, secure: false }, sentDomain: "trafficflow.test",
      },
      machineName: "a phone", installId: randomUUID(), keks: { 1: "c".repeat(64) },
      adapterFactory: (cfg, ctx) => new ImapAdapter(
        { ...cfg, host: "127.0.0.1", port: proxy.port }, { onConnectionError: ctx.onConnectionError, maxBatchMessages: 2 },
      ),
    });
    engines.push(engine);

    const stored = async (): Promise<Array<[unknown, unknown, unknown]>> =>
      (await exec.all("SELECT message_id_header, subject, from_address FROM messages", [])).rows as Array<[unknown, unknown, unknown]>;
    for (let i = 0; i < 6 && (await stored()).length < 4; i++) await engine.resume().catch(() => undefined);

    expect(proxy.hold, "the hold never fired, so nothing raced").toBe(null);
    expect(proxy.unsolicited, "the flag change never came back inside the reply").toBeGreaterThan(0);
    const rows = await stored();
    expect(rows.filter(([mid, subject, from]) => mid === null && subject === "" && from === ""), "a blank message").toEqual([]);
    expect(rows.map(([mid]) => mid).sort()).toEqual([...ids].sort());
  }, 180_000);
});

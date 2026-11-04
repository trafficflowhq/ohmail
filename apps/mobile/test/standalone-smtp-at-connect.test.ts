/**
 * THE OUTGOING SERVER AT CONNECT — over the ARTIFACT, against two loopback servers this file owns.
 *
 * `standalone-dial-refusal.test.ts` holds the incoming half of the same seam. Here the incoming
 * server logs in and the outgoing one is the variable: its greeting and AUTH are asked at Connect,
 * a refusal reaches the form as the outgoing server's sentence, and nothing sealed is left behind.
 * The fixture password lives in this file only and is asserted absent from every sentence.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BUNDLE, buildPhoneEngine } from "../scripts/bundle-engine.mjs";
import { openStandaloneMailbox } from "../src/engine/standalone-door";
import { EMPTY_STANDALONE, type StandaloneFields } from "../src/ui/standalone-form";
import { sayRefusal } from "../src/refusal";

const require_ = createRequire(import.meta.url);
type Db = {
  exec(sql: string): void; close(): void;
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown; columns?(): { column?: string | null; name?: string }[] };
};
const sqlite = require_("node:sqlite") as { DatabaseSync: new (path: string) => Db };

const PASSWORD = "connect-time-password";

/** The two native modules the bundle leaves external — `standalone-dial-refusal.test.ts`'s shape. */
function loadArtifact(): Record<string, unknown> {
  const Module = require_("node:module") as { _load(r: string, p: unknown, m: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "react-native-tcp-socket") {
      const net = require_("node:net") as Record<string, unknown>;
      const tls = require_("node:tls") as Record<string, unknown>;
      return { createConnection: net.createConnection, connectTLS: tls.connect, TLSSocket: tls.TLSSocket,
               isIP: net.isIP, isIPv4: net.isIPv4, isIPv6: net.isIPv6 };
    }
    if (request === "react-native-quick-crypto") return require_("node:crypto");
    return original.call(this, request, parent, isMain);
  };
  try { return require_(BUNDLE) as Record<string, unknown>; } finally { Module._load = original; }
}

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
let live: { stop(): Promise<void> } | null = null;
afterEach(async () => {
  if (live) await live.stop().catch(() => undefined);
  live = null;
  for (const c of closers.splice(0)) await c();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** `node:sqlite` ON DISK behind the statement-runner contract, so the store can be read after the engine closed it. */
function fileStore(): { file: string; exec: Record<string, unknown> } {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-smtp-at-connect-"));
  dirs.push(dir);
  const file = join(dir, "engine.db");
  const raw = new sqlite.DatabaseSync(file);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T,>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job); tail = next.catch(() => undefined); return next;
  };
  return {
    file,
    exec: {
      all: (sql: string, params: readonly unknown[]) => serial(async () => {
        const st = raw.prepare(sql);
        const columns = (st.columns?.() ?? []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
        return { columns, rows: columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o)) };
      }),
      run: (sql: string, params: readonly unknown[]) => serial(async () => { raw.prepare(sql).run(...(params as unknown[])); }),
      batch: (sts: readonly { sql: string; params?: readonly unknown[] }[]) => serial(async () => {
        raw.exec("BEGIN IMMEDIATE");
        try { for (const { sql, params = [] } of sts) raw.prepare(sql).run(...(params as unknown[])); raw.exec("COMMIT"); }
        catch (e) { try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ } throw e; }
      }),
      close: async () => { try { raw.close(); } catch { /* already closed */ } },
    },
  };
}

function credentialsIn(file: string): number {
  const raw = new sqlite.DatabaseSync(file);
  try { return (raw.prepare("select count(*) as n from mailbox_credentials").all()[0] as { n: number }).n; }
  finally { raw.close(); }
}

interface Fake { port: number; verbs: string[] }

/** A server on loopback, its line protocol a function; the verbs it saw are kept, never a payload. */
async function listen(greeting: string, answer: (line: string, write: (s: string) => void) => void): Promise<Fake> {
  const verbs: string[] = [];
  const live_ = new Set<Socket>();
  const srv = createServer((sock) => {
    live_.add(sock);
    sock.on("error", () => { /* a client hanging up mid-refusal is the normal case */ });
    sock.on("close", () => live_.delete(sock));
    const write = (s: string): void => { if (!sock.destroyed) sock.write(s); };
    let buf = "";
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        answer(line, write);
      }
    });
    write(greeting);
  });
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  closers.push(() => new Promise<void>((res) => { for (const s of live_) s.destroy(); srv.close(() => res()); }));
  return { port: (srv.address() as { port: number }).port, verbs };
}

/** An incoming server that logs anybody in and knows one folder. */
async function imapThatLogsIn(): Promise<Fake> {
  const fake = await listen("* OK fake imap ready\r\n", (line, write) => {
    const [tag, cmd, ...args] = line.split(" ");
    const c = (cmd ?? "").toUpperCase();
    fake.verbs.push(c);
    if (c === "CAPABILITY") write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
    else if (c === "LOGIN") write(`${tag} OK logged in\r\n`);
    else if (c === "LIST" && args.join(" ") === `"" ""`) write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
    else if (c === "LIST") write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
    else if (c === "LOGOUT") write(`* BYE\r\n${tag} OK\r\n`);
    else write(`${tag} NO unsupported here\r\n`);
  });
  return fake;
}

/** An outgoing server whose AUTH answer is the variable. */
async function smtp(o: { acceptAuth: boolean }): Promise<Fake> {
  const fake = await listen("220 fake.test ESMTP\r\n", (line, write) => {
    const verb = line.slice(0, 4).toUpperCase();
    fake.verbs.push(verb);
    if (verb === "EHLO") write("250-fake.test\r\n250 AUTH PLAIN LOGIN\r\n");
    else if (verb === "AUTH") write(o.acceptAuth ? "235 2.7.0 ok\r\n" : "535 5.7.8 refused\r\n");
    else if (verb === "QUIT") write("221 bye\r\n");
    else write("250 ok\r\n");
  });
  return fake;
}

async function press(imapPort: number, smtpPort: number, file: { exec: Record<string, unknown> }) {
  await buildPhoneEngine();
  const mod = loadArtifact();
  const fields: StandaloneFields = {
    ...EMPTY_STANDALONE, address: "someone@example.test", password: PASSWORD,
    imapHost: "127.0.0.1", imapPort: String(imapPort), imapTls: false,
    smtpHost: "127.0.0.1", smtpPort: String(smtpPort),
  };
  return openStandaloneMailbox(fields, {
    startEngine: mod.startPhoneEngine as never,
    platform: async () => ({ kind: "ready" as const, exec: file.exec, keks: { 1: "c".repeat(64) } }),
    machineName: () => "ohmail on a phone",
    installId: async () => "smtp-at-connect-case",
  });
}

describe("the fourth door asks the outgoing server at Connect", () => {
  it("REFUSES an outgoing server that rejects the sign-in, names it, and keeps nothing sealed", async () => {
    const [imap, out] = [await imapThatLogsIn(), await smtp({ acceptAuth: false })];
    const store = fileStore();
    const outcome = await press(imap.port, out.port, store);

    expect(out.verbs, "the outgoing server was asked for its greeting and AUTH").toEqual(expect.arrayContaining(["EHLO", "AUTH"]));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason.say).toBe("standaloneSmtpSignInRefused");
    expect(sayRefusal(outcome.reason)).not.toContain(PASSWORD);
    expect(credentialsIn(store.file), "the refused launch discarded what it sealed").toBe(0);
  }, 60_000);

  it("ADMITS an outgoing server that takes the sign-in — the positive control", async () => {
    const [imap, out] = [await imapThatLogsIn(), await smtp({ acceptAuth: true })];
    const store = fileStore();
    const outcome = await press(imap.port, out.port, store);

    expect(out.verbs).toEqual(expect.arrayContaining(["EHLO", "AUTH"]));
    expect(outcome.ok, "a submission server that signs us in is not a refusal").toBe(true);
    if (outcome.ok) live = outcome.door as unknown as { stop(): Promise<void> };
  }, 60_000);
});

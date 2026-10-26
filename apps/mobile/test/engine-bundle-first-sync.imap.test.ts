import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { parseProfileMessage, type OrganizerProfileDoc } from "../../../packages/core/src/adapters/organizer-profile.js";

import { BUNDLE, buildPhoneEngine } from "../scripts/bundle-engine.mjs";

/**
 * THE ARTIFACT'S FIRST SYNC READS EVERY SELECT ANSWER — PERF-026, against a real IMAP server, under
 * BOTH schedulers the bundle meets: node's `setImmediate`, and React Native's, which bridgeless 0.86
 * installs as a `queueMicrotask` shim (`Libraries/Core/setUpTimers.js`). With a microtask `nextTick`
 * the parser's next line lands in imapflow's reader guard gap and the SELECT answer is never read
 * (measured: 0 of 30 at the 30 s bound). The phone bundle re-arms that reader (`bundle-engine.mjs`).
 */
const require_ = createRequire(import.meta.url);
const sqlite = require_("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void; close(): void;
    prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown; columns?(): { name?: string }[] };
  };
};
const HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OHMAIL_PHONE_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);
const LETTERS = 30;

function loadArtifact(): Record<string, unknown> {
  const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
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
  try {
    delete (require_ as unknown as { cache?: Record<string, unknown> }).cache?.[BUNDLE];
    return require_(BUNDLE) as Record<string, unknown>;
  } finally { Module._load = original; }
}

function sqlExecutor() {
  const raw = new sqlite.DatabaseSync(":memory:");
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T,>(job: () => T): Promise<T> => { const n = tail.then(job, job); tail = n.catch(() => undefined); return n; };
  return {
    all: (sql: string, params: readonly unknown[]) => serial(() => {
      const st = raw.prepare(sql);
      const columns = (st.columns?.() ?? []).map((c) => c.name ?? "");
      const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
      return { columns, rows: columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o)) };
    }),
    run: (sql: string, params: readonly unknown[]) => serial(() => { raw.prepare(sql).run(...(params as unknown[])); }),
    batch: (statements: readonly { sql: string; params?: readonly unknown[] }[]) => serial(() => {
      raw.exec("BEGIN IMMEDIATE");
      try { for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as unknown[])); raw.exec("COMMIT"); }
      catch (err) { try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ } throw err; }
    }),
    close: async () => { try { raw.close(); } catch { /* closed */ } },
  };
}

type Witness = {
  connect(): Promise<void>; append(p: string, raw: string): Promise<unknown>; logout(): Promise<void>;
  list(): Promise<{ path: string }[]>; getMailboxLock(p: string): Promise<{ release(): void }>;
  fetch(r: string, q: unknown): AsyncIterable<{ source?: Buffer }>;
};
/** The server runs with authentication disabled. */
const imapAuth = (user: string) => ({ host: HOST, port: PORT, secure: false, auth: { user, pass: "fixture" } });
function witness(user: string): Witness {
  const { ImapFlow } = require_(require_.resolve("imapflow", { paths: [require_.resolve("../../../packages/core/package.json")] })) as {
    ImapFlow: new (o: unknown) => Witness;
  };
  return new ImapFlow({ ...imapAuth(user), logger: false });
}

/** A fresh fixture mailbox of `LETTERS` letters. */
async function seed(user: string): Promise<void> {
  const c = witness(user);
  await c.connect();
  for (let i = 0; i < LETTERS; i += 1) {
    await c.append("INBOX", [`From: Sender ${i % 5} <s${i % 5}@sender.test>`, `To: ${user}`, `Subject: Letter ${i}`,
      "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <first-sync-${i}-${user}>`, "", `Body ${i}.`, ""].join("\r\n"));
  }
  await c.logout();
}

let live: { stop(): Promise<void> } | null = null;
afterEach(async () => { if (live) await live.stop().catch(() => undefined); live = null; });

/** React Native's `setImmediate` as bridgeless 0.86 installs it: a `queueMicrotask` shim. */
const nodeSetImmediate = globalThis.setImmediate;
function installReactNativeImmediate(): void {
  (globalThis as { setImmediate: unknown }).setImmediate = (cb: (...a: unknown[]) => void, ...args: unknown[]) => {
    globalThis.queueMicrotask(() => { cb.apply(undefined, args); });
    return 0;
  };
}
afterEach(() => { (globalThis as { setImmediate: unknown }).setImmediate = nodeSetImmediate; });

type Engine = {
  stop(): Promise<void>; claimHere(o: { by: "press" }): Promise<string>;
  handle(r: Request): Promise<Response>; sessionToken: string;
};
/** A fresh artifact instance with its own database and install id, logging into `lines`. */
async function startEngine(user: string, lines: string[], extra: Record<string, unknown> = {}): Promise<Engine> {
  const start = loadArtifact().startPhoneEngine as (d: unknown) => Promise<Engine>;
  return start({
    exec: sqlExecutor(), imap: imapAuth(user),
    address: user, machineName: "first-sync census", installId: `install-${randomUUID()}`, keks: { 1: "c".repeat(64) },
    logSink: (line: string) => { lines.push(line); },
    ...extra,
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logged = (lines: string[], event: string, from = 0) => lines.slice(from).find((l) => l.includes(`"event":"${event}"`));

async function firstSync(): Promise<{ messages?: number } | null> {
  await buildPhoneEngine();
  const user = `first-sync-${randomUUID().slice(0, 8)}@lane.test`;
  await seed(user);
  const lines: string[] = [];
  live = await startEngine(user, lines);
  for (let i = 0; i < 240 && !logged(lines, "first_sync_finished"); i += 1) await sleep(250);
  const line = logged(lines, "first_sync_finished");
  return line === undefined ? null : JSON.parse(line) as { messages?: number };
}

async function call(e: Engine, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await e.handle(new Request(`http://engine.invalid${path}`, {
    method, headers: { authorization: `Bearer ${e.sessionToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Every `X-Ohmail-Profile: 1` message in the mailbox's `_meta` folder, as raw text. */
async function profilesInMeta(user: string): Promise<string[]> {
  const c = witness(user);
  await c.connect();
  const out: string[] = [];
  try {
    for (const { path } of (await c.list()).filter((f) => /(^|[./])ohmail[./]_meta$/.test(f.path))) {
      const lock = await c.getMailboxLock(path);
      try {
        for await (const m of c.fetch("1:*", { uid: true, source: true })) {
          const raw = m.source?.toString("utf8") ?? "";
          if (/^X-Ohmail-Profile:[ \t]*1[ \t]*$/im.test(raw.split(/\r?\n\r?\n/, 1)[0] ?? "")) out.push(raw);
        }
      } finally { lock.release(); }
    }
  } finally { await c.logout(); }
  return out;
}

describe("the phone engine artifact against a real IMAP server", () => {
  it("finishes its first sync under node's setImmediate", async () => {
    const finished = await firstSync();
    expect(finished, "the first sync never finished: an IMAP answer was pushed and never read").not.toBeNull();
    expect(finished!.messages, "the first sync finished without the mailbox's letters").toBe(LETTERS);
  }, 120_000);

  it("finishes its first sync under React Native's setImmediate, a microtask", async () => {
    installReactNativeImmediate();
    const finished = await firstSync();
    expect(finished, "the first sync never finished: an IMAP answer was pushed and never read").not.toBeNull();
    expect(finished!.messages, "the first sync finished without the mailbox's letters").toBe(LETTERS);
  }, 120_000);

  it("an organizer phone writes its profile to _meta, and a second install imports it", async () => {
    await buildPhoneEngine();
    const user = `profile-${randomUUID().slice(0, 8)}@lane.test`;
    await seed(user);
    const a: string[] = [];
    const engineA = await startEngine(user, a, { profileFlushIntervalMs: 1000 });
    live = engineA;
    for (let i = 0; i < 240 && !logged(a, "first_sync_finished"); i += 1) await sleep(250);
    expect(await engineA.claimHere({ by: "press" })).toBe("claimed");
    const rule = { kind: "sender", match: "s1@sender.test", destination: "ohmail/News" };
    expect((await call(engineA, "POST", "/rules", rule)).status).toBe(201);
    const mark = a.length;
    for (let i = 0; i < 240 && !logged(a, "organizer_profile_written", mark); i += 1) await sleep(250);
    expect(logged(a, "organizer_profile_write_failed"), "the profile append failed").toBeUndefined();
    expect(logged(a, "organizer_profile_written", mark), "no profile write after the rule").toBeDefined();

    const stored = await profilesInMeta(user);
    expect(stored).toHaveLength(1);
    const parsed = parseProfileMessage(stored[0]!) as { status?: string; encoded?: boolean; doc?: OrganizerProfileDoc };
    expect(parsed).toMatchObject({ status: "ok", encoded: true });
    expect(parsed.doc!.rules).toEqual([expect.objectContaining(rule)]);

    const b: string[] = [];
    const engineB = await startEngine(user, b);
    try {
      for (let i = 0; i < 240 && !logged(b, "profile_mirror_written"); i += 1) await sleep(250);
      expect(logged(b, "profile_mirror_written"), "the second install never mirrored the profile").toBeDefined();
      const boxes = (await call(engineB, "GET", "/mailboxes")).json;
      const id = ((boxes?.items ?? boxes) as { id: string }[])[0]!.id;
      const view = await call(engineB, "GET", `/mailboxes/${id}/profile`);
      expect(view.status).toBe(200);
      expect(view.json.organizing).toBe(false);
      expect(view.json.profile.rules).toEqual([expect.objectContaining(rule)]);
      expect(view.json.profile.screening).toMatchObject({ baselineAt: expect.any(String), dormancyDays: 60, scope: "window" });
    } finally { await engineB.stop().catch(() => undefined); }
  }, 180_000);
});

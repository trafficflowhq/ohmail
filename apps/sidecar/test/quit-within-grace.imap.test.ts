import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapAdapter, type ImapConfig, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { SEND_HELD_SENTENCE } from "@trafficflow/services/mail";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, settledWithin, type AdapterDialContext, type QuitPlan, type Sidecar } from "../src/engine.js";
import { LOCK_FILE, STORE_GENERATION_FILE } from "../src/db.js";
import { noteFirstPageServed, resetFirstPageGate } from "../src/first-page-gate.js";
import {
  QUIT_GOODBYE_MS, QUIT_PASS_MS, QUIT_REQUESTS_MS, QUIT_STORE_CLOSE_RESERVE_MS, QUIT_STORE_WAIT_MS, SHUTDOWN_DEADLINE_MS,
} from "../src/main.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { serviceUp } from "@trafficflow/db/testing";

/**
 * A QUIT AGAINST A SLOW MAIL SERVER CLOSES THE STORE INSIDE THE GRACE — GreenMail and Dovecot,
 * through a relay that holds every server answer for two seconds (the tester measured about two
 * seconds per command on a real provider). At main an idle reader's LOGOUT took
 * 4.4 s, an organizer's claim release ran past 15 s, and the store close waited behind both.
 */

vi.setConfig({ testTimeout: 2 * PGLITE_STANDUP_BUDGET_MS + 60_000 });

const SLOW_MS = 2_000;
/* An idle reader's goodbye is two answers (DONE, LOGOUT): at 2 s each they land at 4.0 to 4.5 s, on
   the goodbye bound itself, and a loaded machine pushed 1.5 s ones there too. At 1 s they fit with
   room, which is what "completes" can be held to, and still outlast the store's own close. */
const READER_SLOW_MS = 1_000;
/* "At once": the store's own close on a fresh store, with room for a loaded machine. Behind the
   goodbyes it was 4.4 s for a reader and 15 s for an organizer at main. */
const STORE_FIRST_MS = 3_000;
const plan = (): QuitPlan => ({
  passMs: QUIT_PASS_MS, requestsMs: QUIT_REQUESTS_MS, storeWaitMs: QUIT_STORE_WAIT_MS, goodbyeMs: QUIT_GOODBYE_MS,
});
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  resetFirstPageGate();
});

/**
 * A TCP relay that holds each chunk the server sends for `delayMs`, in order; switchable live.
 * `setHeld(true)` is a paused server: nothing moves either way, and what a client sent before
 * leaving is never read.
 */
async function slowRelay(host: string, port: number, delayMs = 0): Promise<{
  port: number; setDelay(ms: number): void; setHeld(on: boolean): void;
}> {
  let delay = delayMs;
  let held = false;
  let waiting: Array<() => void> = [];
  const gate = (): Promise<void> => (held ? new Promise((r) => { waiting.push(r); }) : Promise.resolve());
  const sockets: Socket[] = [];
  const server: Server = createServer((client) => {
    const up = netConnect({ host, port });
    sockets.push(client, up);
    let upChain = Promise.resolve();
    client.on("data", (b: Buffer) => {
      upChain = upChain.then(gate).then(() => { if (!client.destroyed && !up.destroyed) up.write(b); });
    });
    let chain = Promise.resolve();
    up.on("data", (b: Buffer) => {
      const d = delay;
      chain = chain.then(() => sleep(d)).then(gate).then(() => { if (!client.destroyed) client.write(b); });
    });
    up.on("end", () => { chain = chain.then(() => { client.end(); }); });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
    client.on("close", () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => { for (const s of sockets) s.destroy(); server.close(); });
  return {
    port: (server.address() as { port: number }).port,
    setDelay: (ms) => { delay = ms; },
    setHeld: (on) => { held = on; if (!on) { const w = waiting; waiting = []; for (const r of w) r(); } },
  };
}

/** An SMTP relay that passes everything at once but holds the answer to the end-of-data mark `dotMs`. */
async function slowAcceptRelay(host: string, port: number, dotMs: number): Promise<{ port: number }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((client) => {
    const up = netConnect({ host, port });
    sockets.push(client, up);
    let tail = "";
    let afterDot = false;
    client.on("data", (b: Buffer) => {
      tail = (tail + b.toString("latin1")).slice(-8);
      if (tail.includes("\r\n.\r\n")) { afterDot = true; tail = ""; }
      up.write(b);
    });
    let chain = Promise.resolve();
    up.on("data", (b: Buffer) => {
      const d = afterDot ? dotMs : 0;
      afterDot = false;
      chain = chain.then(() => sleep(d)).then(() => { if (!client.destroyed) client.write(b); });
    });
    up.on("end", () => { chain = chain.then(() => { client.end(); }); });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
    client.on("close", () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => { for (const s of sockets) s.destroy(); server.close(); });
  return { port: (server.address() as { port: number }).port };
}

const storeOpen = (dataDir: string): boolean | null => {
  try { return (JSON.parse(readFileSync(join(dataDir, STORE_GENERATION_FILE), "utf8")) as { open?: boolean }).open ?? null; } catch { return null; }
};

/** When, after `began`, the store was first read as closed with its lock gone; null if never inside `withinMs`. */
async function storeClosedAt(dataDir: string, began: number, withinMs: number): Promise<number | null> {
  while (performance.now() - began < withinMs) {
    if (storeOpen(dataDir) === false && !existsSync(join(dataDir, LOCK_FILE))) return performance.now() - began;
    await sleep(25);
  }
  return null;
}

const GREENMAIL = { host: process.env.IMAP_HOST ?? "127.0.0.1", port: Number(process.env.IMAP_PORT ?? 3143) };
const DOVECOT = { host: "127.0.0.1", port: Number(process.env.IMAP_CONDSTORE_PORT ?? 3144) };
const dovecotPass = (): string =>
  /password=(\S+)/.exec(readFileSync(new URL("../../../test/dovecot/dovecot.conf", import.meta.url), "utf8"))?.[1] ?? "";

/* The run's one probe of each server (`serviceUp`), never a home-made one. */
const SERVERS = [
  { name: "GreenMail", up: serviceUp("greenmail", `${GREENMAIL.host}:${GREENMAIL.port}`).up, ...GREENMAIL, pass: () => "test" },
  { name: "Dovecot", up: serviceUp("dovecot", `${DOVECOT.host}:${DOVECOT.port}`).up, ...DOVECOT, pass: dovecotPass },
];

interface Line { event: string; at: number; detail: Record<string, unknown> }

for (const server of SERVERS) {
  describe.skipIf(!server.up)(`a quit against ${server.name} answering every command ${SLOW_MS / 1000} s late`, () => {
    async function boot(organize: boolean): Promise<{
      sidecar: Sidecar; dataDir: string; address: string; relay: { setDelay(ms: number): void }; lines: Line[];
      logouts: Array<{ at: number; doneAt: number | null }>;
      reads: { entered: number; onEnter: (() => void) | null; onLine: ((l: Line) => void) | null };
    }> {
      noteFirstPageServed();
      const relay = await slowRelay(server.host, server.port);
      const address = `dcc-${randomUUID()}@trafficflow.test`;
      const dataDir = await freshDataDir("ohmail-quit-grace-imap-");
      const lines: Line[] = [];
      const logouts: Array<{ at: number; doneAt: number | null }> = [];
      const reads = { entered: 0, onEnter: null as (() => void) | null, onLine: null as ((l: Line) => void) | null };
      const factory = (cfg: ImapConfig, ctx: AdapterDialContext): MailboxAdapter => {
        const real = new ImapAdapter(cfg, { onConnectionError: ctx.onConnectionError });
        return new Proxy(real, {
          get(target, prop) {
            // The drain's read of the server, inside the serialized pass: a writer of the store.
            if (prop === "changesSince") {
              return (...a: Parameters<MailboxAdapter["changesSince"]>) => {
                reads.entered += 1;
                reads.onEnter?.();
                return target.changesSince(...a);
              };
            }
            if (prop === "close") {
              return async () => {
                const rec = { at: performance.now(), doneAt: null as number | null };
                logouts.push(rec);
                try { await target.close(); } finally { rec.doneAt = performance.now(); }
              };
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        });
      };
      const sidecar = await createSidecar({
        dataDir, address, machineName: "quit rig", pollIntervalMs: 15_000, leaseStaleAfterMs: 60_000,
        imap: { host: "127.0.0.1", port: relay.port, secure: false, auth: { user: address, pass: server.pass() } },
        adapterFactory: factory,
        log: (event, detail) => {
          const line = { event, at: performance.now(), detail: (detail ?? {}) as Record<string, unknown> };
          lines.push(line);
          reads.onLine?.(line);
        },
      });
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      if (organize) await grantOrganizeConsent(sidecar);
      expect((await sidecar.start()).failures, "the premise: the launch").toEqual([]);
      await sleep(1_000);
      return { sidecar, dataDir, address, relay, lines, logouts, reads };
    }

    it("an idle reader (1 s per answer): the store closes before the LOGOUT, which still completes before its bound", async () => {
      const b = await boot(false);
      b.relay.setDelay(READER_SLOW_MS);
      const began = performance.now();
      const stopping = b.sidecar.stop(plan());
      const closedAt = await storeClosedAt(b.dataDir, began, SHUTDOWN_DEADLINE_MS);
      const report = await stopping;
      expect(closedAt, "the store did not close inside the grace").not.toBeNull();
      expect(b.logouts).toHaveLength(1);
      expect(b.logouts[0]!.doneAt, "the LOGOUT never completed").not.toBeNull();
      const loggedOut = b.logouts[0]!.doneAt! - began;
      expect(closedAt!, "the store waited behind the LOGOUT").toBeLessThan(loggedOut);
      expect(loggedOut, "the LOGOUT outran its bound").toBeLessThan(QUIT_GOODBYE_MS);
      expect(report.forced).toBe(0);
    });

    it("an idle organizer: the store closes at once, and a claim release past the bound is left to age out", async () => {
      const b = await boot(true);
      b.relay.setDelay(SLOW_MS);
      const began = performance.now();
      const stopping = b.sidecar.stop(plan());
      const closedAt = await storeClosedAt(b.dataDir, began, SHUTDOWN_DEADLINE_MS);
      const report = await stopping;
      const took = performance.now() - began;
      expect(closedAt, "the store did not close inside the grace").not.toBeNull();
      expect(closedAt!, "the store waited behind the claim release").toBeLessThan(STORE_FIRST_MS);
      expect(took, "the goodbye outran its bound").toBeLessThan(QUIT_GOODBYE_MS + 500);
      expect(b.lines.filter((l) => l.event === "mailbox_detach_forced").map((l) => l.detail.phase)).toEqual(["goodbye"]);
      expect(report.forced).toBe(1);
    });

    it("a pass in flight is cut at its bound, and the store closes after it", async () => {
      const b = await boot(false);
      /* Slow from the drain's read on: the heartbeat before it runs outside the queue and writes
         nothing, so a stop inside it cuts no pass. */
      b.reads.onEnter = () => b.relay.setDelay(SLOW_MS);
      const readsBefore = b.reads.entered;
      const drain = b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
      const t = performance.now();
      while (b.reads.entered === readsBefore && performance.now() - t < 20_000) await sleep(20);
      expect(b.reads.entered, "the premise: the drain is reading the server").toBeGreaterThan(readsBefore);
      await sleep(200);
      const began = performance.now();
      const stopping = b.sidecar.stop(plan());
      const closedAt = await storeClosedAt(b.dataDir, began, SHUTDOWN_DEADLINE_MS);
      const report = await stopping;
      /* The cut destroyed the socket, which is what ends the read it was parked in. */
      expect(await settledWithin(drain, 1_000), "the cut left the drain reading the server").toBe(true);
      const forced = b.lines.filter((l) => l.event === "mailbox_detach_forced");
      expect(forced.map((l) => l.detail.phase), "the pass was not cut").toEqual(["pass"]);
      expect(forced[0]!.at - began).toBeGreaterThanOrEqual(QUIT_PASS_MS - 50);
      expect(forced[0]!.at - began).toBeLessThan(QUIT_PASS_MS + 1_000);
      expect(closedAt, "the store did not close inside the grace").not.toBeNull();
      expect(closedAt!, "the store closed past the plan's own promise").toBeLessThan(QUIT_STORE_WAIT_MS + QUIT_STORE_CLOSE_RESERVE_MS);
      expect(report.passesMs).toBeGreaterThanOrEqual(QUIT_PASS_MS - 50);
    });

    it("an organizer's pass cut at its bound still gives the claim back on a server that answers again", async () => {
      const b = await boot(true);
      const peek = async (): Promise<number> => {
        const a = new ImapAdapter({
          host: server.host, port: server.port, secure: false, auth: { user: b.address, pass: server.pass() },
        });
        await a.connect();
        try { return (await a.leasePeekIo().listClaims()).length; } finally { await a.close().catch(() => undefined); }
      };
      expect(await peek(), "the premise: this install holds the claim").toBe(1);
      /* The page is slow, then the server is fast again from the cut on: a heavy page, not a slow link. */
      b.reads.onEnter = () => b.relay.setDelay(SLOW_MS);
      b.reads.onLine = (l) => { if (l.event === "mailbox_detach_forced") b.relay.setDelay(0); };
      const readsBefore = b.reads.entered;
      const drain = b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
      const t = performance.now();
      while (b.reads.entered === readsBefore && performance.now() - t < 20_000) await sleep(20);
      expect(b.reads.entered, "the premise: the drain is reading the server").toBeGreaterThan(readsBefore);
      await sleep(200);
      const began = performance.now();
      const stopping = b.sidecar.stop(plan());
      const closedAt = await storeClosedAt(b.dataDir, began, SHUTDOWN_DEADLINE_MS);
      await stopping;
      await settledWithin(drain, 1_000);
      expect(b.lines.filter((l) => l.event === "mailbox_detach_forced").map((l) => l.detail.phase)).toEqual(["pass"]);
      const released = b.lines.find((l) => l.event === "organizer_claim_released_on_stop");
      expect(released, "the cut pass left its claim to age out").toBeDefined();
      expect(released!.at - began, "the release ran past the goodbye bound").toBeLessThan(QUIT_GOODBYE_MS);
      expect(closedAt, "the store did not close inside the grace").not.toBeNull();
      expect(await peek(), "a claim is still in ohmail/_meta").toBe(0);
    });
  });
}

/**
 * THE ENGINE AS THE SHELL RUNS IT: spawned on `src/main.ts`, its launch dialling and draining through
 * the slow relay, then its input closed. At main it was killed by its own deadline at 5 s, exit 1,
 * with the store recorded open and the lock left behind.
 */
const SIDECAR_DIR = fileURLToPath(new URL("..", import.meta.url));
const greenmailUp = SERVERS[0]!.up;

describe.skipIf(!greenmailUp)("the engine, its input closed while a slow drain runs", () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const clients: StdioClient[] = [];
  afterEach(() => {
    for (const cl of clients.splice(0)) cl.close();
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  });

  it("leaves with exit 0 inside the grace, the store recorded closed and the lock gone", async () => {
    const relay = await slowRelay(GREENMAIL.host, GREENMAIL.port, SLOW_MS);
    const dataDir = await freshDataDir("ohmail-quit-grace-spawn-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const address = `dcc-${randomUUID()}@trafficflow.test`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("OHMAIL_")) delete env[k];
    Object.assign(env, {
      OHMAIL_DATA_DIR: dataDir,
      OHMAIL_IMAP_HOST: "127.0.0.1",
      OHMAIL_IMAP_PORT: String(relay.port),
      OHMAIL_IMAP_SECURE: "0",
      OHMAIL_IMAP_USER: address,
      OHMAIL_IMAP_PASS: "test",
      OHMAIL_MAILBOX_ADDRESS: address,
      OHMAIL_KEK: "cd".repeat(32),
      OHMAIL_POLL_MS: "15000",
    });
    const child = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx", "src/main.ts"], {
      cwd: SIDECAR_DIR, env, stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    const client = connectOverStdio({ input: child.stdout, output: child.stdin, baseUrl: "http://sidecar" });
    clients.push(client);
    await client.ready();
    await sleep(1_500);                          // the launch is dialling and draining through the relay

    const exited = new Promise<number>((resolve) => { child.once("exit", (code) => resolve(code ?? -1)); });
    const began = performance.now();
    child.stdin.end();
    const code = await Promise.race([exited, sleep(10_000).then(() => "still running" as const)]);
    const took = performance.now() - began;

    const events = stderr.split("\n").flatMap((l) => {
      try { return [(JSON.parse(l) as { event?: string }).event ?? ""]; } catch { return []; }
    });
    expect(events, "the deadline ended the engine").not.toContain("shutdown_deadline");
    expect(code, `the engine left with ${String(code)}`).toBe(0);
    expect(took, "the engine took longer than the shell waits").toBeLessThan(SHUTDOWN_DEADLINE_MS - 250);
    expect(storeOpen(dataDir), "the store was left recorded open").toBe(false);
    expect(existsSync(join(dataDir, LOCK_FILE)), "the lock outlived the engine").toBe(false);
    expect(events).toContain("engine_left");
  });
});

/**
 * A REPLY SENT HALF A SECOND BEFORE CLOSING, WHILE THE MAIL SERVER IS SLOW TO ANSWER.
 * The send's own IMAP login (before any SMTP) runs past the quit, so nothing was offered. At main the
 * next start probed Sent, found nothing and wrote `unverified` for good, and the reply never went. Now
 * the start forgets the reservation that offered nothing and the key's replay sends it once. Over a
 * connection kept from an earlier send, the press reached SMTP on a server that had stopped answering
 * and the quit lost its Sent copy; now a kept connection answers a NOOP before a press uses it.
 */
describe.skipIf(!greenmailUp)("a reply sent just before the quit while the mail server is slow to log in", () => {
  const kids: ChildProcessWithoutNullStreams[] = [];
  const bridges: StdioClient[] = [];
  afterEach(() => {
    for (const cl of bridges.splice(0)) cl.close();
    for (const c of kids.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  });

  const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);
  async function engine(dataDir: string, address: string, imapPort: number, smtp = { host: GREENMAIL.host, port: SMTP_PORT }) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("OHMAIL_")) delete env[k];
    Object.assign(env, {
      OHMAIL_DATA_DIR: dataDir, OHMAIL_IMAP_HOST: "127.0.0.1", OHMAIL_IMAP_PORT: String(imapPort),
      OHMAIL_IMAP_SECURE: "0", OHMAIL_IMAP_USER: address, OHMAIL_IMAP_PASS: "test",
      OHMAIL_SMTP_HOST: smtp.host, OHMAIL_SMTP_PORT: String(smtp.port), OHMAIL_SMTP_SECURE: "0",
      OHMAIL_MAILBOX_ADDRESS: address, OHMAIL_KEK: "cd".repeat(32), OHMAIL_POLL_MS: "15000",
    });
    const child = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx", "src/main.ts"], {
      cwd: SIDECAR_DIR, env, stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    kids.push(child);
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    const exited = new Promise<number>((resolve) => { child.once("exit", (code) => resolve(code ?? -1)); });
    const client = connectOverStdio({ input: child.stdout, output: child.stdin, baseUrl: "http://sidecar" });
    bridges.push(client);
    const header = await client.ready();
    const call = (path: string, method: string, body?: unknown, key?: string) => client.fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${String(header.sessionToken)}`, "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const events = (): string[] => stderr.split("\n").flatMap((l) => {
      try { return [(JSON.parse(l) as { event?: string }).event ?? ""]; } catch { return []; }
    });
    return { child, header, call, events, exited };
  }

  async function copies(user: string, folder: string, messageId: string): Promise<number> {
    const c = new ImapFlow({ host: GREENMAIL.host, port: GREENMAIL.port, secure: false, auth: { user, pass: "test" }, logger: false });
    await c.connect();
    try {
      const lock = await c.getMailboxLock(folder);
      try {
        const uids = await c.search({ header: { "message-id": messageId.replace(/[<>]/g, "") } }, { uid: true });
        return Array.isArray(uids) ? uids.length : 0;
      } finally { lock.release(); }
    } finally { await c.logout().catch(() => undefined); }
  }

  it("goes out once at the next start: one delivery, one copy in Sent, the draft sent", async () => {
    const relay = await slowRelay(GREENMAIL.host, GREENMAIL.port, 0);
    const dataDir = await freshDataDir("ohmail-quit-slow-login-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const address = `dcc-${randomUUID()}@trafficflow.test`;
    const to = `rcpt-${randomUUID()}@trafficflow.test`;
    const first = await engine(dataDir, address, relay.port);
    await sleep(1_500);
    const created = await first.call("/drafts", "POST", {
      mailboxId: first.header.mailboxId, subject: "Re: Thursday", body: "Yes, Thursday works.", to: [{ name: null, address: to }],
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const draftId = (await created.json() as { id: string }).id;
    const key = `quit-${randomUUID()}`;
    relay.setDelay(SLOW_MS);
    void first.call(`/drafts/${draftId}/send`, "POST", {}, key).catch(() => undefined);
    await sleep(500);
    first.child.stdin.end();
    const code = await Promise.race([first.exited, sleep(10_000).then(() => "still running" as const)]);
    expect(code, `the first engine left with ${String(code)}`).toBe(0);

    relay.setDelay(0);
    const next = await engine(dataDir, address, relay.port);
    const replay = await next.call(`/drafts/${draftId}/send`, "POST", {}, key);
    const sent = await replay.json() as { status?: string; providerMessageId?: string };
    expect({ http: replay.status, status: sent.status }).toEqual({ http: 200, status: "sent" });
    expect(next.events(), "the start did not forget the reservation that offered nothing").toContain("inherited_sends_forgotten");
    expect(await copies(address, "Sent", sent.providerMessageId!), "not exactly one copy in Sent").toBe(1);
    expect(await copies(to, "INBOX", sent.providerMessageId!), "not exactly one delivery").toBe(1);
    const d = await next.call(`/drafts/${draftId}`, "GET");
    expect((await d.json() as { status?: string }).status).toBe("sent");
    next.child.stdin.end();
    await Promise.race([next.exited, sleep(10_000)]);
  }, 120_000);

  /**
   * Quit `quitAfterMs` (0.5 s) after the press, start again on a server that answers, replay the
   * press's key; answers what the press itself was answered, or null. `stall`: the server at the
   * press answers nothing (absent), every command SLOW_MS late ("slow"), or that many ms late.
   */
  async function quitThenReplay(o: {
    relay: { port: number; setHeld(on: boolean): void; setDelay(ms: number): void }; dataDir: string; address: string;
    to: string; first: Awaited<ReturnType<typeof engine>>; draftId: string; stall?: "slow" | number; quitAfterMs?: number;
    smtp?: { host: string; port: number };
  }): Promise<{ http: number; body: unknown } | null> {
    const stall = (on: boolean): void => {
      if (o.stall === undefined) o.relay.setHeld(on);
      else o.relay.setDelay(on ? (o.stall === "slow" ? SLOW_MS : o.stall) : 0);
    };
    const key = `quit-${randomUUID()}`;
    stall(true);
    const pressed = o.first.call(`/drafts/${o.draftId}/send`, "POST", {}, key)
      .then(async (r) => ({ http: r.status, body: await r.json().catch(() => null) as unknown }), () => null);
    await sleep(o.quitAfterMs ?? 500);
    o.first.child.stdin.end();
    const code = await Promise.race([o.first.exited, sleep(10_000).then(() => "still running" as const)]);
    expect(code, `the first engine left with ${String(code)}`).toBe(0);
    const answered = await Promise.race([pressed, sleep(5_000).then(() => null)]);
    stall(false);
    const next = await engine(o.dataDir, o.address, o.relay.port, o.smtp);
    const replay = await next.call(`/drafts/${o.draftId}/send`, "POST", {}, key);
    const sent = await replay.json() as { status?: string; providerMessageId?: string };
    expect({ http: replay.status, status: sent.status }).toEqual({ http: 200, status: "sent" });
    expect(await copies(o.address, "Sent", sent.providerMessageId!), "not exactly one copy in Sent").toBe(1);
    expect(await copies(o.to, "INBOX", sent.providerMessageId!), "not exactly one delivery").toBe(1);
    const d = await next.call(`/drafts/${o.draftId}`, "GET");
    expect((await d.json() as { status?: string }).status).toBe("sent");
    next.child.stdin.end();
    await Promise.race([next.exited, sleep(10_000)]);
    return answered;
  }

  /** A reply pressed and the quit after it; with `kept`, reply one went first and keeps its connection. */
  async function pressThenQuit(o: {
    kept?: boolean; stall?: "slow" | number; quitAfterMs?: number; smtp?: { host: string; port: number };
  } = {}): Promise<{ http: number; body: unknown } | null> {
    const relay = await slowRelay(GREENMAIL.host, GREENMAIL.port, 0);
    const dataDir = await freshDataDir("ohmail-quit-press-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const address = `dcc-${randomUUID()}@trafficflow.test`;
    const to = `rcpt-${randomUUID()}@trafficflow.test`;
    const first = await engine(dataDir, address, relay.port, o.smtp);
    await sleep(1_500);
    const draft = async (subject: string): Promise<string> => {
      const r = await first.call("/drafts", "POST", {
        mailboxId: first.header.mailboxId, subject, body: "Fine.", to: [{ name: null, address: to }],
      });
      expect(r.status, await r.clone().text()).toBe(201);
      return (await r.json() as { id: string }).id;
    };
    if (o.kept === true) {
      const one = await first.call(`/drafts/${await draft("Re: one")}/send`, "POST", {}, `k-${randomUUID()}`);
      expect(one.status, "the premise: the first reply went and keeps its connection").toBe(200);
    }
    const draftId = await draft("Re: two");
    return quitThenReplay({ relay, dataDir, address, to, first, draftId, ...o });
  }

  it("a server answering nothing at the press: the next start sends it once with its Sent copy", async () => {
    await pressThenQuit();
  }, 120_000);

  it("a reply pressed over a kept connection after the server stopped answering goes at the next start with its copy", async () => {
    await pressThenQuit({ kept: true });
  }, 120_000);

  /* The NOOP check moves SMTP one slow round trip later, so the server's accept lands after the store
     closed: delivered, its copy dropped, and the replay read `unverified`. Held instead, and told so. */
  it("a reply over a kept connection to a slow server, its accept held 0.5 s, quit 0.5 s after the press: once, with its copy", async () => {
    const smtp = await slowAcceptRelay(GREENMAIL.host, SMTP_PORT, 500);
    const answer = await pressThenQuit({ kept: true, stall: "slow", smtp: { host: "127.0.0.1", port: smtp.port } });
    expect(answer, "the press was not told it goes at the next start").toMatchObject({
      http: 503, body: { error: { code: "upstream_unavailable", message: SEND_HELD_SENTENCE, retryable: true } },
    });
  }, 120_000);

  /* A server that answers in time: the press still goes before the engine leaves, as it did before the
     NOOP check. The check's first fix held every press whose open ended after the quit began. */
  const SENT_AT_QUIT = { http: 200, body: { status: "sent", sentCopy: "filed" } };
  it("a healthy server (50 ms an answer), quit 0.1 s after the press: sent with its copy before the engine leaves", async () => {
    expect(await pressThenQuit({ stall: 50, quitAfterMs: 100 })).toMatchObject(SENT_AT_QUIT);
  }, 120_000);

  it("the same over a kept connection (100 ms an answer), quit 0.05 s after the press", async () => {
    expect(await pressThenQuit({ kept: true, stall: 100, quitAfterMs: 50 })).toMatchObject(SENT_AT_QUIT);
  }, 120_000);

  async function bySubject(user: string, folder: string, subject: string): Promise<number> {
    const c = new ImapFlow({ host: GREENMAIL.host, port: GREENMAIL.port, secure: false, auth: { user, pass: "test" }, logger: false });
    await c.connect();
    try {
      const lock = await c.getMailboxLock(folder).catch(() => null);
      if (lock === null) return 0;
      try {
        const uids = await c.search({ subject }, { uid: true });
        return Array.isArray(uids) ? uids.length : 0;
      } finally { lock.release(); }
    } finally { await c.logout().catch(() => undefined); }
  }

  /**
   * Delivered, then the engine gone before its Sent copy: the server's accept held 1.5 s, IMAP stops
   * answering at 1 s (dialled, the APPEND not yet sent), and the engine quits or is killed at 2.5 s.
   * Before: the copy was owed only in memory and never filed.
   */
  async function deliveredThenGone(how: "quit" | "kill"): Promise<void> {
    const relay = await slowRelay(GREENMAIL.host, GREENMAIL.port, 0);
    const smtp = await slowAcceptRelay(GREENMAIL.host, SMTP_PORT, 1_500);
    const viaSmtp = { host: "127.0.0.1", port: smtp.port };
    const dataDir = await freshDataDir("ohmail-quit-owed-copy-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const address = `dcc-${randomUUID()}@trafficflow.test`;
    const to = `rcpt-${randomUUID()}@trafficflow.test`;
    const subject = `Re: owed ${randomUUID()}`;
    const first = await engine(dataDir, address, relay.port, viaSmtp);
    await sleep(1_500);
    const created = await first.call("/drafts", "POST", {
      mailboxId: first.header.mailboxId, subject, body: "See you then.", to: [{ name: null, address: to }],
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const draftId = (await created.json() as { id: string }).id;
    void first.call(`/drafts/${draftId}/send`, "POST", {}, `owed-${randomUUID()}`).catch(() => undefined);
    await sleep(1_000);
    relay.setHeld(true);
    await sleep(1_500);
    if (how === "quit") first.child.stdin.end();
    else first.child.kill("SIGKILL");
    await Promise.race([first.exited, sleep(10_000)]);
    relay.setHeld(false);
    expect(await bySubject(to, "INBOX", subject), "the premise: delivered once").toBe(1);

    const next = await engine(dataDir, address, relay.port, viaSmtp);
    const d = await next.call(`/drafts/${draftId}`, "GET");
    expect((await d.json() as { status?: string }).status, `first engine: ${first.events().join(",")}`).toBe("sent");
    let inSent = 0;
    for (const t = performance.now(); performance.now() - t < 30_000 && inSent === 0; await sleep(500)) {
      inSent = await bySubject(address, "Sent", subject);
    }
    expect(inSent, `no copy in Sent after the next start — events ${next.events().join(",")}`).toBe(1);
    await sleep(1_000);
    expect(await bySubject(address, "Sent", subject), "a second copy").toBe(1);
    expect(await bySubject(to, "INBOX", subject), "sent again").toBe(1);
    next.child.stdin.end();
    await Promise.race([next.exited, sleep(10_000)]);
  }

  it("delivered, then quit before its Sent copy: the next start files the copy once", async () => {
    await deliveredThenGone("quit");
  }, 120_000);

  it("delivered, then killed before its Sent copy: the next start files the copy once", async () => {
    await deliveredThenGone("kill");
  }, 120_000);
});

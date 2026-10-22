/**
 * A PHONE STARTED AGAIN SHOWS THE MAIL IT HOLDS AT ONCE, WHATEVER THE NETWORK.
 *
 * The real phone engine (`_phone-offline-rig.ts`) under the app's own relaunch — the profile row,
 * `connectProfileById`, `reopenStandaloneMailbox`, `bootEngine` and the Ohbox projection — through a
 * relay that holds the mail server's greeting for HOLD_MS, a login that takes that long. Measured at
 * the base: the session opened only after the held login AND the launch's whole first drain, so the
 * Ohbox was a skeleton for all of it, while an offline start opened at once. The empty store is the
 * positive control: nothing to show, so the launch is still waited for. Runs under the sqlite project.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlExecutor, SqlRow, SqlValue } from "@ohmail/client-engine";
import {
  EXPECTED_DIALECT, HOST, ON_DEVICE_STORE, PASS, PORT, SMTP_PORT, dialectSeam, deliver, dirs,
  nodeExecutor, open, seedMailboxId, untilIngested,
} from "./_phone-offline-rig.js";
import { serviceUp } from "@trafficflow/db/testing";
import { startPhoneEngine, startPhoneEngineFromSealed } from "../src/mobile.js";
import { bootEngine, LOCAL_ENGINE_ORIGIN, type MobileEngineDeps } from "../../mobile/src/engine/boot.js";
import { connectProfileById, type PairingEnv } from "../../mobile/src/net/pairing.js";
import { ServerProfileStore, type SecureKV } from "../../mobile/src/state/servers.js";
import { reopenStandaloneMailbox } from "../../mobile/src/engine/standalone-door.js";
import {
  forgetOrganizerSessionForTests, organizerDoor, standaloneHere,
} from "../../mobile/src/engine/organizer-session.js";
import {
  SCREENING_UNSUPPLIED, connectionSay, liveOhbox, mirrorSettled, presentedWorld,
} from "../../mobile/src/state/live.js";
import { listSurface } from "../../mobile/src/state/surface.js";

/** The run's one probe (test/setup/services.global.ts), at the address this file dials. */
const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** How long the relay holds the server's greeting on a relaunch — a login that slow. */
const HOLD_MS = Number(process.env.OHMAIL_RELAUNCH_HOLD_MS ?? 6000);
const RING = { 1: "c".repeat(64) };
const SENDER = "a.friend@known.example";

/**
 * THE PHONE'S ROUTE TO ITS MAIL SERVER, with a hold on the server's first bytes. `holdMs` applies to
 * connections opened after it is set; `released` counts the holds that have ended, so zero is the
 * proof a reading was taken before any login. `target` can be moved, so the sealed port stays put.
 */
class Relay {
  private server: Server | null = null;
  private readonly live = new Set<Socket>();
  holdMs = 0;
  released = 0;
  port = 0;
  constructor(public target: { host: string; port: number }) {}
  async open(): Promise<void> {
    this.server = createServer((inbound) => {
      const outbound = netConnect(this.target);
      this.live.add(inbound).add(outbound);
      const end = (): void => {
        inbound.destroy(); outbound.destroy();
        this.live.delete(inbound); this.live.delete(outbound);
      };
      inbound.on("error", end).on("close", end);
      outbound.on("error", end).on("close", end);
      let held: Buffer[] | null = null;
      if (this.holdMs > 0) {
        held = [];
        setTimeout(() => {
          this.released += 1;
          const bytes = held ?? [];
          held = null;
          for (const b of bytes) if (!inbound.destroyed) inbound.write(b);
        }, this.holdMs);
      }
      outbound.on("data", (b: Buffer) => { if (held !== null) held.push(b); else inbound.write(b); });
      inbound.on("data", (b: Buffer) => outbound.write(b));
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr !== null ? addr.port : 0;
  }
  async close(): Promise<void> {
    for (const s of [...this.live]) s.destroy();
    this.live.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

/** A server that greets and refuses every sign-in — a password changed at the provider. */
async function refusingImap(): Promise<{ port: number; close(): Promise<void> }> {
  const live = new Set<Socket>();
  const srv = createServer((sock) => {
    live.add(sock);
    sock.on("error", () => undefined).on("close", () => live.delete(sock));
    const write = (s: string): void => { if (!sock.destroyed) sock.write(s); };
    let buf = "";
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const [tag, cmd] = buf.slice(0, i).split(" ");
        buf = buf.slice(i + 2);
        const c = (cmd ?? "").toUpperCase();
        if (c === "CAPABILITY") write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        else if (c === "LOGIN") write(`${tag} NO [AUTHENTICATIONFAILED] refused\r\n`);
        else if (c === "LOGOUT") write(`* BYE\r\n${tag} OK\r\n`);
        else write(`${tag} NO unsupported\r\n`);
      }
    });
    write("* OK ready\r\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return {
    port: (srv.address() as { port: number }).port,
    close: () => new Promise<void>((r) => { for (const s of live) s.destroy(); srv.close(() => r()); }),
  };
}

const relays: Relay[] = [];
const closers: Array<() => Promise<void>> = [];
const mirrors: import("node:sqlite").DatabaseSync[] = [];

afterEach(async () => {
  forgetOrganizerSessionForTests();
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (relays.length > 0) await relays.pop()!.close();
  while (closers.length > 0) await closers.pop()!();
  for (const m of mirrors.splice(0)) { try { m.close(); } catch { /* closed by the store */ } }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

/** The app's mirror databases, on disk in this phone's directory so a relaunch reopens them. */
function mirrorDeps(dir: string): MobileEngineDeps {
  return {
    openExecutor: (name: string): SqlExecutor => {
      const db = new sqlite.DatabaseSync(join(dir, `${name.replace(/[^A-Za-z0-9.-]/g, "_")}.db`));
      mirrors.push(db);
      return {
        async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
          return db.prepare(sql).all(...params) as SqlRow[];
        },
        async batch(statements): Promise<void> {
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
            db.exec("COMMIT");
          } catch (err) { db.exec("ROLLBACK"); throw err; }
        },
      };
    },
    deleteDatabase: async () => undefined,
    uuid: () => randomUUID(),
    fetch: async () => { throw new Error("the global transport was used on the standalone door"); },
  };
}

interface PhoneOnDisk { dir: string; file: string; installId: string; accountId: string; relay: Relay; user: string }

/**
 * THE FIRST CONNECT, as the door press does it, and — unless `drain` is false — one session over it
 * that takes the mail in: a Yes for SENDER (a rule, so their letters are Ohbox rows) and the pulls
 * that bring the letters and the rule into the mirror. `letters: false` is an empty mailbox whose
 * first pass finished; `drain: false` a first connect whose server was unreachable — the password
 * is sealed and the store holds nothing.
 */
async function firstConnect(o: { drain: boolean; letters?: boolean }): Promise<PhoneOnDisk> {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-relaunch-"));
  dirs.push(dir);
  const user = `relaunch-${randomUUID()}@trafficflow.test`;
  const relay = new Relay({ host: HOST, port: o.drain ? PORT : 1 });
  await relay.open();
  relays.push(relay);
  const installId = `install-${randomUUID()}`;
  const file = join(dir, "engine.db");
  const letters = o.drain && o.letters !== false;
  if (letters) {
    await deliver(user, SENDER, "the first letter");
    await deliver(user, SENDER, "the second letter");
  }
  const exec = dialectSeam(nodeExecutor(file));
  const engine = await startPhoneEngine({
    exec,
    imap: {
      host: "127.0.0.1", port: relay.port, secure: false,
      auth: { user, pass: PASS },
      /* Connect dials the outgoing server too, so the seeding start names the rig's own. */
      smtp: { host: HOST, port: SMTP_PORT, secure: false },
    },
    machineName: "the relaunched phone",
    installId,
    keks: RING,
  });
  const accountId = engine.accountId;
  if (o.drain && !letters) {
    const until = Date.now() + 60_000;
    let passed = false;
    while (!passed && Date.now() < until) {
      const r = await exec.all("select last_sync_at from mailboxes", []);
      passed = r.rows.some((row) => row[0] !== null);
      if (!passed) await new Promise((res) => setTimeout(res, 250));
    }
    expect(passed, "the empty mailbox's first pass never finished").toBe(true);
    const boot = await bootEngine(mirrorDeps(dir), { origin: LOCAL_ENGINE_ORIGIN, accountId, localEngine: engine });
    if (boot.kind !== "ready") throw new Error("the first session's mirror refused");
    await boot.verifyIdentity();
    await boot.engine.start();
    boot.store.close();
  }
  if (letters) {
    const phone = { engine, lines: [], exec, installId, file };
    expect(await untilIngested(phone, "the second letter", 60_000), "the first launch took no mail in").not.toBeNull();
    const boot = await bootEngine(mirrorDeps(dir), { origin: LOCAL_ENGINE_ORIGIN, accountId, localEngine: engine });
    if (boot.kind !== "ready") throw new Error("the first session's mirror refused");
    await boot.verifyIdentity();
    await boot.engine.start();
    /* THIS PHONE ORGANIZES THE MAILBOX (the consent press), so the Yes below is a rule it may write. */
    expect(await engine.claimHere({ by: "press" })).toBe("claimed");
    const id = seedMailboxId(phone);
    const until = Date.now() + 30_000;
    while (engine.runtimes().organizer[id]?.organizing !== true && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const yes = await boot.engine.mutate({ kind: "rule_create", ruleKind: "sender", match: SENDER, destination: "INBOX" });
    expect(yes.status, "the Yes for the sender was refused").not.toBe("rolled_back");
    await boot.engine.syncOnce();
    expect(ohboxTotal(boot.engine), "the first session left no Ohbox rows to relaunch over").toBeGreaterThanOrEqual(2);
    boot.store.close();
  }
  await engine.stop();
  return { dir, file, installId, accountId, relay, user };
}

function ohboxTotal(engine: { read(): Parameters<typeof presentedWorld>[0] }): number {
  const now = new Date();
  const world = presentedWorld(engine.read(), now, false, SCREENING_UNSUPPLIED);
  return liveOhbox(world.reader, { now, zone: "UTC", screening: SCREENING_UNSUPPLIED }).total;
}

/** The cold launch the app makes, through its own seams. Answers when the session is live. */
async function relaunchApp(phone: PhoneOnDisk): Promise<{ ms: number; outcome: Awaited<ReturnType<typeof connectProfileById>> }> {
  const env: PairingEnv = {
    profiles: new ServerProfileStore(memoryKV()),
    engineDeps: mirrorDeps(phone.dir),
    standalone: {
      door: () => organizerDoor(),
      reopen: () => reopenStandaloneMailbox({
        startFromSealed: async (deps) => {
          const started = await startPhoneEngineFromSealed({ ...deps, exec: dialectSeam(nodeExecutor(phone.file)) } as never);
          if (started.kind === "started") open.push(started.engine);
          return started as never;
        },
        platform: async () => ({ kind: "ready" as const, exec: {}, keks: RING }),
        machineName: () => "the relaunched phone",
        installId: async () => phone.installId,
      }),
      removeEngine: async () => { throw new Error("nothing here removes the engine"); },
      standDownAway: async () => undefined,
    },
  };
  const row = await env.profiles.addStandalone({ origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: phone.accountId });
  const t0 = Date.now();
  const outcome = await connectProfileById(env, row.id);
  return { ms: Date.now() - t0, outcome };
}

const onServer = ON_DEVICE_STORE && SERVER_UP;

describe.skipIf(!onServer)("a phone started again shows the mail it holds before the first pull", () => {
  it("the Ohbox rows are readable while the login is still held, and the pull refreshes behind them", async () => {
    const phone = await firstConnect({ drain: true });
    await deliver(phone.user, SENDER, "a letter that came while the phone was closed");
    phone.relay.holdMs = HOLD_MS;
    const { ms, outcome } = await relaunchApp(phone);
    expect(outcome.kind, "the relaunch did not open").toBe("connected");
    if (outcome.kind !== "connected") return;
    const loginsAtOpen = phone.relay.released;
    const rows = ohboxTotal(outcome.session.engine);
    expect(rows, "the stored Ohbox rows were not readable at open").toBeGreaterThanOrEqual(2);
    expect(listSurface({ settled: mirrorSettled(outcome.session.store), count: rows })).toBe("content");
    expect(ms, `the session opened only after ${ms} ms, behind a login held for ${HOLD_MS} ms`).toBeLessThan(HOLD_MS);
    expect(loginsAtOpen, "the reading was taken after the mail server had greeted").toBe(0);
    /* AND THE FIRST PULL, run the moment the app runs it, lands without taking a row away. */
    await outcome.session.verifyIdentity();
    await outcome.session.engine.start();
    expect(ohboxTotal(outcome.session.engine)).toBeGreaterThanOrEqual(2);
    /* …and the letter the network brings arrives behind them, on the app's own later pulls. */
    const deadline = Date.now() + HOLD_MS + 60_000;
    while (ohboxTotal(outcome.session.engine) < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      await outcome.session.engine.syncOnce();
    }
    expect(ohboxTotal(outcome.session.engine), "the letter the network held never arrived").toBe(3);
    outcome.session.store.close();
  }, 180_000);

  it("a refused sign-in on the way in opens the stored mail and says the sign-in was refused", async () => {
    const phone = await firstConnect({ drain: true });
    const refusing = await refusingImap();
    closers.push(refusing.close);
    phone.relay.target = { host: "127.0.0.1", port: refusing.port };
    const { outcome } = await relaunchApp(phone);
    expect(outcome.kind, "a changed password took the stored mail off the screen").toBe("connected");
    if (outcome.kind !== "connected") return;
    expect(ohboxTotal(outcome.session.engine)).toBeGreaterThanOrEqual(2);
    const deadline = Date.now() + 30_000;
    while (standaloneHere()?.signInRefused !== true && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(connectionSay(standaloneHere(), new Date(), "UTC")).toEqual({ kind: "refused" });
    outcome.session.store.close();
  }, 180_000);

  it("a first import cut short before its pass was stamped still shows what it took in", async () => {
    const phone = await firstConnect({ drain: true });
    /* The store a kill mid-way through the first pass leaves: pages committed, no pass recorded. */
    const exec = dialectSeam(nodeExecutor(phone.file));
    await exec.run("update mailboxes set last_sync_at = null", []);
    await exec.close();
    phone.relay.holdMs = HOLD_MS;
    const { ms, outcome } = await relaunchApp(phone);
    expect(outcome.kind).toBe("connected");
    if (outcome.kind !== "connected") return;
    expect(ms, `the store holding mail opened only after ${ms} ms`).toBeLessThan(HOLD_MS);
    expect(ohboxTotal(outcome.session.engine)).toBeGreaterThanOrEqual(2);
    outcome.session.store.close();
  }, 180_000);

  it("an empty mailbox whose first pass finished opens at once and says it is empty", async () => {
    const phone = await firstConnect({ drain: true, letters: false });
    phone.relay.holdMs = HOLD_MS;
    const { ms, outcome } = await relaunchApp(phone);
    expect(outcome.kind).toBe("connected");
    if (outcome.kind !== "connected") return;
    expect(ms, `the settled empty mailbox opened only after ${ms} ms`).toBeLessThan(HOLD_MS);
    expect(listSurface({ settled: mirrorSettled(outcome.session.store), count: ohboxTotal(outcome.session.engine) }))
      .toBe("empty");
    outcome.session.store.close();
  }, 180_000);

  it("CONTROL: the form's own start over the same store still refuses a password the server refuses", async () => {
    const phone = await firstConnect({ drain: true });
    const refusing = await refusingImap();
    closers.push(refusing.close);
    phone.relay.target = { host: "127.0.0.1", port: refusing.port };
    const verdict = await startPhoneEngine({
      exec: dialectSeam(nodeExecutor(phone.file)),
      imap: { host: "127.0.0.1", port: phone.relay.port, secure: false, auth: { user: phone.user, pass: "a-new-one-password" } },
      machineName: "the relaunched phone",
      installId: phone.installId,
      keks: RING,
    }).then((engine) => { open.push(engine); return "opened"; }, () => "refused");
    expect(verdict, "a typed password the server refused was handed back as an opened mailbox").toBe("refused");
  }, 180_000);

  it("CONTROL: a store holding nothing yet waits for the launch, and the Ohbox is a skeleton", async () => {
    const phone = await firstConnect({ drain: false });
    phone.relay.target = { host: HOST, port: PORT };
    phone.relay.holdMs = HOLD_MS;
    const { ms, outcome } = await relaunchApp(phone);
    expect(outcome.kind).toBe("connected");
    if (outcome.kind !== "connected") return;
    expect(ms, "an empty store was opened before its launch had anything to give").toBeGreaterThanOrEqual(HOLD_MS);
    expect(listSurface({ settled: mirrorSettled(outcome.session.store), count: ohboxTotal(outcome.session.engine) }))
      .toBe("skeleton");
    outcome.session.store.close();
  }, 180_000);
});

describe("the premise", () => {
  it("runs on the device store against a mail server that answers, or says which is missing", () => {
    if (EXPECTED_DIALECT !== "sqlite") {
      expect(ON_DEVICE_STORE, "the default project has no device store; this file runs under the sqlite one").toBe(false);
      return;
    }
    expect(SERVER_UP, `no IMAP server answered at ${HOST}:${PORT}`).toBe(true);
  });
});

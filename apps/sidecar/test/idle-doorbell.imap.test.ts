import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ImapAdapter, type ImapConfig, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { messages } from "@trafficflow/db";
import { createSidecar, type AdapterDialContext, type Sidecar } from "../src/engine.js";
import { noteFirstPageServed } from "../src/first-page-gate.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: 2 * PGLITE_STANDUP_BUDGET_MS });

/**
 * THE DOORBELL AFTER A POLL, on real servers. A poll drain ends with the request channel and the
 * profile publish, both on `ohmail/_meta`; the INBOX re-arm ran before them, so IDLE rested on
 * `_meta` and an arrival waited for the ladder (56-120 s on 0.26.1). The poll here is an hour, so
 * only the doorbell can bring the mail in time. The same after a pass whose mail read failed, and
 * after a hand-back and resume. Control: with IDLE not advertised the poll does.
 */

const GREENMAIL = { host: process.env.IMAP_HOST ?? "127.0.0.1", port: Number(process.env.IMAP_PORT ?? 3143) };
/** The compose Dovecot's static passdb, read from its own config rather than repeated here. */
const dovecotPass = (): string =>
  /password=(\S+)/.exec(readFileSync(new URL("../../../test/dovecot/dovecot.conf", import.meta.url), "utf8"))?.[1] ?? "";
const DOVECOT = {
  host: process.env.IMAP_CONDSTORE_HOST ?? "127.0.0.1", port: Number(process.env.IMAP_CONDSTORE_PORT ?? 3144),
  pass: process.env.IMAP_CONDSTORE_PASS ?? dovecotPass(),
};

/** Does something answer IMAP there? Asked, never assumed. */
function imapAnswers(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    const sock = netConnect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.on("data", (b: Buffer) => finish(/^\* (OK|PREAUTH)/im.test(b.toString("utf8"))));
    sock.once("close", () => finish(false));
  });
}

const SERVERS = [
  { name: "GreenMail", up: await imapAnswers(GREENMAIL.host, GREENMAIL.port), host: GREENMAIL.host, port: GREENMAIL.port, pass: "test" },
  { name: "Dovecot", up: await imapAnswers(DOVECOT.host, DOVECOT.port), host: DOVECOT.host, port: DOVECOT.port, pass: DOVECOT.pass },
];

const DOORBELL_BOUND_MS = 5_000;
const HOUR = 60 * 60 * 1000;

interface Line { event: string; detail: Record<string, unknown> }
interface World {
  sidecar: Sidecar; raw: ImapFlow; lines: Line[]; address: string; adapters: ImapAdapter[];
  /** The next mail read throws once, as a store or pipeline fault would: the login stands. */
  failNextRead: () => void;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function standUp(
  server: (typeof SERVERS)[number], opts: { pollIntervalMs: number; idle: boolean },
): Promise<World> {
  // The window's first page is served, as the desktop's is at boot (`host.ts`): the gate's once-per-process
  // grace then sits in no case's doorbell bound, whichever case runs first.
  noteFirstPageServed();
  const address = `idle-${randomUUID()}@trafficflow.test`;
  const imap = { host: server.host, port: server.port, secure: false, auth: { user: address, pass: server.pass } };
  const dataDir = await freshDataDir("ohmail-idle-doorbell-");
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const lines: Line[] = [];
  const adapters: ImapAdapter[] = [];
  let failRead = false;
  const factory = (cfg: ImapConfig, ctx: AdapterDialContext): MailboxAdapter => {
    const real = new ImapAdapter(cfg, { onConnectionError: ctx.onConnectionError });
    adapters.push(real);
    // The real connection; `idle: false` withholds the capability, as a server without IDLE.
    return new Proxy(real, {
      get(target, prop) {
        if (prop === "capabilities" && !opts.idle) {
          return async () => ({ ...(await target.capabilities()), idle: false });
        }
        if (prop === "changesSince" && failRead) {
          failRead = false;
          return async () => { throw new Error("the rig failed this read"); };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  const sidecar = await createSidecar({
    dataDir, address, imap, machineName: "the doorbell rig",
    pollIntervalMs: opts.pollIntervalMs, leaseStaleAfterMs: 60_000,
    adapterFactory: factory,
    log: (event, detail) => { lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
  });
  cleanups.push(async () => { await sidecar.stop().catch(() => undefined); });
  await grantOrganizeConsent(sidecar);
  const raw = new ImapFlow({ ...imap, logger: false });
  await raw.connect();
  cleanups.push(async () => { await raw.logout().catch(() => undefined); });
  return { sidecar, raw, lines, address, adapters, failNextRead: () => { failRead = true; } };
}

async function deliver(w: World, tag: string): Promise<string> {
  const mid = `doorbell-${tag}-${randomUUID()}@rig.test`;
  await w.raw.append("INBOX", Buffer.from([
    `Message-ID: <${mid}>`, "From: Mara <mara@rig.test>", `To: <${w.address}>`, `Subject: doorbell ${tag}`,
    `Date: ${new Date().toUTCString()}`, "Content-Type: text/plain; charset=utf-8", "", "ring", "",
  ].join("\r\n"), "utf8"));
  return mid;
}

/** Milliseconds from now until the message is in the store, or null past `boundMs`. */
async function arrivalMs(w: World, mid: string, boundMs: number): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < boundMs) {
    const rows = await w.sidecar.db.select({ id: messages.id }).from(messages).where(eq(messages.messageIdHeader, mid));
    if (rows.length > 0) return Date.now() - t0;
    await new Promise((r) => { setTimeout(r, 100); });
  }
  return null;
}

/** Where the engine's connection rests: the SELECTed mailbox and whether IDLE runs. */
function restingOn(w: World): { path: string | null; idling: boolean } {
  const client = (w.adapters.at(-1) as unknown as { client?: ImapFlow }).client;
  const mb = client?.mailbox;
  return { path: mb && typeof mb === "object" ? mb.path : null, idling: client?.idling === true };
}

/** Where the connection rests once it rests on INBOX with IDLE running, or where it is past the bound. */
async function restsOnInbox(w: World): Promise<{ path: string | null; idling: boolean }> {
  const t0 = Date.now();
  while (Date.now() - t0 < DOORBELL_BOUND_MS) {
    const now = restingOn(w);
    if (now.path === "INBOX" && now.idling) return now;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  return restingOn(w);
}

for (const server of SERVERS) {
  describe.skipIf(!server.up)(`the INBOX doorbell after a poll drain (${server.name})`, () => {
    it("an arrival after a poll drain reaches the store within seconds, on the IDLE", async () => {
      const w = await standUp(server, { pollIntervalMs: HOUR, idle: true });
      await w.sidecar.start();
      expect(await arrivalMs(w, await deliver(w, "launch"), DOORBELL_BOUND_MS), "the premise: after the launch")
        .not.toBeNull();
      // Two poll drains, each through the request channel and the profile publish.
      for (const round of [1, 2]) {
        await w.sidecar.syncUntilQuiet();
        expect(await restsOnInbox(w), `after poll drain ${round} the connection does not rest on INBOX`)
          .toEqual({ path: "INBOX", idling: true });
        const took = await arrivalMs(w, await deliver(w, `poll-${round}`), DOORBELL_BOUND_MS);
        expect(took, `arrival after poll drain ${round} waited for the poll`).not.toBeNull();
      }
      expect(w.lines.filter((l) => l.event === "local_wake_unarmed")).toEqual([]);
    });

    it("an arrival after a FAILED poll pass still rings: the failure is not a dead doorbell", async () => {
      const w = await standUp(server, { pollIntervalMs: HOUR, idle: true });
      await w.sidecar.start();
      w.failNextRead();
      await w.sidecar.syncUntilQuiet().catch(() => undefined);
      expect(w.lines.some((l) => l.event === "local_wake_rearm_failed")).toBe(false);
      expect(await restsOnInbox(w), "after the failed pass the connection does not rest on INBOX")
        .toEqual({ path: "INBOX", idling: true });
      expect(await arrivalMs(w, await deliver(w, "after-failure"), DOORBELL_BOUND_MS),
        "arrival after the failed pass waited for the poll").not.toBeNull();
    });

    it("after a hand-back and a resume the doorbell rings again", async () => {
      const w = await standUp(server, { pollIntervalMs: HOUR, idle: true });
      await w.sidecar.start();
      await w.sidecar.syncUntilQuiet();
      await w.sidecar.handBack();
      await w.sidecar.resume();
      expect(await restsOnInbox(w), "after the resume the connection does not rest on INBOX")
        .toEqual({ path: "INBOX", idling: true });
      expect(await arrivalMs(w, await deliver(w, "after-resume"), DOORBELL_BOUND_MS),
        "arrival after the resume waited for the poll").not.toBeNull();
    });

    it("with IDLE not advertised the poll carries the arrival, at the base interval", async () => {
      const w = await standUp(server, { pollIntervalMs: 1_500, idle: false });
      await w.sidecar.start();
      expect(w.lines.filter((l) => l.event === "local_wake_unarmed").length).toBe(1);
      await w.sidecar.syncUntilQuiet();
      expect(await arrivalMs(w, await deliver(w, "poll"), DOORBELL_BOUND_MS), "the poll fallback").not.toBeNull();
      expect(w.lines.filter((l) => l.event === "sync_idle_backoff"), "rested without a doorbell").toEqual([]);
    });
  });
}

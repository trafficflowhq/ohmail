import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
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
import { serviceUp } from "@trafficflow/db/testing";

/** What a case stands on (the launch and the first arrival after it) has its own bound. */
const PREMISE_BOUND_MS = 30_000;

vi.setConfig({ testTimeout: 2 * PGLITE_STANDUP_BUDGET_MS + PREMISE_BOUND_MS });

/**
 * THE DOORBELL AFTER A POLL, on real servers. A poll drain ends with the request channel and the
 * profile publish, both on `ohmail/_meta`; the INBOX re-arm ran before them, so IDLE rested on
 * `_meta` and an arrival waited for the ladder (56-120 s on 0.26.1). The poll here is an hour, so
 * only the doorbell can bring the mail in time. The same after a pass whose mail read failed, and
 * after a hand-back and resume. Control: with IDLE not advertised the poll does. The first arrival after
 * the launch is the premise (it pays the process's first ingest); every arrival a case proves keeps 5 s.
 */

const GREENMAIL = { host: process.env.IMAP_HOST ?? "127.0.0.1", port: Number(process.env.IMAP_PORT ?? 3143) };
/** The compose Dovecot's static passdb, read from its own config rather than repeated here. */
const dovecotPass = (): string =>
  /password=(\S+)/.exec(readFileSync(new URL("../../../test/dovecot/dovecot.conf", import.meta.url), "utf8"))?.[1] ?? "";
const DOVECOT = {
  host: process.env.IMAP_CONDSTORE_HOST ?? "127.0.0.1", port: Number(process.env.IMAP_CONDSTORE_PORT ?? 3144),
  pass: process.env.IMAP_CONDSTORE_PASS ?? dovecotPass(),
};

const SERVERS = [
  { name: "GreenMail", up: serviceUp("greenmail", `${GREENMAIL.host}:${GREENMAIL.port}`).up, host: GREENMAIL.host, port: GREENMAIL.port, pass: "test" },
  { name: "Dovecot", up: serviceUp("dovecot", `${DOVECOT.host}:${DOVECOT.port}`).up, host: DOVECOT.host, port: DOVECOT.port, pass: DOVECOT.pass },
];

const DOORBELL_BOUND_MS = 5_000;
const HOUR = 60 * 60 * 1000;

interface Line { event: string; detail: Record<string, unknown> }
interface World {
  sidecar: Sidecar; raw: ImapFlow; lines: Line[]; address: string; adapters: ImapAdapter[];
  imap: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } };
  /** The next mail read throws once, as a store or pipeline fault would: the login stands. */
  failNextRead: () => void;
  /** Every NOOP the engine sent on the wire, with whether IDLE ran just before it and just after. */
  noops: { idlingBefore: boolean; idlingAfter: boolean }[];
  /** From now on a NOOP is answered without the wire, so only IDLE can bring an arrival in. */
  quietNoops: () => void;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function standUp(
  server: (typeof SERVERS)[number],
  opts: { pollIntervalMs: number; idle: boolean; organize?: boolean; heartbeatTimeoutMs?: number },
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
  let quiet = false;
  const noops: World["noops"] = [];
  const factory = (cfg: ImapConfig, ctx: AdapterDialContext): MailboxAdapter => {
    const real = new ImapAdapter(cfg, { onConnectionError: ctx.onConnectionError });
    adapters.push(real);
    // The real connection; `idle: false` withholds the capability, as a server without IDLE.
    return new Proxy(real, {
      get(target, prop) {
        if (prop === "capabilities" && !opts.idle) {
          return async () => ({ ...(await target.capabilities()), idle: false });
        }
        if (prop === "noop") {
          const idling = (): boolean => (target as unknown as { client?: ImapFlow }).client?.idling === true;
          return async () => {
            if (quiet) return;
            const idlingBefore = idling();
            await target.noop();
            // Before the adapter's re-arm, which it asks for a turn later.
            noops.push({ idlingBefore, idlingAfter: idling() });
          };
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
    ...(opts.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: opts.heartbeatTimeoutMs }),
  });
  cleanups.push(async () => { await sidecar.stop().catch(() => undefined); });
  if (opts.organize !== false) await grantOrganizeConsent(sidecar);
  const raw = new ImapFlow({ ...imap, logger: false });
  await raw.connect();
  cleanups.push(async () => { await raw.logout().catch(() => undefined); });
  return {
    sidecar, raw, imap, lines, address, adapters, noops,
    failNextRead: () => { failRead = true; }, quietNoops: () => { quiet = true; },
  };
}

/** The start, which reports a failed mailbox rather than throwing: a case stands on a launch that served. */
async function launch(w: World): Promise<void> {
  expect((await w.sidecar.start()).failures, "the premise: the launch").toEqual([]);
}

async function deliver(w: World, tag: string): Promise<string> {
  const mid = `doorbell-${tag}-${randomUUID()}@rig.test`;
  await w.raw.append("INBOX", Buffer.from([
    `Message-ID: <${mid}>`, "From: Mara <mara@rig.test>", `To: <${w.address}>`, `Subject: doorbell ${tag}`,
    `Date: ${new Date().toUTCString()}`, "Content-Type: text/plain; charset=utf-8", "", "ring", "",
  ].join("\r\n"), "utf8"));
  return mid;
}

/** The same letter on a fresh connection: GreenMail drops a session left quiet past its idle timeout. */
async function deliverFresh(w: World, tag: string): Promise<string> {
  const mid = `doorbell-${tag}-${randomUUID()}@rig.test`;
  const c = new ImapFlow({ ...w.imap, logger: false });
  await c.connect();
  try {
    await c.append("INBOX", Buffer.from([
      `Message-ID: <${mid}>`, "From: Mara <mara@rig.test>", `To: <${w.address}>`, `Subject: doorbell ${tag}`,
      `Date: ${new Date().toUTCString()}`, "Content-Type: text/plain; charset=utf-8", "", "ring", "",
    ].join("\r\n"), "utf8"));
  } finally {
    await c.logout().catch(() => undefined);
  }
  return mid;
}

/** The engine connection's INBOX count against the server's. */
async function counts(w: World): Promise<{ client: number; server: number }> {
  const client = (w.adapters.at(-1) as unknown as { client?: ImapFlow }).client;
  const mb = client?.mailbox;
  const status = await w.raw.status("INBOX", { messages: true });
  return { client: mb && typeof mb === "object" ? mb.exists : -1, server: status.messages ?? -1 };
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

/** The first heartbeat NOOP sent while IDLE ran, awaited as that event rather than sampled from the IDLE flag. */
async function heartbeatDuringIdle(w: World): Promise<World["noops"][number] | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < PREMISE_BOUND_MS) {
    const beat = w.noops.find((n) => n.idlingBefore);
    if (beat) return beat;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  return null;
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
      await launch(w);
      expect(await arrivalMs(w, await deliver(w, "launch"), PREMISE_BOUND_MS), "the premise: after the launch")
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
      await launch(w);
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
      await launch(w);
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
      await launch(w);
      expect(w.lines.filter((l) => l.event === "local_wake_unarmed").length).toBe(1);
      await w.sidecar.syncUntilQuiet();
      expect(await arrivalMs(w, await deliver(w, "poll"), DOORBELL_BOUND_MS), "the poll fallback").not.toBeNull();
      expect(w.lines.filter((l) => l.event === "sync_idle_backoff"), "rested without a doorbell").toEqual([]);
    });
  });

  /**
   * THE DOORBELL AFTER A DELETE, and after the heartbeat. On a QRESYNC server (Dovecot) an INBOX
   * expunge arrives as VANISHED, which imapflow 1.7.8 never counted: the next arrival's EXISTS
   * equalled the stale count and was dropped. And the heartbeat's NOOP ended IDLE, which came back
   * only after imapflow's 15 s auto-IDLE delay.
   */
  describe.skipIf(!server.up)(`the INBOX doorbell after a delete and after the heartbeat (${server.name})`, () => {
    it("after a mail filed at launch, the next arrival rings", async () => {
      const w = await standUp(server, { pollIntervalMs: HOUR, idle: true });
      await deliverFresh(w, "seed");
      await w.sidecar.start();
      expect(await restsOnInbox(w), "after the launch the connection does not rest on INBOX")
        .toEqual({ path: "INBOX", idling: true });
      const before = await counts(w);
      expect(before.client, "the client's INBOX count after the launch filing").toBe(before.server);
      expect(await arrivalMs(w, await deliverFresh(w, "after-seed"), DOORBELL_BOUND_MS),
        "the arrival after the launch filing waited for the poll").not.toBeNull();
    });

    it("after another client deletes the one INBOX mail, the next arrival rings", async () => {
      const w = await standUp(server, { pollIntervalMs: HOUR, idle: true, organize: false });
      await w.sidecar.start();
      expect(await arrivalMs(w, await deliverFresh(w, "first"), DOORBELL_BOUND_MS), "the premise").not.toBeNull();
      await w.sidecar.syncUntilQuiet();
      expect(await restsOnInbox(w)).toEqual({ path: "INBOX", idling: true });
      const other = new ImapFlow({ ...w.imap, logger: false });
      await other.connect();
      await other.mailboxOpen("INBOX");
      await other.messageDelete("1:*");
      await other.logout().catch(() => undefined);
      const t0 = Date.now();
      while (Date.now() - t0 < DOORBELL_BOUND_MS && (await counts(w)).client !== 0) {
        await new Promise((r) => { setTimeout(r, 50); });
      }
      expect(await arrivalMs(w, await deliverFresh(w, "after-delete"), DOORBELL_BOUND_MS),
        "the arrival after the other client's delete waited for the poll").not.toBeNull();
    });

    it("the heartbeat's NOOP ends IDLE, IDLE comes back before imapflow's own, and the next arrival rings", async () => {
      const w = await standUp(server, { pollIntervalMs: HOUR, idle: true, organize: false, heartbeatTimeoutMs: 6_000 });
      await w.sidecar.start();
      expect(await restsOnInbox(w)).toEqual({ path: "INBOX", idling: true });
      const beat = await heartbeatDuringIdle(w);
      expect(beat, "no heartbeat NOOP while IDLE ran").not.toBeNull();
      expect(beat?.idlingAfter, "the heartbeat never ended IDLE").toBe(false);
      w.quietNoops();
      // The bound sits well inside imapflow's 15 s auto-IDLE delay, which is what brought IDLE back before.
      expect(await restsOnInbox(w), "IDLE was not back after the heartbeat NOOP").toEqual({ path: "INBOX", idling: true });
      expect(await arrivalMs(w, await deliverFresh(w, "after-noop"), DOORBELL_BOUND_MS),
        "the arrival after the heartbeat did not ring on the IDLE").not.toBeNull();
    });
  });
}

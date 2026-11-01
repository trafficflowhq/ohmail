import { rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { mailboxCredentials, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { serviceUp } from "@trafficflow/db/testing";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * THE DESKTOP'S FIRST CONNECT, ON THE REAL ADAPTER: the engine boots with no password, the door
 * seals one through `PATCH /local/mailboxes/:id`, then replaces the engine. Every set-up logged a
 * `mailbox_relogin_cycle_failed` TypeError here: the seal's forced cycle drained over an
 * `ImapAdapter` nothing had connected (`client` undefined). A double cannot show that class, so
 * this runs `ImapAdapter` against the compose fixture. Controls: the double-based twins in
 * `unreadable-credential-is-an-outage.test.ts`, and the mutations named there.
 */

const HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.IMAP_PORT ?? 3143);

const SERVER_UP = serviceUp("greenmail", `${HOST}:${PORT}`).up;

interface Line { event: string; detail: Record<string, unknown> }

/** Whether an event carried a TypeError, itself or as the cause a wrapper names. */
const typeErrorIn = (l: Line): boolean => {
  const err = l.detail.err as { name?: unknown; cause?: { name?: unknown } } | undefined;
  return err?.name === "TypeError" || err?.cause?.name === "TypeError";
};

const seen = (lines: Line[], event: string): number => lines.filter((l) => l.event === event).length;

/** `n` letters in a fixture mailbox; the fixture has authentication disabled. */
async function seedMailbox(address: string, pass: string, n: number): Promise<void> {
  const seeder = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user: address, pass }, logger: false });
  await seeder.connect();
  try {
    for (let i = 0; i < n; i++) {
      await seeder.append("INBOX", Buffer.from([
        `From: sender${i} <sender${i}@example.test>`, `To: <${address}>`, `Subject: first door ${i}`,
        `Message-ID: <first-door-${i}-${randomUUID()}@example.test>`,
        `Date: Thu, 24 Sep 2026 10:0${i}:00 +0000`, "Content-Type: text/plain; charset=utf-8", "",
        `body ${i}`, "",
      ].join("\r\n"), "utf8"));
    }
  } finally {
    await seeder.logout().catch(() => undefined);
  }
}

/** A port on this machine that refuses connections. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return port;
}

/** The door's seal, as `doors.ts` sends it. */
const seal = (s: Sidecar, address: string, pass: string, port: number): Promise<Response> => s.handle(new Request(
  `http://local/local/mailboxes/${encodeURIComponent(s.world.mailboxId)}`,
  {
    method: "PATCH",
    headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ imap: { host: HOST, port, secure: false, user: address, pass, smtpHost: "" } }),
  },
));

/** The mailboxes the window lists. */
async function listed(s: Sidecar): Promise<string[]> {
  const res = await s.handle(new Request("http://local/mailboxes", { headers: { authorization: `Bearer ${s.sessionToken}` } }));
  return ((await res.json()) as { items: { address: string }[] }).items.map((m) => m.address);
}

describe.skipIf(!SERVER_UP)("the first connect's seal, then the relaunch the door performs", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it("the seal re-dials nothing and the relaunch drains the mailbox to quiet", async () => {
    // Generated here and never printed; the fixture has authentication disabled.
    const address = `t-${randomUUID()}@trafficflow.test`;
    const pass = randomUUID();
    const N = 5;
    const seeder = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user: address, pass }, logger: false });
    await seeder.connect();
    try {
      for (let i = 0; i < N; i++) {
        await seeder.append("INBOX", Buffer.from([
          `From: sender${i} <sender${i}@example.test>`, `To: <${address}>`, `Subject: first connect ${i}`,
          `Message-ID: <first-connect-${i}-${randomUUID()}@example.test>`,
          `Date: Thu, 24 Sep 2026 10:0${i}:00 +0000`, "Content-Type: text/plain; charset=utf-8", "",
          `body ${i}`, "",
        ].join("\r\n"), "utf8"));
      }
    } finally {
      await seeder.logout().catch(() => undefined);
    }

    const dataDir = await freshDataDir("ohmail-first-connect-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const keks = { 1: randomBytes(32) };
    const boot = async (lines: Line[]): Promise<Sidecar> => {
      const s = await createSidecar({
        dataDir, address, keks,
        imap: { host: HOST, port: PORT, secure: false, auth: { user: address } },
        machineName: "the computer being set up",
        pollIntervalMs: 60 * 60 * 1000,
        leaseStaleAfterMs: 60_000,
        log: (event, detail) => { lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
      });
      cleanups.push(async () => { await s.stop().catch(() => undefined); });
      return s;
    };
    const count = (lines: Line[], event: string): number => lines.filter((l) => l.event === event).length;

    // The engine the door's first configure starts: no password stored, none supplied.
    const firstLines: Line[] = [];
    const first = await boot(firstLines);
    await first.start();
    expect(count(firstLines, "stored_login_absent"), "the rig did not boot without a password").toBe(1);
    const sealed = await first.handle(new Request(
      `http://local/local/mailboxes/${encodeURIComponent(first.world.mailboxId)}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${first.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ imap: { host: HOST, port: PORT, secure: false, user: address, pass, smtpHost: "" } }),
      },
    ));
    expect(sealed.status).toBe(200);
    await new Promise((r) => { setTimeout(r, 500); });
    expect(count(firstLines, "mailbox_relogin_cycle_failed"), "the seal drained over an adapter "
      + "nothing had connected").toBe(0);
    expect(count(firstLines, "mailbox_relogin_skipped")).toBe(1);
    expect(firstLines.filter(typeErrorIn).map((l) => l.event), "a TypeError from the engine's own code")
      .toEqual([]);
    await first.stop();

    // The door's next step: the engine is replaced, and its launch dials the sealed password.
    const nextLines: Line[] = [];
    const next = await boot(nextLines);
    await next.start();
    expect(nextLines.some((l) => l.event === "sync_drain" && l.detail.drained === true),
      "the relaunch's first drain did not run to quiet").toBe(true);
    expect(count(nextLines, "first_sync_finished"), "the first import did not finish").toBe(1);
    const stored = await next.db.select({ id: messages.id }).from(messages)
      .where(eq(messages.mailboxId, next.world.mailboxId));
    expect(stored.length, "the relaunch did not bring the mailbox's mail down").toBe(N);
    expect(count(nextLines, "mailbox_relogin_cycle_failed")).toBe(0);
    expect(nextLines.filter(typeErrorIn).map((l) => l.event)).toEqual([]);
  });

  /**
   * One install; each call is an engine the shell starts: `pending` while the first door is unsaved,
   * `save` for the shell's save of it, `other` for any other start (a relaunch, a door switched in Settings).
   */
  async function install(tag: string) {
    const dataDir = await freshDataDir(`ohmail-first-door-${tag}-`);
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const keks = { 1: randomBytes(32) };
    return async (address: string, port: number, how: "pending" | "save" | "other", lines: Line[] = []): Promise<Sidecar> => {
      const s = await createSidecar({
        dataDir, address, keks, doorPending: how === "pending", doorSave: how === "save", dkimKeys: null,
        imap: { host: HOST, port, secure: false, auth: { user: address } },
        machineName: "the computer being set up",
        pollIntervalMs: 60 * 60 * 1000,
        leaseStaleAfterMs: 60_000,
        log: (event, detail) => { lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
      });
      cleanups.push(async () => { await s.stop().catch(() => undefined); });
      await s.start();
      return s;
    };
  }
  const mailboxOf = async (s: Sidecar): Promise<string[]> =>
    (await s.db.select({ id: messages.mailboxId }).from(messages)).map((r) => r.id);

  it("a first door quit after its seal leaves no password for a first door under another address", async () => {
    const [x, y, passX, passY] = [`t-${randomUUID()}@trafficflow.test`, `t-${randomUUID()}@trafficflow.test`, randomUUID(), randomUUID()];
    await seedMailbox(x, passX, 3);
    await seedMailbox(y, passY, 2);
    const boot = await install("quit");

    const first = await boot(x, PORT, "pending");
    expect((await seal(first, x, passX, PORT)).status).toBe(200);
    await first.stop();

    const second = await boot(y, PORT, "pending");
    expect(await listed(second)).toEqual([y]);
    expect(await second.db.select({ id: mailboxCredentials.mailboxId }).from(mailboxCredentials),
      "the first address's password outlived its unsaved door").toEqual([]);
    expect(await mailboxOf(second), "the first address's mail was fetched under the second door").toEqual([]);
    expect((await seal(second, y, passY, PORT)).status).toBe(200);
    await second.stop();

    const lines: Line[] = [];
    const saved = await boot(y, PORT, "save", lines);
    expect(await listed(saved)).toEqual([y]);
    expect(seen(lines, "first_sync_finished")).toBe(1);
    const stored = await mailboxOf(saved);
    expect(stored.length).toBe(2);
    expect(new Set(stored)).toEqual(new Set([saved.world.mailboxId]));
  });

  it("a first door quit after its seal leaves no password for a later start of the same address that is not its save", async () => {
    const [x, passX] = [`t-${randomUUID()}@trafficflow.test`, randomUUID()];
    await seedMailbox(x, passX, 3);
    const boot = await install("switched");

    const first = await boot(x, PORT, "pending");
    expect((await seal(first, x, passX, PORT)).status).toBe(200);
    await first.stop();

    // A door switched to this computer in Settings starts its engine before its password check.
    const lines: Line[] = [];
    const switched = await boot(x, PORT, "other", lines);
    expect(await switched.db.select({ id: mailboxCredentials.mailboxId }).from(mailboxCredentials),
      "the unsaved door's password outlived a start that was not its save").toEqual([]);
    expect(seen(lines, "first_sync_finished")).toBe(0);
    expect(await mailboxOf(switched), "the unsaved door's password fetched mail").toEqual([]);
  });

  it("a refused first door leaves no mailbox behind a first door under another address", async () => {
    const [x, y, pass] = [`t-${randomUUID()}@trafficflow.test`, `t-${randomUUID()}@trafficflow.test`, randomUUID()];
    const shut = await closedPort();
    const boot = await install("refused");

    const first = await boot(x, shut, "pending");
    expect((await seal(first, x, pass, shut)).status).not.toBe(200);
    await first.stop();

    const second = await boot(y, PORT, "pending");
    expect(await listed(second), "the refused attempt's bare row is still listed").toEqual([y]);
  });

  it("CONTROL: a refused first door, the same address again, then its save: one mailbox, synced", async () => {
    const [x, pass] = [`t-${randomUUID()}@trafficflow.test`, randomUUID()];
    await seedMailbox(x, pass, 3);
    const shut = await closedPort();
    const boot = await install("again");

    const refused = await boot(x, shut, "pending");
    expect((await seal(refused, x, pass, shut)).status).not.toBe(200);
    await refused.stop();
    const again = await boot(x, PORT, "pending");
    expect((await seal(again, x, pass, PORT)).status).toBe(200);
    await again.stop();

    const lines: Line[] = [];
    const saved = await boot(x, PORT, "save", lines);
    expect(await listed(saved)).toEqual([x]);
    expect(saved.world.mailboxId).toBe(again.world.mailboxId);
    expect(seen(lines, "first_sync_finished")).toBe(1);
    expect((await mailboxOf(saved)).length).toBe(3);
  });
});

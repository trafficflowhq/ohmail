import { rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { messages } from "@trafficflow/db";
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
});

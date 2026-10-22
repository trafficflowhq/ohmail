/**
 * A PHONE SEND WHOSE OUTGOING SERVER SAYS "NOT NOW" ONCE GOES ON THE FIRST PRESS. The real phone
 * engine (`_phone-offline-rig.ts`) with the app's own client composed over its door, as the
 * standalone door composes it, and an outgoing server that answers the send's first AUTH 454. The
 * press waits out the server's named wait queued under its key; the reconnect flush replays that
 * key and the engine re-arms the one reservation: one delivery, one draft row. Cancel during the
 * wait withdraws the key in the engine's store and nothing is ever delivered. Before: the first
 * answer said not retryable, and the press ended "Not sent" for the person to press again.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlExecutor, SqlRow, SqlValue } from "@ohmail/client-engine";
import {
  Cable, EXPECTED_DIALECT, HOST, ON_DEVICE_STORE, PORT, SmtpSink,
  bootPhone, cables, dirs, eventsSince, open, post, seedMailboxId, type Phone,
} from "./_phone-offline-rig.js";
import { serviceUp } from "@trafficflow/db/testing";
import { bootEngine, LOCAL_ENGINE_ORIGIN } from "../../mobile/src/engine/boot.js";
import { installNetworkReader, networkNow } from "../../mobile/src/net/network-door.js";
import { flushQueued, liveActions } from "../../mobile/src/state/live.js";
import { sayArg } from "../../mobile/src/refusal.js";
import { Copy } from "../../mobile/src/copy.js";

/** The run's one probe (test/setup/services.global.ts), at the address this file dials. */
const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function mirrorExecutor(file: string): SqlExecutor & { close(): void } {
  const db = new sqlite.DatabaseSync(file);
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
    close: () => { try { db.close(); } catch { /* already closed */ } },
  };
}

const sinks: SmtpSink[] = [];
afterEach(async () => {
  installNetworkReader(null);
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (cables.length > 0) await cables.pop()!.close();
  while (sinks.length > 0) await sinks.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function appOver(phone: Phone) {
  const uuid = (): string => randomUUID();
  const mirrors: Array<{ close(): void }> = [];
  const boot = await bootEngine(
    { openExecutor: () => { const m = mirrorExecutor(":memory:"); mirrors.push(m); return m; }, deleteDatabase: async () => undefined, uuid },
    { origin: LOCAL_ENGINE_ORIGIN, accountId: phone.engine.accountId, localEngine: phone.engine, network: networkNow },
  );
  if (boot.kind !== "ready") throw new Error("the app's client did not boot over the engine's door");
  await boot.engine.start();
  const toasts: string[] = [];
  const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
  const close = (): void => { boot.store.close(); for (const m of mirrors) m.close(); };
  return { boot, actions, toasts, close };
}

/** An outgoing server whose n-th AUTH answers "not now"; the launch's own AUTH is the first. */
async function phoneWithSink(notNowAt: number): Promise<{ phone: Phone; sink: SmtpSink }> {
  let auths = 0;
  const sink = new SmtpSink({
    auth: () => (++auths === notNowAt
      ? { ok: false, afterMs: 0, line: "454 4.7.0 Temporary authentication failure" }
      : { ok: true, afterMs: 0 }),
  });
  await sink.open();
  sinks.push(sink);
  const user = `sender-${randomUUID()}@trafficflow.test`;
  const imap = new Cable("reset");
  await imap.open();
  cables.push(imap);
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-rearm-"));
  dirs.push(dir);
  const phone = await bootPhone({ user, file: join(dir, "engine.db"), cable: imap, smtp: sink });
  expect(await post(phone, `/local/mailboxes/${seedMailboxId(phone)}/organize`)).toBe(200);
  return { phone, sink };
}

/** The server's named wait, waited out as the engine waits it out. */
const theServersWait = (): Promise<void> => new Promise((r) => setTimeout(r, 2_300));

async function sendsIn(p: Phone): Promise<string[]> {
  const r = await p.exec.all("select status from outbound_sends", []);
  return r.rows.map((row) => String(row[0]));
}

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE && !SERVER_UP)("the mail server this file measures against", () => {
  it(`is NOT answering on ${HOST}:${PORT} — the cases below measured nothing in this run`, () => {
    expect(SERVER_UP, "the probe says the server answers, so the cases should have RUN").toBe(false);
  });
});

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("a phone send whose outgoing server says 'not now' once", () => {
  it("waits out the server's wait under its key, then goes once", async () => {
    const { phone, sink } = await phoneWithSink(2);
    const app = await appOver(phone);
    const subject = `not now ${randomUUID()}`;
    const res = await app.actions.sendNew(seedMailboxId(phone), [{ name: "R", address: "r@trafficflow.test" }], subject, "Hello.");
    expect(res.outcome, `the press did not wait — events ${eventsSince(phone, 0)}`).toBe("queued");
    expect(app.toasts).toEqual([Copy.replyQueued]);
    expect(sink.messages).toBe(0);
    expect(await sendsIn(phone)).toEqual(["failed"]);

    await theServersWait();
    const settled = await flushQueued(app.boot.engine, app.actions.releaseConfirmed);
    expect(settled.get(res.key!)?.status, `the replay did not go — events ${eventsSince(phone, 0)}`).toBe("confirmed");
    expect(sink.messages, "not exactly one delivery").toBe(1);
    expect(await sendsIn(phone)).toEqual(["sent"]);
    const drafts = await phone.exec.all("select id from drafts where subject = ?", [subject]);
    expect(drafts.rows, "the replay wrote a second row").toHaveLength(1);
    app.close();
  }, 120_000);

  it("Cancel during the wait withdraws the key, and nothing is ever delivered", async () => {
    const { phone, sink } = await phoneWithSink(2);
    const app = await appOver(phone);
    const res = await app.actions.sendNew(seedMailboxId(phone), [{ name: "R", address: "r@trafficflow.test" }], `cancelled ${randomUUID()}`, "Hello.");
    expect(res.outcome).toBe("queued");
    expect(await app.actions.withdrawSend(res.key!)).toBe("withdrawn");
    expect(await sendsIn(phone)).toEqual(["withdrawn"]);
    await theServersWait();
    await flushQueued(app.boot.engine, app.actions.releaseConfirmed);
    expect(sink.messages).toBe(0);
    app.close();
  }, 120_000);
});

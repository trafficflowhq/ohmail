/**
 * A SEND PRESSED WHILE THE PHONE IS OFFLINE WAITS, AND GOES ONCE WHEN THE NETWORK IS BACK.
 *
 * The real phone engine (the rig in `_phone-offline-rig.ts`, IMAP and SMTP through cables this file
 * cuts) with the app's own client composed over its door exactly as the standalone door does it
 * (`bootEngine` with the engine as `localEngine` and the network door as `network`). Measured on
 * the base: the offline press reached the engine and failed at the mail server, and a press again
 * wrote another draft. The verdicts are the engine's store and the recipient's mailbox.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlExecutor, SqlRow, SqlValue } from "@ohmail/client-engine";
import {
  Cable, EXPECTED_DIALECT, HOST, ON_DEVICE_STORE, PORT, SMTP_PORT,
  bootPhone, cables, deliver, dirs, eventsSince, open, post, seedMailboxId, untilIngested, withServer, type Phone,
} from "./_phone-offline-rig.js";
import { serviceUp } from "@trafficflow/db/testing";
import { bootEngine, LOCAL_ENGINE_ORIGIN } from "../../mobile/src/engine/boot.js";
import { installNetworkReader, networkNow, type NetworkReader } from "../../mobile/src/net/network-door.js";
import { flushQueued, liveActions } from "../../mobile/src/state/live.js";
import { sayArg } from "../../mobile/src/refusal.js";
import { Copy } from "../../mobile/src/copy.js";

/** The run's one probe (test/setup/services.global.ts), at the address this file dials. */
const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** The app's mirror, in memory — `node:sqlite` behind the client engine's statement-runner contract. */
function mirrorExecutor(): SqlExecutor {
  const db = new sqlite.DatabaseSync(":memory:");
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
}

afterEach(async () => {
  installNetworkReader(null);
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (cables.length > 0) await cables.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The platform's reader, turned by hand, and the two cables it stands for. */
function network(imap: Cable, smtp: Cable): { reader: NetworkReader; set(s: "online" | "offline"): void } {
  let state: "online" | "offline" = "online";
  const listeners = new Set<(r: unknown) => void>();
  return {
    reader: { read: () => state, subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; } },
    set(s) {
      if (s === "offline") { imap.cut(); smtp.cut(); } else { imap.mend(); smtp.mend(); }
      state = s;
      for (const l of [...listeners]) l(s);
    },
  };
}

/** Rows the engine's own store holds as drafts with this subject. */
async function draftsIn(p: Phone, subject: string): Promise<number> {
  const r = await p.exec.all("select count(*) from drafts where subject = ?", [subject]);
  return Number(r.rows[0]?.[0] ?? 0);
}

/** The text of every letter with this subject in the recipient's INBOX. */
async function bodiesOf(recipient: string, subject: string): Promise<string[]> {
  return withServer(recipient, async (c) => {
    const lock = await c.getMailboxLock("INBOX");
    try {
      const hits = await c.search({ header: { subject } }, { uid: true });
      const out: string[] = [];
      for (const uid of Array.isArray(hits) ? hits : []) {
        const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
        if (m && m.source) out.push(m.source.toString("utf8"));
      }
      return out;
    } finally { lock.release(); }
  });
}

/** Copies of the letter in the recipient's INBOX, read by a client the engine knows nothing about. */
async function delivered(recipient: string, subject: string): Promise<number> {
  return withServer(recipient, async (c) => {
    const lock = await c.getMailboxLock("INBOX");
    try {
      const hits = await c.search({ header: { subject } }, { uid: true });
      return Array.isArray(hits) ? hits.length : 0;
    } finally { lock.release(); }
  });
}

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE && !SERVER_UP)("the mail server this file measures against", () => {
  it(`is NOT answering on ${HOST}:${PORT} — the case below measured nothing in this run`, () => {
    expect(SERVER_UP, "the probe says the server answers, so the case should have RUN").toBe(false);
  });
});

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("a send pressed while the phone is offline", () => {
  it("waits with its one draft, says so, and is delivered once when the network is back", async () => {
    const user = `sender-${randomUUID()}@trafficflow.test`;
    const recipient = `recipient-${randomUUID()}@trafficflow.test`;
    const imap = new Cable("reset");
    const smtp = new Cable("reset", { host: HOST, port: SMTP_PORT });
    await imap.open();
    await smtp.open();
    cables.push(imap, smtp);
    const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-send-"));
    dirs.push(dir);
    const phone = await bootPhone({ user, file: join(dir, "engine.db"), cable: imap, smtp });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    const net = network(imap, smtp);
    installNetworkReader(net.reader);

    let n = 0;
    const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const boot = await bootEngine(
      { openExecutor: () => mirrorExecutor(), deleteDatabase: async () => undefined, uuid },
      { origin: LOCAL_ENGINE_ORIGIN, accountId: phone.engine.accountId, localEngine: phone.engine, network: networkNow },
    );
    if (boot.kind !== "ready") throw new Error("the app's client did not boot over the engine's door");
    await boot.engine.start();
    const toasts: string[] = [];
    const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });

    net.set("offline");
    const subject = `written offline ${randomUUID()}`;
    const res = await actions.sendNew(mailboxId, [{ name: "R", address: recipient }], subject, "On a train.");
    expect(res.outcome, `the offline press did not wait — events ${eventsSince(phone, 0)}`).toBe("queued");
    expect(toasts).toContain(Copy.replyQueuedOffline);
    expect(boot.engine.pendingMutations()).toHaveLength(1);
    expect(await draftsIn(phone, subject), "the words are not in exactly one draft in the engine's store").toBe(1);

    net.set("online");
    const settled = await flushQueued(boot.engine, actions.releaseConfirmed);
    expect(settled.get(res.key!)?.status, `the waiting send did not go on the return — events ${eventsSince(phone, 0)}`)
      .toBe("confirmed");
    expect(await delivered(recipient, subject), "not exactly one copy reached the recipient").toBe(1);
    expect(await draftsIn(phone, subject), "not exactly one draft row for one message").toBe(1);
    expect(boot.engine.pendingMutations()).toHaveLength(0);
    boot.store.close();
  }, 300_000);

  it("REPRESS-OFFLINE-REPLY-SENDS-THE-EARLIER-WORDS: a reply pressed offline, edited and pressed again offline, goes once with the later words", async () => {
    const user = `sender-${randomUUID()}@trafficflow.test`;
    const recipient = `ada-${randomUUID()}@trafficflow.test`;
    const imap = new Cable("reset");
    const smtp = new Cable("reset", { host: HOST, port: SMTP_PORT });
    await imap.open();
    await smtp.open();
    cables.push(imap, smtp);
    const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-repress-"));
    dirs.push(dir);
    const phone = await bootPhone({ user, file: join(dir, "engine.db"), cable: imap, smtp });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    const net = network(imap, smtp);
    installNetworkReader(net.reader);
    const subject = `the invoice ${randomUUID()}`;
    await deliver(user, recipient, subject);
    expect(await untilIngested(phone, subject, 60_000), "the letter never reached the engine").not.toBeNull();

    let n = 0;
    const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const boot = await bootEngine(
      { openExecutor: () => mirrorExecutor(), deleteDatabase: async () => undefined, uuid },
      { origin: LOCAL_ENGINE_ORIGIN, accountId: phone.engine.accountId, localEngine: phone.engine, network: networkNow },
    );
    if (boot.kind !== "ready") throw new Error("the app's client did not boot over the engine's door");
    await boot.engine.start();
    const parent = boot.engine.read().list<{ id: string; subject?: string }>("message").find((m) => m.subject === subject);
    expect(parent, "the app's mirror does not hold the letter").toBeDefined();
    const actions = liveActions({ engine: boot.engine, toast: () => {}, uuid, zone: "UTC" });

    net.set("offline");
    expect((await actions.sendReply(parent!.id, "Words A, the first draft.", false)).outcome).toBe("queued");
    expect((await actions.sendReply(parent!.id, "Words B, the edit.", false)).outcome).toBe("queued");
    net.set("online");
    await flushQueued(boot.engine, actions.releaseConfirmed);
    await flushQueued(boot.engine, actions.releaseConfirmed);
    const got = await bodiesOf(recipient, `Re: ${subject}`);
    expect({ copies: got.length, latest: got.some((b) => b.includes("Words B, the edit.")), earlier: got.some((b) => b.includes("Words A")) },
      `the earlier words went, or twice — events ${eventsSince(phone, 0)}`).toEqual({ copies: 1, latest: true, earlier: false });
    boot.store.close();
  }, 300_000);
});


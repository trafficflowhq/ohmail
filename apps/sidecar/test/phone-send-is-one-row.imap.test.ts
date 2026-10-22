/**
 * ONE LETTER IS ONE ROW, WHATEVER THE SEND'S ANSWER AND HOWEVER LATE IT COMES — the real phone
 * engine (`_phone-offline-rig.ts`) with the app's own client composed over its door, as the
 * standalone door composes it. The outgoing server is a sink this file scripts (a refused AUTH,
 * a slow one, a slow end of DATA) or the lane GreenMail through a cable; the verdicts are the
 * engine's own store, the ledger the composer reads, and what reached the server.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlExecutor, SqlRow, SqlValue } from "@ohmail/client-engine";
import {
  Cable, EXPECTED_DIALECT, HOST, ON_DEVICE_STORE, PORT, SMTP_PORT, SmtpSink,
  bootPhone, cables, deliver, dirs, eventsSince, open, post, relaunch, seedMailboxId, untilIngested, withServer, type Phone,
} from "./_phone-offline-rig.js";
import { serviceUp } from "@trafficflow/db/testing";
import { bootEngine, LOCAL_ENGINE_ORIGIN } from "../../mobile/src/engine/boot.js";
import { installNetworkReader, networkNow, type NetworkReader } from "../../mobile/src/net/network-door.js";
import { answersWaiting, flushQueued, liveActions } from "../../mobile/src/state/live.js";
import { sayArg } from "../../mobile/src/refusal.js";
import { Copy } from "../../mobile/src/copy.js";

/** The run's one probe (test/setup/services.global.ts), at the address this file dials. */
const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** The app's mirror in a FILE, so a relaunched app opens the outbox the killed one left. */
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

function network(cuts: Cable[]): { reader: NetworkReader; set(s: "online" | "offline"): void } {
  let state: "online" | "offline" = "online";
  const listeners = new Set<(r: unknown) => void>();
  return {
    reader: { read: () => state, subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; } },
    set(s) {
      for (const c of cuts) { if (s === "offline") c.cut(); else c.mend(); }
      state = s;
      for (const l of [...listeners]) l(s);
    },
  };
}

async function draftsIn(p: Phone, subject: string): Promise<{ n: number; ids: string[] }> {
  const r = await p.exec.all("select id from drafts where subject = ?", [subject]);
  return { n: r.rows.length, ids: r.rows.map((row) => String(row[0])) };
}

async function delivered(recipient: string, subject: string): Promise<number> {
  return withServer(recipient, async (c) => {
    const lock = await c.getMailboxLock("INBOX");
    try {
      const hits = await c.search({ header: { subject } }, { uid: true });
      return Array.isArray(hits) ? hits.length : 0;
    } finally { lock.release(); }
  });
}

/** The app's client over the phone engine's door, on a mirror file. */
async function appOver(phone: Phone, mirrorFile: string) {
  const uuid = (): string => randomUUID();
  const mirrors: Array<{ close(): void }> = [];
  const boot = await bootEngine(
    { openExecutor: () => { const m = mirrorExecutor(mirrorFile); mirrors.push(m); return m; }, deleteDatabase: async () => undefined, uuid },
    { origin: LOCAL_ENGINE_ORIGIN, accountId: phone.engine.accountId, localEngine: phone.engine, network: networkNow },
  );
  if (boot.kind !== "ready") throw new Error("the app's client did not boot over the engine's door");
  await boot.engine.start();
  const toasts: string[] = [];
  const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC" });
  const close = (): void => { boot.store.close(); for (const m of mirrors) m.close(); };
  return { boot, actions, toasts, close };
}

/** Once the app's engine holds an answer nobody collected — its own notification, never a clock. */
function lateAnswer(engine: Parameters<typeof answersWaiting>[0]): Promise<true> {
  return new Promise((resolve) => {
    if (answersWaiting(engine)) { resolve(true); return; }
    const off = engine.subscribe(() => { if (answersWaiting(engine)) { off(); resolve(true); } });
  });
}

async function organizedPhone(opts: { smtp: { port: number } }): Promise<{ phone: Phone; imap: Cable; dir: string; user: string }> {
  const user = `sender-${randomUUID()}@trafficflow.test`;
  const imap = new Cable("reset");
  await imap.open();
  cables.push(imap);
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-one-row-"));
  dirs.push(dir);
  const phone = await bootPhone({ user, file: join(dir, "engine.db"), cable: imap, smtp: opts.smtp });
  expect(await post(phone, `/local/mailboxes/${seedMailboxId(phone)}/organize`)).toBe(200);
  return { phone, imap, dir, user };
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

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("a phone send is one row", () => {
  it("a send waiting for the network, the app killed and relaunched: one draft, one delivery", async () => {
    const smtp = new Cable("reset", { host: HOST, port: SMTP_PORT });
    await smtp.open();
    cables.push(smtp);
    const { phone, imap, dir } = await organizedPhone({ smtp });
    const net = network([imap, smtp]);
    installNetworkReader(net.reader);
    const mirrorFile = join(dir, "mirror.db");
    const first = await appOver(phone, mirrorFile);
    const recipient = `recipient-${randomUUID()}@trafficflow.test`;
    const subject = `relaunched ${randomUUID()}`;

    net.set("offline");
    const res = await first.actions.sendNew(seedMailboxId(phone), [{ name: "R", address: recipient }], subject, "On a train.");
    expect(res.outcome, `the offline press did not wait — events ${eventsSince(phone, 0)}`).toBe("queued");
    expect((await draftsIn(phone, subject)).n).toBe(1);

    // The app is killed while the send waits: its client and the engine go, the files stay.
    first.close();
    await phone.engine.stop();
    const again = await relaunch(phone);
    const second = await appOver(again, mirrorFile);
    expect(second.boot.engine.pendingMutations(), "the relaunch did not restore the waiting send").toHaveLength(1);

    net.set("online");
    const settled = await flushQueued(second.boot.engine, second.actions.releaseConfirmed);
    expect(settled.get(res.key!)?.status, `the restored send did not go — events ${eventsSince(again, 0)}`).toBe("confirmed");
    expect(await delivered(recipient, subject), "not exactly one copy reached the recipient").toBe(1);
    expect((await draftsIn(again, subject)).n, "the restored send wrote a second draft").toBe(1);
    second.close();
  }, 300_000);

  it("an AUTH refused after the engine stopped waiting reaches the ledger as that refusal, with its row", async () => {
    let stallMs = 11_000;
    let auths = 0;
    // The launch dials the outgoing server once and is admitted; every send's AUTH is refused.
    const sink = new SmtpSink({ auth: () => (++auths === 1 ? { ok: true, afterMs: 0 } : { ok: false, afterMs: stallMs }) });
    await sink.open();
    sinks.push(sink);
    const { phone } = await organizedPhone({ smtp: sink });
    const app = await appOver(phone, ":memory:");
    const subject = `refused late ${randomUUID()}`;

    const res = await app.actions.sendNew(seedMailboxId(phone), [{ name: "R", address: "r@trafficflow.test" }], subject, "Hello.");
    expect(res.outcome, "the engine answered before its deadline; nothing here is late").toBe("queued");
    expect(app.toasts).toEqual([Copy.replyQueued]);
    expect(await lateAnswer(app.boot.engine), `no late answer — events ${eventsSince(phone, 0)}`).toBe(true);
    stallMs = 0;
    const settled = await flushQueued(app.boot.engine, app.actions.releaseConfirmed);
    const rows = await draftsIn(phone, subject);
    expect(rows.n).toBe(1);
    expect(settled.get(res.key!)).toMatchObject({
      status: "rolled_back", kind: "mail_send", failure: "replyLoginRefused", draftId: rows.ids[0],
    });

    // The composer binds that row: the next press is the same letter, never a second row.
    const again = await app.actions.sendNew(seedMailboxId(phone), [{ name: "R", address: "r@trafficflow.test" }], subject, "Hello again.", null, null, [], rows.ids[0]);
    expect(again).toMatchObject({ outcome: "failed", failure: "replyLoginRefused" });
    expect((await draftsIn(phone, subject)).n, "the press after a late refusal wrote a second row").toBe(1);
    expect(sink.messages).toBe(0);
    app.close();
  }, 300_000);

  it("a send the server accepted past its attempt ceiling is reported accepted, and is handed over once", async () => {
    let dataAfterMs = 26_000;
    const sink = new SmtpSink({ auth: () => ({ ok: true, afterMs: 0 }), dataAfterMs: () => dataAfterMs });
    await sink.open();
    sinks.push(sink);
    const { phone } = await organizedPhone({ smtp: sink });
    const app = await appOver(phone, ":memory:");
    const subject = `accepted ${randomUUID()}`;

    const res = await app.actions.sendNew(seedMailboxId(phone), [{ name: "R", address: "r@trafficflow.test" }], subject, "Slow server.");
    expect(res.outcome).toBe("queued");
    expect(await lateAnswer(app.boot.engine), `no late answer — events ${eventsSince(phone, 0)}`).toBe(true);
    dataAfterMs = 0;
    const accepted: string[] = [];
    const settled = await flushQueued(app.boot.engine, app.actions.releaseConfirmed, (key) => accepted.push(key));
    expect(accepted, "the server's 202 did not reach the ledger as an acceptance").toContain(res.key);
    expect(settled.get(res.key!)?.status ?? "not terminal").not.toBe("rolled_back");
    await sink.dataAnswered;
    await flushQueued(app.boot.engine, app.actions.releaseConfirmed);
    expect(sink.messages, "the accepted send was handed to the server more than once").toBe(1);
    expect((await draftsIn(phone, subject)).n).toBe(1);
    app.close();
  }, 300_000);

  it("REPRESS-OFFLINE-REPLY-SENDS-THE-EARLIER-WORDS: a reply whose first send outlived the engine's wait, edited and pressed again offline, goes once and is said truly", async () => {
    let dataAfterMs = 26_000;
    const sink = new SmtpSink({ auth: () => ({ ok: true, afterMs: 0 }), dataAfterMs: () => dataAfterMs });
    await sink.open();
    sinks.push(sink);
    const { phone, imap, user } = await organizedPhone({ smtp: sink });
    const subject = `the invoice ${randomUUID()}`;
    await deliver(user, "ada@stranger.example", subject);
    expect(await untilIngested(phone, subject, 60_000), "the letter never reached the engine").not.toBeNull();
    const app = await appOver(phone, ":memory:");
    const parent = app.boot.engine.read().list<{ id: string; subject?: string }>("message").find((m) => m.subject === subject);
    expect(parent, "the app's mirror does not hold the letter").toBeDefined();
    const net = network([imap]);
    installNetworkReader(net.reader);

    const a = await app.actions.sendReply(parent!.id, "Words A, the first draft.", false);
    expect(a.outcome, "premise: the first send outlived the engine's wait").toBe("queued");
    net.set("offline");
    const b = await app.actions.sendReply(parent!.id, "Words B, the edit.", false);
    expect(b.outcome).toBe("queued");
    dataAfterMs = 0;
    await sink.dataAnswered;
    net.set("online");
    const going: string[] = [];
    const settled = await flushQueued(app.boot.engine, app.actions.releaseConfirmed, undefined, (key) => going.push(key));
    await flushQueued(app.boot.engine, app.actions.releaseConfirmed, undefined, (key) => going.push(key));
    const went = sink.bodies.map((d) => (d.includes("Words B") ? "B" : d.includes("Words A") ? "A" : "?"));
    const said = [...app.toasts, ...[...settled.values()].map((o) => (o.earlierWent ? "earlierWent" : o.status)), ...going.map(() => "earlierGoing")];
    // ONE delivery; and it carries B, or what is said is that the earlier version went.
    expect({ copies: sink.messages, truthful: went[0] === "B" || said.includes("earlierWent") || said.includes("earlierGoing") },
      `went ${JSON.stringify(went)}, said ${JSON.stringify(said)} — events ${eventsSince(phone, 0)}`).toEqual({ copies: 1, truthful: true });
    app.close();
  }, 300_000);

  it("the same, pressed again offline after the server ACCEPTED the first: the press itself says the earlier version is going", async () => {
    let dataAfterMs = 26_000;
    const sink = new SmtpSink({ auth: () => ({ ok: true, afterMs: 0 }), dataAfterMs: () => dataAfterMs });
    await sink.open();
    sinks.push(sink);
    const { phone, imap, user } = await organizedPhone({ smtp: sink });
    const subject = `the invoice ${randomUUID()}`;
    await deliver(user, "ada@stranger.example", subject);
    expect(await untilIngested(phone, subject, 60_000), "the letter never reached the engine").not.toBeNull();
    const app = await appOver(phone, ":memory:");
    const parent = app.boot.engine.read().list<{ id: string; subject?: string }>("message").find((m) => m.subject === subject);
    const net = network([imap]);
    installNetworkReader(net.reader);
    expect((await app.actions.sendReply(parent!.id, "Words A, the first draft.", false)).outcome).toBe("queued");
    expect(await lateAnswer(app.boot.engine)).toBe(true);
    const accepted: string[] = [];
    await flushQueued(app.boot.engine, app.actions.releaseConfirmed, (key) => accepted.push(key));
    expect(accepted.length, "premise: the server accepted the first send").toBe(1);
    net.set("offline");
    expect((await app.actions.sendReply(parent!.id, "Words B, the edit.", false)).outcome).toBe("queued");
    expect(app.toasts.at(-1), "the edited press was told its words would go").toBe(Copy.earlierGoing);
    dataAfterMs = 0;
    await sink.dataAnswered;
    net.set("online");
    app.close();
  }, 300_000);
});


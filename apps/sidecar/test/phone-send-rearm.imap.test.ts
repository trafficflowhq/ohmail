/**
 * A PHONE SEND WHOSE OUTGOING SERVER SAYS "NOT NOW" ONCE GOES ON THE FIRST PRESS. The real phone
 * engine (`_phone-offline-rig.ts`) with the app's own client composed over its door, as the
 * standalone door composes it, and an outgoing server that answers the send's first AUTH 454. The
 * press waits out the server's named wait queued under its key; the reconnect flush replays that
 * key and the engine re-arms the one reservation: one delivery, one draft row. Cancel during the
 * wait withdraws the key in the engine's store and nothing is ever delivered. Before: the first
 * answer said not retryable, and the press ended "Not sent" for the person to press again.
 *
 * And a photo letter on a slow link whose answer never came back: Send again looks in Sent first,
 * goes under the same Message-ID with the photo, and never twice for one press.
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
  bootPhone, cables, dirs, eventsSince, open, post, relaunch, seedMailboxId, withServer, type Phone,
} from "./_phone-offline-rig.js";
import type { LetterDoor } from "../../mobile/src/compose/letter-store.js";
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

async function appOver(phone: Phone, kept: Map<string, typeof PHOTO[]> = new Map()) {
  const uuid = (): string => randomUUID();
  const mirrors: Array<{ close(): void }> = [];
  const boot = await bootEngine(
    { openExecutor: () => { const m = mirrorExecutor(":memory:"); mirrors.push(m); return m; }, deleteDatabase: async () => undefined, uuid },
    { origin: LOCAL_ENGINE_ORIGIN, accountId: phone.engine.accountId, localEngine: phone.engine, network: networkNow },
  );
  if (boot.kind !== "ready") throw new Error("the app's client did not boot over the engine's door");
  await boot.engine.start();
  const toasts: string[] = [];
  /* The files this phone keeps with a draft: what Send again carries. */
  const letters = { filesOf: (id: string) => kept.get(id) ?? [], letterOf: () => undefined, drop: () => undefined } as unknown as LetterDoor;
  const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC", letters });
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

/** The photo letter: one 684 KB picture. */
const PHOTO = { filename: "photo.jpg", contentType: "image/jpeg", contentBase64: Buffer.alloc(684 * 1024, 0x5a).toString("base64") };

/**
 * A phone on a slow link (SMTP at 1 MB/s through a cable) to an outgoing server that ends each
 * message as scripted: `taken` answers 250, `lost` takes it and drops before the 250, `dropped`
 * drops at DATA, so nothing is taken.
 */
async function slowPhone(ends: Array<"taken" | "lost" | "dropped">) {
  let at = 0;
  const sink = new SmtpSink({
    auth: () => ({ ok: true, afterMs: 0 }),
    dropInData: () => (ends[at] === "dropped" ? (at += 1, true) : false),
    dataEnd: () => (ends[at++] === "lost" ? "drop" : "answer"),
  });
  await sink.open();
  sinks.push(sink);
  const smtp = new Cable("reset", { host: "127.0.0.1", port: sink.port }, 1_000_000);
  await smtp.open();
  cables.push(smtp);
  const user = `photo-${randomUUID()}@trafficflow.test`;
  const imap = new Cable("reset");
  await imap.open();
  cables.push(imap);
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-again-"));
  dirs.push(dir);
  const phone = await bootPhone({ user, file: join(dir, "engine.db"), cable: imap, smtp: { port: smtp.port } });
  expect(await post(phone, `/local/mailboxes/${seedMailboxId(phone)}/organize`)).toBe(200);
  return { phone, sink, user };
}

const R = [{ name: "R", address: "r@trafficflow.test" }];
const idOf = (data: string): string | undefined => /^Message-ID:\s*(\S+)/im.exec(data)?.[1];

/** A press of the photo letter whose answer was lost: held, with its row named. */
async function heldPhoto(p: { phone: Phone }, app: Awaited<ReturnType<typeof appOver>>, subject: string): Promise<string> {
  const res = await app.actions.sendNew(seedMailboxId(p.phone), R, subject, "The photo.", null, null, [PHOTO]);
  expect(res.outcome, `the lost answer did not hold it — events ${eventsSince(p.phone, 0)}`).toBe("unverified");
  await app.boot.engine.syncOnce();
  return res.draftId!;
}

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("Send again of a photo letter whose answer was lost", () => {
  it("found in Sent, as a provider files it: Send again takes nothing more", async () => {
    const slow = await slowPhone(["lost"]);
    const kept = new Map<string, typeof PHOTO[]>();
    const app = await appOver(slow.phone, kept);
    const subject = `filed ${randomUUID()}`;
    const draftId = await heldPhoto(slow, app, subject);
    expect(slow.sink.messages).toBe(1);
    const raw = [`Message-ID: ${idOf(slow.sink.bodies[0]!)}`, `Subject: ${subject}`, "From: me@trafficflow.test", "", "The photo.", ""].join("\r\n");
    await withServer(slow.user, async (c) => { await c.mailboxCreate("Sent").catch(() => undefined); await c.append("Sent", Buffer.from(raw)); });
    kept.set(draftId, [PHOTO]);
    expect(await app.actions.draftSendAgain(draftId)).toBe("alreadySent");
    expect(slow.sink.messages, "a second copy went").toBe(1);
    app.close();
  }, 120_000);

  it("not in Sent: two taken, one Message-ID, the second with the photo; a relaunch sends nothing more", async () => {
    const slow = await slowPhone(["lost", "taken"]);
    const kept = new Map<string, typeof PHOTO[]>();
    const app = await appOver(slow.phone, kept);
    const draftId = await heldPhoto(slow, app, `again ${randomUUID()}`);
    kept.set(draftId, [PHOTO]);
    expect(await app.actions.draftSendAgain(draftId), `events ${eventsSince(slow.phone, 0)}`).toBe("sent");
    expect(slow.sink.messages).toBe(2);
    expect(idOf(slow.sink.bodies[1]!)).toBe(idOf(slow.sink.bodies[0]!));
    expect(slow.sink.bodies[1]!).toContain("photo.jpg");
    expect((await sendsIn(slow.phone)).sort()).toEqual(["sent", "unverified"]);
    app.close();
    await slow.phone.engine.stop();
    const again = await relaunch(slow.phone);
    const next = await appOver(again, kept);
    await flushQueued(next.boot.engine, next.actions.releaseConfirmed);
    await next.boot.engine.syncOnce();
    expect(slow.sink.messages, "the relaunch sent it again").toBe(2);
    next.close();
  }, 120_000);

  it("never taken: the press is a known not-sent, and its press again takes exactly one, with the photo", async () => {
    const slow = await slowPhone(["dropped", "taken"]);
    const app = await appOver(slow.phone);
    const subject = `dropped ${randomUUID()}`;
    const first = await app.actions.sendNew(seedMailboxId(slow.phone), R, subject, "The photo.", null, null, [PHOTO]);
    expect(first.outcome, `events ${eventsSince(slow.phone, 0)}`).toBe("failed");
    expect(slow.sink.messages).toBe(0);
    const second = await app.actions.sendNew(seedMailboxId(slow.phone), R, subject, "The photo.", null, null, [PHOTO], first.draftId ?? null);
    expect(second.outcome).toBe("sent");
    expect(slow.sink.messages).toBe(1);
    expect(slow.sink.bodies[0]!).toContain("photo.jpg");
    app.close();
  }, 120_000);

  it("its kept files gone: Send again is refused and takes nothing", async () => {
    const slow = await slowPhone(["lost", "taken"]);
    const app = await appOver(slow.phone);
    const draftId = await heldPhoto(slow, app, `no files ${randomUUID()}`);
    expect(await app.actions.draftSendAgain(draftId)).toBe("changed");
    expect(slow.sink.messages).toBe(1);
    app.close();
  }, 120_000);
});

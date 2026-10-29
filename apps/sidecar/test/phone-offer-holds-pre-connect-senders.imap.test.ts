/**
 * MAIL ALREADY IN THE INBOX WHEN A PHONE CONNECTS STAYS WHERE IT IS, AND THE OFFER HOLDS ITS SENDERS.
 * `startPhoneEngine` over `node:sqlite` against a real IMAP server, in the rig corpus's shape: the
 * account wrote to Mara before the connect, and her letter and a stranger's arrived before it too.
 * Nothing moves until the Ohbox's offer is pressed; the offer names both, and its press puts both
 * letters in the Screener on the server. Runs under the sqlite project; the default one states the premise.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startPhoneEngine } from "../src/mobile.js";
import {
  EXPECTED_DIALECT, HOST, ON_DEVICE_STORE, PASS, PORT, SMTP_PORT,
  deliver, dialectSeam, dirs, folderOnServer, nodeExecutor, open, post, rowOf, seedMailboxId, withServer, type Line, type Phone,
} from "./_phone-offline-rig.js";
import { serviceUp } from "@trafficflow/db/testing";
import { rigAppendDates } from "../../../test/support/rig-append-date.js";
import { createRequire } from "node:module";
import type { SqlExecutor, SqlRow, SqlValue } from "@ohmail/client-engine";
import { bootEngine, LOCAL_ENGINE_ORIGIN, localEngineTransport, type MobileEngineDeps } from "../../mobile/src/engine/boot.js";
import { confirmSeed, readFoldersEnabled, readSeedReview } from "../../mobile/src/net/consent.js";
import { readMailboxes } from "../../mobile/src/net/mailboxes.js";
import { seedStage, worldSeedOf, type SeedFacts } from "../../mobile/src/state/seed-offer.js";
import { SCREENING_UNSUPPLIED, liveOhbox, presentedWorld } from "../../mobile/src/state/live.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** The app's mirror over `node:sqlite`, in its own directory. */
function appMirror(): MobileEngineDeps {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-seed-mirror-"));
  dirs.push(dir);
  return {
    openExecutor: (name: string): SqlExecutor => {
      const db = new sqlite.DatabaseSync(join(dir, `${name.replace(/[^A-Za-z0-9.-]/g, "_")}.db`));
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

/** The run's one probe (test/setup/services.global.ts), at the address this file dials. */
const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const MIN = 60_000;

async function bootPhone(user: string): Promise<Phone> {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-pre-connect-"));
  dirs.push(dir);
  const file = join(dir, "engine.db");
  const lines: Line[] = [];
  const exec = dialectSeam(nodeExecutor(file));
  const engine = await startPhoneEngine({
    exec,
    imap: { host: HOST, port: PORT, secure: false, auth: { user, pass: PASS }, smtp: { host: HOST, port: SMTP_PORT, secure: false } },
    address: user,
    machineName: "the phone with an old Inbox",
    installId: `install-${randomUUID()}`,
    keks: { 1: "d".repeat(64) },
    log: (event, detail) => { lines.push({ event, detail }); },
  });
  open.push(engine);
  return { engine, lines, exec, installId: "", file };
}

/** One message APPENDed as the rig seeds it: its own INTERNALDATE, read already. */
async function put(user: string, folder: string, h: { from: string; to: string; subject: string; at: Date }): Promise<void> {
  const raw = [
    `From: ${h.from}`, `To: ${h.to}`, `Subject: ${h.subject}`, `Date: ${h.at.toUTCString()}`,
    `Message-ID: <${randomUUID()}@pre-connect.example>`, "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8", "", `The body of ${h.subject}.`, "",
  ].join("\r\n");
  await withServer(user, async (c) => {
    if (folder !== "INBOX") await c.mailboxCreate(folder).catch(() => undefined);
    await c.append(folder, Buffer.from(raw, "utf8"), ["\\Seen"], h.at);
  });
}

async function ask(p: Phone, path: string, method = "GET"): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await p.engine.handle(new Request(`http://sidecar${path}`, {
    method, headers: { authorization: `Bearer ${p.engine.sessionToken}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
  }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Passes until `done` holds or the deadline. */
async function until(p: Phone, done: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    await p.engine.resume();
    if (await done()) return true;
    if (Date.now() - t0 >= deadlineMs) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const addresses = (body: Record<string, unknown>, key: string): string[] =>
  ((body[key] ?? []) as Array<{ address: string }>).map((g) => g.address).sort();
const events = (p: Phone): string => [...new Set(p.lines.map((l) => l.event))].join(", ");

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE && !SERVER_UP)("the mail server this file measures against", () => {
  it(`is NOT answering on ${HOST}:${PORT} — the cases below measured nothing in this run`, () => {
    expect(SERVER_UP, "the probe says the server answers, so these cases should have RUN").toBe(false);
  });
});

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("a phone connected to a mailbox with mail already in its Inbox", () => {
  it("keeps that mail where it is, offers both senders, and the offer's press holds them", async () => {
    const user = `pre-connect-${randomUUID()}@trafficflow.test`;
    const n = randomUUID().slice(0, 8);
    const [sentAt, plainAt, firstAt] = rigAppendDates([60 * MIN, 50 * MIN, 45 * MIN]);
    const mara = `mara.${n}@rig-corpus.invalid`;
    const stranger = `nobody.${n}@stranger.invalid`;
    await put(user, "Sent", { from: `<${user}>`, to: `Mara Lindqvist <${mara}>`, subject: `Keys ${n}`, at: sentAt });
    const plain = `Plain note ${n}`;
    const first = `First contact ${n}`;
    await put(user, "INBOX", { from: `Mara Lindqvist <${mara}>`, to: `<${user}>`, subject: plain, at: plainAt });
    await put(user, "INBOX", { from: `Nobody Known <${stranger}>`, to: `<${user}>`, subject: first, at: firstAt });

    const phone = await bootPhone(user);
    expect(await post(phone, `/local/mailboxes/${seedMailboxId(phone)}/organize`)).toBe(200);
    const read = await until(phone, async () => (await rowOf(phone, plain)) !== null && (await rowOf(phone, first)) !== null, 180_000);
    expect(read, `never ingested — events ${events(phone)}`).toBe(true);
    for (let i = 0; i < 5; i++) await phone.engine.resume();
    expect([await folderOnServer(user, plain), await folderOnServer(user, first)], "mail moved with nobody's press").toEqual(["INBOX", "INBOX"]);

    const offer = await ask(phone, "/screener/unscreened");
    expect(offer.status).toBe(200);
    expect(addresses(offer.body, "groups"), "the offer did not name both senders").toEqual([mara, stranger].sort());

    const pressed = await ask(phone, "/screener/unscreened", "POST");
    expect(pressed.status).toBe(200);
    expect(addresses(pressed.body, "screened")).toEqual([mara, stranger].sort());
    const held = await until(phone, async () =>
      (await folderOnServer(user, plain)) === "ohmail/Screener" && (await folderOnServer(user, first)) === "ohmail/Screener", 90_000);
    expect(held, `the press left the mail — ${JSON.stringify([await rowOf(phone, plain), await rowOf(phone, first)])}`).toBe(true);
    const queue = await ask(phone, "/screener");
    expect(((queue.body.items ?? []) as Array<{ sender: { address: string } }>).map((i) => i.sender.address).sort()).toEqual([mara, stranger].sort());
    expect(addresses((await ask(phone, "/screener/unscreened")).body, "groups"), "the offer outlived its press").toEqual([]);
  }, 600_000);

  /* THE SENT-MAIL SEED ON THE STANDALONE PHONE. Mara is somebody the account wrote to: without the
     seed her next letter is held as a first-time sender's. The app's own reads over its own door
     ask it, the confirm writes her rule, the release returns the held letter, and her next one
     stays in the Inbox; a stranger is still held. */
  it("asks the sent-mail seed, and a yes lets the person written to through", async () => {
    const user = `pre-connect-seed-${randomUUID()}@trafficflow.test`;
    const n = randomUUID().slice(0, 8);
    const [sentAt, plainAt, firstAt] = rigAppendDates([60 * MIN, 50 * MIN, 45 * MIN]);
    const mara = `mara.${n}@rig-corpus.invalid`;
    const stranger = `nobody.${n}@stranger.invalid`;
    await put(user, "Sent", { from: `<${user}>`, to: `Mara Lindqvist <${mara}>`, subject: `Keys ${n}`, at: sentAt });
    const plain = `Plain note ${n}`;
    const first = `First contact ${n}`;
    await put(user, "INBOX", { from: `Mara Lindqvist <${mara}>`, to: `<${user}>`, subject: plain, at: plainAt });
    await put(user, "INBOX", { from: `Nobody Known <${stranger}>`, to: `<${user}>`, subject: first, at: firstAt });

    const phone = await bootPhone(user);
    expect(await post(phone, `/local/mailboxes/${seedMailboxId(phone)}/organize`)).toBe(200);
    expect(await until(phone, async () => (await rowOf(phone, plain)) !== null && (await rowOf(phone, first)) !== null, 180_000),
      `never ingested — events ${events(phone)}`).toBe(true);
    const boot = await bootEngine(appMirror(), { origin: LOCAL_ENGINE_ORIGIN, accountId: phone.engine.accountId, localEngine: phone.engine });
    if (boot.kind !== "ready") throw new Error("the app's mirror refused");
    await boot.verifyIdentity();
    await boot.engine.start();
    const session = { profile: { origin: LOCAL_ENGINE_ORIGIN, apiBase: null }, fetch: localEngineTransport(phone.engine).fetch };
    const facts = async (): Promise<SeedFacts> => ({
      seed: worldSeedOf((await readFoldersEnabled(session as never))!.seed),
      mailboxes: { known: true, rows: (await readMailboxes(session as never)) ?? [] },
      profileQuestionOpen: false,
    });
    try {
      const before = await facts();
      expect(before.seed, "the door said nothing about the seed").toEqual({ known: true, carried: true, confirmedAt: null });
      expect(seedStage(before), "the phone does not owe the seed").toBe("owed");

      const again = `Mara again ${n}`;
      await deliver(user, `Mara Lindqvist <${mara}>`, again);
      expect(await until(phone, async () => (await folderOnServer(user, again)) === "ohmail/Screener", 90_000),
        "the premise: a letter from somebody written to is held while the seed is owed").toBe(true);

      const review = await readSeedReview(session);
      expect(review?.candidates.map((c) => c.address), "the review did not name the person written to").toEqual([mara]);
      expect((await confirmSeed(session, [mara], `seed-${n}`)).rulesCreated).toBe(1);
      await boot.engine.requestPull();
      expect(await until(phone, async () => (await folderOnServer(user, again)) === "INBOX", 90_000),
        "the yes left her held letter in the Screener").toBe(true);

      const next = `Mara once more ${n}`;
      await deliver(user, `Mara Lindqvist <${mara}>`, next);
      expect(await until(phone, async () => (await rowOf(phone, next)) !== null, 60_000)).toBe(true);
      for (let i = 0; i < 5; i++) await phone.engine.resume();
      expect(await folderOnServer(user, next), "her next letter was held as a first-time sender's").toBe("INBOX");
      await boot.engine.syncOnce();
      const now = new Date();
      const box = liveOhbox(presentedWorld(boot.engine.read(), now, false, SCREENING_UNSUPPLIED).reader, { now, zone: "UTC", screening: SCREENING_UNSUPPLIED });
      expect([...box.resurfaced, ...box.fresh, ...box.seen].map((m) => m.subject)).toEqual(expect.arrayContaining([again, next]));
      expect(addresses((await ask(phone, "/screener/unscreened")).body, "groups"), "the offer still names her").toEqual([stranger]);

      const later = `Somebody new ${n}`;
      await deliver(user, `Somebody New <new.${n}@stranger.invalid>`, later);
      expect(await until(phone, async () => (await folderOnServer(user, later)) === "ohmail/Screener", 90_000),
        "the control: a stranger is still held").toBe(true);
      expect(seedStage(await facts()), "the seed is still owed after the yes").toBe("none");
    } finally { boot.store.close(); }
  }, 600_000);
});

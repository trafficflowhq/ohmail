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
  dialectSeam, dirs, folderOnServer, nodeExecutor, open, post, rowOf, seedMailboxId, withServer, type Line, type Phone,
} from "./_phone-offline-rig.js";
import { serviceUp } from "@trafficflow/db/testing";

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
    const base = Date.now();
    const mara = `mara.${n}@rig-corpus.invalid`;
    const stranger = `nobody.${n}@stranger.invalid`;
    await put(user, "Sent", { from: `<${user}>`, to: `Mara Lindqvist <${mara}>`, subject: `Keys ${n}`, at: new Date(base - 60 * MIN) });
    const plain = `Plain note ${n}`;
    const first = `First contact ${n}`;
    await put(user, "INBOX", { from: `Mara Lindqvist <${mara}>`, to: `<${user}>`, subject: plain, at: new Date(base - 50 * MIN) });
    await put(user, "INBOX", { from: `Nobody Known <${stranger}>`, to: `<${user}>`, subject: first, at: new Date(base - 45 * MIN) });

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
});

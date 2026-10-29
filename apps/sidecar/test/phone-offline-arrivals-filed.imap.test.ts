/**
 * MAIL THAT ARRIVES WHILE THE PHONE IS OFFLINE IS FILED ON THE SERVER WHEN IT IS BACK.
 *
 * `startPhoneEngine` — the phone's `main.ts` — over `node:sqlite`, dialling a real IMAP server
 * through a cable this file can cut. A first-time sender's letter lands while the cable is down;
 * the verdict is read on the server by a client the engine knows nothing about: the letter must be
 * in `ohmail/Screener` there within one pass of the phone having it, beside a live control. The
 * device report this answers was a correspondent the phone called held, not a filing miss; this
 * pins the filing half. Runs under the sqlite project; the default project states the premise.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import {
  Cable, DELIVER_AT_MS, EXPECTED_DIALECT, HOST, ON_DEVICE_STORE, OUTAGE_MS, PASS, PORT, bootPhone, cables, deliver, dirs, eventsSince, folderOnServer, open, post, relaunch, rowOf, seedMailboxId,
  untilIngested, untilScreened, withServer, type Phone,
} from "./_phone-offline-rig.js";
import { serviceUp } from "@trafficflow/db/testing";

/** The run's one probe (test/setup/services.global.ts), at the address this file dials. */
const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (cables.length > 0) await cables.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-offline-"));
  dirs.push(dir);
  return dir;
}

/** Consent, then the control: a stranger's letter arriving while online is filed on the server. */
async function organizingPhone(mode: "reset" | "stall"): Promise<{ phone: Phone; cable: Cable; user: string }> {
  const user = `offline-${randomUUID()}@trafficflow.test`;
  const cable = new Cable(mode);
  await cable.open();
  cables.push(cable);
  const phone = await bootPhone({ user, file: join(storeDir(), "engine.db"), cable });
  const mailboxId = seedMailboxId(phone);
  expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
  const live = `live arrival ${randomUUID()}`;
  await new Promise((r) => setTimeout(r, 3000));
  await deliver(user, "first.contact.live@stranger.example", live);
  const control = await untilScreened(user, live, 120_000);
  expect(control.at, `the control: a live stranger's letter was not filed — events ${eventsSince(phone, 0)}`)
    .toBe("ohmail/Screener");
  return { phone, cable, user };
}

/** The outage itself: the cable goes, a first-time sender's letter lands, the cable comes back. */
async function arrivesWhileOffline(user: string, cable: Cable, from: string): Promise<string> {
  await new Promise((r) => setTimeout(r, DELIVER_AT_MS));
  const subject = `offline arrival ${randomUUID()}`;
  await deliver(user, from, subject);
  await new Promise((r) => setTimeout(r, Math.max(0, OUTAGE_MS - DELIVER_AT_MS)));
  cable.mend();
  return subject;
}

/** The verdict, read on the server: in `ohmail/Screener` within one pass of the phone having it. */
async function expectFiled(phone: Phone, user: string, subject: string): Promise<void> {
  const ingested = await untilIngested(phone, subject, 180_000);
  expect(ingested, `the phone never ingested the offline letter — events ${eventsSince(phone, 0)}`).not.toBeNull();
  const filed = await untilScreened(user, subject, 60_000);
  expect(filed.at, `the offline letter stayed in ${filed.at} — the phone's row ${JSON.stringify(await rowOf(phone, subject))}; `
    + `events ${eventsSince(phone, 0)}`).toBe("ohmail/Screener");
}

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

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("mail that arrives while the phone is offline", () => {
  it.each(["reset", "stall"] as const)(
    "a first-time sender's letter that landed during the outage is filed after the return (%s)",
    async (mode) => {
      const { phone, cable, user } = await organizingPhone(mode);
      cable.cut();
      const offline = await arrivesWhileOffline(user, cable, "first.contact.offline@stranger.example");
      await expectFiled(phone, user, offline);
      /* The live arrival after the return is filed as before the outage. */
      const after = `after the return ${randomUUID()}`;
      await deliver(user, "first.contact.after@stranger.example", after);
      expect((await untilScreened(user, after, 120_000)).at).toBe("ohmail/Screener");
    },
    600_000,
  );

  it("a letter that landed while a cold relaunch had no network is filed once the network is back", async () => {
    const first = await organizingPhone("reset");
    /* The app process ends while the phone is offline and is launched again with no network, so
       the relaunch's first connection is the one the return makes (the device run's shape). */
    first.cable.cut();
    await first.phone.engine.stop().catch(() => undefined);
    open.splice(open.indexOf(first.phone.engine), 1);
    const phone = await relaunch(first.phone);
    const offline = await arrivesWhileOffline(first.user, first.cable, "first.contact.cold@stranger.example");
    await expectFiled(phone, first.user, offline);
  }, 600_000);
});

/* FOLDER-MISSING-FILINGS (the phone): another client deletes ohmail/Screened; a Move there said
   done and the server kept the letter in the Inbox for as long as the folder was gone. */
describe.runIf(ON_DEVICE_STORE && SERVER_UP)("a filing into ohmail's folder another client deleted", () => {
  it("the phone makes the folder again and files the letter there", async () => {
    const { phone, user } = await organizingPhone("reset");
    const subject = `kept here ${randomUUID()}`;
    await deliver(user, "first.contact.kept@stranger.example", subject);
    expect((await untilScreened(user, subject, 120_000)).at).toBe("ohmail/Screener");
    await withServer(user, (c) => c.mailboxDelete("ohmail.Screened"));
    const [id] = (await phone.exec.all("select id from messages where subject = ?", [subject])).rows[0]!;
    const res = await phone.engine.handle(new Request(`http://sidecar/messages/${String(id)}/move`, {
      method: "POST",
      headers: { authorization: `Bearer ${phone.engine.sessionToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ folder: "ohmail/Screened" }),
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    let at: string | null = null;
    for (const t0 = Date.now(); Date.now() - t0 < 120_000 && at !== "ohmail/Screened"; await new Promise((r) => setTimeout(r, 1000))) {
      at = await folderOnServer(user, subject);
    }
    expect(at, `the phone's row ${JSON.stringify(await rowOf(phone, subject))}; events ${eventsSince(phone, 0)}`).toBe("ohmail/Screened");
  }, 600_000);
});


/** Passes everything; armed, it forwards the next `\Seen` STORE and ends the phone's side on the answer. */
class LosesStoreAnswer {
  port = 0;
  /* The server it stands in front of, held as the rig's Cable holds it. */
  private readonly target = { host: HOST, port: PORT };
  armed = false;
  fired = false;
  unseenStores = 0;
  private server: Server | null = null;
  private live = new Set<Socket>();
  async open(): Promise<void> {
    this.server = createServer((inbound) => {
      const outbound = connect(this.target);
      this.live.add(inbound).add(outbound);
      const end = (): void => { inbound.destroy(); outbound.destroy(); this.live.delete(inbound); this.live.delete(outbound); };
      inbound.on("error", end).on("close", end);
      outbound.on("error", end).on("close", end);
      let cutOnAnswer = false;
      outbound.on("data", (b: Buffer) => {
        if (cutOnAnswer) { outbound.destroy(); inbound.end(); this.fired = true; return; }
        if (!inbound.destroyed) inbound.write(b);
      });
      inbound.on("data", (b: Buffer) => {
        const line = b.toString("latin1");
        if (/ STORE /i.test(line) && /\\Seen/i.test(line)) {
          if (/-FLAGS/i.test(line)) this.unseenStores += 1;
          if (this.armed) { this.armed = false; cutOnAnswer = true; }
        }
        if (!outbound.destroyed) outbound.write(b);
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async close(): Promise<void> {
    for (const s of [...this.live]) s.destroy();
    await new Promise<void>((r) => this.server!.close(() => r()));
  }
}

async function until(done: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 100))) if (await done()) return true;
  return false;
}

/** The letter's `\\Seen` on the server, read by a client of its own (`null`: no such letter). */
async function seenOnServer(user: string, subject: string): Promise<boolean | null> {
  for (let attempt = 1; ; attempt += 1) {
    const c = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user, pass: PASS }, logger: false });
    c.on("error", () => undefined); // a reset socket's error event; the pending command rejects anyway
    try {
      await c.connect();
      const lock = await c.getMailboxLock("INBOX");
      try {
        const hits = await c.search({ header: { subject } }, { uid: true });
        if (!Array.isArray(hits) || hits.length === 0) return null;
        const m = await c.fetchOne(String(hits[0]), { flags: true }, { uid: true });
        return m ? (m.flags?.has("\\Seen") ?? false) : null;
      } finally { lock.release(); }
    } catch (err) {
      // GreenMail can drop a connection whose SELECT races a write to that folder; read again on a fresh one.
      if ((err as { code?: unknown }).code !== "NoConnection" || attempt === 3) throw err;
    } finally {
      await c.logout().catch(() => undefined);
    }
  }
}

/* The read push's STORE reaches the server and the connection ends before its answer; the person
   presses Mark unread before the re-dial. That unread is owed: the read may have landed. */
describe.runIf(ON_DEVICE_STORE && SERVER_UP)("a read whose STORE answer is lost, then Mark unread", () => {
  it("ends unread on the server and in the app, with one unread STORE", async () => {
    const door = new LosesStoreAnswer();
    await door.open();
    try {
      const user = `seen-lost-${randomUUID()}@trafficflow.test`;
      const subject = `lost answer ${randomUUID()}`;
      await deliver(user, "someone@elsewhere.example", subject);
      const phone = await bootPhone({ user, file: join(storeDir(), "engine.db"), cable: door as unknown as Cable });
      expect(await post(phone, `/local/mailboxes/${seedMailboxId(phone)}/organize`)).toBe(200);
      let id = "";
      expect(await until(async () => {
        await phone.engine.resume();
        id = String((await phone.exec.all("select id from messages where subject = ?", [subject])).rows[0]?.[0] ?? "");
        return id !== "";
      }, 120_000), "the letter was never ingested").toBe(true);
      for (let i = 0; i < 3; i++) await phone.engine.resume();
      const press = async (unread: boolean): Promise<number> => (await phone.engine.handle(new Request("http://sidecar/messages", {
        method: "PATCH",
        headers: { authorization: `Bearer ${phone.engine.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ids: [id], unread }),
      }))).status;
      const unreadInApp = async (): Promise<boolean> =>
        Boolean((await phone.exec.all("select unread from messages where id = ?", [id])).rows[0]?.[0]);

      door.armed = true;
      expect(await press(false)).toBe(200);
      expect(await until(() => door.fired, 15_000), "the read push sent no STORE").toBe(true);
      expect(await until(async () => (await seenOnServer(user, subject)) === true, 15_000), "the server did not apply the read").toBe(true);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await press(true)).toBe(200);

      await until(async () => {
        await phone.engine.resume();
        return (await seenOnServer(user, subject)) === false && await unreadInApp();
      }, 30_000);
      for (let i = 0; i < 2; i++) await phone.engine.resume();
      expect({ server: await seenOnServer(user, subject), app: await unreadInApp() }, `events ${eventsSince(phone, 0)}`)
        .toEqual({ server: false, app: true });
      expect(door.unseenStores, "the unread went out exactly once").toBe(1);
    } finally {
      await door.close();
    }
  }, 240_000);
});

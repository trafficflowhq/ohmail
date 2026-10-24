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
import { afterEach, describe, expect, it } from "vitest";
import {
  Cable, DELIVER_AT_MS, EXPECTED_DIALECT, HOST, ON_DEVICE_STORE, OUTAGE_MS, PORT, bootPhone, cables, deliver, dirs, eventsSince, folderOnServer, open, post, relaunch, rowOf, seedMailboxId,
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


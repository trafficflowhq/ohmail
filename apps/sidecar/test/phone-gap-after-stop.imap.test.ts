/**
 * LETTERS THAT ARRIVED WHILE A PHONE HAD HANDED ITS MAILBOX BACK ARE OFFERED AFTER START.
 * The phone engine over `node:sqlite` against a real IMAP server, with the phone's date parsing: its
 * JS engine refuses the RFC 3501 form INTERNALDATE comes in, and imapflow then keeps the string.
 * Stop, three letters (two from senders with rules, one from a sender nobody knows), Start: the
 * window offers {2, 1}, nothing moves until File, and File files the two by their rules and screens
 * the third, once. Runs under the sqlite project; the default one states the premise.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serviceUp } from "@trafficflow/db/testing";
import {
  Cable, EXPECTED_DIALECT, HOST, ON_DEVICE_STORE, PORT,
  bootPhone, cables, dirs, folderOnServer, open, post, seedMailboxId, withServer, type Phone,
} from "./_phone-offline-rig.js";

const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

/* The phone's Date: `new Date("24-Oct-2026 06:29:08 +0000")` is an Invalid Date there, only that form. */
const RealDate = Date;
const IMAP_FORM = /^\s?\d{1,2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/;
beforeAll(() => {
  const PhoneDate = function (this: unknown, ...a: unknown[]) {
    if (!new.target) return (RealDate as unknown as (...x: unknown[]) => string)(...a);
    if (a.length === 1 && typeof a[0] === "string" && IMAP_FORM.test(a[0])) return new RealDate(Number.NaN);
    return new (RealDate as unknown as new (...x: unknown[]) => Date)(...a);
  } as unknown as DateConstructor;
  Object.setPrototypeOf(PhoneDate, RealDate);
  (PhoneDate as unknown as { prototype: Date }).prototype = RealDate.prototype;
  (PhoneDate as unknown as { parse: (s: string) => number }).parse = (s: string) => (IMAP_FORM.test(s) ? Number.NaN : RealDate.parse(s));
  (globalThis as { Date: DateConstructor }).Date = PhoneDate;
});
afterAll(() => { (globalThis as { Date: DateConstructor }).Date = RealDate; });

afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (cables.length > 0) await cables.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function q(p: Phone, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const r = await p.exec.all(sql, params);
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

/* No APPEND date: GreenMail reads a supplied 12:xx time as 00:xx, which would put the letter before the window. */
async function deliver(user: string, from: string, subject: string): Promise<void> {
  const raw = [
    `From: ${from}`, `To: <${user}>`, `Subject: ${subject}`, `Date: ${new RealDate().toUTCString()}`,
    `Message-ID: <${randomUUID()}@gap-after-stop.example>`, "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8", "", `The body of ${subject}.`, "",
  ].join("\r\n");
  await withServer(user, async (c) => { await c.append("INBOX", Buffer.from(raw, "utf8"), []); });
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

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("Stop, letters, Start on the same phone", () => {
  it("offers the ruled letters and the stranger, moves nothing unasked, and File files them once", async () => {
    const user = `gap-after-stop-${randomUUID()}@trafficflow.test`;
    const n = randomUUID().slice(0, 8);
    const cable = new Cable("reset");
    await cable.open();
    cables.push(cable);
    const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-gap-"));
    dirs.push(dir);
    const p = await bootPhone({ user, file: join(dir, "engine.db"), cable });
    const id = seedMailboxId(p);
    expect(await post(p, `/local/mailboxes/${id}/organize`)).toBe(200);
    for (let i = 0; i < 60 && p.engine.runtimes().organizer[id]?.organizing !== true; i++) await sleep(500);
    expect(p.engine.runtimes().organizer[id]?.organizing, "premise: organizing").toBe(true);
    const ruleMade = RealDate.now() - 7 * 86_400_000;
    for (const [kind, match, to] of [["sender", `letters.${n}@news.example`, "ohmail/News"], ["domain", `shop-${n}.example`, "ohmail/Receipts"]]) {
      await p.exec.run(`insert into rules (account_id, kind, match, destination, provenance, enabled, created_at, updated_at)
        values ((select account_id from mailboxes where id = ?), ?, ?, ?, 'manual', 1, ?, ?)`, [id, kind, match, to, ruleMade, ruleMade]);
    }
    const gap = async () => (await q(p, `select gap_since as since, gap_letters as letters, gap_strangers as strangers
      from mailboxes where id = ?`, [id]))[0]!;
    for (let i = 0; i < 120 && (await gap()).since !== null; i++) await sleep(500);
    expect((await gap()).since, "premise: the window the connect opened closed").toBeNull();

    expect(await p.engine.stopOrganizing()).toBe("released");
    await sleep(2500); // INTERNALDATE has whole seconds; the window starts at the press's millisecond
    const news = `Weekly ${n}`;
    const receipt = `Order ${n}`;
    const first = `Hello ${n}`;
    await deliver(user, `Letters <letters.${n}@news.example>`, news);
    await deliver(user, `Shop <orders@shop-${n}.example>`, receipt);
    await deliver(user, `Newcomer <someone.${n}@newcomer.example>`, first);
    const taken = async () => q(p, "select m.arrived_at as arrived from messages m where m.subject in (?, ?, ?)", [news, receipt, first]);
    for (let i = 0; i < 120 && (await taken()).length < 3; i++) await sleep(500);
    const rows = await taken();
    expect(rows, "the reader did not take the letters in").toHaveLength(3);
    expect(rows.filter((r) => r.arrived === null), "the phone stored letters with no arrival time").toEqual([]);

    expect(await p.engine.claimHere({ by: "press" })).toBe("claimed");
    for (let i = 0; i < 240; i++) {
      const g = await gap();
      if (g.letters !== null || g.since === null) break;
      await sleep(500);
    }
    const events = [...new Set(p.lines.map((l) => l.event))].join(", ");
    expect(await gap(), `the gap letters were not offered — ${events}`).toMatchObject({ letters: 2, strangers: 1 });
    expect(p.lines.filter((l) => l.event === "lease_server_clock_unavailable"), "the claim was read with no server stamp").toEqual([]);
    expect([await folderOnServer(user, news), await folderOnServer(user, receipt), await folderOnServer(user, first)],
      "mail moved with nobody's press").toEqual(["INBOX", "INBOX", "INBOX"]);

    const filed = await p.engine.handle(new Request(`http://sidecar/mailboxes/${id}/gap-letters`, {
      method: "POST", headers: { authorization: `Bearer ${p.engine.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ file: true, count: 2, strangers: 1 }),
    }));
    expect(filed.status, await filed.clone().text()).toBe(202);
    const want = ["ohmail/News", "ohmail/Receipts", "ohmail/Screener"];
    let at: Array<string | null> = [];
    for (let i = 0; i < 90; i++) {
      at = [await folderOnServer(user, news), await folderOnServer(user, receipt), await folderOnServer(user, first)];
      if (at.every((f, k) => f === want[k])) break;
      await sleep(1000);
    }
    expect(at, "File did not file the ruled letters and screen the stranger").toEqual(want);
    await sleep(3000);
    const moves = await q(p, "select count(*) as n from audit_log where action = 'gap_catchup_move'");
    expect(Number(moves[0]!.n), "a letter was filed more than once").toBe(2);
    expect(await gap()).toEqual({ since: null, letters: null, strangers: null });
  }, 600_000);
});

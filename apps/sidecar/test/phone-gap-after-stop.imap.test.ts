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
  bootPhone, cables, dirs, folderOnServer, open, post, relaunch, seedMailboxId, withServer, type Phone,
} from "./_phone-offline-rig.js";
import { imapDateTime } from "@trafficflow/core/adapters/imap";
import { EN } from "../../mobile/src/copy.en.js";
import { organizerNoticeBody } from "../../mobile/src/engine/organizer-notice.js";
import { forgetOrganizerSessionForTests, holdStandaloneDoor, standaloneHere } from "../../mobile/src/engine/organizer-session.js";
import type { StandaloneEngine } from "../../mobile/src/engine/standalone-door.js";
import { claimChipLabel, claimHere, mayStartHere } from "../../mobile/src/ui/standalone-form.js";

const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

/* The phone's Date: `new Date("24-Oct-2026 06:29:08 +0000")` is an Invalid Date there, only that form;
   `skewMs` sets the phone's wall clock off the server's. */
const RealDate = Date;
const IMAP_FORM = /^\s?\d{1,2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/;
let skewMs = 0;
beforeAll(() => {
  const PhoneDate = function (this: unknown, ...a: unknown[]) {
    if (!new.target) return (RealDate as unknown as (...x: unknown[]) => string)(...a);
    if (a.length === 0) return new RealDate(RealDate.now() + skewMs);
    if (a.length === 1 && typeof a[0] === "string" && IMAP_FORM.test(a[0])) return new RealDate(Number.NaN);
    return new (RealDate as unknown as new (...x: unknown[]) => Date)(...a);
  } as unknown as DateConstructor;
  Object.setPrototypeOf(PhoneDate, RealDate);
  (PhoneDate as unknown as { prototype: Date }).prototype = RealDate.prototype;
  (PhoneDate as unknown as { now: () => number }).now = () => RealDate.now() + skewMs;
  (PhoneDate as unknown as { parse: (s: string) => number }).parse = (s: string) => (IMAP_FORM.test(s) ? Number.NaN : RealDate.parse(s));
  (globalThis as { Date: DateConstructor }).Date = PhoneDate;
});
afterAll(() => { (globalThis as { Date: DateConstructor }).Date = RealDate; });

afterEach(async () => {
  skewMs = 0;
  forgetOrganizerSessionForTests();
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

/** A phone organizing a fresh mailbox with a sender rule and a domain rule, its boot window closed. */
async function organizingWithRules(tag: string) {
  const user = `${tag}-${randomUUID()}@trafficflow.test`;
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
  const gap = async (q0: Phone = p) => (await q(q0, `select gap_since as since, gap_letters as letters, gap_strangers as strangers
    from mailboxes where id = ?`, [id]))[0]!;
  for (let i = 0; i < 120 && (await gap()).since !== null; i++) await sleep(500);
  expect((await gap()).since, "premise: the window the connect opened closed").toBeNull();
  const letters = { news: `Weekly ${n}`, receipt: `Order ${n}`, first: `Hello ${n}` };
  const three = async (): Promise<void> => {
    await deliver(user, `Letters <letters.${n}@news.example>`, letters.news);
    await deliver(user, `Shop <orders@shop-${n}.example>`, letters.receipt);
    await deliver(user, `Newcomer <someone.${n}@newcomer.example>`, letters.first);
  };
  const taken = async (q0: Phone = p) => q(q0, `select m.id, m.arrived_at as arrived, m.created_at as created, m.native_locator as locator
    from messages m where m.subject in (?, ?, ?)`, [letters.news, letters.receipt, letters.first]);
  /** "Organize here", then the offer the gap pass counts. */
  const startAndOffer = async (q0: Phone) => {
    // A relaunched engine answers once its first look has read the lease.
    let claimed = await q0.engine.claimHere({ by: "press" });
    for (let i = 0; i < 60 && claimed === "unreadable"; i++) { await sleep(500); claimed = await q0.engine.claimHere({ by: "press" }); }
    expect(claimed).toBe("claimed");
    for (let i = 0; i < 240; i++) {
      const g = await gap(q0);
      if (g.letters !== null || g.since === null) break;
      await sleep(500);
    }
    return gap(q0);
  };
  const fileThem = async (q0: Phone) => {
    const filed = await q0.engine.handle(new Request(`http://sidecar/mailboxes/${id}/gap-letters`, {
      method: "POST", headers: { authorization: `Bearer ${q0.engine.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ file: true, count: 2, strangers: 1 }),
    }));
    expect(filed.status, await filed.clone().text()).toBe(202);
    const want = ["ohmail/News", "ohmail/Receipts", "ohmail/Screener"];
    let at: Array<string | null> = [];
    for (let i = 0; i < 90; i++) {
      at = [await folderOnServer(user, letters.news), await folderOnServer(user, letters.receipt), await folderOnServer(user, letters.first)];
      if (at.every((f, k) => f === want[k])) break;
      await sleep(1000);
    }
    expect(at, "File did not file the ruled letters and screen the stranger").toEqual(want);
  };
  return { p, id, n, user, cable, gap, letters, three, taken, startAndOffer, fileThem };
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

  it("a phone 2 minutes fast: letters that reached the server after its last finished drain and before Stop are offered", async () => {
    skewMs = 120_000;
    const g = await organizingWithRules("gap-before-stop");
    const through = async () => (await q(g.p, "select organized_through as t from mailboxes where id = ?", [g.id]))[0]!.t as number | null;
    await deliver(g.user, `Letters <letters.${g.n}@news.example>`, `Seed ${g.n}`);
    for (let i = 0; i < 120 && (await through()) === null; i++) await sleep(500);
    const last = await through();
    expect(last, "the drain that took the seed in recorded no start").not.toBeNull();
    for (let i = 0; i < 60 && (await folderOnServer(g.user, `Seed ${g.n}`)) !== "ohmail/News"; i++) await sleep(500);
    await sleep(1000);
    // No drain between the letters and the press: the engine's connection is cut, the server takes them.
    g.cable.cut();
    await g.three();
    const reached = RealDate.now();
    await sleep(45_000);
    const stop = await g.p.engine.handle(new Request(`http://sidecar/mailboxes/${g.id}/release`, {
      method: "POST", headers: { authorization: `Bearer ${g.p.engine.sessionToken}`, "content-type": "application/json" },
      body: "{}",
    }));
    expect(stop.status, await stop.clone().text()).toBe(202);
    g.cable.mend();
    const role = async () => (await q(g.p, "select organizer_role as r from mailboxes where id = ?", [g.id]))[0]!.r;
    for (let i = 0; i < 120 && (await role()) !== "reader"; i++) { await g.p.engine.resume().catch(() => undefined); await sleep(500); }
    expect(await role(), "the stop was not honoured").toBe("reader");
    // The fallback (the press less the allowance) reaches back only about 30 s: it cannot pass this.
    expect(RealDate.now() + skewMs - 150_000, "premise: the letters are older than the fallback start").toBeGreaterThan(reached + 5_000);
    expect((await g.gap()).since, "the window did not start at the last finished drain").toBe(last);
    for (let i = 0; i < 120 && (await g.taken()).length < 3; i++) await sleep(500);
    expect(await g.taken(), "the reader did not take the letters in").toHaveLength(3);

    const offered = await g.startAndOffer(g.p);
    const events = [...new Set(g.p.lines.map((l) => l.event))].join(", ");
    expect(offered, `the letters before Stop were not offered — ${events}`).toMatchObject({ letters: 2, strangers: 1 });
    await g.fileThem(g.p);
    await sleep(3000);
    const moves = await q(g.p, "select count(*) as n from audit_log where action = 'gap_catchup_move'");
    expect(Number(moves[0]!.n), "a letter was filed more than once").toBe(2);
  }, 600_000);

  it("letters this phone stored with no arrival time get the server's INTERNALDATE, read-only; older rows stay as they are", async () => {
    const g = await organizingWithRules("arrival-backfill");
    expect(await g.p.engine.stopOrganizing()).toBe("released");
    await g.three();
    for (let i = 0; i < 120 && (await g.taken()).length < 3; i++) await sleep(500);
    const rows = await g.taken();
    expect(rows).toHaveLength(3);
    const [floor] = await q(g.p, "select applied_at as at from ohmail_sqlite_migrations where name = '0119_messages_arrived_at.sql'");
    const old = rows[0]!.id as string;
    // As a phone stored them before it read INTERNALDATE by hand; one row from before mail 0119.
    await g.p.exec.run(`update messages set arrived_at = null where id in (?, ?, ?)`, rows.map((r) => r.id));
    await g.p.exec.run("update messages set created_at = ? where id = ?", [Number(floor!.at) - 60_000, old]);
    const [mark] = await q(g.p, "select coalesce(max(seq), 0) as s from change_log");
    const flagsBefore = await withServer(g.user, async (c) => {
      await c.mailboxOpen("INBOX");
      const out: string[] = [];
      for await (const m of c.fetch("1:*", { flags: true })) out.push([...(m.flags ?? [])].sort().join(" "));
      return out;
    });
    await g.p.engine.stop().catch(() => undefined);
    open.splice(open.indexOf(g.p.engine), 1);
    const p2 = await relaunch(g.p);
    const filled = async () => (await g.taken(p2)).filter((r) => r.arrived !== null).length;
    for (let i = 0; i < 120 && (await filled()) < 2; i++) { await p2.engine.resume().catch(() => undefined); await sleep(500); }
    const after = await g.taken(p2);
    const server = await withServer(g.user, async (c) => {
      await c.mailboxOpen("INBOX");
      const out = new Map<number, number>();
      // This Date refuses the RFC 3501 form, as the phone's does: read by hand.
      for await (const m of c.fetch("1:*", { uid: true, internalDate: true })) out.set(m.uid, imapDateTime(m.internalDate)!.getTime());
      return out;
    });
    for (const r of after) {
      const uid = Number(String((typeof r.locator === "string" ? JSON.parse(r.locator) : r.locator).ref).split(":")[1]);
      if (r.id === old) expect(r.arrived, "a row from before mail 0119 was given an arrival time").toBeNull();
      else expect(r.arrived, "the arrival time is not the server's INTERNALDATE").toBe(server.get(uid));
    }
    const changes = await q(p2, `select entity_id as id, count(*) as n from change_log
      where entity_type = 'message' and op = 'update' and seq > ? and entity_id in (?, ?, ?) group by entity_id`,
    [Number(mark!.s), ...rows.map((r) => r.id)]);
    expect(changes.map((c) => [c.id, Number(c.n)]).sort(), "each filled row is one change")
      .toEqual(rows.filter((r) => r.id !== old).map((r) => [r.id, 1]).sort());
    const flagsAfter = await withServer(g.user, async (c) => {
      await c.mailboxOpen("INBOX");
      const out: string[] = [];
      for await (const m of c.fetch("1:*", { flags: true })) out.push([...(m.flags ?? [])].sort().join(" "));
      return out;
    });
    expect(flagsAfter, "a date read changed a flag").toEqual(flagsBefore);
    expect([await folderOnServer(g.user, g.letters.news), await folderOnServer(g.user, g.letters.receipt),
      await folderOnServer(g.user, g.letters.first)], "a date read moved mail").toEqual(["INBOX", "INBOX", "INBOX"]);
  }, 600_000);

  it("an open window whose letters have no arrival time waits for them, then offers them", async () => {
    const g = await organizingWithRules("gap-unarrived");
    expect(await g.p.engine.stopOrganizing()).toBe("released");
    await sleep(2500);
    await g.three();
    for (let i = 0; i < 120 && (await g.taken()).length < 3; i++) await sleep(500);
    // As a phone stored them before it read INTERNALDATE by hand.
    await g.p.exec.run("update messages set arrived_at = null where id in (?, ?, ?)", (await g.taken()).map((r) => r.id));
    await g.p.engine.stop().catch(() => undefined);
    open.splice(open.indexOf(g.p.engine), 1);
    const p2 = await relaunch(g.p);
    expect((await g.gap(p2)).since, "premise: the window is open").not.toBeNull();
    // The reader asks the server for them; the window stays open meanwhile.
    for (let i = 0; i < 120 && (await g.taken(p2)).some((r) => r.arrived === null); i++) {
      await p2.engine.resume().catch(() => undefined);
      await sleep(500);
    }
    expect((await g.taken(p2)).filter((r) => r.arrived === null), "the letters were not given their arrival times").toEqual([]);
    expect((await g.gap(p2)).since, "the window closed before its letters had arrival times").not.toBeNull();
    const offered = await g.startAndOffer(p2);
    const events = [...new Set(p2.lines.map((l) => l.event))].join(", ");
    expect(offered, `the window closed over letters it could not see — ${events}`).toMatchObject({ letters: 2, strangers: 1 });
    expect(p2.lines.filter((l) => l.event === "gap_catchup_unarrived")).toEqual([]);
    await g.fileThem(p2);
  }, 600_000);

  it("a phone whose clock is 4 minutes off the server's stops and says so, in the strip and the notification", async () => {
    skewMs = 240_000;
    const user = `gap-clock-off-${randomUUID()}@trafficflow.test`;
    const n = randomUUID().slice(0, 8);
    const cable = new Cable("reset");
    await cable.open();
    cables.push(cable);
    const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-clock-"));
    dirs.push(dir);
    const p = await bootPhone({ user, file: join(dir, "engine.db"), cable });
    const id = seedMailboxId(p);
    expect(await post(p, `/local/mailboxes/${id}/organize`)).toBe(200);
    // The second gate run reads this phone's own claim with the server's stamp; letters keep it running.
    for (let k = 0; k < 6 && !p.lines.some((l) => l.event === "lease_clock_skew_refused"); k++) {
      await deliver(user, `Letters <letters.${n}@news.example>`, `Weekly ${n} #${k}`);
      for (let i = 0; i < 40 && !p.lines.some((l) => l.event === "lease_clock_skew_refused"); i++) await sleep(500);
    }
    expect(p.lines.some((l) => l.event === "lease_clock_skew_refused"), "premise: the gate refused the clock").toBe(true);
    const organizer = p.engine.runtimes().organizer;
    expect(organizer[id], "premise: the engine keeps the claim and names the clock").toMatchObject({ organizing: true, unreadableReason: "clock_off" });

    expect(organizerNoticeBody(user, organizer), "the notification said Organizing over a refused gate").toBe(EN.phoneStateClockOff);
    expect(holdStandaloneDoor(p.engine as unknown as StandaloneEngine)).toBe(true);
    const claim = claimHere(standaloneHere()!, "idle", false);
    expect(claimChipLabel(claim), "the strip said Organizing over a refused gate").toBe(EN.phoneStateClockOff);
    expect(mayStartHere(claim)).toBe(false);
  }, 300_000);
});

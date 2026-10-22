import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxFolders, messageInstances, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { serviceUp } from "@trafficflow/db/testing";

/**
 * A REAL SERVER WHOSE BATCH CROSSES ITS DECLARED TOTAL (GreenMail). GreenMail's RFC822.SIZE counts
 * the body only, so a message with ~950,000 bytes of header and a one-line body stays under its own
 * 1 MiB floor (a floor-rider) while it pushes its batch past the total the batch declared. That
 * breach named no message: nothing was kept, and every re-dial breached on the same bodies. Now
 * the pass keeps what arrived, the rest syncs over the next connection, and only a message past
 * its own ceiling is set aside. In INBOX, and in a customer folder and Sent on their first read.
 * Box file: GreenMail on 127.0.0.1:3143, through box-lock.sh greenmail.
 */
const HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.IMAP_PORT ?? 3143);

const SERVER_UP = serviceUp("greenmail", `${HOST}:${PORT}`).up;

const message = (user: string, subject: string, headerPad = 0): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", `To: <${user}>`, `Subject: ${subject}`,
  `Message-ID: <${subject}-${randomUUID()}@lane.test>`, "Date: Tue, 06 Oct 2026 10:00:00 +0000",
  ...(headerPad > 0 ? [`X-Padding: ${"a".repeat(headerPad)}`] : []),
  "Content-Type: text/plain; charset=utf-8", "", `Body of ${subject}.`, "",
].join("\r\n"), "utf8");

async function withClient<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, logger: false });
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => undefined); }
}

const MIB = 1_048_576;
const honestBody = (user: string, subject: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", `To: <${user}>`, `Subject: ${subject}`,
  `Message-ID: <${subject}-${randomUUID()}@lane.test>`, "Date: Tue, 06 Oct 2026 10:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8", "", ...Array.from({ length: 800 }, () => "b".repeat(74)), "",
].join("\r\n"), "utf8");

/** Declared and arrived bytes per message in a folder, read back from the server. */
async function sizesIn(user: string, folder: string): Promise<Array<{ declared: number; arrived: number }>> {
  return withClient(user, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const out: Array<{ declared: number; arrived: number }> = [];
      for await (const m of c.fetch("1:*", { uid: true, size: true, source: true })) {
        out.push({ declared: m.size ?? 0, arrived: m.source?.length ?? 0 });
      }
      return out;
    } finally { lock.release(); }
  });
}

/**
 * The desktop engine on the mailbox until every subject in `want` is stored (new INBOX mail
 * included) or 90 s pass. A re-dial after progress waits the ladder's first step (about 15 s);
 * one that climbs waits 30 s, then 60 s, so a folder that never drains shows as missing subjects.
 */
async function walk(user: string, want: readonly string[]) {
  const dir = await freshDataDir("ohmail-overrun-batch-greenmail-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const lines: Array<{ event: string }> = [];
  const s: Sidecar = await createSidecar({
    dataDir: dir,
    imap: { host: HOST, port: PORT, secure: false, auth: { user, pass: "test" } },
    machineName: "a desktop", pollIntervalMs: 600_000,
    log: (event: string) => { lines.push({ event }); },
  });
  cleanups.push(() => s.stop().catch(() => undefined));
  await grantOrganizeConsent(s);
  await s.start().catch(() => undefined);
  for (let i = 0; i < 4; i++) await s.syncUntilQuiet().catch(() => undefined);
  await withClient(user, (c) => c.append("INBOX", message(user, "inbox-new-mail")).then(() => undefined));
  const stored = async (): Promise<string[]> =>
    (await s.db.select({ subject: messages.subject }).from(messages)).map((r) => r.subject ?? "").sort();
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    await s.syncUntilQuiet().catch(() => undefined);
    const have = await stored();
    if (have.includes("inbox-new-mail") && want.every((w) => have.includes(w))) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  const subjects = await stored();
  const conn = Object.values(s.connectionStates())[0]!;
  const redials = lines.filter((l) => l.event === "mailbox_connection_unavailable").length;
  return { subjects, conn, redials };
}

const cleanups: Array<() => Promise<void> | void> = [];

describe.skipIf(!SERVER_UP)(`a batch GreenMail under-declares in total — needs IMAP on ${HOST}:${PORT}`, () => {
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  it("(a) a floor-rider among honest mail: everything is stored, nothing set aside, new INBOX mail arrives", async () => {
    const user = `obt-${randomUUID()}@trafficflow.test`;
    await withClient(user, async (c) => {
      await c.append("INBOX", message(user, "floor-rider", 950_000));
      for (const n of [1, 2, 3]) await c.append("INBOX", honestBody(user, `honest-${n}`));
    });
    // THE PREMISES, read from the server.
    const sizes = await sizesIn(user, "INBOX");
    const rider = sizes[0]!;
    const declared = sizes.reduce((n, m) => n + m.declared, 0);
    const arrived = sizes.reduce((n, m) => n + m.arrived, 0);
    expect(rider.declared * 10, "GreenMail declared the rider's header block").toBeLessThan(rider.arrived);
    expect(rider.arrived, "the rider is past its own floor, so it would be set aside").toBeLessThan(MIB);
    expect(arrived, "the batch arrives within its total, so nothing crosses").toBeGreaterThan(MIB);
    expect(declared * 1.5, "the declared total's ceiling is not the floor").toBeLessThan(MIB);

    const r = await walk(user, ["floor-rider", "honest-1", "honest-2", "honest-3"]);
    console.log("BATCH TOTAL greenmail (a)", JSON.stringify({ redials: r.redials, setAside: r.conn.setAside, sizes }));
    expect(r.redials, "the batch total never crossed, so this cell measured nothing").toBeGreaterThanOrEqual(1);
    expect(r.redials, "the re-dials over kept mail were not bounded").toBeLessThanOrEqual(2);
    expect(r.subjects).toEqual(["floor-rider", "honest-1", "honest-2", "honest-3", "inbox-new-mail"]);
    expect(r.conn.setAside, "a message inside its own ceiling was set aside").toBe(0);
    expect(r.conn.reachable, "the mailbox is served again").toBe(true);
  }, 180_000);

  it("(b) a floor-rider and a liar: only the liar is set aside, the rest is stored", async () => {
    const user = `obt-${randomUUID()}@trafficflow.test`;
    await withClient(user, async (c) => {
      await c.append("INBOX", message(user, "floor-rider", 950_000));
      for (const n of [1, 2, 3]) await c.append("INBOX", honestBody(user, `honest-${n}`));
      await c.append("INBOX", message(user, "the-liar", 1_200_000));
    });
    const sizes = await sizesIn(user, "INBOX");
    expect(sizes[4]!.arrived, "the liar is within its own floor, so nothing names it").toBeGreaterThan(MIB);

    const r = await walk(user, ["floor-rider", "honest-1", "honest-2", "honest-3"]);
    console.log("BATCH TOTAL greenmail (b)", JSON.stringify({ redials: r.redials, setAside: r.conn.setAside }));
    expect(r.redials).toBeGreaterThanOrEqual(1);
    expect(r.redials, "the re-dials were not bounded").toBeLessThanOrEqual(3);
    expect(r.subjects).toEqual(["floor-rider", "honest-1", "honest-2", "honest-3", "inbox-new-mail"]);
    expect(r.conn.setAside, "the liar is set aside once").toBe(1);
    expect(r.conn.reachable, "the mailbox is served again").toBe(true);
  }, 180_000);

  /* A FOLDER WITH NO CURSOR YET, read for the first time: a customer folder, and Sent, which is not
     a watched folder. The cursor names neither until a pass writes one, so a breach on its first
     read left the kept mail unknown and every re-dial crossed at the same message again. */
  for (const folder of ["Archive", "Sent"]) {
    it(`(c) a floor-rider among honest mail in a first-seen ${folder}: everything is stored, nothing set aside`, async () => {
      const user = `obt-${randomUUID()}@trafficflow.test`;
      await withClient(user, async (c) => {
        await c.mailboxCreate(folder);
        await c.append(folder, message(user, `${folder}-floor-rider`, 950_000));
        for (const n of [1, 2, 3]) await c.append(folder, honestBody(user, `${folder}-honest-${n}`));
      });
      const sizes = await sizesIn(user, folder);
      const declared = sizes.reduce((n, m) => n + m.declared, 0);
      const arrived = sizes.reduce((n, m) => n + m.arrived, 0);
      expect(sizes[0]!.arrived, "the rider is within its own floor").toBeLessThan(MIB);
      expect(arrived, "the batch crosses its total").toBeGreaterThan(MIB);
      expect(declared * 1.5, "the declared total's ceiling is not the floor").toBeLessThan(MIB);

      const want = [`${folder}-floor-rider`, ...[1, 2, 3].map((n) => `${folder}-honest-${n}`)];
      const r = await walk(user, want);
      console.log(`BATCH TOTAL greenmail (c) ${folder}`, JSON.stringify({ redials: r.redials, setAside: r.conn.setAside, subjects: r.subjects }));
      expect(r.redials, "the batch total never crossed, so this cell measured nothing").toBeGreaterThanOrEqual(1);
      expect(r.subjects).toEqual([...want, "inbox-new-mail"].sort());
      expect(r.redials, "the re-dials over kept mail were not bounded").toBeLessThanOrEqual(2);
      expect(r.conn.setAside, "a message inside its own ceiling was set aside").toBe(0);
      expect(r.conn.reachable, "the mailbox is served again").toBe(true);
    }, 180_000);
  }

  /* A RENUMBERED CUSTOMER FOLDER: made again with the same letters while the app is closed, so the
     server states a new UIDVALIDITY, one letter gone meanwhile. (GreenMail drops the connection of a
     client deleting a folder an earlier session selected, so the old folder is renamed away and
     emptied; its UIDVALIDITY is the creation second.) The re-read crosses the batch total; the
     cursor kept naming the old epoch, so every pass saw the reset again and crossed at the same
     letters. Now the folder is re-learned under its new epoch and the gone letter leaves the mirror. */
  it("(d) a renumbered customer folder whose re-read crosses: re-learned under its new epoch, the deleted letter gone", async () => {
    const user = `obt-${randomUUID()}@trafficflow.test`;
    const kept = [message(user, "Archive-floor-rider", 950_000), ...[1, 2, 3].map((n) => honestBody(user, `Archive-honest-${n}`))];
    const doomed = honestBody(user, "Archive-deleted-meanwhile");
    await withClient(user, async (c) => {
      await c.mailboxCreate("Archive");
      for (const raw of [...kept, doomed]) await c.append("Archive", raw);
    });
    const epochOf = (): Promise<string> => withClient(user, async (c) => String((await c.status("Archive", { uidValidity: true })).uidValidity));
    const before = await epochOf();

    const dir = await freshDataDir("ohmail-overrun-batch-greenmail-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const lines: Array<{ event: string }> = [];
    /** The desktop engine on this data directory, as a launch makes it. */
    const launch = async (): Promise<Sidecar> => {
      const s = await createSidecar({
        dataDir: dir, imap: { host: HOST, port: PORT, secure: false, auth: { user, pass: "test" } },
        machineName: "a desktop", pollIntervalMs: 600_000, log: (event: string) => { lines.push({ event }); },
      });
      cleanups.push(() => s.stop().catch(() => undefined));
      await grantOrganizeConsent(s);
      await s.start().catch(() => undefined);
      return s;
    };
    const stored = async (s: Sidecar): Promise<string[]> =>
      (await s.db.select({ subject: messages.subject }).from(messages)).map((r) => r.subject ?? "").sort();
    const until = async (s: Sidecar, done: () => Promise<boolean>): Promise<void> => {
      const end = Date.now() + 90_000;
      while (Date.now() < end) {
        await s.syncUntilQuiet().catch(() => undefined);
        if (await done()) return;
        await new Promise((r) => setTimeout(r, 500));
      }
    };
    const first = await launch();
    await until(first, async () => (await stored(first)).length === 5);
    expect((await stored(first)).length, "the first read did not drain, so this cell measured nothing").toBe(5);
    await first.stop();

    await withClient(user, async (c) => {
      await c.mailboxRename("Archive", "Archive-renamed-away");
      const lock = await c.getMailboxLock("Archive-renamed-away");
      try { await c.messageDelete("1:*"); } finally { lock.release(); }
      await c.mailboxCreate("Archive");
      for (const raw of kept) await c.append("Archive", raw);
      await c.append("INBOX", message(user, "inbox-new-mail"));
    });
    const after = await epochOf();
    expect(after, "GreenMail kept the folder's UIDVALIDITY, so nothing was renumbered").not.toBe(before);
    const sizes = await sizesIn(user, "Archive");
    expect(sizes.reduce((n, m) => n + m.arrived, 0), "the re-read crosses its total").toBeGreaterThan(MIB);

    const redialsFrom = lines.filter((l) => l.event === "mailbox_connection_unavailable").length;
    const s = await launch();
    const relearned = async (): Promise<string[]> => (await s.db.select({ uv: messageInstances.uidvalidity })
      .from(messageInstances).where(eq(messageInstances.folder, "Archive"))).map((r) => String(r.uv));
    await until(s, async () => {
      const at = await relearned();
      return (await stored(s)).includes("inbox-new-mail") && at.length === kept.length && at.every((uv) => uv === after);
    });
    const at = await relearned();
    const redials = lines.filter((l) => l.event === "mailbox_connection_unavailable").length - redialsFrom;
    const conn = Object.values(s.connectionStates())[0]!;
    console.log("BATCH TOTAL greenmail (d) renumbered", JSON.stringify({ before, after, at, redials, setAside: conn.setAside }));
    expect(at, "the folder was not re-learned under its new epoch").toEqual(Array(kept.length).fill(after));
    expect(await stored(s)).toContain("inbox-new-mail");
    expect(redials, "the re-read never crossed, so this cell measured nothing").toBeGreaterThanOrEqual(1);
    expect(redials, "the re-dials over re-learned mail were not bounded").toBeLessThanOrEqual(2);
    expect(conn.setAside, "a message inside its own ceiling was set aside").toBe(0);
    expect(conn.reachable, "the mailbox is served again").toBe(true);
    const [gone] = await s.db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.subject, "Archive-deleted-meanwhile"));
    expect(gone?.deletedAt, "the letter deleted during the renumbering is still shown").not.toBeNull();
    const [row] = await s.db.select({ uv: mailboxFolders.uidvalidity }).from(mailboxFolders).where(eq(mailboxFolders.folder, "Archive"));
    expect(String(row?.uv)).toBe(after);
  }, 240_000);
});

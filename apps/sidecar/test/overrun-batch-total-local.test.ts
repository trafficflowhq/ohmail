import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxFolders, messageInstances, messages } from "@trafficflow/db";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { boot, eml, ordinary, rig, server, type Msg } from "./_overrun-rig.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 6 });

/**
 * A BATCH-TOTAL OVERRUN, DESKTOP ENGINE. Twelve messages each declare 10 bytes and stream 300 KB:
 * each is inside its own 1 MiB floor, four together cross the batch total. That breach named no
 * message, so nothing was kept: every re-dial fetched the same four bodies, climbed the ladder and
 * read "unreachable". Now each pass keeps what arrived and the re-dial after it is progress.
 */
const rider = (id: string): Msg => ({ id, raw: Buffer.concat([eml(id), Buffer.alloc(300_000, 0x61)]), declared: 10 });

describe("the desktop engine: a batch-total overrun keeps what arrived", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); vi.restoreAllMocks(); });
  const clock = { skewMs: 0 };

  it("twelve floor-riders then new mail: all stored, each body fetched once, no climbed wait, never unreachable", async () => {
    const inbox: Array<[number, Msg]> = [[1, ordinary("old-1")]];
    for (let u = 2; u <= 13; u++) inbox.push([u, rider(`rider-${u}`)]);
    const s = server(inbox);
    const { cycle, subjects, events, connection } = await boot(rig(s), clock, cleanups);
    const POLL_MS = 20_000;
    const unreachableAt: number[] = [];
    let storedAt = -1;
    for (let i = 0; i < 20 && storedAt < 0; i++) {
      if (i === 1) s.state.folders.get("INBOX")!.msgs.set(100, ordinary("new-mail"));
      clock.skewMs += POLL_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hung = await Promise.race([cycle().then(() => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(true), 15_000); })]);
      clearTimeout(timer);
      if (hung) break;
      if (!(await connection()).reachable) unreachableAt.push(i);
      if ((await subjects()).length === 14) storedAt = i;
    }
    const waits = events.filter((e) => e.event === "mailbox_reconnect_failed").map((e) => e.detail.retryInMs as number);
    console.log("BATCH TOTAL desktop", JSON.stringify({ storedAt, bodies: s.state.bodies, waits, unreachableAt }));
    expect(await subjects()).toEqual(["new-mail", "old-1", ...Array.from({ length: 12 }, (_, i) => `rider-${i + 2}`)].sort());
    expect(Object.values(s.state.bodies), "a body was fetched more than once").toEqual(Array(14).fill(1));
    expect(Math.max(0, ...waits), "a re-dial after kept mail climbed the ladder").toBeLessThanOrEqual(15_000 * 1.2);
    expect(unreachableAt, "polls that reported the server unreachable while it answered").toEqual([]);
    expect((await connection()).setAside, "a message inside its own ceiling was set aside").toBe(0);
    expect(events.some((e) => e.event === "mailbox_redial_after_set_aside"), "no breach was met, so this case proves nothing").toBe(true);
  });

  /* A FOLDER WITH NO CURSOR ROW YET: Sent is not a watched folder and a customer folder has no row
     until a pass writes one, so the cursor names neither. The overrun must leave a cursor naming
     the folder's epoch, or the next pass holds none of the kept UIDs as known and crosses at the
     same row for ever. */
  for (const folder of ["Sent", "Archive"]) {
    it(`twelve floor-riders in a first-seen ${folder}: all stored, each body fetched once, never unreachable`, async () => {
      const s = server([[1, ordinary("old-1")]]);
      const msgs = new Map<number, Msg>();
      for (let u = 1; u <= 12; u++) msgs.set(u, rider(`first-${u}`));
      s.state.folders.set(folder, { uidValidity: 300n, msgs });
      const { cycle, subjects, events, connection } = await boot(rig(s), clock, cleanups);
      const unreachableAt: number[] = [];
      let storedAt = -1;
      for (let i = 0; i < 12 && storedAt < 0; i++) {
        clock.skewMs += 20_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const hung = await Promise.race([cycle().then(() => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(true), 15_000); })]);
        clearTimeout(timer);
        if (hung) break;
        if (!(await connection()).reachable) unreachableAt.push(i);
        if ((await subjects()).length === 13) storedAt = i;
      }
      const waits = events.filter((e) => e.event === "mailbox_reconnect_failed").map((e) => e.detail.retryInMs as number);
      console.log(`FIRST-SEEN ${folder}`, JSON.stringify({ storedAt, bodies: s.state.bodies, waits, unreachableAt }));
      expect(await subjects()).toEqual(["old-1", ...Array.from({ length: 12 }, (_, i) => `first-${i + 1}`)].sort());
      expect(Object.values(s.state.bodies), "a body was fetched more than once").toEqual(Array(13).fill(1));
      expect(Math.max(0, ...waits), "a re-dial after kept mail climbed the ladder").toBeLessThanOrEqual(15_000 * 1.2);
      expect(unreachableAt, "polls that reported the server unreachable while it answered").toEqual([]);
      expect(events.some((e) => e.event === "mailbox_redial_after_set_aside"), "no breach was met, so this case proves nothing").toBe(true);
    });
  }

  /* A RENUMBERED FOLDER (its UIDVALIDITY changed) whose re-read crosses the batch total. The cursor
     kept naming the old epoch, so every pass saw the reset again, re-read the same newest letters,
     found them already held, and climbed the ladder. Now the reset settles in the pass that crosses
     and the next one resumes; a letter re-learned under the new epoch is progress, as a stored one is.
     INBOX on a reader install: an organizer screens its mail out of INBOX, which this rig's move
     cannot follow; the organizer leaves a customer folder's and Sent's mail where it is. */
  for (const folder of ["Archive", "Sent", "INBOX"]) {
    it(`twelve floor-riders in a renumbered ${folder}: each re-learned once, the deleted one gone, never unreachable`, async () => {
      const ids = Array.from({ length: 12 }, (_, i) => `${folder}-${i + 1}`);
      const s = server([[1, ordinary("old-1")]]);
      const inbox = folder === "INBOX";
      const epoch = inbox ? 100n : 300n;
      const first = new Map<number, Msg>(inbox ? [[1, ordinary("old-1")]] : []);
      ids.forEach((id, i) => first.set(2 + i, rider(id)));
      s.state.folders.set(folder, { uidValidity: epoch, msgs: first });
      const { cycle, subjects, events, connection, sidecar } = await boot(rig(s), clock, cleanups, inbox ? { reader: true } : {});
      const poll = async (): Promise<boolean> => {
        clock.skewMs += 20_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const hung = await Promise.race([cycle().then(() => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(true), 15_000); })]);
        clearTimeout(timer);
        return !hung;
      };
      for (let i = 0; i < 12 && (await subjects()).length < 13; i++) if (!(await poll())) break;
      expect((await subjects()).length, "the first read did not drain, so this case proves nothing").toBe(13);

      // The server renumbers the folder: the same letters under new uids and a new epoch, the last
      // one deleted meanwhile; and new mail arrives in INBOX.
      const renumbered = new Map<number, Msg>();
      for (const [uid, m] of first) if (m.id !== ids[11]) renumbered.set(100 + uid, m);
      s.state.folders.set(folder, { uidValidity: epoch + 1n, msgs: renumbered });
      s.state.folders.get("INBOX")!.msgs.set(500, ordinary("new-mail"));
      const bodiesBefore = { ...s.state.bodies };
      const waitsFrom = events.length;
      const instancesIn = async () => (await sidecar.db.select({ uv: messageInstances.uidvalidity })
        .from(messageInstances).where(eq(messageInstances.folder, folder))).map((r) => String(r.uv));
      const unreachableAt: number[] = [];
      let settledAt = -1;
      for (let i = 0; i < 12 && settledAt < 0; i++) {
        if (!(await poll())) break;
        if (!(await connection()).reachable) unreachableAt.push(i);
        const at = await instancesIn();
        if ((await subjects()).includes("new-mail") && at.length === renumbered.size && at.every((uv) => uv === String(epoch + 1n))) settledAt = i;
      }
      const again = Object.fromEntries(Object.entries(s.state.bodies).map(([id, n]) => [id, n - (bodiesBefore[id] ?? 0)]));
      const waits = events.slice(waitsFrom).filter((e) => e.event === "mailbox_reconnect_failed").map((e) => e.detail.retryInMs as number);
      console.log(`RENUMBERED ${folder}`, JSON.stringify({ settledAt, again, waits, unreachableAt }));
      expect(settledAt, "the re-read never re-learned the folder under its new epoch").toBeGreaterThanOrEqual(0);
      for (const m of renumbered.values()) expect(again[m.id], `${m.id} fetched again`).toBe(1);
      expect(again[ids[11]!] ?? 0, "the deleted letter was fetched").toBe(0);
      expect(Math.max(0, ...waits), "a re-dial after re-learned mail climbed the ladder").toBeLessThanOrEqual(15_000 * 1.2);
      expect(unreachableAt, "polls that reported the server unreachable while it answered").toEqual([]);
      expect((await connection()).setAside, "a message inside its own ceiling was set aside").toBe(0);
      expect(events.slice(waitsFrom).some((e) => e.event === "mailbox_redial_after_set_aside"), "no breach was met, so this case proves nothing").toBe(true);
      // The deleted letter is proved gone by the whole-folder read and leaves the mirror.
      const [gone] = await sidecar.db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.subject, ids[11]!));
      expect(gone?.deletedAt, "the letter deleted during the renumbering is still shown").not.toBeNull();
      const [row] = await sidecar.db.select({ uv: mailboxFolders.uidvalidity }).from(mailboxFolders).where(eq(mailboxFolders.folder, folder));
      expect(String(row?.uv)).toBe(String(epoch + 1n));
    });
  }
});

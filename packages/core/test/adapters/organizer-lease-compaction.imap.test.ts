import { describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";

import {
  CLAIM_PROTOCOL,
  META_FOLDER,
  formatClaim,
  isMalformed,
  parseClaim,
} from "../../src/adapters/organizer-lease.js";
import { greenmailConfig } from "./_imapenv.js";
import { rigAppendDate } from "../../../../test/support/rig-append-date.js";

/**
 * The library types both of these as optional and `internalDate` as `Date | string`: a server may
 * answer either, and a reply that carries neither is a case this file has nothing to say about. So
 * they are narrowed HERE, once, and a missing one refuses the read rather than being coerced —
 * comparing two stamps that were never read is how a copy that restamped would look faithful.
 */
function stampOf(m: { internalDate?: Date | string }): number {
  const at = m.internalDate instanceof Date ? m.internalDate.getTime()
    : typeof m.internalDate === "string" ? Date.parse(m.internalDate) : NaN;
  if (!Number.isFinite(at)) throw new Error("the server answered no INTERNALDATE for a record");
  return at;
}

function sourceOf(m: { source?: Buffer }): string {
  if (m.source === undefined) throw new Error("the server answered no source for a record");
  return m.source.toString("utf8");
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE COMPACTION'S ONE ASSUMPTION, ASKED OF A SERVER WE SHIP AGAINST
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The compaction moves a record by copying `ohmail/_meta` into ITSELF and expunging the original.
 * Everything it promises rests on what the server does with that copy, and no in-memory fixture can
 * answer it — a double is only ever as honest as the person who wrote it, and this one would be
 * asserting its own author's belief. So the belief is measured here:
 *
 *  · a folder may be copied into itself at all;
 *  · `COPYUID` comes back, because it is the compaction's only proof that a record survived and
 *    nothing is ever expunged without it;
 *  · the copy carries the ORIGINAL's `INTERNALDATE` — the whole reason this is a COPY and not a
 *    re-APPEND of the same bytes. A restamped claim reads as freshly live and stands a running
 *    install down; a restamped acknowledgement never ages out of the sweep. The record has to
 *    arrive as the same record with a different number;
 *  · and its flags, so a moved record does not turn `ohmail/_meta` unread in somebody's mail app.
 *
 * The high-uid arms are not here: GreenMail cannot be told which uid to mint, and reaching the
 * span by appending would be thousands of round trips per case. Those run on the fake that can
 * PLACE a uid (`organizer-lease-meta-compaction.test.ts`); this file answers the question the fake
 * cannot.
 */

const NOW = new Date();
const TEST_META_ID = { installId: "compaction-install", mailboxId: "compaction-mailbox" };

function ourClaim(): string {
  return formatClaim({
    installId: TEST_META_ID.installId,
    kind: "cloud",
    displayName: "Cloud",
    claimedAt: new Date(NOW.getTime() - 60_000),
    heartbeat: new Date(NOW.getTime() - 1_000),
    nonce: "compaction-nonce",
    authorizedAt: new Date(NOW.getTime() - 60_000),
    capabilities: ["requests"],
    protocol: CLAIM_PROTOCOL,
  });
}

describe("ohmail/_meta copied into itself, on GreenMail", () => {
  it("keeps the record's stamp, its flags and its identity, and says where it landed", async () => {
    const cfg = greenmailConfig();
    /* The RAW connection throughout: this case is about what the SERVER does with one command, so
       nothing the adapter decides should be able to stand between the question and the answer. */
    const raw = new ImapFlow({
      host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false,
    });
    await raw.connect();
    try {
      await raw.mailboxCreate("ohmail/_meta").catch(() => { /* already there */ });
      const metaPath = (await raw.list())
        .map((m) => m.path)
        .find((p) => p.toLowerCase().endsWith("_meta"));
      expect(metaPath, `${META_FOLDER} was not created on the server`).toBeDefined();
      await raw.append(metaPath as string, ourClaim(), ["\\Seen"]);
      {
        const lock = await raw.getMailboxLock(metaPath as string);
        let uidValidity: string;
        const before: Array<{ uid: number; internalDate: number; flags: string[]; raw: string }> = [];
        let copied: Map<number, number> | undefined;
        try {
          /* READ BACK FROM THE SERVER, never derived: GreenMail 2.1.3 stamps UIDVALIDITY per
             MAILBOX at creation from a second-resolution clock, so a test that assumes 1 — or
             assumes two users share one — is asserting about a folder it invented. */
          const st = await raw.status(metaPath as string, { uidValidity: true, uidNext: true });
          uidValidity = String(st.uidValidity);
          expect(uidValidity, "the server did not report a generation for the folder").not.toBe("undefined");

          for await (const m of raw.fetch("1:*", { uid: true, internalDate: true, flags: true, source: true })) {
            before.push({
              uid: m.uid,
              internalDate: stampOf(m),
              flags: [...(m.flags ?? [])].sort(),
              raw: sourceOf(m),
            });
          }
          expect(before.length, "the claim this case is about is not in the folder").toBe(1);

          const reply = await raw.messageCopy(
            before.map((m) => m.uid), metaPath as string, { uid: true },
          );
          copied = (reply as { uidMap?: Map<number, number> }).uidMap;
        } finally {
          lock.release();
        }

        expect(copied, "the server copied the folder into itself without saying where it landed")
          .toBeInstanceOf(Map);
        const landedAt = copied?.get(before[0]!.uid);
        expect(landedAt, "COPYUID did not name the record this pass copied").toBeDefined();
        expect(landedAt, "the copy did not get a uid above the original's").toBeGreaterThan(before[0]!.uid);

        const lock2 = await raw.getMailboxLock(metaPath as string);
        try {
          const st2 = await raw.status(metaPath as string, { uidValidity: true });
          expect(String(st2.uidValidity),
            "the folder was renumbered by a copy into itself").toBe(uidValidity);

          const after: Array<{ uid: number; internalDate: number; flags: string[]; raw: string }> = [];
          for await (const m of raw.fetch("1:*", { uid: true, internalDate: true, flags: true, source: true })) {
            after.push({
              uid: m.uid,
              internalDate: stampOf(m),
              flags: [...(m.flags ?? [])].sort(),
              raw: sourceOf(m),
            });
          }
          const moved = after.find((m) => m.uid === landedAt);
          expect(moved, "the copy is not in the folder").toBeDefined();

          /* THE THREE THINGS THE COMPACTION PROMISES ABOUT A MOVED RECORD. */
          expect(moved?.internalDate,
            "the server restamped the copy, so a stale claim would read as freshly live")
            .toBe(before[0]!.internalDate);
          expect(moved?.flags,
            "the copy lost its flags, so a moved record turns the folder unread in a mail app")
            .toEqual(before[0]!.flags);

          const original = parseClaim(before[0]!.raw, before[0]!.uid);
          const carried = parseClaim(moved!.raw, moved!.uid);
          expect(carried !== null && !isMalformed(carried),
            "the moved record no longer parses as the claim it was").toBe(true);
          expect(carried !== null && !isMalformed(carried) ? carried.nonce : null,
            "the moved claim is not the claim that was moved")
            .toBe(original !== null && !isMalformed(original) ? original.nonce : "<unparsed>");
        } finally {
          lock2.release();
        }
      }
    } finally {
      await raw.logout();
    }
  }, 60_000);

  /**
   * THE CONTROL THAT MAKES THE CASE ABOVE MEAN SOMETHING — the same record put back the other way.
   *
   * "The copy kept its stamp" is only evidence if a re-APPEND of the same bytes does not. If both
   * behaved alike the choice of verb would be arbitrary and the assertion above would be passing
   * for nothing; this is the measurement that says the compaction had to be a copy.
   */
  it("CONTROL: the same bytes re-APPENDED are restamped, which is why the move is a copy", async () => {
    const cfg = greenmailConfig();
    const raw = new ImapFlow({
      host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false,
    });
    await raw.connect();
    try {
      await raw.mailboxCreate("ohmail/_meta").catch(() => { /* already there */ });
      const metaPath = (await raw.list())
        .map((m) => m.path)
        .find((p) => p.toLowerCase().endsWith("_meta")) as string;
      /* A record filed two days ago, off GreenMail's 12:xx hour and without the wall clock's
         milliseconds, which an IMAP date-time has no field for (the FIXTURE case below). */
      const old = rigAppendDate(2 * 24 * 3_600_000, NOW.getTime());
      await raw.append(metaPath, ourClaim(), ["\\Seen"], old);

      const lock = await raw.getMailboxLock(metaPath);
      try {
        const first: Array<{ uid: number; at: number; raw: string }> = [];
        for await (const m of raw.fetch("1:*", { uid: true, internalDate: true, source: true })) {
          first.push({ uid: m.uid, at: stampOf(m), raw: sourceOf(m) });
        }
        expect(first.length, "the record this control is about is not in the folder").toBe(1);
        expect(Math.abs(first[0]!.at - old.getTime()),
          "the server did not file the record at the date it was given").toBeLessThan(60_000);

        await raw.append(metaPath, first[0]!.raw, ["\\Seen"]);
        const stamps: number[] = [];
        for await (const m of raw.fetch("1:*", { uid: true, internalDate: true })) {
          stamps.push(stampOf(m));
        }
        expect(stamps.length, "the re-append did not land").toBe(2);
        expect(Math.max(...stamps) - Math.min(...stamps),
          "a re-append kept the original's stamp, so this file's copy proves nothing")
          .toBeGreaterThan(24 * 3_600_000);
      } finally {
        lock.release();
      }
    } finally {
      await raw.logout();
    }
  }, 60_000);

  /**
   * THE FIXTURE BEHAVIOUR THE CASE ABOVE STEPS AROUND, documented rather than hidden.
   *
   * ImapFlow sends a correct 24-hour date-time; GreenMail's own APPEND parse reads it with a
   * twelve-hour pattern and an AM default, so noon files at midnight. Every wall-clock APPEND date
   * comes from test/support/rig-append-date.ts for that reason, and this asserts the reason is
   * real — if GreenMail ever fixes it this goes red and that helper stops being needed.
   */
  it("FIXTURE: GreenMail files a 12:xx UTC append at 00:xx — the reason APPEND dates skip that hour", async () => {
    const cfg = greenmailConfig();
    const raw = new ImapFlow({
      host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false,
    });
    await raw.connect();
    try {
      const box = "ohmail/_meta_noonprobe";
      await raw.mailboxCreate(box).catch(() => { /* already there */ });
      const noon = new Date(Date.UTC(2026, 9, 27, 12, 34, 56, 0));
      await raw.append(box, ourClaim(), ["\\Seen"], noon);
      const lock = await raw.getMailboxLock(box);
      try {
        const stamps: number[] = [];
        for await (const m of raw.fetch("1:*", { uid: true, internalDate: true })) stamps.push(stampOf(m));
        expect(stamps.length, "the probe record is not in its own folder").toBe(1);
        /* TWELVE HOURS EARLY, to the second: 12:34:56 filed at 00:34:56. Asserted as the exact
           shape rather than "not equal", so a DIFFERENT fixture fault cannot pass as this one. */
        expect(noon.getTime() - stamps[0]!, "GreenMail no longer files a noon append at midnight")
          .toBe(12 * 3_600_000);
      } finally {
        lock.release();
      }
    } finally {
      await raw.logout();
    }
  }, 60_000);
});

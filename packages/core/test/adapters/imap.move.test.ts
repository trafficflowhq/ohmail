import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, MoveVerifyError, SameFolderMoveError, parseRef } from "../../src/adapters/imap.js";
import { greenmailConfig, eml, seedInbox } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

async function raw(cfg: ReturnType<typeof greenmailConfig>) {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}

describe("ImapAdapter.move (GreenMail)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("moves and returns a NEW locator in the destination; message is gone from source", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const src = await seedInbox(cfg, "move1@x");

    const newLoc = await adapter.move({ folder: "INBOX", ref: src.ref }, "ohmail/News", FIXTURE_DOOR);
    expect(newLoc.folder).toBe("ohmail/News");
    expect(parseRef(newLoc.ref).uid).toBeGreaterThan(0);

    // verify: present in Feed under the new uid, absent from INBOX
    const c = await raw(cfg);
    const inFeed = await (async () => { const l = await c.getMailboxLock("ohmail.News"); try { return await c.search({ header: { "message-id": "move1@x" } }, { uid: true }); } finally { l.release(); } })();
    const inInbox = await (async () => { const l = await c.getMailboxLock("INBOX"); try { return await c.search({ header: { "message-id": "move1@x" } }, { uid: true }); } finally { l.release(); } })();
    await c.logout();
    expect(Array.isArray(inFeed) && inFeed.length).toBeTruthy();
    expect(Array.isArray(inInbox) ? inInbox.length : 1).toBe(0);
  });

  it("learns the new UID via the search-by-Message-ID fallback when UIDPLUS is unavailable", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { uidplus: false } });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const src = await seedInbox(cfg, "move2@x");

    const newLoc = await adapter.move({ folder: "INBOX", ref: src.ref }, "ohmail/Screened", FIXTURE_DOOR);
    expect(newLoc.folder).toBe("ohmail/Screened");
    expect(parseRef(newLoc.ref).uid).toBeGreaterThan(0);
  });

  /**
   * ── THE DESTINATION UID IS PROVED, NOT GUESSED ────────────────────────────────
   *
   * The no-COPYUID fallback learned the new UID with
   * `search({ header: { "message-id": inner } })` and then `Math.max(...found)`. A Message-ID is
   * chosen by whoever sent the mail, so two messages in the destination can share one — a stranger
   * only has to name the id of a message the user holds. `Math.max` takes the HIGHEST UID, which is
   * the most recently delivered, which is the attacker's. The row's locator then points at their
   * bytes, and `GET /attachments/:id` and reply quoting both read through it.
   *
   * Here the destination is pre-loaded with a DECOY sharing the Message-ID and appended AFTER the
   * copy, so the decoy holds the higher UID. The full-fingerprint verify has to pick ours.
   */
  it("picks OUR bytes, not the highest UID, when the destination shares a Message-ID", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { uidplus: false, move: false } });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const src = await seedInbox(cfg, "collide@x");

    // The copy lands first; the decoy is appended after it, so the decoy gets the HIGHER uid.
    const newLoc = await adapter.move({ folder: "INBOX", ref: src.ref }, "ohmail/Screened", FIXTURE_DOOR);

    const c = await raw(cfg);
    const l = await c.getMailboxLock("ohmail.Screened");
    let ours = 0;
    let decoy = 0;
    try {
      ours = parseRef(newLoc.ref).uid;
      await c.append("ohmail.Screened", eml({
        from: "attacker@evil.example", subject: "mv", messageId: "collide@x",
      }));
      const found = await c.search({ header: { "message-id": "collide@x" } }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      decoy = Math.max(...uids);
      // The premise: the decoy really does hold a higher UID than ours, so `Math.max` would take it.
      expect(decoy).toBeGreaterThan(ours);
    } finally { l.release(); await c.logout(); }

    // And a SECOND move of the same logical message, with the decoy now sitting at the destination
    // holding the HIGHER uid. This is the assertion that names the finding directly: `Math.max`
    // would answer `decoy`, and the fingerprint answers OURS.
    const src2 = await seedInbox(cfg, "collide@x");
    const second = await adapter.move({ folder: "INBOX", ref: src2.ref }, "ohmail/Screened", FIXTURE_DOOR);
    expect(parseRef(second.ref).uid, "the attacker's higher UID must never be adopted")
      .not.toBe(decoy);
    expect(parseRef(second.ref).uid, "our own copy, proved by full fingerprint").toBe(ours);
  });

  /**
   * ── THE DESTINATION PRE-CHECK: A MOVE THAT ALREADY COPIED IS FINISHED, NOT REPEATED ─────────
   *
   * COPY-then-EXPUNGE has a window. When the expunge does not happen the message is in both
   * folders, and the retry used to COPY AGAIN — the destination grew by one identical message
   * every cycle, and the verify, which requires exactly one fingerprint match, then found several
   * and refused for ever.
   *
   * Seeded verbatim here: a copy already at the destination, the source still in INBOX. The move
   * must recognise its own completed copy, write NOTHING to the destination, and expunge the
   * source — leaving exactly one RFC822 message in the whole mailbox.
   */
  it("adopts an already-copied message instead of copying it again, and expunges the source", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { uidplus: false, move: false } });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const body = eml({ from: "s@x.example", subject: "mv", messageId: "interrupted@x" });
    const c0 = await raw(cfg);
    const l0 = await c0.getMailboxLock("ohmail.News");
    try { await c0.append("ohmail.News", body); } finally { l0.release(); await c0.logout(); }
    const src = await seedInbox(cfg, "interrupted@x");

    const newLoc = await adapter.move({ folder: "INBOX", ref: src.ref }, "ohmail/News", FIXTURE_DOOR);
    expect(newLoc.folder).toBe("ohmail/News");

    const c = await raw(cfg);
    const inDst = await (async () => {
      const l = await c.getMailboxLock("ohmail.News");
      try { return await c.search({ header: { "message-id": "interrupted@x" } }, { uid: true }); }
      finally { l.release(); }
    })();
    const inSrc = await (async () => {
      const l = await c.getMailboxLock("INBOX");
      try { return await c.search({ header: { "message-id": "interrupted@x" } }, { uid: true }); }
      finally { l.release(); }
    })();
    await c.logout();

    // THE ACCEPTANCE CRITERION. Remove the pre-check and the destination holds two.
    expect(Array.isArray(inDst) ? inDst.length : 0, "no second copy may be made").toBe(1);
    expect(Array.isArray(inSrc) ? inSrc.length : 1, "the source must be expunged").toBe(0);
    expect(parseRef(newLoc.ref).uid).toBe((inDst as number[])[0]);
  });

  /**
   * The same, on a server that advertises UIDPLUS. This is the branch that is easy to get wrong:
   * COPYUID names a NEW copy, it does not stop one being made, and UIDPLUS and MOVE are separate
   * capabilities — so a UIDPLUS server can still take the interruptible COPY path. Gate the
   * pre-check on `!caps.uidplus` and this test is the only thing that notices.
   */
  it("pre-checks the destination on a UIDPLUS server too", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { uidplus: true, move: false } });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const body = eml({ from: "s@x.example", subject: "mv", messageId: "uidplus-dup@x" });
    const c0 = await raw(cfg);
    const l0 = await c0.getMailboxLock("ohmail.News");
    try { await c0.append("ohmail.News", body); } finally { l0.release(); await c0.logout(); }
    const src = await seedInbox(cfg, "uidplus-dup@x");

    await adapter.move({ folder: "INBOX", ref: src.ref }, "ohmail/News", FIXTURE_DOOR);

    const c = await raw(cfg);
    const inDst = await (async () => {
      const l = await c.getMailboxLock("ohmail.News");
      try { return await c.search({ header: { "message-id": "uidplus-dup@x" } }, { uid: true }); }
      finally { l.release(); }
    })();
    await c.logout();
    expect(Array.isArray(inDst) ? inDst.length : 0, "COPYUID does not stop a copy being made")
      .toBe(1);
  });

  /**
   * ── AND THE SOURCE IS NOT EXPUNGED BEFORE THE DESTINATION IS KNOWN ─────────────────────────
   *
   * `messageDelete` used to run inside phase 1, BEFORE the verify. A `MoveVerifyError` therefore
   * left the message already gone from the source AND the database pointing at a UID that never
   * existed — the message was nowhere anyone could name. With the delete in phase 3, a failed verify
   * leaves a duplicate on the server, which the next `changesSince` observes and reconciles.
   */
  it("leaves the SOURCE in place, and adds nothing, when the destination is ambiguous", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { uidplus: false, move: false } });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    // TWO byte-identical copies already in the destination. Byte-identical is what makes the
    // candidate set genuinely unresolvable — a decoy with a different body is separated by the
    // fingerprint, which is an earlier test, and a SINGLE identical copy is this move's own
    // completed work, which is the pre-check case. Two cannot be told apart by any amount of
    // content inspection, so the only honest answer is to refuse.
    const dup = eml({ from: "s@x.example", subject: "mv", messageId: "amb@x" });
    const c0 = await raw(cfg);
    const l0 = await c0.getMailboxLock("ohmail.Receipts");
    try {
      await c0.append("ohmail.Receipts", dup);
      await c0.append("ohmail.Receipts", dup);
    } finally { l0.release(); await c0.logout(); }
    const src = await seedInbox(cfg, "amb@x");

    await expect(adapter.move({ folder: "INBOX", ref: src.ref }, "ohmail/Receipts", FIXTURE_DOOR))
      .rejects.toBeInstanceOf(MoveVerifyError);

    const c = await raw(cfg);
    const still = await (async () => {
      const l = await c.getMailboxLock("INBOX");
      try { return await c.search({ header: { "message-id": "amb@x" } }, { uid: true }); }
      finally { l.release(); }
    })();
    // AND NOTHING WAS ADDED. Refusing after the copy is what made the duplicate grow by one every
    // cycle; the refusal now happens before anything is written.
    const dst = await (async () => {
      const l = await c.getMailboxLock("ohmail.Receipts");
      try { return await c.search({ header: { "message-id": "amb@x" } }, { uid: true }); }
      finally { l.release(); }
    })();
    await c.logout();
    // THE SOURCE IS STILL THERE. Move `messageDelete` back before the verify and this is 0.
    expect(Array.isArray(still) ? still.length : 0).toBe(1);
    expect(Array.isArray(dst) ? dst.length : 0, "an ambiguous destination must not grow").toBe(2);
  });

  /**
   * A stranger who names a `Message-ID` the mailbox already holds must not be able to BLOCK a
   * move either. The pre-check finds their message as a candidate, the fingerprint rejects it, and
   * the copy proceeds normally — the mirror image of the adopt case, and the reason `candidates`
   * and `matches` are counted separately.
   */
  it("a destination decoy that is not ours does not block the copy", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { uidplus: false, move: false } });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const c0 = await raw(cfg);
    const l0 = await c0.getMailboxLock("ohmail.Screened");
    try {
      await c0.append("ohmail.Screened", eml({
        from: "attacker@evil.example", subject: "mv", messageId: "block@x",
      }));
    } finally { l0.release(); await c0.logout(); }
    const src = await seedInbox(cfg, "block@x");

    const newLoc = await adapter.move({ folder: "INBOX", ref: src.ref }, "ohmail/Screened", FIXTURE_DOOR);

    const c = await raw(cfg);
    const gone = await (async () => {
      const l = await c.getMailboxLock("INBOX");
      try { return await c.search({ header: { "message-id": "block@x" } }, { uid: true }); }
      finally { l.release(); }
    })();
    await c.logout();
    expect(parseRef(newLoc.ref).uid).toBeGreaterThan(0);
    expect(Array.isArray(gone) ? gone.length : 1, "the move must still complete").toBe(0);
  });

  it("uses COPY+EXPUNGE when MOVE is unavailable", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { move: false } });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const src = await seedInbox(cfg, "move3@x");

    const newLoc = await adapter.move({ folder: "INBOX", ref: src.ref }, "ohmail/Receipts", FIXTURE_DOOR);
    expect(newLoc.folder).toBe("ohmail/Receipts");
    const c = await raw(cfg);
    const gone = await (async () => { const l = await c.getMailboxLock("INBOX"); try { return await c.search({ header: { "message-id": "move3@x" } }, { uid: true }); } finally { l.release(); } })();
    await c.logout();
    expect(Array.isArray(gone) ? gone.length : 1).toBe(0);
  });

  it("refuses a move into the folder the message is already in, and the letter stays where it is", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    const src = await seedInbox(cfg, "same1@x");
    const at = { folder: "INBOX", ref: src.ref };
    const asked = (p: Promise<unknown>) => p.then(() => "moved", (e: unknown) => e);
    const outcomes = [
      await asked(adapter.move(at, "INBOX", FIXTURE_DOOR)),
      await asked(adapter.moveMany([at], "INBOX", FIXTURE_DOOR)),
    ];
    const c = await raw(cfg);
    const l = await c.getMailboxLock("INBOX");
    const here = await c.search({ header: { "message-id": "same1@x" } }, { uid: true }).finally(() => l.release());
    await c.logout();
    expect(here, "the move expunged the only copy").toEqual([src.uid]);
    for (const o of outcomes) expect(o).toBeInstanceOf(SameFolderMoveError);
  });
});

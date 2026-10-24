import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { DestinationMissingError, ImapAdapter, parseRef, FILING_BATCH_MAX } from "../../src/adapters/imap.js";
import { greenmailConfig, eml } from "./_imapenv.js";
import type { NativeLocator } from "../../src/adapters/imap-types.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * ── WHAT A BATCH IS ALLOWED TO DO TO SOMEBODY'S MAILBOX ────────────────────────────────────
 *
 * `moveMany` exists because filing one message at a time cost five IMAP commands each — minutes
 * for one long production screening session, all of it inside the worker's
 * serial cycle. Speed is not the property under test here. The property is that the server's
 * folders end up EXACTLY where filing each message on its own would have put them, and that every
 * case the batch cannot prove that for is refused with nothing written.
 *
 * Every assertion below therefore reads the SERVER, not the return value, wherever the server can
 * answer — a method that reported success and moved nothing would satisfy the return contract.
 */

const cfgFor = () => greenmailConfig();

async function raw(cfg: ReturnType<typeof greenmailConfig>) {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}

/** Append `n` messages to INBOX and return their locators, newest last. */
async function seedInbox(
  cfg: ReturnType<typeof greenmailConfig>, ids: readonly string[],
): Promise<NativeLocator[]> {
  const c = await raw(cfg);
  const out: NativeLocator[] = [];
  const lock = await c.getMailboxLock("INBOX");
  try {
    const uidValidity = String((c.mailbox as { uidValidity: bigint }).uidValidity);
    for (const id of ids) {
      const res = await c.append("INBOX", eml({ from: "s@x.example", subject: id, messageId: id }));
      const uid = res && typeof res !== "boolean" ? res.uid : 0;
      out.push({ folder: "INBOX", ref: `${uidValidity}:${uid}` });
    }
  } finally { lock.release(); await c.logout(); }
  return out;
}

/** The Message-IDs a folder holds, as a set — the server's own answer about where mail is. */
async function idsIn(cfg: ReturnType<typeof greenmailConfig>, serverPath: string): Promise<Set<string>> {
  const c = await raw(cfg);
  const lock = await c.getMailboxLock(serverPath);
  const found = new Set<string>();
  try {
    for await (const m of c.fetch("1:*", { uid: true, envelope: true })) {
      const id = m.envelope?.messageId;
      if (id) found.add(id.replace(/[<>]/g, ""));
    }
  } catch { /* an empty mailbox answers no messages, not an error worth failing on */ } finally {
    lock.release(); await c.logout();
  }
  return found;
}

describe("ImapAdapter.moveMany (GreenMail)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("files the whole group: every message at the destination, none left at the source", async () => {
    const cfg = cfgFor();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const ids = Array.from({ length: 12 }, (_, i) => `mm-ok-${i}@x`);
    const locs = await seedInbox(cfg, ids);

    const res = await adapter.moveMany(locs, "ohmail/News", FIXTURE_DOOR);

    expect(res.outcome, "a UIDPLUS + MOVE server must take the batched path").toBe("batched");
    expect(res.gone).toEqual([]);
    expect(res.moved.size).toBe(ids.length);
    // The locators must name the DESTINATION and a real UID — a batch that answered with the
    // source's UIDs would leave every row pointing at bytes that are no longer there.
    for (const loc of locs) {
      const next = res.moved.get(loc.ref);
      expect(next, `no destination locator for ${loc.ref}`).toBeDefined();
      expect(next!.folder).toBe("ohmail/News");
      expect(parseRef(next!.ref).uid).toBeGreaterThan(0);
    }
    // …and the server agrees.
    expect(await idsIn(cfg, "ohmail.News")).toEqual(new Set(ids));
    expect(await idsIn(cfg, "INBOX")).toEqual(new Set());
  });

  /**
   * THE PRE-CHECK, ASKED ONCE FOR THE GROUP.
   *
   * `move` refuses to write when the destination already holds something sharing the message's
   * Message-ID: the copy may be ours (adopt and expunge), may be a stranger's (a Message-ID is
   * chosen by whoever sent the mail), and telling them apart is a per-message fingerprint verify.
   * The batch has no way to do that for one member without doing it for all of them, so ONE hit
   * sends the whole chunk back — and it must do so having written NOTHING, or the fallback would
   * be filing a group whose other half has already moved.
   */
  it("refuses the whole chunk, without writing, when the destination shares a Message-ID", async () => {
    const cfg = cfgFor();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const ids = ["mm-collide-a@x", "mm-collide-b@x", "mm-collide-c@x"];
    const locs = await seedInbox(cfg, ids);
    // A decoy at the destination naming ONE of the group's Message-IDs. Different bytes, so it is
    // a candidate and not a match — exactly the case `move` resolves by fingerprint.
    {
      const c = await raw(cfg);
      await c.append("ohmail.News", eml({ from: "stranger@x.example", subject: "decoy", messageId: "mm-collide-b@x", body: "not ours" }));
      await c.logout();
    }

    const res = await adapter.moveMany(locs, "ohmail/News", FIXTURE_DOOR);

    expect(res.outcome, "a Message-ID hit at the destination must refuse the batch").toBe("declined");
    expect(res.moved.size).toBe(0);
    // NOTHING WRITTEN is the load-bearing half: all three are still in INBOX and the destination
    // still holds only the decoy.
    expect(await idsIn(cfg, "INBOX")).toEqual(new Set(ids));
    expect(await idsIn(cfg, "ohmail.News")).toEqual(new Set(["mm-collide-b@x"]));
  });

  /**
   * A UID THE SOURCE NO LONGER HOLDS IS `gone`, NOT A THROW — and the rest still file.
   *
   * This is the batch's `MessageGoneError`, and it is the ordinary shape of a crash between a
   * completed IMAP move and the database write that records it: the message really is at the
   * destination, the row really is still pending, and the next `changesSince` adopts it. Throwing
   * would let one such row cost the other forty-nine their pass.
   */
  it("reports a vanished message as gone and files the rest", async () => {
    const cfg = cfgFor();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const ids = ["mm-gone-a@x", "mm-gone-b@x", "mm-gone-c@x"];
    const locs = await seedInbox(cfg, ids);
    // A locator for a UID that was never issued — the same fact as a message expunged since the
    // database read, and reachable without racing the server.
    const phantom: NativeLocator = { folder: "INBOX", ref: `${parseRef(locs[0]!.ref).uidValidity}:99999` };

    const res = await adapter.moveMany([...locs, phantom], "ohmail/Screened", FIXTURE_DOOR);

    expect(res.outcome).toBe("batched");
    expect(res.gone.map((l) => l.ref)).toEqual([phantom.ref]);
    expect(res.moved.size).toBe(ids.length);
    expect(await idsIn(cfg, "ohmail.Screened")).toEqual(new Set(ids));
    expect(await idsIn(cfg, "INBOX")).toEqual(new Set());
  });

  /**
   * RESUME AFTER A PARTIAL FAILURE CONVERGES ON ONE COPY.
   *
   * The state a dropped connection leaves is: the server moved the mail, the database still calls
   * the rows pending. The next pass re-presents the SAME locators. It must not move anything a
   * second time, must not produce a duplicate, and must report the whole group as gone so the
   * caller leaves the rows for `changesSince` to adopt.
   */
  it("a replayed batch moves nothing again and reports the group gone", async () => {
    const cfg = cfgFor();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const ids = ["mm-replay-a@x", "mm-replay-b@x"];
    const locs = await seedInbox(cfg, ids);

    const first = await adapter.moveMany(locs, "ohmail/News", FIXTURE_DOOR);
    expect(first.outcome).toBe("batched");

    // The database never learned about the first pass, so the same locators come round again.
    const second = await adapter.moveMany(locs, "ohmail/News", FIXTURE_DOOR);

    expect(second.outcome, "a replay is answerable — every member is simply gone").toBe("batched");
    expect(second.moved.size).toBe(0);
    expect(second.gone.map((l) => l.ref).sort()).toEqual(locs.map((l) => l.ref).sort());
    // ONE copy each, which is the whole point: a COPY-based retry would have made a second.
    expect(await idsIn(cfg, "ohmail.News")).toEqual(new Set(ids));
    expect(await idsIn(cfg, "INBOX")).toEqual(new Set());
  });

  /**
   * The caller chunks; the adapter refuses to be handed more than a chunk. See
   * {@link FILING_BATCH_MAX} — the ceiling exists because the destination pre-check is ONE
   * command holding one term per member, and an unbounded group builds one no server will take.
   */
  it("refuses a group larger than FILING_BATCH_MAX rather than building an unbounded command", async () => {
    const cfg = cfgFor();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    const tooMany: NativeLocator[] = Array.from(
      { length: FILING_BATCH_MAX + 1 }, (_, i) => ({ folder: "INBOX", ref: `1:${i + 1}` }),
    );
    await expect(adapter.moveMany(tooMany, "ohmail/News", FIXTURE_DOOR)).rejects.toThrow(/FILING_BATCH_MAX/);
  });

  it("refuses a group that does not share one source folder", async () => {
    const cfg = cfgFor();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await expect(adapter.moveMany(
      [{ folder: "INBOX", ref: "1:1" }, { folder: "ohmail/Screener", ref: "1:2" }], "ohmail/News", FIXTURE_DOOR,
    )).rejects.toThrow(/one source folder/);
  });

  /**
   * NO ATOMIC MOVE ⇒ NO BATCH. Without `MOVE` the server does COPY-then-EXPUNGE, which has a
   * window in which the message exists in both folders, and closing that window correctly is
   * per-message work. The refusal must happen before anything is written.
   */
  it("declines to batch on a server without MOVE, leaving the mail where it was", async () => {
    const cfg = cfgFor();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { move: false } });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const ids = ["mm-nomove-a@x", "mm-nomove-b@x"];
    const locs = await seedInbox(cfg, ids);

    const res = await adapter.moveMany(locs, "ohmail/News", FIXTURE_DOOR);

    expect(res.outcome).toBe("declined");
    expect(await idsIn(cfg, "INBOX")).toEqual(new Set(ids));
  });

  /** No COPYUID ⇒ the destination UIDs would have to be recovered per message by fingerprint. */
  it("declines to batch on a server without UIDPLUS, leaving the mail where it was", async () => {
    const cfg = cfgFor();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { uidplus: false } });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const ids = ["mm-nouidplus-a@x", "mm-nouidplus-b@x"];
    const locs = await seedInbox(cfg, ids);

    const res = await adapter.moveMany(locs, "ohmail/News", FIXTURE_DOOR);

    expect(res.outcome).toBe("declined");
    expect(await idsIn(cfg, "INBOX")).toEqual(new Set(ids));
  });

  it("a destination another client deleted: the batch names it missing and writes nothing", async () => {
    const cfg = cfgFor();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const ids = ["mm-gone-a@x", "mm-gone-b@x"];
    const locs = await seedInbox(cfg, ids);
    const c = await raw(cfg);
    await c.mailboxDelete("ohmail.Receipts");
    await c.logout();

    const err = await adapter.moveMany(locs, "ohmail/Receipts", FIXTURE_DOOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DestinationMissingError);
    expect(await idsIn(cfg, "INBOX")).toEqual(new Set(ids));
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import type { ChangeBatch, ImapCursor } from "../../src/adapters/imap-types.js";
import { greenmailConfig, eml } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * THE BOUNDED BACKFILL (the 2026-08-01 outage).
 *
 * `changesSince` used to fetch `source: true` for EVERY unknown UID in one pass, so the first
 * sync of a real mailbox materialised the whole thing — bodies included — in one array. On a
 * small Railway container an ordinary mailbox ran it out of memory and it was SIGKILLed; because
 * the folder cursor is only persisted after the whole batch commits, every restart re-fetched
 * from scratch and the worker crash-looped with `mailbox_folders` permanently empty.
 *
 * The contract these tests pin:
 *   • a cold sync returns at most `maxBatchMessages` creates, newest first;
 *   • while a folder's backlog is truncated its cursor is HELD at the previous value — a
 *     `highestModseq` advanced past uncommitted mail would skip it forever;
 *   • `hasBacklog` says another pass is owed, and the cursor advances only on the pass that
 *     genuinely drained the folder.
 */
async function raw(cfg: ReturnType<typeof greenmailConfig>) {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}

const FOLDERS = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];

function emptyCursor(): ImapCursor {
  const folders: ImapCursor["folders"] = {};
  for (const f of FOLDERS) folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders };
}

/** Roll the cursor forward exactly as `sync.ts` does: persisted part + the locators just committed. */
function advance(cur: ImapCursor, batch: ChangeBatch): ImapCursor {
  const next: ImapCursor = { folders: {} };
  for (const f of FOLDERS) {
    const learned = [...batch.creates, ...batch.moves]
      .filter((c) => c.locator.folder === f)
      .map((c) => ({ uid: parseRef(c.locator.ref).uid, messageId: null as string | null }));
    next.folders[f] = { ...batch.newCursor.folders[f], known: [...(cur.folders[f]?.known ?? []), ...learned] };
  }
  return next;
}

const uidsOf = (b: ChangeBatch): number[] => b.creates.map((c) => parseRef(c.locator.ref).uid).sort((a, z) => a - z);

describe("ImapAdapter.changesSince — bounded backfill", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("caps a cold sync at maxBatchMessages, holds the cursor while truncated, and drains newest-first", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { condstore: false }, maxBatchMessages: 10 });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const c = await raw(cfg);
    for (let i = 1; i <= 25; i++) {
      await c.append("INBOX", eml({ from: "anna@x.example", subject: `s${i}`, messageId: `m${i}@x` }));
    }

    // ── pass 1: capped, newest first, cursor HELD at the zero cursor ────────────────────
    let cur = emptyCursor();
    const b1 = await adapter.changesSince(cur);
    expect(b1.creates).toHaveLength(10);
    expect(b1.hasBacklog).toBe(true);
    expect(uidsOf(b1)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    // The cursor must NOT advance: these 25 messages are not all committed yet, and a
    // highestModseq past them is mail that is never fetched again.
    /* `serverExists` — the server's own EXISTS for the folder, added to the cursor by
     * a later change and asserted here because this is an exact-shape check: a field the adapter
     * publishes and no test names is a field nothing guards. It is deliberately NOT held back
     * under truncation the way the three cursors above it are (a count is what the folder holds
     * right now; a cursor that advanced past unread work would lose mail), so it reads 25 on
     * every pass of this drain while `uidNext` and `highestModseq` stay pinned. */
    expect(b1.newCursor.folders["INBOX"]).toEqual({ uidValidity: "0", uidNext: 0, highestModseq: "0", serverExists: 25 });

    // ── pass 2: the next ten, still truncated ───────────────────────────────────────────
    cur = advance(cur, b1);
    const b2 = await adapter.changesSince(cur);
    expect(b2.creates).toHaveLength(10);
    expect(b2.hasBacklog).toBe(true);
    expect(uidsOf(b2)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(b2.newCursor.folders["INBOX"]).toEqual({ uidValidity: "0", uidNext: 0, highestModseq: "0", serverExists: 25 });

    // ── pass 3: the tail drains, and NOW the cursor is allowed to advance ───────────────
    cur = advance(cur, b2);
    const b3 = await adapter.changesSince(cur);
    expect(b3.creates).toHaveLength(5);
    expect(b3.hasBacklog).toBe(false);
    expect(uidsOf(b3)).toEqual([1, 2, 3, 4, 5]);
    expect(b3.newCursor.folders["INBOX"].uidValidity).not.toBe("0");
    expect(b3.newCursor.folders["INBOX"].uidNext).toBeGreaterThan(25);

    // ── pass 4: fully drained, nothing owed ─────────────────────────────────────────────
    cur = advance(cur, b3);
    const b4 = await adapter.changesSince(cur);
    expect(b4.creates).toHaveLength(0);
    expect(b4.hasBacklog).toBe(false);

    // Every message arrived exactly once across the drain.
    const all = [...uidsOf(b1), ...uidsOf(b2), ...uidsOf(b3)].sort((a, z) => a - z);
    expect(all).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    await c.logout();
  }, 60_000);

  it("takes a per-call limit that only lowers the cap, as an ordinary truncated batch", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { condstore: false }, maxBatchMessages: 10 });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const c = await raw(cfg);
    for (let i = 1; i <= 25; i++) {
      await c.append("INBOX", eml({ from: "anna@x.example", subject: `l${i}`, messageId: `l${i}@x` }));
    }

    let cur = emptyCursor();
    const b1 = await adapter.changesSince(cur, { messages: 3 });
    expect(uidsOf(b1)).toEqual([23, 24, 25]);
    expect(b1.hasBacklog).toBe(true);
    // Held, exactly as under the adapter's own cap.
    expect(b1.newCursor.folders["INBOX"]).toEqual({ uidValidity: "0", uidNext: 0, highestModseq: "0", serverExists: 25 });

    // A limit above the adapter's own cap is the cap, never more.
    cur = advance(cur, b1);
    const b2 = await adapter.changesSince(cur, { messages: 1_000_000 });
    expect(uidsOf(b2)).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
    expect(b2.hasBacklog).toBe(true);

    // Zero still takes one message, so a drain under any limit progresses.
    cur = advance(cur, b2);
    const b3 = await adapter.changesSince(cur, { messages: 0 });
    expect(uidsOf(b3)).toEqual([12]);
    expect(b3.hasBacklog).toBe(true);
    expect(b3.newCursor.folders["INBOX"].highestModseq).toBe("0");
    await c.logout();
  }, 60_000);

  it("honours a byte budget, and always returns at least one message so an oversized mail cannot stall the drain", async () => {
    const cfg = greenmailConfig();
    // One byte: every message overshoots, so the >= 1 rule is the only thing that makes progress.
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { condstore: false }, maxBatchBytes: 1 });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const c = await raw(cfg);
    for (let i = 1; i <= 3; i++) {
      await c.append("INBOX", eml({ from: "anna@x.example", subject: `b${i}`, messageId: `b${i}@x`, body: "x".repeat(2000) }));
    }

    const b1 = await adapter.changesSince(emptyCursor());
    expect(b1.creates).toHaveLength(1);
    expect(b1.hasBacklog).toBe(true);
    expect(b1.newCursor.folders["INBOX"].highestModseq).toBe("0");   // held
    await c.logout();
  }, 60_000);

  it("never asks the CONDSTORE fast path for message bodies", async () => {
    // A fake client (same approach as imap.changes.fastpath.test.ts) so the fetch OPTIONS
    // themselves can be asserted — the outage's second reproduction is a bulk flag change on
    // a large mailbox, where `changedSince` + `source: true` pulls every touched body only
    // for sync.ts to discard it.
    const src = Buffer.from("Message-ID: <new@x>\r\nSubject: n\r\n\r\nbody");
    const calls: Array<{ range: unknown; query: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const inbox = { path: "INBOX", uidValidity: 100n, uidNext: 12, highestModseq: 50n, exists: 2 };
    const client = {
      capabilities: new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["IDLE", true]]),
      mailbox: inbox as typeof inbox,
      _path: "INBOX",
      async list() { return [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }]; },
      async getMailboxLock(path: string) {
        this._path = path;
        this.mailbox = path === "INBOX" ? inbox : { ...inbox, path, exists: 0, highestModseq: 0n, uidNext: 1 };
        return { path, release() { /* noop */ } };
      },
      async logout() { /* noop */ },
      close() { /* noop */ },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(range: any, query: any, options: any) {
        calls.push({ range, query, options });
        if (this._path !== "INBOX") return;
        if (options?.changedSince) {
          yield { uid: 5, flags: new Set<string>(["\\Seen"]) };          // known → flag change
          yield { uid: 11, flags: new Set<string>() };                   // unknown → ignored here
        } else if (query?.source) {
          yield { uid: 11, flags: new Set<string>(), envelope: { messageId: "<new@x>" }, source: src };
        } else if (query?.size) {
          yield { uid: 11, size: src.length };
        } else {
          yield { uid: 5 }; yield { uid: 11 };                           // uid enumeration
        }
      },
    };

    adapter = new ImapAdapter(greenmailConfig(), { client });
    await adapter.connect();
    const cur = emptyCursor();
    cur.folders["INBOX"] = { uidValidity: "100", uidNext: 6, highestModseq: "50", known: [{ uid: 5, messageId: "old@x" }] };

    const b = await adapter.changesSince(cur);

    // uid 11 was unknown → a create, fetched through the capped path; uid 5 → a flag change.
    expect(b.creates).toHaveLength(1);
    expect(parseRef(b.creates[0].locator.ref).uid).toBe(11);
    expect(b.flagChanges.some((f) => parseRef(f.locator.ref).uid === 5 && f.seen === true)).toBe(true);
    expect(b.hasBacklog).toBe(false);

    // THE ASSERTION THAT MATTERS: the changedSince fetch must not request bodies.
    const changedSinceCalls = calls.filter((c) => c.options?.changedSince);
    expect(changedSinceCalls.length).toBeGreaterThan(0);
    for (const c of changedSinceCalls) {
      expect(c.query.source).toBeFalsy();
      expect(c.query.envelope).toBeFalsy();
    }
  });
});

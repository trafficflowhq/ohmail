import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import type { ChangeBatch, ImapCursor } from "../../src/adapters/imap-types.js";
import { greenmailConfig } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * INGEST ORDER IS WHAT THE CLIENT SEES FIRST, AND IT WAS UID ORDER.
 *
 * `fetchCapped` sorted the candidate UIDs descending and called the result `newestFirst`. UID
 * is an arrival counter, not a clock: on a real mailbox a high uid can carry an old date,
 * and a lower uid a newer one. Because the worker commits
 * `batch.creates` in array order (`packages/organizer/src/sync.ts`) and each commit allocates the
 * next `change_log.seq`, ingest order IS the order `/sync` hands the client its mailbox. So
 * the first page of a fresh account's bootstrap was an arbitrary slice of its history —
 * measured on a seeded account: the newest mail did not arrive until page 4 of
 * 34, and page 1 spanned 2023-01-01 to 2025-12-26. That is the reported "the Screener suddenly
 * jumps to 2025".
 *
 * The fix is ordering, not throughput. Raising the page size was measured and rejected:
 * server cost is linear in rows, so the whole drain takes the same time at any page size of rows
 * — larger pages only buy round-trips and cost a larger response body.
 *
 * ── WHAT THESE TESTS PIN ────────────────────────────────────────────────────────────────
 *
 *  1. the Date: header wins, because it is the field the UI sorts by — and because a mailbox
 *     migrated by a tool that APPENDed without preserving INTERNALDATE has every message
 *     stamped with the import time, which would leave the fix with a constant sort key;
 *  2. INTERNALDATE is the fallback when a message carries no Date: header;
 *  3. UID descending is the tiebreak, which is what keeps the pre-existing
 *     `imap.changes.backfill.test.ts` — 25 messages appended within one second — meaningful;
 *  4. re-ordering does not break the drain: the cursor is still HELD while truncated, and
 *     every message still arrives exactly once.
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

/** UIDs in the order the adapter YIELDED them — this is the order change_log.seq will follow. */
const orderOf = (b: ChangeBatch): number[] => b.creates.map((c) => parseRef(c.locator.ref).uid);
const sortedUidsOf = (b: ChangeBatch): number[] => orderOf(b).sort((a, z) => a - z);

/** A message with an explicit Date: header, so the sort key under test is unambiguous. */
function emlDated(i: number, date: Date | null): string {
  const lines = [
    `Message-ID: <d${i}@x>`,
    "From: anna@x.example",
    "To: mila@lichtgrat.example",
    `Subject: s${i}`,
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (date) lines.push(`Date: ${date.toUTCString()}`);
  lines.push("", "hello");
  return lines.join("\r\n");
}

describe("ImapAdapter.changesSince — the backfill drains newest-by-DATE, not by UID", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("(1) prefers the Date: header — a migrated mailbox whose INTERNALDATE is all import time", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { condstore: false }, maxBatchMessages: 10 });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const c = await raw(cfg);
    // THE MIGRATED-MAILBOX SHAPE. Every message gets the SAME INTERNALDATE (the import ran
    // now), and a Date: header deliberately ANTI-CORRELATED with the UID: uid 1 is the
    // newest mail, uid 25 the oldest. Ordering by UID gets this exactly backwards, and
    // ordering by INTERNALDATE learns nothing at all.
    const importedAt = new Date("2026-08-04T09:00:00Z");
    for (let i = 1; i <= 25; i++) {
      const sent = new Date(Date.UTC(2026, 0, 1) + (25 - i) * 86_400_000);
      await c.append("INBOX", emlDated(i, sent), undefined, importedAt);
    }

    const b1 = await adapter.changesSince(emptyCursor());
    expect(b1.creates).toHaveLength(10);
    expect(b1.hasBacklog).toBe(true);
    // The ten NEWEST BY Date: header are uids 1..10 — the exact opposite of the UID order.
    expect(sortedUidsOf(b1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // …and they are yielded newest-first, because that is the order change_log.seq inherits.
    expect(orderOf(b1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await c.logout();
  }, 60_000);

  it("(2) falls back to INTERNALDATE when a message carries no Date: header", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { condstore: false }, maxBatchMessages: 5 });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const c = await raw(cfg);
    for (let i = 1; i <= 15; i++) {
      const idate = new Date(Date.UTC(2026, 0, 1) + (15 - i) * 86_400_000);
      await c.append("INBOX", emlDated(i, null), undefined, idate);
    }

    const b1 = await adapter.changesSince(emptyCursor());
    expect(b1.creates).toHaveLength(5);
    expect(sortedUidsOf(b1)).toEqual([1, 2, 3, 4, 5]);
    await c.logout();
  }, 60_000);

  it("(3) ties break on UID descending — equal dates keep the old newest-first behaviour", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { condstore: false }, maxBatchMessages: 10 });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const c = await raw(cfg);
    const same = new Date("2026-03-03T12:00:00Z");
    for (let i = 1; i <= 25; i++) await c.append("INBOX", emlDated(i, same), undefined, same);

    const b1 = await adapter.changesSince(emptyCursor());
    expect(b1.creates).toHaveLength(10);
    expect(orderOf(b1)).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
    await c.logout();
  }, 60_000);

  it("(4) re-ordering does not break the drain: cursor held while truncated, each message once", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { condstore: false }, maxBatchMessages: 10 });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const c = await raw(cfg);
    // Dates scrambled against UID, so no pass takes a contiguous UID block. This is the
    // property the old drain accidentally had and the new one must not need.
    const importedAt = new Date("2026-08-04T09:00:00Z");
    for (let i = 1; i <= 25; i++) {
      const day = (i * 7) % 25;
      await c.append("INBOX", emlDated(i, new Date(Date.UTC(2026, 0, 1) + day * 86_400_000)), undefined, importedAt);
    }

    let cur = emptyCursor();
    const b1 = await adapter.changesSince(cur);
    expect(b1.creates).toHaveLength(10);
    expect(b1.hasBacklog).toBe(true);
    // HELD — these 25 are not all committed, and a highestModseq past them is mail never
    // fetched again. Unchanged by the re-ordering.
    /* `serverExists` — the server's own EXISTS for the folder, added to the cursor by
     * a later change and asserted here because this is an exact-shape check: a field the adapter
     * publishes and no test names is a field nothing guards. It is deliberately NOT held back
     * under truncation the way the three cursors above it are (a count is what the folder holds
     * right now; a cursor that advanced past unread work would lose mail), so it reads 25 on
     * every pass of this drain while `uidNext` and `highestModseq` stay pinned. */
    expect(b1.newCursor.folders["INBOX"]).toEqual({ uidValidity: "0", uidNext: 0, highestModseq: "0", serverExists: 25 });

    cur = advance(cur, b1);
    const b2 = await adapter.changesSince(cur);
    expect(b2.creates).toHaveLength(10);
    expect(b2.hasBacklog).toBe(true);
    expect(b2.newCursor.folders["INBOX"]).toEqual({ uidValidity: "0", uidNext: 0, highestModseq: "0", serverExists: 25 });

    cur = advance(cur, b2);
    const b3 = await adapter.changesSince(cur);
    expect(b3.creates).toHaveLength(5);
    expect(b3.hasBacklog).toBe(false);
    expect(b3.newCursor.folders["INBOX"].uidValidity).not.toBe("0");
    expect(b3.newCursor.folders["INBOX"].uidNext).toBeGreaterThan(25);

    cur = advance(cur, b3);
    const b4 = await adapter.changesSince(cur);
    expect(b4.creates).toHaveLength(0);
    expect(b4.hasBacklog).toBe(false);

    // Exactly once, across a drain whose passes are NOT contiguous in UID.
    const all = [...sortedUidsOf(b1), ...sortedUidsOf(b2), ...sortedUidsOf(b3)].sort((a, z) => a - z);
    expect(all).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));

    // And the drain really was date-ordered across passes: every uid in pass 1 is at least as
    // new as every uid in pass 2. (Sorted by the day the Date: header carries.)
    const dayOf = (uid: number) => (uid * 7) % 25;
    const oldestInPass1 = Math.min(...sortedUidsOf(b1).map(dayOf));
    const newestInPass2 = Math.max(...sortedUidsOf(b2).map(dayOf));
    expect(oldestInPass1).toBeGreaterThanOrEqual(newestInPass2);

    await c.logout();
  }, 60_000);
});

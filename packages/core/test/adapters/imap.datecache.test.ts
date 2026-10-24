import { describe, it, expect } from "vitest";
import { ImapAdapter, arrivalKey, orderCandidates, parseRef } from "../../src/adapters/imap.js";
import type { ImapCursor } from "../../src/adapters/imap-types.js";
import { greenmailConfig } from "./_imapenv.js";
import { usePhoneDate } from "../_hermes-date.js";

/**
 * the two properties that keep the date ordering AFFORDABLE, and the rule itself.
 *
 * The greenmail tests (`imap.changes.dateorder.test.ts`) prove the adapter orders by the right
 * thing. These prove it does not pay for it twice, and that the ordering rule survives the
 * inputs a real server actually produces.
 */

const FOLDERS = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];

function emptyCursor(): ImapCursor {
  const folders: ImapCursor["folders"] = {};
  for (const f of FOLDERS) folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders };
}

/**
 * A fake ImapFlow that records every FETCH, so the date lookup can be counted rather than
 * described. Same approach as `imap.changes.fastpath.test.ts`.
 */
function fakeClient(opts: {
  uids: number[]; uidValidity?: bigint; onDateLookup?: () => void; onEnumerate?: () => void;
}) {
  const calls: Array<{ range: unknown; query: Record<string, unknown> }> = [];
  const src = Buffer.from("Message-ID: <n@x>\r\nSubject: n\r\n\r\nbody");
  const inbox = {
    path: "INBOX", uidValidity: opts.uidValidity ?? 100n, uidNext: Math.max(...opts.uids) + 1,
    highestModseq: 0n, exists: opts.uids.length,
  };
  return {
    calls,
    /** The live mailbox object `getMailboxLock` re-installs — mutate THIS to change the epoch. */
    inbox,
    client: {
      capabilities: new Map<string, boolean>([["MOVE", true]]),
      mailbox: inbox as typeof inbox,
      _path: "INBOX",
      async list() { return [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }]; },
      async getMailboxLock(path: string) {
        this._path = path;
        this.mailbox = path === "INBOX" ? inbox : { ...inbox, path, exists: 0, uidNext: 1 };
        return { path, release() { /* noop */ } };
      },
      async logout() { /* noop */ },
      close() { /* noop */ },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(range: any, query: any, _options: any) {
        calls.push({ range, query });
        if (this._path !== "INBOX") return;
        const asked: number[] = Array.isArray(range) || /^[\d:,]+$/.test(String(range))
          ? expand(range)
          : opts.uids;
        if (query?.source) {
          for (const uid of asked) {
            yield { uid, flags: new Set<string>(), envelope: { messageId: `<m${uid}@x>` }, source: src,
              internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000) };
          }
        } else if (query?.internalDate && !query?.source) {
          // The DATE lookup. Deliberately anti-correlated with UID.
          opts.onDateLookup?.();
          for (const uid of asked) {
            yield { uid, internalDate: new Date(Date.UTC(2026, 0, 1) + (10_000 - uid) * 86_400_000) };
          }
        } else if (query?.size) {
          for (const uid of asked) yield { uid, size: src.length };
        } else {
          opts.onEnumerate?.();
          for (const uid of opts.uids) yield { uid };
        }
      },
    },
  };
}

/** Every UID a sequence set names — the date lookup is sent packed (`1:6`, not `1,2,…,6`). */
function expand(range: unknown): number[] {
  if (Array.isArray(range)) return range as number[];
  const out: number[] = [];
  for (const part of String(range).split(",")) {
    const [a, b] = part.split(":").map(Number);
    if (b === undefined) { out.push(a!); continue; }
    for (let u = a!; u <= b; u++) out.push(u);
  }
  return out;
}

/** Every FETCH that asked for INTERNALDATE without asking for bodies — the date lookup. */
const dateCalls = (calls: Array<{ range: unknown; query: Record<string, unknown> }>) =>
  calls.filter((c) => c.query?.internalDate && !c.query?.source);

describe("the date lookup is cached and chunked", () => {
  it("a second pass asks for NOTHING it already knows, and only about UIDs that arrived since", async () => {
    const fake = fakeClient({ uids: [1, 2, 3, 4, 5, 6] });
    const adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchMessages: 2,
    });
    await adapter.connect();

    const cur = emptyCursor();
    cur.folders["INBOX"] = { uidValidity: "100", uidNext: 1, highestModseq: "0", known: [] };
    const b1 = await adapter.changesSince(cur);
    expect(b1.creates).toHaveLength(2);
    const firstLookup = dateCalls(fake.calls);
    expect(firstLookup).toHaveLength(1);
    expect(firstLookup[0]!.range).toBe("1:6");
    // Newest by internaldate is the LOWEST uid, by construction of the fake.
    expect(b1.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([1, 2]);

    // Pass 2: uids 1 and 2 are known now. Nothing new has arrived, so the cache answers in
    // full and no date FETCH is issued at all.
    fake.calls.length = 0;
    cur.folders["INBOX"] = {
      uidValidity: "100", uidNext: 1, highestModseq: "0",
      known: [{ uid: 1, messageId: null }, { uid: 2, messageId: null }],
    };
    const b2 = await adapter.changesSince(cur);
    expect(b2.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([3, 4]);
    expect(dateCalls(fake.calls), "the cache was not consulted — the drain re-read every date").toHaveLength(0);

    await adapter.close();
  });

  it("a UIDVALIDITY change discards the cache rather than ordering by a dead epoch's dates", async () => {
    const fake = fakeClient({ uids: [1, 2, 3, 4] });
    const adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchMessages: 2,
    });
    await adapter.connect();

    const cur = emptyCursor();
    cur.folders["INBOX"] = { uidValidity: "100", uidNext: 1, highestModseq: "0", known: [] };
    await adapter.changesSince(cur);
    expect(dateCalls(fake.calls)).toHaveLength(1);

    // The server renumbers. Every cached date belongs to a different message now.
    // Mutated on the captured object, because `getMailboxLock` re-installs it on every pass —
    // assigning to `client.mailbox` is silently undone, which is how this test first passed
    // for the wrong reason.
    fake.calls.length = 0;
    fake.inbox.uidValidity = 200n;
    const b2 = await adapter.changesSince(cur);
    expect(b2.creates.length).toBeGreaterThan(0);
    expect(dateCalls(fake.calls), "the stale epoch's dates were reused").toHaveLength(1);
    expect(dateCalls(fake.calls)[0]!.range).toBe("1:4");

    await adapter.close();
  });

  it("chunks the lookup so one command never carries a whole mailbox", async () => {
    // Thousands of unknown UIDs with a hole between every two, so no two pack into one range.
    // `ImapFlow.fetch` serialises an array with `range.join(',')`, so an unchunked lookup here is
    // one ~6 KiB command — and larger still on the real account this was measured
    // against. A contiguous set packs into `a:b` and is not the case this pins.
    const uids = Array.from({ length: 1_200 }, (_, i) => (i + 1) * 2);
    const fake = fakeClient({ uids });
    const adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchMessages: 5,
    });
    await adapter.connect();

    const cur = emptyCursor();
    cur.folders["INBOX"] = { uidValidity: "100", uidNext: 1, highestModseq: "0", known: [] };
    await adapter.changesSince(cur);

    const lookups = dateCalls(fake.calls);
    expect(lookups.length).toBe(3);                       // ceil(1200 / 500) ranges
    for (const c of lookups) {
      expect(expand(c.range).length).toBeLessThanOrEqual(500);
      expect(String(c.range).length).toBeLessThan(4_096);
    }
    // Every candidate was asked about exactly once, across the chunks.
    const asked = lookups.flatMap((c) => expand(c.range)).sort((a, b) => a - b);
    expect(asked).toEqual(uids);

    await adapter.close();
  });
});

/**
 * A BURST ON A SLOW DEVICE. The lookup is paid per unknown message, so on a phone a burst's dates
 * alone outran the 300 s pass and a re-dial paid them again. Each date chunk here costs the
 * adapter's clock 100 s: two chunks spend half the pass, and the page comes from what is dated.
 * The UIDs have a hole between every two so the packed read is one chunk's UIDs a command, and the page
 * is wider than two commands date, so the per-pass read clock (a page's worth dated) never acts.
 */
describe("the date lookup takes at most its share of the pass", () => {
  const uids = Array.from({ length: 1_500 }, (_, i) => (i + 1) * 2);
  const slowAdapter = () => {
    let clock = 1_000_000;
    const fake = fakeClient({ uids, onDateLookup: () => { clock += 100_000; } });
    const adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchMessages: 1_200,
      nowMs: () => clock,
    });
    return { fake, adapter };
  };
  const cold = (): ImapCursor => {
    const cur = emptyCursor();
    cur.folders["INBOX"] = { uidValidity: "100", uidNext: 1, highestModseq: "0", known: [] };
    return cur;
  };

  it("stops dating at half the pass, pages from the newest arrivals and holds the cursor", async () => {
    const { fake, adapter } = slowAdapter();
    await adapter.connect();
    const b = await adapter.changesSince(cold());

    const asked = dateCalls(fake.calls).flatMap((c) => expand(c.range));
    expect(dateCalls(fake.calls), "the lookup ignored the pass clock").toHaveLength(2);
    expect(asked).toEqual(uids.slice(500).reverse());
    // Newest by date among what was dated — the fake dates the LOWEST uid newest.
    expect(b.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual(uids.slice(500));
    expect(b.hasBacklog, "undated candidates are owed, so the pass is not quiet").toBe(true);
    expect(b.newCursor.folders["INBOX"]!.uidNext, "the cursor moved past undated mail").toBe(1);
    await adapter.close();
  });

  it("the next pass dates the rest, asks nothing twice, and the whole-folder order returns", async () => {
    const { fake, adapter } = slowAdapter();
    await adapter.connect();
    await adapter.changesSince(cold());
    fake.calls.length = 0;

    const next = cold();
    next.folders["INBOX"]!.known = uids.slice(500).map((uid) => ({ uid, messageId: null }));
    const b = await adapter.changesSince(next);
    const asked = dateCalls(fake.calls).flatMap((c) => expand(c.range));
    expect(asked, "the second pass re-asked dates it had").toEqual(uids.slice(0, 500).reverse());
    expect(b.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual(uids.slice(0, 500));
    await adapter.close();
  });

  it("always dates one chunk, however spent the pass, and a page wider than it still holds the cursor", async () => {
    let clock = 1_000_000;
    // The folder's own enumeration has already spent 160 s of the pass.
    const fake = fakeClient({
      uids, onDateLookup: () => { clock += 100_000; }, onEnumerate: () => { clock += 160_000; },
    });
    const adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchMessages: 600,
      nowMs: () => clock,
    });
    await adapter.connect();
    const b = await adapter.changesSince(cold());
    expect(dateCalls(fake.calls)).toHaveLength(1);
    // The page could take more than were dated: all the dated come, the rest are owed.
    expect(b.creates).toHaveLength(500);
    expect(b.hasBacklog, "the page emptied the dated set and called the folder drained").toBe(true);
    expect(b.newCursor.folders["INBOX"]!.uidNext).toBe(1);
    await adapter.close();
  });
  it("the command size is the caller's: a slow-link caller's burst stops at the share, a default caller's is one command", async () => {
    // A CONTIGUOUS burst packs into one range, so only the per-command size can split it.
    const burst = Array.from({ length: 1_500 }, (_, i) => i + 1);
    const run = async (dateReadCommandSize?: number) => {
      let clock = 1_000_000;
      const fake = fakeClient({ uids: burst, onDateLookup: () => { clock += 100_000; } });
      const cfg = dateReadCommandSize === undefined ? greenmailConfig() : { ...greenmailConfig(), dateReadCommandSize };
      const adapter = new ImapAdapter(cfg, {
        client: fake.client, capabilityOverrides: { condstore: false }, maxBatchMessages: 1_200, nowMs: () => clock,
      });
      await adapter.connect();
      await adapter.changesSince(cold());
      await adapter.close();
      return dateCalls(fake.calls).map((c) => expand(c.range).length);
    };
    expect(await run(500), "the phone's size: two commands of 500, then the share stops it").toEqual([500, 500]);
    expect(await run(), "the default size: the whole burst in one command").toEqual([1_500]);
  });
});

describe("arrivalKey and orderCandidates (the rule, without a server)", () => {
  const internal = Date.UTC(2026, 7, 4);
  const earlier = Date.UTC(2024, 0, 1);
  const forged = Date.UTC(2099, 0, 1);

  it("prefers the sender's date when it is earlier than the server's — the migrated mailbox", () => {
    expect(arrivalKey(new Date(internal), new Date(earlier))).toBe(earlier);
  });

  it("CLAMPS a forged future Date: back to actual arrival, so it wins no position", () => {
    expect(arrivalKey(new Date(internal), new Date(forged))).toBe(internal);
  });

  it("falls back to INTERNALDATE with no Date: header, and to the header with no INTERNALDATE", () => {
    expect(arrivalKey(new Date(internal), null)).toBe(internal);
    expect(arrivalKey(null, new Date(earlier))).toBe(earlier);
  });

  it("reads the strings the phone's imapflow leaves (its Date refuses them) as their instants", () => {
    const restore = usePhoneDate();
    try {
      expect(arrivalKey(null, "24 Oct 2026 06:29:09 +0200")).toBe(Date.UTC(2026, 9, 24, 4, 29, 9));
      expect(arrivalKey("24-Oct-2026 06:29:09 +0200", null)).toBe(Date.UTC(2026, 9, 24, 4, 29, 9));
    } finally { restore(); }
  });

  it("never throws on junk, and sorts it oldest", () => {
    expect(arrivalKey(null, null)).toBe(0);
    expect(arrivalKey("not a date", undefined)).toBe(0);
    expect(arrivalKey(undefined, "nonsense")).toBe(0);
  });

  it("orders newest first, and breaks ties on UID descending", () => {
    const dates = new Map([[1, 300], [2, 100], [3, 300], [4, 200]]);
    expect(orderCandidates([1, 2, 3, 4], dates)).toEqual([3, 1, 4, 2]);
  });

  it("degrades to exactly the old behaviour when every date is equal", () => {
    const flat = new Map([[7, 5], [8, 5], [9, 5]]);
    expect(orderCandidates([7, 8, 9], flat)).toEqual([9, 8, 7]);
  });

  it("treats an unknown UID as oldest rather than dropping it", () => {
    const partial = new Map([[1, 500]]);
    expect(orderCandidates([1, 2, 3], partial)).toEqual([1, 3, 2]);
  });
});

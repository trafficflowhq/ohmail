import { describe, it, expect } from "vitest";
import { ImapAdapter, ImapBoundExceeded, parseRef } from "../../src/adapters/imap.js";
import { IMAP_BODY_OVERRUN_FLOOR_BYTES } from "../../src/adapters/imap-bounds.js";
import type { ImapCursor } from "../../src/adapters/imap-types.js";

/*
 * BATCH-TOTAL-OVERRUN-SETS-NOTHING-ASIDE. Messages each inside their own ceiling (a "floor-rider"
 * declares 10 bytes and streams 300 KB, under the 1 MiB floor) can cross the batch total together.
 * That breach named no message and kept nothing, so every pass re-dialled, re-fetched the same
 * bodies and breached again. Now the pass keeps every asked message that arrived whole and ends,
 * as a per-message overrun does; a UID is named only when the command that crossed asked for one.
 */

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };
const FOLDERS = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];
const KB = 1000;

interface Opts {
  /**
   * Messages per folder: uid -> declared RFC822.SIZE, the bytes the body streams, and the letter's
   * Message-ID (`m<uid>` when absent, so a renumbered folder can hold the same letter at another uid).
   */
  folders: Record<string, Record<number, { declared: number; actual: number; id?: string }>>;
  /** Each folder's UIDVALIDITY; 100 when absent. */
  epochs?: Record<string, bigint>;
  /** Rows a body FETCH streams for unasked uids before the asked ones. */
  junkFirst?: (asked: number[]) => Array<{ uid: number; bytes: number }>;
  /** Each asked row streams twice. */
  twice?: boolean;
  /** The first body fetch (the one asking ENVELOPE) omits every row. */
  withholdFirst?: boolean;
}

function messageOf(id: string, n: number): Buffer {
  const head = Buffer.from(`Message-ID: <${id}@x>\r\nSubject: ${id}\r\nFrom: a@b.c\r\n\r\n`);
  return n <= head.length ? head : Buffer.concat([head, Buffer.alloc(n - head.length, 0x61)]);
}

function server(o: Opts) {
  /** `bodies`: every body fetch, keyed `folder:uid`; `byId`: the same, keyed by Message-ID. */
  const stats = { bodies: new Map<string, number>(), byId: new Map<string, number>(), arrived: 0 };
  const client = () => {
    let path = "INBOX";
    const msgs = (): Record<number, { declared: number; actual: number; id?: string }> => o.folders[path] ?? {};
    const idOf = (uid: number): string => msgs()[uid]?.id ?? `m${uid}`;
    const uids = (): number[] => Object.keys(msgs()).map(Number).sort((a, b) => a - b);
    const c = {
      usable: true,
      capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true]]),
      mailbox: undefined as unknown,
      async list() {
        return [...new Set([...FOLDERS, ...Object.keys(o.folders)])].map((p) => ({ path: p, name: p.split("/").pop()!, delimiter: "/", flags: new Set<string>() }));
      },
      async mailboxCreate(p: string) { return { path: p }; },
      async getMailboxLock(p: string) {
        path = p;
        const all = uids();
        c.mailbox = { path: p, uidValidity: o.epochs?.[p] ?? 100n, uidNext: Math.max(0, ...all) + 1, highestModseq: 0n, exists: all.length };
        return { path: p, release() { /* nothing */ } };
      },
      async search() { return []; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(range: any, query: any) {
        const asked: number[] = Array.isArray(range)
          ? range.map(Number).filter((u: number) => msgs()[u] !== undefined).sort((a: number, b: number) => a - b)
          : uids();
        if (query?.source) {
          if (o.withholdFirst && query.envelope) return;
          for (const j of o.junkFirst?.(asked) ?? []) {
            stats.arrived += j.bytes;
            yield { uid: j.uid, flags: new Set<string>(), envelope: { messageId: `<j${j.uid}@x>` }, source: Buffer.alloc(j.bytes, 0x62) };
          }
          for (const uid of asked) {
            const k = `${path}:${uid}`;
            stats.bodies.set(k, (stats.bodies.get(k) ?? 0) + 1);
            stats.byId.set(idOf(uid), (stats.byId.get(idOf(uid)) ?? 0) + 1);
            for (let n = 0; n < (o.twice ? 2 : 1); n++) {
              stats.arrived += msgs()[uid]!.actual;
              yield {
                uid, flags: new Set<string>(), envelope: { messageId: `<${idOf(uid)}@x>` },
                source: messageOf(idOf(uid), msgs()[uid]!.actual), internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000),
              };
            }
          }
          return;
        }
        if (query?.size) { for (const uid of asked) yield { uid, size: msgs()[uid]!.declared }; return; }
        // The reset's proof: every letter's Message-ID, header only.
        if (query?.headers) { for (const uid of asked) yield { uid, headers: Buffer.from(`Message-ID: <${idOf(uid)}@x>\r\n`) }; return; }
        if (query?.internalDate) {
          for (const uid of asked) yield { uid, internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000) };
          return;
        }
        for (const uid of asked) yield { uid };
      },
      async logout() { /* nothing */ },
      close() { /* nothing */ },
    };
    return c;
  };
  return { client, stats };
}

type Site = { folder: string; uid: number };
const key = (s: Site): string => `${s.folder}:${s.uid}`;

/**
 * The cursor as `buildCursor` makes it: the six watched folders, plus a folder only once a pass has
 * written its row (`rows`). A folder with no row carries no known-set, whatever is stored for it.
 */
function cursorOf(known: Set<string>, aside: Set<string>, rows: ReadonlySet<string> = new Set()): ImapCursor {
  const folders: ImapCursor["folders"] = {};
  for (const f of new Set([...FOLDERS, ...rows])) {
    folders[f] = {
      uidValidity: "100", uidNext: 0, highestModseq: "0",
      known: [...known].filter((k) => k.startsWith(`${f}:`)).map((k) => ({ uid: Number(k.slice(f.length + 1)), messageId: null })),
    };
  }
  const setAside = [...aside].map((k) => {
    const at = k.lastIndexOf(":");
    return { folder: k.slice(0, at), uidValidity: "100", uid: Number(k.slice(at + 1)) };
  });
  return { folders, ...(setAside.length > 0 ? { setAside } : {}) };
}

/** One pass on a fresh adapter, as a re-dial makes it. */
async function pass(client: () => unknown, cursor: ImapCursor) {
  const retired: unknown[] = [];
  const adapter = new ImapAdapter(cfg, {
    client: client() as never, capabilityOverrides: { condstore: false }, onConnectionError: (e) => { retired.push(e); },
  });
  await adapter.connect();
  try {
    return { batch: await adapter.changesSince(cursor), retired };
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

/** A runtime's view across re-dials: creates become known, a named overrun is set aside. */
async function drain(o: Opts, maxPasses = 12) {
  const { client, stats } = server(o);
  const known = new Set<string>();
  const aside = new Set<string>();
  const rows = new Set<string>();
  let passes = 0;
  let retirements = 0;
  let threw = 0;
  for (let p = 0; p < maxPasses; p++) {
    passes++;
    let r: Awaited<ReturnType<typeof pass>>;
    try { r = await pass(client, cursorOf(known, aside, rows)); } catch { threw++; retirements++; continue; }
    retirements += r.retired.length;
    for (const f of Object.keys(r.batch.newCursor.folders)) rows.add(f);
    for (const c of r.batch.creates) known.add(key({ folder: c.locator.folder, uid: parseRef(c.locator.ref).uid }));
    const ov = r.batch.overrun;
    if (ov?.uid !== undefined) aside.add(key({ folder: ov.folder, uid: ov.uid }));
    if (!r.batch.hasBacklog && ov === undefined) break;
  }
  const perBody = [...stats.bodies.values()];
  return {
    passes, threw, retirements, known, aside: [...aside].sort(),
    bodies: perBody.reduce((a, b) => a + b, 0), maxPerBody: Math.max(0, ...perBody), arrived: stats.arrived,
  };
}

const riders = (n: number, from = 1): Record<number, { declared: number; actual: number }> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [from + i, { declared: 10, actual: 300 * KB }]));
const honest = (bytes: number) => ({ declared: bytes, actual: bytes });

describe("a batch-total overrun keeps what arrived whole", () => {
  it("twenty floor-riders: everything is stored, nothing set aside, each body fetched once", async () => {
    const r = await drain({ folders: { INBOX: riders(20) } });
    expect(r.threw, "a pass threw the batch total instead of keeping what arrived").toBe(0);
    expect(r.known.size).toBe(20);
    expect(r.aside).toEqual([]);
    expect(r.bodies, "bodies fetched").toBe(20);
    expect(r.maxPerBody, "a body fetched more than once").toBe(1);
    // The extra-fetch bound: one re-dial per MiB that arrived, plus one per message set aside.
    expect(r.retirements).toBeLessThanOrEqual(Math.ceil(r.arrived / IMAP_BODY_OVERRUN_FLOOR_BYTES) + r.aside.length);
    expect(r.retirements).toBeGreaterThan(0);
  });

  it("CONTROL: one large floor-rider among honest mail is stored, not set aside (within its own ceiling)", async () => {
    const r = await drain({ folders: { INBOX: { 1: { declared: 20, actual: 1_000_000 }, 2: honest(60 * KB), 3: honest(60 * KB), 4: honest(60 * KB), 5: honest(60 * KB), 6: honest(60 * KB) } } });
    expect(r.threw).toBe(0);
    expect(r.known.size).toBe(6);
    expect(r.aside).toEqual([]);
    expect(r.maxPerBody).toBe(1);
    expect(r.retirements).toBeLessThanOrEqual(Math.ceil(r.arrived / IMAP_BODY_OVERRUN_FLOOR_BYTES));
  });

  it("a floor-rider and a liar: only the liar is set aside, every body fetched once", async () => {
    const r = await drain({ folders: { INBOX: {
      1: { declared: 20, actual: 1_000_000 }, 2: honest(60 * KB), 3: honest(60 * KB), 4: honest(60 * KB),
      5: honest(60 * KB), 6: honest(60 * KB), 7: { declared: 20, actual: 1_200_000 },
    } } });
    expect(r.threw).toBe(0);
    expect(r.aside).toEqual(["INBOX:7"]);
    expect(r.known.size).toBe(6);
    expect(r.bodies).toBe(7);
    expect(r.retirements).toBeLessThanOrEqual(Math.ceil(r.arrived / IMAP_BODY_OVERRUN_FLOOR_BYTES) + 1);
  });

  /* NO CURSOR ROW YET: Sent is not watched and a customer folder has none until a pass writes one,
     so without a row left behind the next pass held none of the kept UIDs as known and crossed at
     the same row on every pass. */
  for (const folder of ["Sent", "Archive"]) {
    it(`twenty floor-riders in a first-seen ${folder}: everything stored, each body fetched once`, async () => {
      const r = await drain({ folders: { INBOX: { 1: honest(500) }, [folder]: riders(20) } });
      expect(r.threw).toBe(0);
      expect(r.known.size, "kept mail was fetched again instead of new mail").toBe(21);
      expect(r.aside).toEqual([]);
      expect(r.maxPerBody, "a body fetched more than once").toBe(1);
      expect(r.retirements).toBeLessThanOrEqual(Math.ceil(r.arrived / IMAP_BODY_OVERRUN_FLOOR_BYTES));
      expect(r.retirements).toBeGreaterThan(0);
    });
  }

  it("CONTROL: an honest batch takes one pass and retires nothing", async () => {
    const r = await drain({ folders: { INBOX: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, honest(300 * KB)])) } });
    expect(r.passes).toBe(1);
    expect(r.retirements).toBe(0);
    expect(r.known.size).toBe(20);
  });
});

describe("one pass that crosses the batch total", () => {
  it("keeps the crossing row itself, reports nothing unanswered, and writes no cursor for the folder", async () => {
    const { client } = server({ folders: { INBOX: { 1: { declared: 10, actual: 600 * KB }, 2: { declared: 10, actual: 600 * KB }, 3: { declared: 10, actual: 600 * KB } } } });
    const { batch, retired } = await pass(client, cursorOf(new Set(), new Set()));
    // Ascending stream: 1 (600 KB), then 2 crosses 1 MiB. Both arrived whole, both are kept.
    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([2, 1]);
    expect(batch.overrun?.folder).toBe("INBOX");
    expect(batch.overrun?.uid, "a multi-UID command named a message").toBeUndefined();
    expect((batch.overrun?.breach as ImapBoundExceeded).bound).toBe("body_overrun");
    expect(batch.overrun?.breach).toBe(retired[0]);
    expect(batch.hasBacklog).toBe(true);
    expect(batch.unanswered ?? []).toEqual([]);
    expect(batch.newCursor.folders.INBOX, "the breached folder's cursor was written").toBeUndefined();
  });

  it("a first-seen folder gets a cursor naming its live epoch and no UID, which advances nothing", async () => {
    const { client } = server({ folders: { INBOX: { 1: honest(500) }, Archive: riders(5) } });
    const { batch } = await pass(client, cursorOf(new Set(), new Set()));
    expect(batch.overrun?.folder).toBe("Archive");
    expect(batch.creates.filter((c) => c.locator.folder === "Archive")).toHaveLength(4);
    expect(batch.newCursor.folders.Archive).toEqual({ uidValidity: "100", uidNext: 0, highestModseq: "0" });
    expect(batch.unanswered ?? []).toEqual([]);
  });

  it("a duplicate reply that crosses keeps the first reply and names nobody", async () => {
    const { client } = server({ folders: { INBOX: { 1: { declared: 10, actual: 600 * KB } } }, twice: true });
    const { batch } = await pass(client, cursorOf(new Set(), new Set()));
    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([1]);
    expect(batch.overrun).toBeDefined();
    expect(batch.overrun?.uid).toBeUndefined();
  });

  it("a one-UID command answered with unasked rows past the ceiling names that UID", async () => {
    const { client } = server({
      folders: { INBOX: { 1: honest(500) } }, junkFirst: (a) => [{ uid: 900 + a[0]!, bytes: 1_100 * KB }],
    });
    const { batch } = await pass(client, cursorOf(new Set(), new Set()));
    expect(batch.creates).toEqual([]);
    expect(batch.overrun).toMatchObject({ folder: "INBOX", uidValidity: "100", uid: 1 });
  });

  it("CONTROL: a multi-UID command with unasked rows before any asked row names nobody and keeps nothing", async () => {
    const { client } = server({
      folders: { INBOX: { 1: honest(500), 2: honest(500), 3: honest(500) } }, junkFirst: (a) => [{ uid: 900 + a[0]!, bytes: 1_100 * KB }],
    });
    const { batch } = await pass(client, cursorOf(new Set(), new Set()));
    expect(batch.creates).toEqual([]);
    expect(batch.overrun).toBeDefined();
    expect(batch.overrun?.uid, "an innocent message was named").toBeUndefined();
  });

  it("the re-ask of withheld rows keeps what arrived too", async () => {
    const { client } = server({ folders: { INBOX: riders(5) }, withholdFirst: true });
    const { batch } = await pass(client, cursorOf(new Set(), new Set()));
    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([4, 3, 2, 1]);
    expect(batch.overrun?.uid).toBeUndefined();
    expect(batch.unanswered ?? []).toEqual([]);
  });

  it("a folder whose cursor names its live epoch keeps it, and so does every later folder", async () => {
    const { client } = server({ folders: { INBOX: riders(5), "ohmail/News": { 1: honest(500) } } });
    const { batch } = await pass(client, cursorOf(new Set(), new Set()));
    expect(batch.overrun?.folder).toBe("INBOX");
    expect(batch.newCursor.folders.INBOX).toBeUndefined();
    expect(batch.newCursor.folders["ohmail/News"], "a folder after the breach was read").toBeUndefined();
  });

  it("a crossing in a later folder returns the earlier folder's creates and cursor", async () => {
    const { client } = server({ folders: { INBOX: { 1: honest(500), 2: honest(500) }, "ohmail/News": riders(5) } });
    const { batch } = await pass(client, cursorOf(new Set(), new Set()));
    const inbox = batch.creates.filter((c) => c.locator.folder === "INBOX").map((c) => parseRef(c.locator.ref).uid);
    const news = batch.creates.filter((c) => c.locator.folder === "ohmail/News").map((c) => parseRef(c.locator.ref).uid);
    expect(inbox).toEqual([2, 1]);
    expect(news).toEqual([4, 3, 2, 1]);
    expect(batch.overrun?.folder).toBe("ohmail/News");
    expect(batch.newCursor.folders.INBOX?.uidNext).toBe(3);
    expect(batch.newCursor.folders["ohmail/News"]).toBeUndefined();
    expect(batch.unanswered ?? []).toEqual([]);
  });
});

/*
 * A RENUMBERED FOLDER. The store remembers seven letters at epoch 100 (uids 1-7); the server now
 * states 101 and holds six of them under uids 11-16, each a floor-rider, the seventh deleted
 * meanwhile. The re-read crosses the batch total. It used to keep what arrived and leave the cursor
 * naming 100, so every pass saw the reset again, re-read the same newest letters and crossed at the
 * same row. Now the reset settles in the pass that crosses: its prior-epoch deletes go out with the
 * whole-folder proof (read before the bodies, while the connection still serves), and the cursor
 * names 101 and acknowledges no UID, so the next pass resumes past what this one re-learned.
 */
describe("a renumbered folder whose re-read crosses the batch total", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const renumbered = (): Record<number, { declared: number; actual: number; id: string }> =>
    Object.fromEntries(ids.map((id, i) => [11 + i, { declared: 10, actual: 300 * KB, id }]));
  const at = (folder: string, cur: ImapCursor["folders"][string]): ImapCursor =>
    ({ folders: { ...cursorOf(new Set(), new Set()).folders, [folder]: cur } });
  const remembered = (): ImapCursor["folders"][string] => ({
    uidValidity: "100", uidNext: 8, highestModseq: "0",
    known: [...ids, "g"].map((id, i) => ({ uid: i + 1, messageId: `${id}@x` })),
  });
  const refs = (changes: ReadonlyArray<{ locator: { ref: string } }>): string[] =>
    changes.map((c) => c.locator.ref).sort((x, y) => Number(x.split(":")[1]) - Number(y.split(":")[1]));

  for (const folder of ["INBOX", "Sent"]) {
    it(`${folder}: the reset settles in the pass that crosses, and the cursor names the live epoch and no UID`, async () => {
      const { client } = server({ folders: { [folder]: renumbered() }, epochs: { [folder]: 101n } });
      const { batch } = await pass(client, at(folder, remembered()));
      expect(batch.overrun?.folder).toBe(folder);
      expect(batch.overrun?.uid, "a batch total named a message").toBeUndefined();
      // Ascending: 11-13 arrive (900 KB), 14 crosses 1 MiB and is kept too; each pairs with its
      // prior-epoch delete, a locator refresh.
      expect(refs(batch.moves)).toEqual(["101:11", "101:12", "101:13", "101:14"]);
      expect(batch.creates).toEqual([]);
      expect(batch.newCursor.folders[folder], "the cursor still names the old epoch").toEqual({ uidValidity: "101", uidNext: 0, highestModseq: "0" });
      // The proof: the seventh letter is held by no uid, so it is gone; the two unread ones are held.
      expect(refs(batch.resetGone ?? [])).toEqual(["100:7"]);
      expect(refs(batch.deletes)).toEqual(["100:5", "100:6"]);
      expect(batch.unanswered ?? []).toEqual([]);
    });

    it(`${folder}: the next pass resumes past what the first re-learned, each body fetched once`, async () => {
      const { client, stats } = server({ folders: { [folder]: renumbered() }, epochs: { [folder]: 101n } });
      const first = (await pass(client, at(folder, remembered()))).batch;
      // What the store then holds at 101: the re-learned letters, repointed by the commit.
      const relearned = first.moves.map((m) => ({ uid: parseRef(m.locator.ref).uid, messageId: null }));
      const cur = first.newCursor.folders[folder]!;
      const second = (await pass(client, at(folder, { ...cur, known: relearned }))).batch;
      expect(second.overrun).toBeUndefined();
      expect(refs(second.creates)).toEqual(["101:15", "101:16"]);
      expect(second.deletes).toEqual([]);
      expect(second.newCursor.folders[folder]?.uidValidity).toBe("101");
      expect([...stats.byId.values()], "a body fetched more than once").toEqual(Array(6).fill(1));
    });
  }

  it("CONTROL: a reset that does not cross settles in its one pass, as before", async () => {
    const quiet = Object.fromEntries(ids.map((id, i) => [11 + i, { declared: 500, actual: 500, id }]));
    const { client } = server({ folders: { INBOX: quiet }, epochs: { INBOX: 101n } });
    const { batch } = await pass(client, at("INBOX", remembered()));
    expect(batch.overrun).toBeUndefined();
    expect(refs(batch.moves)).toEqual(["101:11", "101:12", "101:13", "101:14", "101:15", "101:16"]);
    expect(refs(batch.resetGone ?? [])).toEqual(["100:7"]);
    expect(batch.newCursor.folders.INBOX).toMatchObject({ uidValidity: "101", uidNext: 17 });
  });
});


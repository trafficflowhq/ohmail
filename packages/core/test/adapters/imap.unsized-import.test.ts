import { describe, it, expect, afterEach } from "vitest";
import { ImapAdapter, ImapBoundExceeded, parseRef } from "../../src/adapters/imap.js";
import type { ChangeBatch, ImapCursor } from "../../src/adapters/imap-types.js";
import { DEFAULT_SYNC_BATCH_MAX_BYTES, DEFAULT_SYNC_BATCH_MAX_MESSAGES } from "../../src/adapters/imap-types.js";
import { MAX_RAW_MESSAGE_BYTES } from "../../src/mime.js";

/*
 * UNSIZED-MESSAGES-IMPORT-ONE-PER-FOLDER-PER-PASS. A message whose RFC822.SIZE the server does not
 * state was charged at the 64 MiB MIME ceiling against the 32 MiB pass budget, so a folder took
 * one per pass. Unsized messages are now fetched one UID FETCH each after the sized take, the bytes
 * that ARRIVED charged against what the pass has left. Controls: a sized folder is one batched
 * fetch as before, a liar is still set aside, and the pass budget holds by bytes.
 */

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };
const FOLDERS = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];
const mib = 1024 * 1024;

interface Opts {
  count: number;
  /** RFC822.SIZE per uid; 0 = the server states none. */
  declared: (uid: number) => number;
  /** Bytes each body actually streams. */
  actual: (uid: number) => number;
  /** Milliseconds each body FETCH command costs on `clock` (the adapter's injected clock). */
  costMs?: number;
  clock?: { t: number };
  /** Rows a body FETCH streams for OTHER uids before the one it was asked for. */
  extraRows?: (asked: number[]) => Array<{ uid: number; bytes: number }>;
}

function messageOf(uid: number, n: number): Buffer {
  const head = Buffer.from(`Message-ID: <m${uid}@x>\r\nSubject: s\r\nFrom: a@b.c\r\n\r\n`);
  return n <= head.length ? head : Buffer.concat([head, Buffer.alloc(n - head.length, 0x61)]);
}

function fakeServer(o: Opts) {
  /** Each body-carrying FETCH command, by the uids it named. */
  const bodyCommands: number[][] = [];
  const mailbox = { path: "INBOX", uidValidity: 100n, uidNext: o.count + 1, highestModseq: 0n, exists: o.count };
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true]]),
    mailbox: mailbox as unknown,
    _path: "INBOX",
    async list() {
      return FOLDERS.map((path) => ({ path, name: path.split("/").pop()!, delimiter: "/", flags: new Set<string>() }));
    },
    async mailboxCreate(path: string) { return { path }; },
    async getMailboxLock(path: string) {
      client._path = path;
      client.mailbox = path === "INBOX" ? { ...mailbox, path } : { ...mailbox, path, exists: 0, uidNext: 1 };
      return { path, release() { /* nothing */ } };
    },
    async search() { return []; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any) {
      if (client._path !== "INBOX") return;
      const asked: number[] = Array.isArray(range) ? range : [];
      if (query?.source) {
        bodyCommands.push([...asked]);
        if (o.clock && o.costMs) o.clock.t += o.costMs;
        for (const extra of o.extraRows?.(asked) ?? []) {
          yield {
            uid: extra.uid, flags: new Set<string>(), envelope: { messageId: `<x${extra.uid}@x>` },
            source: Buffer.alloc(extra.bytes, 0x61), internalDate: new Date(Date.UTC(2026, 0, 1)),
          };
        }
        for (const uid of asked) {
          yield {
            uid, flags: new Set<string>(), envelope: { messageId: `<m${uid}@x>` },
            source: messageOf(uid, o.actual(uid)), internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000),
          };
        }
        return;
      }
      if (query?.size) {
        for (const uid of asked) yield { uid, size: o.declared(uid) };
        return;
      }
      if (query?.internalDate) {
        for (const uid of asked) yield { uid, internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000) };
        return;
      }
      for (let uid = 1; uid <= o.count; uid++) yield { uid };
    },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return { client, bodyCommands };
}

function emptyCursor(): ImapCursor {
  const out: ImapCursor["folders"] = {};
  for (const f of FOLDERS) out[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders: out };
}

/** The cursor a caller holds after `batch`: its watermarks plus every uid stored so far. */
function nextCursor(batch: ChangeBatch, known: Set<number>): ImapCursor {
  for (const c of batch.creates) known.add(parseRef(c.locator.ref).uid);
  const folders: ImapCursor["folders"] = {};
  for (const [name, f] of Object.entries(batch.newCursor.folders)) folders[name] = { ...f, known: [] };
  folders["INBOX"] = { ...folders["INBOX"]!, known: [...known].map((uid) => ({ uid, messageId: null })) };
  return { folders };
}

describe("a server that states no RFC822.SIZE", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("a large unsized INBOX imports at the message budget per pass, not one", async () => {
    const { client } = fakeServer({ count: 10_000, declared: () => 0, actual: () => 2_000 });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    const known = new Set<number>();
    let cursor = emptyCursor();
    let passes = 0;
    // The fixture over the page size is fifty passes; the bound leaves room and still refuses one-per-pass.
    while (passes < 60) {
      const batch = await adapter.changesSince(cursor);
      passes++;
      if (passes === 1) expect(batch.creates).toHaveLength(DEFAULT_SYNC_BATCH_MAX_MESSAGES);
      cursor = nextCursor(batch, known);
      if (!batch.hasBacklog) break;
    }
    expect(known.size).toBe(10_000);
    expect(passes).toBeLessThanOrEqual(51);
  });

  it("each unsized message is its own UID FETCH; a sized folder is one batched fetch as before", async () => {
    const unsized = fakeServer({ count: 5, declared: () => 0, actual: () => 2_000 });
    adapter = new ImapAdapter(cfg, { client: unsized.client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    const a = await adapter.changesSince(emptyCursor());
    expect(a.creates).toHaveLength(5);
    expect(unsized.bodyCommands.map((c) => c.length)).toEqual([1, 1, 1, 1, 1]);
    // Newest first, whatever order they were fetched in.
    expect(a.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([5, 4, 3, 2, 1]);
    await adapter.close();

    const sized = fakeServer({ count: 5, declared: () => 2_000, actual: () => 2_000 });
    adapter = new ImapAdapter(cfg, { client: sized.client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    const b = await adapter.changesSince(emptyCursor());
    expect(b.creates).toHaveLength(5);
    expect(sized.bodyCommands).toHaveLength(1);
    expect(sized.bodyCommands[0]!.length).toBe(5);
  });

  it("the pass budget holds by the bytes that arrived: 1 MiB bodies stop at 32", async () => {
    const { client, bodyCommands } = fakeServer({ count: 100, declared: () => 0, actual: () => mib });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    const batch = await adapter.changesSince(emptyCursor());
    expect(batch.creates).toHaveLength(DEFAULT_SYNC_BATCH_MAX_BYTES / mib);
    expect(bodyCommands).toHaveLength(DEFAULT_SYNC_BATCH_MAX_BYTES / mib);
    expect(batch.hasBacklog).toBe(true);
  });

  it("what a sized take spent is charged first: the unsized wait when it filled the budget", async () => {
    // uid 3 is sized and takes the whole (seamed) budget as the first admission.
    const { client } = fakeServer({ count: 3, declared: (u) => (u === 3 ? 2 * mib : 0), actual: (u) => (u === 3 ? 2 * mib : 1_000) });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false }, maxBatchBytes: mib });
    await adapter.connect();
    const batch = await adapter.changesSince(emptyCursor());
    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([3]);
    expect(batch.hasBacklog).toBe(true);
  });

  it("the first admission is kept: one unsized message larger than the whole budget is still taken", async () => {
    const { client } = fakeServer({ count: 2, declared: () => 0, actual: () => 2 * mib });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false }, maxBatchBytes: mib });
    await adapter.connect();
    const batch = await adapter.changesSince(emptyCursor());
    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([2]);
    expect(batch.hasBacklog).toBe(true);
  });

  it("a liar is still set aside: an unsized body past the MIME ceiling stops the pass at it, keeping the earlier ones", async () => {
    const { client } = fakeServer({
      count: 3, declared: () => 0, actual: (u) => (u === 2 ? MAX_RAW_MESSAGE_BYTES + 1 : 1_000),
    });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    const batch = await adapter.changesSince(emptyCursor());
    expect(batch.overrun?.uid).toBe(2);
    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([3]);
  });

  /* LOW 1: every unsized fetch ran under one 180 s read deadline, so a
     server at 1 s a fetch threw read_deadline at the 181st and the pass kept nothing (0, 0, 0). */
  async function slowPasses(declared: number, costMs: number, n: number): Promise<number[]> {
    const clock = { t: Date.UTC(2026, 9, 8) };
    const { client } = fakeServer({ count: 1_000, declared: () => declared, actual: () => 2_000, costMs, clock });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false }, nowMs: () => clock.t });
    await adapter.connect();
    const known = new Set<number>();
    let cursor = emptyCursor();
    const perPass: number[] = [];
    for (let i = 0; i < n; i++) {
      const batch = await adapter.changesSince(cursor);
      perPass.push(batch.creates.length);
      cursor = nextCursor(batch, known);
    }
    return perPass;
  }

  it("a slow unsized server (1.0 s a fetch) stops softly before the read deadline and keeps what arrived", async () => {
    const perPass = await slowPasses(0, 1_000, 3);
    for (const n of perPass) expect(n, `a pass imported ${n}`).toBeGreaterThan(0);
  });

  it("…and the newest mail arrives first on such a server", async () => {
    const clock = { t: Date.UTC(2026, 9, 8) };
    const { client } = fakeServer({ count: 1_000, declared: () => 0, actual: () => 2_000, costMs: 1_000, clock });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false }, nowMs: () => clock.t });
    await adapter.connect();
    const batch = await adapter.changesSince(emptyCursor());
    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid)[0]).toBe(1_000);
    expect(batch.hasBacklog).toBe(true);
  });

  it("CONTROL: an unsized server at 0.85 s a fetch still takes the whole batch each pass", async () => {
    expect(await slowPasses(0, 850, 3)).toEqual([200, 200, 200]);
  });

  it("CONTROL: a sized server at 1.0 s a fetch still takes the whole batch each pass", async () => {
    expect(await slowPasses(2_100, 1_000, 3)).toEqual([200, 200, 200]);
  });

  /* LOW 2: rows for another uid were dropped uncounted, so a server stating no sizes could stream
     any number of them. Every row of an unsized command now counts against one batch ceiling. */
  it("rows an unsized FETCH streams for other uids count against the batch ceiling, which retires the connection and names the asked uid", async () => {
    const { client } = fakeServer({
      count: 2, declared: () => 0, actual: () => 1_000,
      extraRows: (asked) => Array.from({ length: 8 }, (_, i) => ({ uid: 900 + i + asked[0]!, bytes: 10 * mib })),
    });
    const retired: unknown[] = [];
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false }, onConnectionError: (e) => { retired.push(e); } });
    await adapter.connect();
    const batch = await adapter.changesSince(emptyCursor());
    const breach = batch.overrun?.breach;
    expect(breach, "the extra rows were never counted").toBeInstanceOf(ImapBoundExceeded);
    expect(retired).toEqual([breach]);
    expect((breach as ImapBoundExceeded).bound).toBe("body_overrun");
    expect((breach as ImapBoundExceeded).limit).toBe(68_157_440);
    expect((breach as ImapBoundExceeded).observed).toBe(73_400_320);
    // The command asked for one uid and its reply never arrived: that uid is the one set aside.
    expect((breach as ImapBoundExceeded).site).toEqual({ uidValidity: "100", uid: 2 });
    expect(batch.overrun).toMatchObject({ folder: "INBOX", uidValidity: "100", uid: 2 });
    expect(batch.creates).toEqual([]);
  });

  it("CONTROL: a few small extra rows under the ceiling are dropped and the asked message still arrives", async () => {
    const { client } = fakeServer({
      count: 2, declared: () => 0, actual: () => 1_000,
      extraRows: (asked) => [{ uid: 900 + asked[0]!, bytes: 1_000 }],
    });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    const batch = await adapter.changesSince(emptyCursor());
    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([2, 1]);
  });
});

import { describe, it, expect } from "vitest";
import { ImapFlow } from "imapflow";
import { randomUUID } from "node:crypto";
import { ImapAdapter, IMAP_QUIET_FULL_READ_MS, parseRef } from "../../src/adapters/imap.js";
import type { ChangeBatch, ImapConfig, ImapCursor, KnownEntry } from "../../src/adapters/imap-types.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";
import { connectedWithOwnClient } from "./_own-client.js";

/**
 * AN IDLE DRAIN COSTS WORK PER FOLDER, NOT PER MESSAGE (PERF-026). Every pass used to fetch every
 * UID of every watched folder (`FETCH 1:* (UID)`) and, without CONDSTORE, every flag, to learn that
 * nothing had happened: seconds of one core per drain on the large rig, more on the Windows guest.
 * A folder whose SELECT repeats the keys of a full read that found nothing is now skipped. Each case
 * below is a change that must still be found: an arrival, an expunge, the two together (EXISTS
 * unchanged), a flag set elsewhere (next pass on both; without CONDSTORE the flag read stays), and a
 * folder recreated with every key equal but UIDVALIDITY.
 */

/** The caller's side of the contract: what `sync.ts` would hand back, rebuilt from the batches. */
class Caller {
  cursor: ImapCursor = { folders: {} };
  /** folder → uid → entry, at the folder's published epoch. */
  private readonly held = new Map<string, Map<number, KnownEntry>>();

  apply(b: ChangeBatch): void {
    for (const d of b.deletes) this.held.get(d.locator.folder)?.delete(parseRef(d.locator.ref).uid);
    for (const c of [...b.creates, ...b.moves]) {
      const m = this.held.get(c.locator.folder) ?? new Map<number, KnownEntry>();
      const uid = parseRef(c.locator.ref).uid;
      m.set(uid, { uid, messageId: null, seen: c.seen ?? null });
      this.held.set(c.locator.folder, m);
    }
    for (const f of b.flagChanges) {
      const e = this.held.get(f.locator.folder)?.get(parseRef(f.locator.ref).uid);
      if (e) e.seen = f.seen ?? null;
    }
    const folders: ImapCursor["folders"] = {};
    for (const [name, f] of Object.entries(b.newCursor.folders)) {
      const was = this.cursor.folders[name];
      if (was && was.uidValidity !== f.uidValidity) {
        // A new epoch: only what this batch created there is held.
        const fresh = new Map<number, KnownEntry>();
        for (const c of [...b.creates, ...b.moves]) {
          if (c.locator.folder === name && parseRef(c.locator.ref).uidValidity === f.uidValidity) {
            const uid = parseRef(c.locator.ref).uid;
            fresh.set(uid, { uid, messageId: null, seen: c.seen ?? null });
          }
        }
        this.held.set(name, fresh);
      }
      folders[name] = { ...f, known: [...(this.held.get(name)?.values() ?? [])].map((e) => ({ ...e })) };
    }
    this.cursor = { folders };
  }
}

/** Every `FETCH` the adapter's connection issues, with the folder it was issued in. */
function recordFetches(client: ImapFlow): Array<{ path: string; range: string; flags: boolean }> {
  const seen: Array<{ path: string; range: string; flags: boolean }> = [];
  const real = client.fetch.bind(client);
  client.fetch = ((range: unknown, ...rest: unknown[]) => {
    const mb = client.mailbox;
    const query = rest[0] as { flags?: boolean } | undefined;
    seen.push({
      path: mb ? mb.path : "", range: Array.isArray(range) ? range.join(",") : String(range), flags: !!query?.flags,
    });
    return (real as (...a: unknown[]) => unknown)(range, ...rest);
  }) as ImapFlow["fetch"];
  return seen;
}

const eml = (id: string): string => [
  `Message-ID: <${id}>`, "From: s@x.example", "To: g@lichtgrat.example", `Subject: ${id}`,
  "Content-Type: text/plain; charset=utf-8", "", "hello",
].join("\r\n");

async function other(cfg: ImapConfig, run: (c: ImapFlow) => Promise<void>): Promise<void> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  try { await run(c); } finally { await c.logout(); }
}

/** The whole sequence against one real server. `condstore` is what the server is expected to have. */
async function scenario(cfg: ImapConfig, condstore: boolean): Promise<void> {
  const now = 1_000_000;
  const { adapter, client } = await connectedWithOwnClient(cfg, { nowMs: () => now });
  try {
    await adapter.ensureFolders(FIXTURE_DOOR);
    expect((await adapter.capabilities()).condstore).toBe(condstore);
    const fetches = recordFetches(client);
    const caller = new Caller();
    const pass = async (): Promise<ChangeBatch> => {
      const b = await adapter.changesSince(caller.cursor);
      caller.apply(b);
      return b;
    };
    /** The UID enumeration; the flag read is the same range asking FLAGS. */
    const enumerations = (): string[] => fetches.filter((f) => f.range === "1:*" && !f.flags).map((f) => f.path);
    const flagReads = (): string[] => fetches.filter((f) => f.range === "1:*" && f.flags).map((f) => f.path);
    // INBOX left SELECTED between passes, as the watch's IDLE leaves it: imapflow then grants the
    // next pass's lock with no SELECT, and the keys it holds are the last SELECT's.
    const holdInbox = async (): Promise<void> => {
      await client.mailboxOpen("INBOX");
    };
    const uidsOf = (b: ChangeBatch, kind: "creates" | "deletes" | "flagChanges"): number[] =>
      b[kind].map((c) => parseRef(c.locator.ref).uid);

    // The server's own spelling of the folder (GreenMail nests under INBOX with its delimiter).
    const news = adapter.toServerPath("ohmail/News");
    await other(cfg, async (c) => {
      for (const id of ["q-a", "q-b", "q-c"]) await c.append("INBOX", eml(`${id}-${randomUUID()}@x`));
      await c.append(news, eml(`q-news-${randomUUID()}@x`));
    });
    expect((await pass()).creates).toHaveLength(4);
    // The read that finds nothing is the one a later SELECT may stand in for.
    const settled = await pass();
    expect([settled.creates, settled.deletes, settled.flagChanges].flat()).toEqual([]);
    expect(enumerations(), "the settling pass did not read INBOX in full").toContain("INBOX");

    // ── IDLE: nothing changed, so no folder is enumerated and the batch says so ──────────────
    await holdInbox();
    fetches.length = 0;
    const idle = await pass();
    expect(enumerations(), "an idle pass enumerated a folder where nothing changed").toEqual([]);
    // With CONDSTORE an unchanged HIGHESTMODSEQ is the flag answer; without it the read runs every pass.
    if (condstore) expect(flagReads()).toEqual([]);
    else expect(flagReads(), "the per-pass flag read is gone without CONDSTORE").toContain("INBOX");
    expect(idle.unchanged).toBe(true);
    expect(idle.newCursor.folders["INBOX"]!.serverExists).toBe(3);
    const inboxUids = caller.cursor.folders["INBOX"]!.known.map((k) => k.uid).sort((a, b) => a - b);

    // ── AN ARRIVAL ─────────────────────────────────────────────────────────────────────────────
    await holdInbox();
    await other(cfg, async (c) => { await c.append("INBOX", eml(`q-d-${randomUUID()}@x`)); });
    const arrived = await pass();
    expect(arrived.creates).toHaveLength(1);
    expect(arrived.unchanged).toBeUndefined();
    await pass();

    // ── AN EXPUNGE (UIDNEXT unchanged) ────────────────────────────────────────────────────────
    const gone = inboxUids[0]!;
    await holdInbox();
    await other(cfg, async (c) => {
      const lock = await c.getMailboxLock("INBOX");
      try { await c.messageDelete(String(gone), { uid: true }); } finally { lock.release(); }
    });
    expect(uidsOf(await pass(), "deletes")).toEqual([gone]);
    await pass();

    // ── AN EXPUNGE AND AN ARRIVAL TOGETHER (EXISTS unchanged, UIDNEXT moved) ──────────────────
    const gone2 = inboxUids[1]!;
    await holdInbox();
    await other(cfg, async (c) => {
      const lock = await c.getMailboxLock("INBOX");
      try { await c.messageDelete(String(gone2), { uid: true }); } finally { lock.release(); }
      await c.append("INBOX", eml(`q-e-${randomUUID()}@x`));
    });
    const swapped = await pass();
    expect(uidsOf(swapped, "deletes")).toEqual([gone2]);
    expect(swapped.creates).toHaveLength(1);
    await pass();
    fetches.length = 0;
    expect((await pass()).unchanged).toBe(true);
    expect(enumerations()).toEqual([]);

    // ── A FLAG SET BY ANOTHER CLIENT ──────────────────────────────────────────────────────────
    const read = inboxUids[2]!;
    await holdInbox();
    await other(cfg, async (c) => {
      const lock = await c.getMailboxLock("INBOX");
      try { await c.messageFlagsAdd(String(read), ["\\Seen"], { uid: true }); } finally { lock.release(); }
    });
    // Found on the NEXT pass on both: HIGHESTMODSEQ moved, or the per-pass flag read saw it.
    expect(uidsOf(await pass(), "flagChanges"), "a flag set elsewhere waited past the next pass").toEqual([read]);
    await pass();

    // ── A FOLDER RECREATED: every key equal but UIDVALIDITY ───────────────────────────────────
    await pass();
    const before = adapterKeys(caller, "ohmail/News");
    await new Promise((r) => setTimeout(r, 1100));      // both servers stamp UIDVALIDITY in seconds
    await other(cfg, async (c) => {
      await c.mailboxDelete(news);
      await c.mailboxCreate(news);
      await c.append(news, eml(`q-news2-${randomUUID()}@x`));
    });
    const reset = await pass();
    const after = adapterKeys(caller, "ohmail/News");
    expect(after.uidNext, "the fixture moved UIDNEXT — the case no longer isolates the epoch").toBe(before.uidNext);
    expect(after.uidValidity).not.toBe(before.uidValidity);
    expect(reset.creates.map((c) => c.locator.folder)).toEqual(["ohmail/News"]);
  } finally {
    await adapter.close();
  }
}

function adapterKeys(caller: Caller, folder: string): { uidValidity: string; uidNext: number } {
  const f = caller.cursor.folders[folder]!;
  return { uidValidity: f.uidValidity, uidNext: f.uidNext };
}

describe("an idle pass reads per folder, and still finds every change — GreenMail (no CONDSTORE)", () => {
  it("skips the enumeration on an unchanged folder and finds an arrival, an expunge, both, a flag and a reset", async () => {
    await scenario(greenmailConfig(), false);
  }, 60_000);
});

describe("a flag set elsewhere on a server without CONDSTORE — GreenMail", () => {
  it("is seen on the next drain, however quiet the folder was", async () => {
    const cfg = greenmailConfig();
    const { adapter, client } = await connectedWithOwnClient(cfg);
    try {
      await adapter.ensureFolders(FIXTURE_DOOR);
      await other(cfg, async (c) => { await c.append("INBOX", eml(`q-f-${randomUUID()}@x`)); });
      const caller = new Caller();
      const pass = async (): Promise<ChangeBatch> => {
        const b = await adapter.changesSince(caller.cursor);
        caller.apply(b);
        return b;
      };
      await pass();
      await pass();
      expect((await pass()).unchanged, "the folder never went quiet — the case measures nothing").toBe(true);
      const uid = caller.cursor.folders["INBOX"]!.known[0]!.uid;
      await client.mailboxOpen("INBOX");
      await other(cfg, async (c) => {
        const lock = await c.getMailboxLock("INBOX");
        try { await c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }); } finally { lock.release(); }
      });
      const next = await pass();
      expect(next.flagChanges.map((f) => parseRef(f.locator.ref).uid), "a flag set elsewhere waited past the next drain")
        .toEqual([uid]);
    } finally {
      await adapter.close();
    }
  }, 30_000);
});

const CONDSTORE = await probeCondstore();
if (!CONDSTORE.ok) console.warn(`\n[condstore] SKIPPING the Dovecot half — ${CONDSTORE.why}\n`);
describe.skipIf(!CONDSTORE.ok)("an idle pass reads per folder, and still finds every change — Dovecot (CONDSTORE)", () => {
  it("skips the enumeration on an unchanged folder and finds an arrival, an expunge, both, a flag and a reset", async () => {
    await scenario({
      host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false,
      auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "testpass-password" },
    }, true);
  }, 60_000);
});

/**
 * The fake: what a real server cannot be made to do on demand — a caller that did not store the
 * cursor or the known-set, a delete the caller could not record, a server that states no UIDNEXT,
 * and keys that never move for longer than the bound.
 */
function fakeServer(opts: { uidNext?: boolean; condstore?: boolean } = {}) {
  const box = { uidValidity: 7n, uids: [1, 2, 3], uidNext: 4, modseq: 9n };
  const ranges: string[] = [];
  /** Set by a test: the next UID enumeration ends with an arrival the server announces by EXISTS. */
  const arm = { arrival: false };
  const client = {
    capabilities: new Map<string, boolean>([
      ...(opts.condstore === false ? [] : [["CONDSTORE", true] as [string, boolean]]),
      ["MOVE", true], ["UIDPLUS", true], ["IDLE", true],
    ]),
    mailbox: {} as Record<string, unknown>,
    _path: "INBOX",
    async list() { return [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }]; },
    async getMailboxLock(path: string) {
      this._path = path;
      const inbox = path === "INBOX";
      this.mailbox = {
        path, uidValidity: inbox ? box.uidValidity : 8n, exists: inbox ? box.uids.length : 0,
        highestModseq: inbox ? box.modseq : 1n,
        ...(opts.uidNext === false ? {} : { uidNext: inbox ? box.uidNext : 1 }),
      };
      return { path, release() {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, options: any) {
      ranges.push(`${this._path} ${Array.isArray(range) ? range.join(",") : String(range)}${query?.flags ? " flags" : ""}`);
      if (this._path !== "INBOX") return;
      if (options?.changedSince !== undefined) return;
      if (query?.source || query?.size) {
        for (const uid of Array.isArray(range) ? range : []) {
          const src = Buffer.from(`Message-ID: <f${uid}@x>\r\nSubject: s\r\n\r\nb`);
          yield query.source ? { uid, flags: new Set<string>(), source: src, envelope: { messageId: `<f${uid}@x>` } } : { uid, size: src.length };
        }
        return;
      }
      if (query?.internalDate || query?.envelope) {
        for (const uid of Array.isArray(range) ? range : []) yield { uid, internalDate: new Date(0), envelope: { date: new Date(0) } };
        return;
      }
      for (const uid of box.uids) yield { uid };
      if (arm.arrival && !query?.flags) {
        // Untagged EXISTS after the enumeration: imapflow updates the live mailbox object.
        arm.arrival = false;
        box.uids.push(box.uidNext);
        box.uidNext += 1;
        Object.assign(this.mailbox, { exists: box.uids.length, uidNext: box.uidNext });
      }
    },
  };
  return { box, ranges, client, arm };
}

describe("the quiet skip fails closed (fake)", () => {
  /** The UID enumeration only; the flag read is `INBOX 1:* flags`. */
  const inboxEnums = (ranges: string[]): number => ranges.filter((r) => r === "INBOX 1:*").length;
  const start = async (opts?: { uidNext?: boolean; condstore?: boolean }) => {
    let now = 0;
    const fake = fakeServer(opts);
    const adapter = new ImapAdapter({ host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
      { client: fake.client, nowMs: () => now });
    await adapter.connect();
    const caller = new Caller();
    const pass = async (cursor?: ImapCursor): Promise<ChangeBatch> => {
      const b = await adapter.changesSince(cursor ?? caller.cursor);
      caller.apply(b);
      return b;
    };
    await pass();
    await pass();
    fake.ranges.length = 0;
    return { fake, caller, pass, tick: (ms: number) => { now += ms; } };
  };

  it("skips once settled (the positive control)", async () => {
    const { fake, pass } = await start();
    expect((await pass()).unchanged).toBe(true);
    expect(inboxEnums(fake.ranges)).toBe(0);
  });

  it("reads in full once the bound has passed with every key still", async () => {
    const { fake, pass, tick } = await start();
    tick(IMAP_QUIET_FULL_READ_MS - 1);
    await pass();
    expect(inboxEnums(fake.ranges)).toBe(0);
    tick(1);
    await pass();
    expect(inboxEnums(fake.ranges)).toBe(1);
  });

  it("without CONDSTORE reads flags every pass and enumerates only at the bound", async () => {
    const { fake, pass, tick } = await start({ condstore: false });
    const flagReads = (): number => fake.ranges.filter((r) => r === "INBOX 1:* flags").length;
    tick(IMAP_QUIET_FULL_READ_MS - 1);
    await pass();
    expect([inboxEnums(fake.ranges), flagReads()]).toEqual([0, 1]);
    tick(1);
    await pass();
    expect([inboxEnums(fake.ranges), flagReads()]).toEqual([1, 2]);
  });

  it("does not record as seen a message that arrived after the enumeration", async () => {
    const { fake, pass, tick } = await start();
    tick(IMAP_QUIET_FULL_READ_MS);
    fake.arm.arrival = true;
    expect((await pass()).creates, "the arrival came after the read and is not in it").toEqual([]);
    const next = await pass();
    expect(next.creates.map((c) => parseRef(c.locator.ref).uid), "the arrival was recorded as seen and skipped")
      .toEqual([4]);
  });

  it("reads in full when the server states no UIDNEXT", async () => {
    const { fake, pass } = await start({ uidNext: false });
    await pass();
    expect(inboxEnums(fake.ranges)).toBe(1);
  });

  it("reads in full when the caller hands back a different known-set", async () => {
    const { fake, caller, pass } = await start();
    const cursor = structuredClone(caller.cursor);
    cursor.folders["INBOX"]!.known = cursor.folders["INBOX"]!.known.slice(1);
    const b = await pass(cursor);
    expect(inboxEnums(fake.ranges)).toBe(1);
    expect(b.creates).toHaveLength(1);
  });

  it("reads in full when the caller hands back a different \\Seen baseline", async () => {
    const { fake, caller, pass } = await start();
    const cursor = structuredClone(caller.cursor);
    cursor.folders["INBOX"]!.known[0]!.seen = !cursor.folders["INBOX"]!.known[0]!.seen;
    await pass(cursor);
    expect(inboxEnums(fake.ranges)).toBe(1);
  });

  it("reads in full when the caller did not store the cursor the read published", async () => {
    const { fake, caller, pass } = await start();
    const cursor = structuredClone(caller.cursor);
    cursor.folders["INBOX"]!.highestModseq = "1";
    await pass(cursor);
    expect(inboxEnums(fake.ranges)).toBe(1);
  });

  it("reports a delete again when the caller could not record it", async () => {
    const { fake, caller, pass } = await start();
    fake.box.uids = [2, 3];
    const kept = structuredClone(caller.cursor);
    const first = await pass(kept);
    expect(first.deletes.map((d) => parseRef(d.locator.ref).uid)).toEqual([1]);
    // The caller's cap stopped it recording: the same cursor and known-set come back.
    const again = await pass(kept);
    expect(again.deletes.map((d) => parseRef(d.locator.ref).uid)).toEqual([1]);
    expect(inboxEnums(fake.ranges)).toBe(2);
  });
});

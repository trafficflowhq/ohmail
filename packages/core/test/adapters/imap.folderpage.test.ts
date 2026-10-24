import { describe, it, expect } from "vitest";
import { FOLDER_PAGE_MAX, ImapAdapter, MessageGoneError } from "../../src/adapters/imap.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * THE JUNK WINDOW'S LIST READ — `listFolderPage` (FOLDERS-SPEC.md §16.2) — and the rescue's
 * epoch guard on `move()`.
 *
 * The read is a SEQUENCE WINDOW: sequence numbers are 1..exists with no holes, so the newest
 * `limit` messages are one bounded FETCH range — no SEARCH, no per-message work proportional to
 * the folder's size (the first version ran `SEARCH ALL` and sorted every UID; a review caught
 * that the WORK was unbounded even though the answer was capped). These tests pin:
 *
 *  · the page cap — a folder past the cap answers 50 and ONE fetch range of exactly 50 seqs;
 *  · `beforeSeq` pages strictly older, ending with a null cursor;
 *  · the EPOCH rule — a cursor whose `expectUidValidity` no longer matches is DISCARDED and the
 *    top page is served under the new epoch (never a stale watermark silently skipping mail);
 *  · missing folder (`null`, the degrade branch) vs a real zero-item page vs a TRANSPORT
 *    failure, which propagates so the caller can say `unreachable` instead of `no_junk_folder`;
 *  · `move()` refuses a stale-epoch ref with `MessageGoneError` BEFORE any write — the rescue
 *    can never move whatever message now wears a recycled UID.
 *
 * The move guard used to be OPT-IN (`move(..., { requireEpoch: true })`) and this file used to
 * pin that: one case asserted that WITHOUT the flag the epoch is not enforced. That assertion
 * described the defect the unenforced-epoch row was filed for — the flag's only caller was
 * this rescue, so the organizer's own move, batch-move and flag mutations ran unguarded — so it
 * is REPLACED here by its inverse rather than softened. The full epoch surface (`moveMany`,
 * `setFlags`, `fetchPart`, `fetchRaw`, and the two `"0"` escapes) is in `imap.epoch-guard.test.ts`.
 *
 * Mutations watched red and restored (2026-08-24, round 2; re-run 2026-08-31 for the guard):
 *  · drop the limit clamp ⇒ the past-the-cap case red on length;
 *  · serve `beforeSeq` despite an epoch mismatch ⇒ the epoch case red;
 *  · (2026-09-12) `sameEpoch` without its `known` guards ⇒ the two unnamed-epoch cases red, and
 *    the positive control below stays green, so the pair is a rule rather than a blanket discard;
 *  · fold transport failures into the `null` branch ⇒ the transport case red;
 *  · make `assertLocatorEpoch` a no-op ⇒ every move-epoch case red.
 */

interface FakeMsg { uid: number; seq?: number; subject: string; date: Date | string; seen?: boolean; messageId?: string }

function makeFakeClient(
  byFolder: Record<string, FakeMsg[]>,
  opts: { uidValidity?: bigint; silentEpoch?: boolean } = {},
) {
  const created: string[] = [];
  const fetchRanges: string[] = [];
  let open: string | null = null;
  const msgs = (): FakeMsg[] => byFolder[open!] ?? [];
  const client = {
    created,
    fetchRanges,
    usable: true,
    capabilities: new Map<string, boolean>([["IDLE", true]]),
    mailbox: false as unknown,
    async list() {
      return Object.keys(byFolder).map((path) => ({
        path, name: path.split("/").pop()!, delimiter: "/", flags: new Set<string>(),
      }));
    },
    async mailboxCreate(path: string) { created.push(path); return { path }; },
    async getMailboxLock(path: string) {
      if (!(path in byFolder)) throw new Error(`NO ${path}`);
      open = path;
      client.mailbox = {
        path, exists: msgs().length,
        // `silentEpoch` is a driver that answers a successful SELECT with no `[UIDVALIDITY n]`,
        // which imapflow represents as a missing field. RFC 3501 requires it; servers omit it.
        uidValidity: opts.silentEpoch ? null : opts.uidValidity ?? 7n,
      };
      return { path, release() { /* nothing */ } };
    },
    async search(_q: unknown, _o: unknown) {
      return msgs().map((m) => m.uid);
    },
    async *fetch(range: string | number[], _q: unknown, _o?: unknown) {
      fetchRanges.push(String(range));
      // Sequence-range form only — "start:end" over 1-based positions in the folder.
      const [startRaw, endRaw] = String(range).split(":");
      const start = Number(startRaw);
      const end = Number(endRaw ?? startRaw);
      const list = msgs();
      for (let seqNo = start; seqNo <= Math.min(end, list.length); seqNo++) {
        const m = list[seqNo - 1]!;
        yield {
          uid: m.uid,
          seq: seqNo,
          envelope: {
            subject: m.subject,
            from: [{ name: "Sender", address: `S${m.uid}@Example.COM ` }],
            date: m.date,
            messageId: m.messageId ?? `<mid-${m.uid}@example.com>`,
          },
          flags: new Set<string>(m.seen ? ["\\Seen"] : []),
          internalDate: m.date,
        };
      }
    },
    fetchOneCalls: 0,
    async fetchOne() { client.fetchOneCalls += 1; return null; },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return client;
}

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

async function adapterOver(
  byFolder: Record<string, FakeMsg[]>,
  opts: { uidValidity?: bigint; silentEpoch?: boolean } = {},
) {
  const fake = makeFakeClient(byFolder, opts);
  const adapter = new ImapAdapter(cfg, { client: fake });
  await adapter.connect();
  return { adapter, fake };
}

const junkOf = (n: number): FakeMsg[] =>
  Array.from({ length: n }, (_, i) => ({
    uid: i + 1, subject: `junk ${i + 1}`, date: new Date(Date.UTC(2026, 0, 1) + (i + 1) * 60_000),
  }));

describe("listFolderPage — the bounded, read-only Junk window read", () => {
  it("a folder past the cap answers exactly the cap, newest first, from ONE bounded fetch range", async () => {
    const { adapter, fake } = await adapterOver({ Junk: junkOf(300) });
    const page = await adapter.listFolderPage("Junk", { limit: 5000 });
    expect(page).not.toBeNull();
    expect(page!.items).toHaveLength(FOLDER_PAGE_MAX);
    expect(page!.total).toBe(300);
    // Newest first, and the WORK was bounded: the one fetch named exactly the top 50 seqs.
    expect(page!.items[0]!.seq).toBe(300);
    expect(page!.items.at(-1)!.seq).toBe(251);
    expect(fake.fetchRanges).toEqual(["251:300"]);
    expect(page!.nextBeforeSeq).toBe(251);
    expect(page!.uidValidity).toBe("7");
    // Read-only: nothing was created on the way through.
    expect(fake.created).toEqual([]);
    // The header facts, normalized: lowercased address, ISO date, the seen flag, the mid.
    const top = page!.items[0]!;
    expect(top.from.address).toBe("s300@example.com");
    expect(top.messageIdHeader).toBe("<mid-300@example.com>");
    expect(top.seen).toBe(false);
    expect(top.date).toBe(new Date(Date.UTC(2026, 0, 1) + 300 * 60_000).toISOString());
  });

  it("a row whose dates the phone's imapflow left as strings (its Date refused them) carries the sent instant", async () => {
    const { adapter } = await adapterOver({ Junk: [
      { uid: 1, subject: "s", date: "24 Oct 2026 06:29:09 +0200" },
      { uid: 2, subject: "t", date: new Date(-61321087851000) }, // "Sat, 24 Oct 26 06:29:09 +0200" on Hermes: year 26
    ] });
    const page = await adapter.listFolderPage("Junk", {});
    expect(page!.items.map((i) => i.date)).toEqual(["2026-10-24T04:29:09.000Z", "2026-10-24T04:29:09.000Z"]);
  });

  it("`beforeSeq` pages STRICTLY older, and the last page says so with a null cursor", async () => {
    const { adapter } = await adapterOver({ Junk: junkOf(60) });
    const older = await adapter.listFolderPage("Junk", { beforeSeq: 11, expectUidValidity: "7" });
    expect(older!.items.map((i) => i.seq)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(older!.nextBeforeSeq).toBeNull();
  });

  it("an EPOCH MISMATCH discards the cursor and serves the top page under the new epoch", async () => {
    // The folder was recreated (uidValidity 7 → 9). A seq watermark from the old epoch means
    // nothing in the new one; serving it would silently skip everything above it. The read
    // starts over and the caller sees the new epoch in the answer.
    const { adapter } = await adapterOver({ Junk: junkOf(60) }, { uidValidity: 9n });
    const page = await adapter.listFolderPage("Junk", { beforeSeq: 11, expectUidValidity: "7" });
    expect(page!.uidValidity).toBe("9");
    expect(page!.items[0]!.seq).toBe(60);
    expect(page!.items).toHaveLength(50);
  });

  it("an UNNAMED epoch discards the cursor too — the `\"0\"` that used to match the other `\"0\"`", async () => {
    // The zero-epoch conflation on the paging path. A server that names no UIDVALIDITY
    // makes this answer `"0"`; the caller stores that and passes it back, and read as strings the
    // two `"0"`s compared EQUAL — so the epoch check sat out exactly the case it exists for, and
    // a seq watermark from a folder nobody can identify was honoured. It is discarded now.
    const { adapter } = await adapterOver({ Junk: junkOf(60) }, { silentEpoch: true });
    const page = await adapter.listFolderPage("Junk", { beforeSeq: 11, expectUidValidity: "0" });
    expect(page!.uidValidity).toBe("0");
    expect(page!.items[0]!.seq).toBe(60);
    expect(page!.items).toHaveLength(50);
  });

  it("…and a server reporting ZERO is the same answer, not a matching epoch", async () => {
    const { adapter } = await adapterOver({ Junk: junkOf(60) }, { uidValidity: 0n });
    const page = await adapter.listFolderPage("Junk", { beforeSeq: 11, expectUidValidity: "0" });
    expect(page!.items[0]!.seq).toBe(60);
    expect(page!.items).toHaveLength(50);
  });

  it("POSITIVE CONTROL — two NAMED, agreeing epochs still page", async () => {
    // Without this the three refusals above are satisfied by a `listFolderPage` that ignores
    // every cursor it is given.
    const { adapter } = await adapterOver({ Junk: junkOf(60) });
    const older = await adapter.listFolderPage("Junk", { beforeSeq: 11, expectUidValidity: "7" });
    expect(older!.items.map((i) => i.seq)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("a MISSING folder is null (the degrade branch); an EMPTY folder is a real zero-item page", async () => {
    const { adapter } = await adapterOver({ Junk: [] });
    expect(await adapter.listFolderPage("NoSuchFolder")).toBeNull();
    const empty = await adapter.listFolderPage("Junk");
    expect(empty).toEqual({ uidValidity: "7", total: 0, items: [], nextBeforeSeq: null });
  });

  it("a TRANSPORT failure propagates — the caller says `unreachable`, never `no_junk_folder`", async () => {
    const { adapter, fake } = await adapterOver({ Junk: junkOf(3) });
    const origLock = fake.getMailboxLock.bind(fake);
    fake.getMailboxLock = async (_path: string) => {
      fake.usable = false; // the socket died with the command
      throw new Error("Connection not available");
    };
    void origLock;
    await expect(adapter.listFolderPage("Junk")).rejects.toThrow("Connection not available");
  });
});

describe("move() — the stale-press guard, now unconditional", () => {
  it("a ref from a RENUMBERED folder is refused as gone, BEFORE the message is even probed", async () => {
    const { adapter, fake } = await adapterOver({ Junk: junkOf(3) }, { uidValidity: 9n });
    await expect(
      adapter.move({ folder: "Junk", ref: "7:2" }, "INBOX", FIXTURE_DOOR),
    ).rejects.toBeInstanceOf(MessageGoneError);
    // The refusal came from the EPOCH, not from the probe — nothing was fetched, and by
    // construction nothing could have been written.
    expect(fake.fetchOneCalls).toBe(0);
  });

  it("NO CALLER CAN OPT OUT — the flagless call refuses too, which is the whole fix", async () => {
    // THE NAMED CONSUMER OF THIS ASSERTION IS THE WORKER'S RECONCILER (`sync.ts#fileOne`), which
    // is the caller that has always used this flagless form. It used to walk PAST the stale epoch
    // to the ordinary probe and, on a folder that still holds a message at that UID, move it.
    // The case that pinned the old behaviour is gone; this is what replaced it.
    const { adapter, fake } = await adapterOver({ Junk: junkOf(3) }, { uidValidity: 9n });
    await expect(
      adapter.move({ folder: "Junk", ref: "7:2" }, "INBOX", FIXTURE_DOOR),
    ).rejects.toBeInstanceOf(MessageGoneError);
    expect(fake.fetchOneCalls).toBe(0);
  });

  it("a MATCHING epoch reaches the probe, not the guard — the healthy path is untouched", async () => {
    const { adapter, fake } = await adapterOver({ Junk: junkOf(3) }, { uidValidity: 9n });
    // The fake's `fetchOne` answers null, so this still ends in `MessageGoneError` — but from the
    // gone-at-source probe, which is observable as the probe having actually run.
    await expect(
      adapter.move({ folder: "Junk", ref: "9:2" }, "INBOX", FIXTURE_DOOR),
    ).rejects.toBeInstanceOf(MessageGoneError);
    expect(fake.fetchOneCalls).toBe(1);
  });
});

describe("move() — the recheck holds at EVERY source lock, not only step 1", () => {
  /**
   * The TOCTOU the second review named: the source lock is released while the destination is
   * inspected, so a folder deleted and recreated IN THAT WINDOW would pass a step-1-only check
   * and still reach the write addressing a recycled UID. The fake flips the folder's
   * UIDVALIDITY on the second acquisition of the source lock — exactly that window — and the
   * move must refuse WITHOUT having copied, moved or deleted anything.
   */
  it("an epoch flip between the probe and the write refuses before any mutation", async () => {
    const writes: string[] = [];
    let junkLocks = 0;
    const client = {
      usable: true,
      capabilities: new Map<string, boolean>([["IDLE", true]]),
      mailbox: false as unknown,
      async list() { return [{ path: "Junk", name: "Junk", delimiter: "/", flags: new Set<string>() }]; },
      async getMailboxLock(path: string) {
        const v = path === "Junk" ? (junkLocks++ === 0 ? 7n : 9n) : 3n;
        client.mailbox = { path, exists: 1, uidValidity: v };
        return { path, release() { /* nothing */ } };
      },
      async search() { return [] as number[]; },
      async fetchOne() {
        return { uid: 2, envelope: { messageId: "<m@x>" }, source: undefined };
      },
      async messageMove(...args: unknown[]) { writes.push(`move ${JSON.stringify(args)}`); return true; },
      async messageCopy(...args: unknown[]) { writes.push(`copy ${JSON.stringify(args)}`); return true; },
      async messageDelete(...args: unknown[]) { writes.push(`delete ${JSON.stringify(args)}`); return true; },
      async logout() { /* nothing */ },
      close() { /* nothing */ },
    };
    const adapter = new ImapAdapter(cfg, { client });
    await adapter.connect();
    await expect(
      adapter.move({ folder: "Junk", ref: "7:2" }, "INBOX", FIXTURE_DOOR),
    ).rejects.toBeInstanceOf(MessageGoneError);
    expect(writes).toEqual([]);
  });
});

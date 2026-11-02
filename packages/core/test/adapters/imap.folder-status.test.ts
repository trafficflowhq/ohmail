import { describe, expect, it } from "vitest";
import { ImapAdapter, isImapBoundExceeded, type LetterAsk } from "../../src/adapters/imap.js";
import { fingerprintDedupKey, legacyDedupKey, messageFingerprint, normalizeMime } from "../../src/mail.js";
import { MAX_RAW_MESSAGE_BYTES } from "../../src/mime.js";

/**
 * `folderStatus` — the mailbox self-check's one server read. Over an injected client, so every
 * answer shape the driver can produce is reachable: a real STATUS, the NotFound imapflow throws for
 * a folder its LIST no longer names, a `false` on a live and on a dead socket, a reply short of a
 * counter, and a STATUS that never answers. Every case asserts the only command sent was STATUS.
 */

type StatusImpl = (path: string, query: Record<string, boolean>) => Promise<unknown>;

function fakeClient(status: StatusImpl, delimiter = "/") {
  const calls: string[] = [];
  const client = {
    calls,
    usable: true,
    closed: 0,
    capabilities: new Map<string, boolean>(),
    mailbox: false as unknown,
    async list() {
      calls.push("list");
      return [{ path: "INBOX", name: "INBOX", delimiter, flags: new Set<string>() }];
    },
    async status(path: string, query: Record<string, boolean>) {
      calls.push(`status ${path} ${Object.keys(query).sort().join(",")}`);
      return status(path, query);
    },
    async logout() { calls.push("logout"); },
    close() { client.closed += 1; client.usable = false; },
  };
  return client;
}

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

async function over(status: StatusImpl, delimiter?: string) {
  const fake = fakeClient(status, delimiter);
  const adapter = new ImapAdapter(cfg, { client: fake });
  await adapter.connect();
  fake.calls.length = 0;
  return { adapter, fake };
}

const never = (): Promise<never> => new Promise<never>(() => { /* a server that never answers */ });

describe("folderStatus — one STATUS, nothing else", () => {
  it("answers the three counters, the epoch as a string, and asks for exactly those three", async () => {
    const { adapter, fake } = await over(async () => ({ path: "INBOX", messages: 12, uidValidity: 1700000001n, uidNext: 40 }));
    expect(await adapter.folderStatus("INBOX", 1_000)).toEqual({ k: "status", messages: 12, uidValidity: "1700000001", uidNext: 40 });
    expect(fake.calls).toEqual(["status INBOX messages,uidNext,uidValidity"]);
  });

  it("addresses the server's path, not the canonical one", async () => {
    const { adapter, fake } = await over(async () => ({ messages: 0, uidValidity: 3n, uidNext: 1 }), ".");
    await adapter.folderStatus("Archive/2019", 1_000);
    expect(fake.calls).toEqual(["status Archive.2019" + " messages,uidNext,uidValidity"]);
  });

  it("a folder the server no longer has is `absent`, a refusal on a live socket `refused`", async () => {
    const gone = await over(async () => { throw Object.assign(new Error("Mailbox doesn't exist"), { code: "NotFound" }); });
    expect(await gone.adapter.folderStatus("Old", 1_000)).toEqual({ k: "absent" });
    const no = await over(async () => false);
    expect(await no.adapter.folderStatus("INBOX", 1_000)).toEqual({ k: "refused" });
  });

  it("a `false` from a socket that died under the command is `dropped`, not a refusal", async () => {
    const holder: { fake?: ReturnType<typeof fakeClient> } = {};
    const { adapter, fake } = await over(async () => { holder.fake!.usable = false; return false; });
    holder.fake = fake;
    expect(await adapter.folderStatus("INBOX", 1_000)).toEqual({ k: "dropped" });
  });

  it("a reply without MESSAGES or UIDVALIDITY is `short` — it compares nothing", async () => {
    const noCount = await over(async () => ({ uidValidity: 9n, uidNext: 3 }));
    expect(await noCount.adapter.folderStatus("INBOX", 1_000)).toEqual({ k: "short" });
    const noEpoch = await over(async () => ({ messages: 4, uidNext: 3 }));
    expect(await noEpoch.adapter.folderStatus("INBOX", 1_000)).toEqual({ k: "short" });
  });

  it("a STATUS that never answers throws the breach inside its deadline and retires the connection", async () => {
    const { adapter, fake } = await over(never);
    const started = Date.now();
    const err = await adapter.folderStatus("INBOX", 60).then(() => null, (e: unknown) => e);
    expect(isImapBoundExceeded(err)).toBe(true);
    expect(Date.now() - started).toBeLessThan(60 * 20);
    expect(fake.closed).toBeGreaterThan(0);
    // The next folder is not queued behind the hung command: it answers at once, unasked.
    const before = fake.calls.length;
    expect(await adapter.folderStatus("Archive", 60)).toEqual({ k: "dropped" });
    expect(fake.calls.length).toBe(before);
  });

  it("POSITIVE CONTROL — an answer inside the deadline is a reading, not a breach", async () => {
    const { adapter, fake } = await over(() => new Promise((ok) => setTimeout(() => ok({ messages: 1, uidValidity: 5n, uidNext: 2 }), 10)));
    expect(await adapter.folderStatus("INBOX", 500)).toMatchObject({ k: "status", messages: 1 });
    expect(fake.closed).toBe(0);
  });
});

describe("folderKeys and uidsHeld — the Junk check's two reads", () => {
  type Search = (q: { uid?: string }, client: { mailbox: unknown }) => unknown;
  async function junk(o: { uidValidity?: bigint; held?: number[]; search?: Search; select?: unknown } = {}) {
    const fake = fakeClient(async () => ({ messages: 2, uidValidity: 7n, uidNext: 30 }));
    const held = new Set(o.held ?? []);
    const asked: string[] = [];
    Object.assign(fake, {
      async getMailboxLock(path: string) {
        fake.calls.push(`select ${path}`);
        if (o.select !== undefined) throw o.select;
        fake.mailbox = { path, uidValidity: o.uidValidity ?? 7n, exists: held.size };
        return { release() { fake.calls.push("release"); } };
      },
      async search(q: { uid?: string }) {
        fake.calls.push("search");
        asked.push(q.uid ?? "?");
        if (o.search) return o.search(q, fake);
        const set = new Set(String(q.uid).split(",").flatMap((r) => {
          const [a, b] = r.split(":").map(Number);
          return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i);
        }));
        return [...held].filter((u) => set.has(u)).concat([100_000]);
      },
    });
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();
    fake.calls.length = 0;
    return { adapter, fake, asked };
  }

  it("folderKeys answers the STATUS keys, a missing folder `absent`, anything short `unanswered`", async () => {
    const { adapter } = await over(async () => ({ messages: 2, uidValidity: 7n, uidNext: 30 }));
    expect(await adapter.folderKeys("Junk")).toEqual({ k: "keys", keys: { uidValidity: "7", uidNext: 30, messages: 2 } });
    const gone = await over(async () => { throw Object.assign(new Error("no"), { code: "NotFound" }); });
    expect(await gone.adapter.folderKeys("Junk")).toEqual({ k: "absent" });
    const noNext = await over(async () => ({ messages: 2, uidValidity: 7n }));
    expect(await noNext.adapter.folderKeys("Junk")).toEqual({ k: "unanswered" });
    const refused = await over(async () => false);
    expect(await refused.adapter.folderKeys("Junk")).toEqual({ k: "unanswered" });
  });

  it("uidsHeld answers the asked UIDs the folder holds, by UID SEARCH under one lock and nothing else", async () => {
    const { adapter, fake, asked } = await junk({ held: [3, 9] });
    const r = await adapter.uidsHeld("Junk", "7", [9, 3, 5]);
    expect(r).toEqual({ k: "held", uidValidity: "7", present: new Set([3, 9]) });
    expect(asked).toEqual(["3,5,9"]);
    expect(fake.calls).toEqual(["select Junk", "search", "release"]);
  });

  it("a re-numbered folder, an unnamed epoch, a missing or refused folder answer without a verdict", async () => {
    const renum = await junk({ uidValidity: 8n, held: [3] });
    expect(await renum.adapter.uidsHeld("Junk", "7", [3])).toEqual({ k: "renumbered", uidValidity: "8" });
    expect(renum.asked).toEqual([]);
    const unnamed = await junk({ held: [3] });
    expect(await unnamed.adapter.uidsHeld("Junk", "0", [3])).toEqual({ k: "unanswered" });
    const missing = await junk({ select: Object.assign(new Error("no"), { serverResponseCode: "NONEXISTENT" }) });
    expect(await missing.adapter.uidsHeld("Junk", "7", [3])).toEqual({ k: "absent" });
    const refused = await junk({ select: new Error("NO [CANNOT]") });
    expect(await refused.adapter.uidsHeld("Junk", "7", [3])).toEqual({ k: "unanswered" });
  });

  it("a `false` search or a selection lost mid-read is `unanswered`; a breach throws", async () => {
    const no = await junk({ search: () => false });
    expect(await no.adapter.uidsHeld("Junk", "7", [3])).toEqual({ k: "unanswered" });
    const lost = await junk({ search: (_q, c) => { c.mailbox = false; return [3]; } });
    expect(await lost.adapter.uidsHeld("Junk", "7", [3])).toEqual({ k: "unanswered" });
    const moved = await junk({ search: (_q, c) => { c.mailbox = { path: "Junk", uidValidity: 8n }; return [3]; } });
    expect(await moved.adapter.uidsHeld("Junk", "7", [3])).toEqual({ k: "unanswered" });
    const flood = await junk({ search: () => Array.from({ length: 50_001 }, (_, i) => i + 1) });
    const err = await flood.adapter.uidsHeld("Junk", "7", [3]).then(() => null, (e: unknown) => e);
    expect(isImapBoundExceeded(err)).toBe(true);
  });

  it("asks in bounded UID sets, never ALL", async () => {
    const uids = Array.from({ length: 600 }, (_, i) => 2 * i + 1);
    const { adapter, asked } = await junk({ held: [1] });
    const r = await adapter.uidsHeld("Junk", "7", uids);
    expect(r).toMatchObject({ k: "held", present: new Set([1]) });
    expect(asked.length).toBeGreaterThan(1);
    for (const set of asked) expect(set.split(",").length).toBeLessThanOrEqual(100);
    expect(asked.join(",").split(",").map(Number).sort((a, b) => a - b)).toEqual(uids);
  });
});

describe("messageIdsGone — the Trash check's read of letters parked at a dropped copy", () => {
  type Query = { header?: Record<string, string>; or?: Array<{ header: Record<string, string> }> };
  /** A folder of `letters` (uid → Message-ID; "" for an envelope naming none). */
  async function trash(o: {
    letters?: Record<number, string>; uidValidity?: bigint; select?: unknown;
    search?: (q: Query, client: { mailbox: unknown }) => unknown; answered?: (uids: number[]) => number[];
  } = {}) {
    const fake = fakeClient(async () => ({ messages: 2, uidValidity: 7n, uidNext: 30 }));
    const letters = new Map(Object.entries(o.letters ?? {}).map(([u, id]) => [Number(u), id]));
    const searched: string[][] = [];
    Object.assign(fake, {
      async getMailboxLock(path: string) {
        fake.calls.push(`select ${path}`);
        if (o.select !== undefined) throw o.select;
        fake.mailbox = { path, uidValidity: o.uidValidity ?? 7n, exists: letters.size };
        return { release() { fake.calls.push("release"); } };
      },
      async search(q: Query) {
        fake.calls.push("search");
        const terms = (q.or ?? [q]).map((x) => x.header!["message-id"]!);
        searched.push(terms);
        if (o.search) return o.search(q, fake);
        // A HEADER search matches a substring of the field, in any case.
        return [...letters].filter(([, id]) => terms.some((t) => id.toLowerCase().includes(t.toLowerCase()))).map(([u]) => u);
      },
      async fetchAll(range: string) {
        fake.calls.push("fetchAll");
        const asked = range.split(",").map(Number);
        return (o.answered ? o.answered(asked) : asked).map((uid) => ({
          uid, envelope: { messageId: letters.get(uid) ? `<${letters.get(uid)}>` : undefined },
        }));
      },
    });
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();
    fake.calls.length = 0;
    return { adapter, fake, searched };
  }

  it("names the asked Message-IDs no letter carries as the server matches them, under one lock", async () => {
    const { adapter, fake } = await trash({ letters: { 3: "a@x", 4: "B@x", 6: "xc@x" } });
    expect(await adapter.messageIdsGone("Trash", "7", ["<a@x>", "b@x", "c@x", "d@x"]))
      .toEqual({ k: "read", uidValidity: "7", gone: new Set(["d@x"]) });
    expect(fake.calls).toEqual(["select Trash", "search", "fetchAll", "release"]);
    const empty = await trash();
    expect(await empty.adapter.messageIdsGone("Trash", "7", ["a@x"])).toEqual({ k: "read", uidValidity: "7", gone: new Set(["a@x"]) });
    expect(empty.fake.calls).toEqual(["select Trash", "search", "release"]);
  });

  it("a refused search, a hit left unread, a lost or renumbered selection and a missing folder give no verdict", async () => {
    const letters = { 3: "a@x" };
    const ask = async (o: Parameters<typeof trash>[0]) => (await trash(o)).adapter.messageIdsGone("Trash", "7", ["a@x", "b@x"]);
    expect(await ask({ letters, search: () => false })).toEqual({ k: "unanswered" });
    expect(await ask({ letters, answered: () => [] })).toEqual({ k: "unanswered" });
    expect(await ask({ letters, search: (_q, c) => { c.mailbox = false; return [3]; } })).toEqual({ k: "unanswered" });
    expect(await ask({ letters, uidValidity: 8n })).toEqual({ k: "renumbered", uidValidity: "8" });
    expect(await ask({ select: Object.assign(new Error("no"), { serverResponseCode: "NONEXISTENT" }) })).toEqual({ k: "absent" });
    // A hit whose envelope names no Message-ID could be either letter's.
    expect(await ask({ letters: { 3: "" }, search: () => [3] })).toEqual({ k: "read", uidValidity: "7", gone: new Set() });
  });

  it("asks in bounded groups, and never names a Message-ID it cannot search for or a group it cannot read", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `m${i}@x`);
    const { adapter, searched } = await trash({ letters: { 9: "m7@x" } });
    const r = await adapter.messageIdsGone("Trash", "7", [...ids, "", "<>", "a b@x", "ü@x"]);
    expect(searched.length).toBeGreaterThan(1);
    for (const s of searched) expect(s.length).toBeLessThanOrEqual(50);
    expect(searched.flat().sort()).toEqual([...ids].sort());
    expect(r).toEqual({ k: "read", uidValidity: "7", gone: new Set(ids.filter((id) => id !== "m7@x")) });
    // A Message-ID that matches more letters than its group may read gets no verdict.
    const crowd = await trash({ letters: { 1: "z@x", 2: "z@xa", 3: "z@xb" } });
    expect(await crowd.adapter.messageIdsGone("Trash", "7", ["z@x"])).toEqual({ k: "read", uidValidity: "7", gone: new Set() });
  });
});

describe("findLetters — a lost delete's letter found in Trash by its own bytes", () => {
  type Query = { header?: Record<string, string>; or?: Array<{ header: Record<string, string> }> };
  const raw = (id: string | null, body: string, subject = "minutes") => Buffer.from([
    ...(id === null ? [] : [`Message-ID: <${id}>`]), "From: anna@x.example", "To: me@x.example", `Subject: ${subject}`,
    "Date: Tue, 02 Jun 2026 09:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", body,
  ].join("\r\n"));
  /** What the store holds for a letter: its keys as ingest wrote them. */
  async function ask(key: string, id: string | null, body: string, o: { legacy?: boolean; subject?: string } = {}): Promise<LetterAsk> {
    const n = await normalizeMime(raw(id, body));
    return {
      key, messageIdHeader: id, dedupKey: o.legacy === true ? legacyDedupKey(n.canonical) : fingerprintDedupKey(messageFingerprint(n)),
      legacy: { messageIdHeader: id, bodyHash: n.canonical.bodyHash, subject: o.subject ?? n.subject, fromAddress: n.from.address },
    };
  }
  /** A Trash folder of `letters` by UID; `size` overrides the size a download declares. */
  async function trash(o: {
    letters?: Record<number, { raw: Buffer; envelopeId?: string | null; size?: number }>; select?: unknown;
    search?: (q: Query, client: { mailbox: unknown }) => unknown; answered?: (uids: number[]) => number[];
  } = {}) {
    const fake = fakeClient(async () => ({ messages: 2, uidValidity: 7n, uidNext: 30 }));
    const letters = new Map(Object.entries(o.letters ?? {}).map(([u, l]) => [Number(u), l]));
    const idOf = (l: { raw: Buffer; envelopeId?: string | null }) =>
      l.envelopeId !== undefined ? l.envelopeId : /^Message-ID: <([^>]*)>/m.exec(l.raw.toString())?.[1] ?? null;
    const searched: string[][] = [];
    Object.assign(fake, {
      async getMailboxLock(path: string) {
        fake.calls.push(`select ${path}`);
        if (o.select !== undefined) throw o.select;
        fake.mailbox = { path, uidValidity: 7n, exists: letters.size };
        return { release() { fake.calls.push("release"); } };
      },
      async search(q: Query) {
        fake.calls.push("search");
        const terms = (q.or ?? [q]).map((x) => x.header!["message-id"]!);
        searched.push(terms);
        if (o.search) return o.search(q, fake);
        return [...letters].filter(([, l]) => terms.some((t) => (/^Message-ID: <([^>]*)>/m.exec(l.raw.toString())?.[1] ?? "")
          .toLowerCase().includes(t.toLowerCase()))).map(([u]) => u);
      },
      async fetchAll(range: string) {
        fake.calls.push("fetchAll");
        const asked = range.split(",").map(Number);
        return (o.answered ? o.answered(asked) : asked).map((uid) => {
          const id = idOf(letters.get(uid)!);
          return { uid, envelope: { messageId: id === null ? undefined : `<${id}>` } };
        });
      },
      async download(range: string, _part: unknown, opts?: { maxBytes?: number }) {
        fake.calls.push(`download ${range}`);
        const l = letters.get(Number(range));
        if (!l) return null;
        const cap = opts?.maxBytes ?? Number.POSITIVE_INFINITY;
        return {
          meta: { expectedSize: l.size ?? l.raw.length },
          content: (async function* () { yield l.raw.length <= cap ? l.raw : l.raw.subarray(0, cap); })(),
        };
      },
    });
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();
    fake.calls.length = 0;
    return { adapter, fake, searched };
  }
  const verdicts = async (t: Awaited<ReturnType<typeof trash>>, asks: LetterAsk[]) => {
    const r = await t.adapter.findLetters("Trash", asks);
    return r.k === "read" ? Object.fromEntries(r.verdicts) : r;
  };

  it("finds the letter whose bytes give its stored key, and an id no letter carries is absent, under one lock", async () => {
    const ours = await ask("a", "a@x", "the minutes of the meeting");
    const t = await trash({ letters: { 4: { raw: raw("a@x", "the minutes of the meeting") } } });
    expect(await verdicts(t, [ours, await ask("b", "b@x", "other")])).toEqual({
      a: { k: "found", locator: { folder: "Trash", ref: "7:4" } }, b: { k: "absent" },
    });
    expect(t.fake.calls).toEqual(["select Trash", "search", "fetchAll", "download 4", "release"]);
  });

  it("a stranger carrying the id, two proven copies, an oversize or short copy are undecided, never found or absent", async () => {
    const ours = await ask("a", "a@x", "the minutes of the meeting");
    const forged = await trash({ letters: { 4: { raw: raw("a@x", "a different letter under the same id") } } });
    expect(await verdicts(forged, [ours])).toEqual({ a: { k: "undecided" } });
    const twice = await trash({ letters: { 4: { raw: raw("a@x", "the minutes of the meeting") }, 5: { raw: raw("a@x", "the minutes of the meeting") } } });
    expect(await verdicts(twice, [ours])).toEqual({ a: { k: "undecided" } });
    const big = await trash({ letters: { 4: { raw: raw("a@x", "the minutes of the meeting"), size: MAX_RAW_MESSAGE_BYTES + 1 } } });
    expect(await verdicts(big, [ours])).toEqual({ a: { k: "undecided" } });
    const short = await trash({ letters: { 4: { raw: raw("a@x", "the minutes of the meeting"), size: 100_000 } } });
    expect(await verdicts(short, [ours])).toEqual({ a: { k: "undecided" } });
  });

  it("a legacy key is proved by its four columns, as ingest proves it", async () => {
    const t = await trash({ letters: { 4: { raw: raw("a@x", "the minutes of the meeting") } } });
    expect(await verdicts(t, [await ask("a", "a@x", "the minutes of the meeting", { legacy: true })]))
      .toEqual({ a: { k: "found", locator: { folder: "Trash", ref: "7:4" } } });
    expect(await verdicts(t, [await ask("a", "a@x", "the minutes of the meeting", { legacy: true, subject: "another subject" })]))
      .toEqual({ a: { k: "undecided" } });
    // One copy proven for two stored letters proves neither.
    expect(await verdicts(t, [
      await ask("a", "a@x", "the minutes of the meeting", { legacy: true }), await ask("b", "a@x", "the minutes of the meeting"),
    ])).toEqual({ a: { k: "undecided" }, b: { k: "undecided" } });
  });

  it("a hit naming no Message-ID, a letter with none, or a crowd of hits leave the group undecided", async () => {
    const ours = await ask("a", "a@x", "the minutes of the meeting");
    const nameless = await trash({
      letters: { 4: { raw: raw("a@x", "the minutes of the meeting") }, 5: { raw: raw("a@x", "x"), envelopeId: null } },
    });
    expect(await verdicts(nameless, [ours, await ask("b", "b@x", "other")])).toEqual({ a: { k: "undecided" }, b: { k: "undecided" } });
    const t = await trash();
    expect(await verdicts(t, [await ask("n", null, "no id at all")])).toEqual({ n: { k: "undecided" } });
    expect(t.searched, "a letter with no Message-ID was searched for").toEqual([]);
    const crowd = await trash({ letters: { 1: { raw: raw("a@x", "1") }, 2: { raw: raw("a@xa", "2") }, 3: { raw: raw("a@xb", "3") } } });
    expect(await verdicts(crowd, [ours])).toEqual({ a: { k: "undecided" } });
  });

  it("a refused search, a hit left unread, an epoch moved under the read or a missing folder give no verdict", async () => {
    const ours = await ask("a", "a@x", "the minutes of the meeting");
    const letters = { 4: { raw: raw("a@x", "the minutes of the meeting") } };
    expect(await verdicts(await trash({ letters, search: () => false }), [ours])).toEqual({ k: "unanswered" });
    expect(await verdicts(await trash({ letters, answered: () => [] }), [ours])).toEqual({ k: "unanswered" });
    expect(await verdicts(await trash({ letters, search: (_q, c) => { c.mailbox = { path: "Trash", uidValidity: 8n }; return [4]; } }), [ours]))
      .toEqual({ k: "unanswered" });
    expect(await verdicts(await trash({ select: Object.assign(new Error("no"), { serverResponseCode: "NONEXISTENT" }) }), [ours]))
      .toEqual({ k: "absent" });
  });

  it("asks in groups of at most 50 ids", async () => {
    const asks = await Promise.all(Array.from({ length: 120 }, (_, i) => ask(`k${i}`, `m${i}@x`, `body ${i}`)));
    const t = await trash({ letters: { 9: { raw: raw("m7@x", "body 7") } } });
    const r = await verdicts(t, asks) as Record<string, { k: string }>;
    expect(t.searched.length).toBe(3);
    for (const s of t.searched) expect(s.length).toBeLessThanOrEqual(50);
    expect(r.k7).toEqual({ k: "found", locator: { folder: "Trash", ref: "7:9" } });
    expect(Object.values(r).filter((v) => v.k === "absent")).toHaveLength(119);
  });
});

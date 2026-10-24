import { describe, expect, it } from "vitest";
import { ImapAdapter, isImapBoundExceeded } from "../../src/adapters/imap.js";

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

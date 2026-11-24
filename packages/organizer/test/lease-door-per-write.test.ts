import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NativeLocator } from "@trafficflow/core";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { ImapAdapter, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { acquireLeasePermit, writeDoorOf, DEFAULT_STALE_AFTER_MS } from "../src/lease.js";
import { reconcileMailbox } from "../src/sync.js";
import { FakeMetaFolder } from "./_fakeadapter.js";
import { PermitClock } from "./_permit-clock.js";

/**
 * ═══ THE LEASE IS ASKED AT THE WRITE, NOT ONLY AT THE PAGE ══════════════════════════════════
 *
 * arm (c): the page boundary asks the permit, and then
 * `moveMany` awaits capabilities, a source lock, a FETCH, a destination lock, a SEARCH and a
 * third lock before its `UID MOVE`. A claim that ages out in that window (a laptop that slept
 * mid-batch) or a stand-down observed there (the send path's own ask) still reached the server.
 *
 * The adapter here is the REAL `ImapAdapter` over a scripted client, so the preflight that holds
 * the window open is the shipped one; the lease is a real permit over an in-memory `_meta`.
 */

let clock = new PermitClock(Date.parse("2026-09-24T10:00:00.000Z"));
const ELEVEN_MINUTES = 11 * 60 * 1000;

interface Script {
  /** Every call the adapter made on the client, in order — the command count. */
  calls: string[];
  /** Every WRITE the client performed, in order — what reached the server. */
  writes: string[];
  /** Run once, inside the first read after the page check. */
  onFirstRead: (() => Promise<void> | void) | null;
  /** Run once, right after the first COPY lands. */
  onCopy: (() => Promise<void> | void) | null;
}

function scriptedClient(opts: { move: boolean; present: number[] }, s: Script) {
  const present = new Set(opts.present);
  let nextDst = 1000;
  const fire = async (which: "onFirstRead" | "onCopy"): Promise<void> => {
    const hook = s[which];
    s[which] = null;
    if (hook) await hook();
  };
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>([
      ["IDLE", true], ["UIDPLUS", true], ...(opts.move ? [["MOVE", true] as [string, boolean]] : []),
    ]),
    mailbox: false as unknown,
    async list() {
      s.calls.push("LIST");
      return ["INBOX", "ohmail/News", "ohmail/Receipts"]
        .map((path) => ({ path, name: path, delimiter: "/", flags: new Set<string>() }));
    },
    async getMailboxLock(path: string) {
      s.calls.push(`SELECT ${path}`);
      client.mailbox = { path, exists: present.size, uidValidity: 42n };
      return { path, release() { /* nothing */ } };
    },
    async fetchAll(range: string) {
      s.calls.push("FETCH");
      await fire("onFirstRead");
      return range.split(",").map(Number).filter((u) => present.has(u))
        .map((uid) => ({ uid, envelope: { messageId: `<m${uid}@rig.test>` } }));
    },
    async fetchOne(uid: string) {
      s.calls.push("FETCH1");
      await fire("onFirstRead");
      const n = Number(uid);
      return present.has(n) ? { uid: n, envelope: { messageId: `<m${n}@rig.test>` } } : false;
    },
    async search() { s.calls.push("SEARCH"); return [] as number[]; },
    async messageMove(uids: number[] | string, to: string) {
      s.calls.push("MOVE");
      s.writes.push(`MOVE ${JSON.stringify(uids)} -> ${to}`);
      const list = Array.isArray(uids) ? uids : [];
      for (const u of list) present.delete(u);
      return { uidValidity: 77n, uidMap: new Map(list.map((u) => [u, nextDst++])) };
    },
    async messageCopy(uids: number[], to: string) {
      s.calls.push("COPY");
      s.writes.push(`COPY ${JSON.stringify(uids)} -> ${to}`);
      const res = { uidValidity: 77n, uidMap: new Map(uids.map((u) => [u, nextDst++])) };
      await fire("onCopy");
      return res;
    },
    async messageDelete(uids: number[]) {
      s.calls.push("EXPUNGE");
      s.writes.push(`EXPUNGE ${JSON.stringify(uids)}`);
      for (const u of uids) present.delete(u);
      return true;
    },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return client;
}

/** Two rows in two destinations: two groups, two pages — the second page is what must not go. */
function repoOf(locs: readonly NativeLocator[], filed: string[]): WorkerRepo {
  const stub = {
    mailboxStatusForWrite: async (): Promise<string> => "connected",
    listPendingFolderStates: async () => [
      { messageId: "m-1", desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: locs[0]! },
      { messageId: "m-2", desiredFolder: "ohmail/Receipts", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: locs[1]! },
    ],
    listPendingFlagStates: async () => [],
    updateLocator: async (messageId: string) => { filed.push(messageId); },
    upsertFolderState: async () => {},
    completeFolderState: async () => true,
    upsertFlagState: async () => {},
    primaryInstanceVanished: async () => false,
    deferFolderReconcile: async () => {},
    deferFlagReconcile: async () => {},
    recordAudit: async () => {},
  };
  return {
    ...stub,
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
  } as unknown as WorkerRepo;
}

const LOCS: NativeLocator[] = [{ folder: "INBOX", ref: "42:1" }, { folder: "INBOX", ref: "42:2" }];

async function rig(opts: { move: boolean }) {
  clock = new PermitClock(Date.parse("2026-09-24T10:00:00.000Z"));
  const script: Script = { calls: [], writes: [], onFirstRead: null, onCopy: null };
  const client = scriptedClient({ move: opts.move, present: [1, 2] }, script);
  const adapter = new ImapAdapter(
    { host: "rig.invalid", port: 0, secure: false, auth: { user: "u", pass: "p" } },
    { client: client as never },
  );
  await adapter.connect();
  const meta = new FakeMetaFolder();
  const mailboxId = randomUUID();
  const permit = await acquireLeasePermit({
    adapter: { leaseIo: () => meta } as unknown as MailboxAdapter,
    self: { installId: "ohmail-cloud:test", kind: "cloud", displayName: "ohmail Cloud", lastNonce: null },
    mailboxId, hasRequestKey: false, ...clock.pair,
  });
  const filed: string[] = [];
  const cycle = (): Promise<unknown> => reconcileMailbox({
    repo: repoOf(LOCS, filed), adapter, accountId: "acct", mailboxId,
    role: "organizer", trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
    writeAuthority: permit,
  }).then(() => null, (e: unknown) => e);
  return { script, meta, permit, filed, cycle };
}

/** THE TAKEOVER as the winner's gate leaves the folder: our claim gone, a fresh foreign one. */
function transferToRival(meta: FakeMetaFolder): void {
  meta.messages.splice(0);
  meta.messages.push({
    ref: 900,
    raw: [
      "X-Ohmail-Lease: 1", "X-Ohmail-Organizer-Kind: local", "X-Ohmail-Install-Id: the-laptop",
      "X-Ohmail-Protocol: 1", `X-Ohmail-Heartbeat: ${clock.now().toISOString()}`,
      `X-Ohmail-Claimed-At: ${new Date(clock.ms - 1_000).toISOString()}`,
      "X-Ohmail-Display-Name: a laptop", "X-Ohmail-Nonce: rival", "", "",
    ].join("\r\n"),
  });
}

describe("the write door — asked immediately before the command", () => {
  it("a claim that ages out between the page check and the UID MOVE sends nothing", async () => {
    const r = await rig({ move: true });
    // The laptop slept inside the batch's preflight: the page check was served inside the permit's
    // minute, and by the time the MOVE would go out every other install reads the claim as stale.
    r.script.onFirstRead = () => { clock.advance(ELEVEN_MINUTES); };

    const err = await r.cycle();

    expect(r.script.writes, "a UID MOVE went out on a claim older than its window").toEqual([]);
    expect(r.filed).toEqual([]);
    expect((err as Error | null)?.name, "the decline must end the cycle, named").toBe("WriteDeclinedError");
    expect((err as { reason?: string }).reason).toBe("claim_stale");
  });

  it("a stand-down observed between the page check and the UID MOVE sends nothing", async () => {
    const r = await rig({ move: true });
    // Another path sharing this receipt (the send path's own ask) re-reads past the minute and
    // finds the laptop holding the mailbox. The permit is revoked while this batch is mid-flight.
    r.script.onFirstRead = async () => {
      transferToRival(r.meta);
      clock.advance(61_000);
      await r.permit.check().catch(() => undefined);
    };

    const err = await r.cycle();

    expect(r.permit.revoked, "the precondition: the concurrent ask stood this permit down").toBe(true);
    expect(r.script.writes, "a UID MOVE went out on a permit that had stood down").toEqual([]);
    expect((err as Error | null)?.name).toBe("WriteDeclinedError");
    expect((err as { reason?: string }).reason).toBe("stood_down");
  });

  it("a COPY-then-DELETE pair is one unit: a stand-down after the COPY still finishes the pair", async () => {
    // No MOVE: `moveMany` declines before anything, and each row takes `move`'s COPY + EXPUNGE.
    const r = await rig({ move: false });
    r.script.onCopy = async () => {
      transferToRival(r.meta);
      clock.advance(61_000);
      await r.permit.check().catch(() => undefined);
    };

    await r.cycle();

    // Message one: the COPY had run, so the EXPUNGE follows — a half pair is mail in two places.
    // Message two: its page asks the permit, which is dead, so nothing of it is written.
    expect(r.script.writes).toEqual([
      'COPY [1] -> ohmail/News',
      "EXPUNGE [1]",
    ]);
    expect(r.filed).toEqual(["m-1"]);
  });

  it("POSITIVE CONTROL — a claim held throughout files both pages, with no extra command", async () => {
    const r = await rig({ move: true });
    const before = r.permit.reads;

    const err = await r.cycle();

    expect(err).toBeNull();
    expect(r.script.writes).toEqual([
      'MOVE [1] -> ohmail/News',
      'MOVE [2] -> ohmail/Receipts',
    ]);
    expect(r.filed).toEqual(["m-1", "m-2"]);
    // THE ROUND-TRIP RATCHET for this seam: the door answers from the permit's own state, so a
    // batch costs the commands it cost before the door existed and the permit is not re-read.
    expect(r.script.calls).toEqual([
      "LIST",
      "SELECT INBOX", "FETCH", "SELECT ohmail/News", "SEARCH", "SELECT INBOX", "MOVE",
      "SELECT INBOX", "FETCH", "SELECT ohmail/Receipts", "SEARCH", "SELECT INBOX", "MOVE",
    ]);
    expect(r.permit.reads).toBe(before);
  });
});

describe("writeDoorOf — the one door, answered from the permit's own state", () => {
  const ALL = ["move", "expunge", "seen", "folder_create", "folder_rename", "folder_delete", "folder_sweep"] as const;

  /** On this file's own clock, which `transferToRival` stamps the winner's heartbeat with. */
  async function permitAt() {
    clock = new PermitClock(Date.parse("2026-09-24T12:00:00.000Z"));
    const meta = new FakeMetaFolder();
    const permit = await acquireLeasePermit({
      adapter: { leaseIo: () => meta } as unknown as MailboxAdapter,
      self: { installId: "ohmail-cloud:test", kind: "cloud", displayName: "ohmail Cloud", lastNonce: null },
      mailboxId: randomUUID(), hasRequestKey: false, ...clock.pair,
    });
    return { permit, meta, advance: (ms: number) => { clock.advance(ms); } };
  }

  it("a held claim admits every organizer write", async () => {
    const { permit } = await permitAt();
    const door = writeDoorOf({ lease: permit });
    for (const w of ALL) expect(door.ask(w), w).toEqual({ admit: true });
  });

  it("the claim is stale AT the window a peer reads it fresh in, less a quarter for clock skew", async () => {
    const { permit, advance } = await permitAt();
    const door = writeDoorOf({ lease: permit });
    const edge = DEFAULT_STALE_AFTER_MS - DEFAULT_STALE_AFTER_MS / 4;
    advance(edge - 1);
    expect(door.ask("move")).toEqual({ admit: true });
    advance(1);
    expect(door.ask("move")).toEqual({ admit: false, reason: "claim_stale" });
  });

  it("a stood-down permit declines, and the reason names it", async () => {
    const { permit, meta, advance } = await permitAt();
    transferToRival(meta);
    advance(61_000);
    await permit.check().catch(() => undefined);
    expect(permit.revoked).toBe(true);
    expect(writeDoorOf({ lease: permit }).ask("seen")).toEqual({ admit: false, reason: "stood_down" });
  });

  it("a reader writes \\Seen and nothing else", () => {
    const door = writeDoorOf({ lease: { noLease: "reader" } });
    expect(door.ask("seen")).toEqual({ admit: true });
    for (const w of ALL.filter((k) => k !== "seen")) {
      expect(door.ask(w), w).toEqual({ admit: false, reason: "no_lease" });
    }
  });

  it("`not_supplied` is refused for every write, by name — the page check agrees (census file)", () => {
    const door = writeDoorOf({ lease: { noLease: "not_supplied" } });
    for (const w of ALL) expect(door.ask(w), w).toEqual({ admit: false, reason: "not_supplied" });
  });

  it("an opt-out observed this batch declines whatever the lease says", async () => {
    const { permit } = await permitAt();
    expect(writeDoorOf({ lease: permit }, { foldersOff: true }).ask("move"))
      .toEqual({ admit: false, reason: "folders_off" });
    expect(writeDoorOf({ lease: permit }, { foldersOff: false }).ask("move")).toEqual({ admit: true });
  });
});

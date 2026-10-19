import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapAdapter, messageIdFromRaw, parseRef } from "../../src/adapters/imap.js";
import { WATCHED_FOLDERS, type ImapConfig, type ImapCursor } from "../../src/adapters/imap-types.js";
import type { Change } from "../../src/mail.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, eml, greenmailConfig, probeCondstore } from "./_imapenv.js";
import { startFaultProxy, type FaultProxy } from "./_fault-proxy.js";

/**
 * A LETTER MARKED READ ELSEWHERE DURING THE SYNC'S OWN FETCHES IS STILL IMPORTED WHOLE
 * (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS), on GreenMail and Dovecot through the real adapter.
 *
 * The proxy parks one of the sync's FETCHes while another session sets \Seen; both servers then send
 * that flag change inside the parked command's reply (`unsolicited` counts it), and with
 * `unsolicitedFirst` ahead of the reply, the order the 2026-10-19 forward put down to iCloud. On the
 * old adapter: A stored an empty create for a letter outside the page, B the same UID twice with the
 * empty one first, C read the page letter's size as none and fetched it alone, D and E made an empty
 * create in the targeted re-read. Every case now answers one create per asked UID, its own bytes.
 * The unit cases, every read site of the adapter, are `imap-stray-rows.test.ts`; the cycle on top of
 * this is `apps/worker/test/sync-flag-race.e2e.test.ts`.
 */

const DOVECOT = await probeCondstore();

const cold = (): ImapCursor => {
  const folders: ImapCursor["folders"] = {};
  for (const f of WATCHED_FOLDERS) folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders };
};

const open: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of open.splice(0)) await c().catch(() => { /* already down */ }); });

async function world(server: { host: string; port: number; pass: string }, n: number, maxBatchMessages = 2) {
  const auth = { user: `t-${randomUUID()}@trafficflow.test`, pass: server.pass };
  const proxy: FaultProxy = await startFaultProxy({ host: server.host, port: server.port });
  open.push(() => proxy.close());
  // The other session — the phone marking a letter read — never goes through the proxy.
  const other = new ImapFlow({ host: server.host, port: server.port, secure: false, auth, logger: false });
  await other.connect();
  open.push(() => other.logout());
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(`letter-${i}-${randomUUID()}@x.example`);
    await other.append("INBOX", eml({ from: `s${i}@x.example`, subject: `letter ${i}`, messageId: ids[i]! }),
      [], new Date(Date.UTC(2026, 0, 1 + i)));
  }
  const lock = await other.getMailboxLock("INBOX");
  const uids = (await other.search({ all: true }, { uid: true }) as number[]).sort((a, b) => a - b);
  lock.release();
  const cfg: ImapConfig = { host: "127.0.0.1", port: proxy.port, secure: false, auth };
  const adapter = new ImapAdapter(cfg, { maxBatchMessages });
  await adapter.connect();
  open.push(() => adapter.close());
  const markSeen = async (uid: number): Promise<void> => {
    const l = await other.getMailboxLock("INBOX");
    try { await other.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }); } finally { l.release(); }
  };
  /** The letter each UID holds, by its Message-ID. */
  const idOf = new Map(uids.map((u, i) => [u, ids[i]!]));
  const uidFetches = (): number => proxy.count("UID FETCH", "INBOX");
  return { adapter, proxy, uids, idOf, markSeen, uidFetches };
}

const BODY = (c: string, a: string): boolean => c === "UID FETCH" && /BODY\.PEEK\[\]/i.test(a);
const SIZE = (c: string, a: string): boolean => c === "UID FETCH" && /RFC822\.SIZE/i.test(a) && !/BODY/i.test(a);

/** One create per expected UID, each carrying its own letter, never an empty one. */
function expectOwnLetters(creates: readonly Change[], idOf: ReadonlyMap<number, string>, uids: readonly number[]): void {
  const uidOf = (c: Change): number => parseRef(c.locator.ref).uid;
  expect(creates.filter((c) => (c.raw?.length ?? 0) === 0).map(uidOf), "an empty create").toEqual([]);
  expect(creates.map(uidOf).sort((a, b) => a - b), "one create per asked UID").toEqual([...uids].sort((a, b) => a - b));
  for (const c of creates) expect(messageIdFromRaw(c.raw!), `uid ${uidOf(c)}`).toBe(idOf.get(uidOf(c)));
}

const servers: Array<[string, () => { host: string; port: number; pass: string } | null]> = [
  ["GreenMail", () => { const g = greenmailConfig(); return { host: g.host, port: g.port, pass: (g.auth as { pass: string }).pass }; }],
  [DOVECOT.ok ? "Dovecot" : `Dovecot — SKIPPED: ${DOVECOT.ok ? "" : DOVECOT.why}`,
    () => (DOVECOT.ok ? { host: CONDSTORE_HOST, port: CONDSTORE_PORT, pass: process.env.IMAP_CONDSTORE_PASS ?? "testpass-password" } : null)],
];

describe.each(servers)("the sync's fetches while another session marks a letter read (%s)", (_name, server) => {
  const run = server() ? it : it.skip;

  run("CONTROL: an undisturbed page of two of four is the two newest letters, in three UID FETCHes", async () => {
    const { adapter, uids, idOf, uidFetches } = await world(server()!, 4);
    const batch = await adapter.changesSince(cold());
    expectOwnLetters(batch.creates, idOf, uids.slice(2));
    expect(uidFetches()).toBe(3);
  });

  run("A: a letter outside the page marked read during the body fetch is no create (servers' own order)", async () => {
    const { adapter, proxy, uids, idOf, markSeen } = await world(server()!, 4);
    proxy.hold = { when: BODY, run: () => markSeen(uids[0]!) };
    const batch = await adapter.changesSince(cold());
    // The rig did what it says: the hold fired and the flag change came back inside the reply.
    expect(proxy.hold).toBe(null);
    expect(proxy.unsolicited).toBeGreaterThanOrEqual(1);
    expectOwnLetters(batch.creates, idOf, uids.slice(2));
    expect(batch.hasBacklog).toBe(true);
  });

  run("B: a page letter marked read during the body fetch, the flag change ahead of the reply", async () => {
    const { adapter, proxy, uids, idOf, markSeen } = await world(server()!, 4);
    proxy.hold = { when: BODY, unsolicitedFirst: true, run: () => markSeen(uids.at(-1)!) };
    const batch = await adapter.changesSince(cold());
    expect(proxy.reordered).toBeGreaterThanOrEqual(1);
    expectOwnLetters(batch.creates, idOf, uids.slice(2));
  });

  run("C: a page letter marked read during the RFC822.SIZE fetch keeps its size: still three UID FETCHes", async () => {
    const { adapter, proxy, uids, idOf, markSeen, uidFetches } = await world(server()!, 4);
    proxy.hold = { when: SIZE, run: () => markSeen(uids.at(-1)!) };
    const batch = await adapter.changesSince(cold());
    expect(proxy.unsolicited).toBeGreaterThanOrEqual(1);
    expectOwnLetters(batch.creates, idOf, uids.slice(2));
    expect(uidFetches(), "an unstated size sends the letter alone, past the size gate").toBe(3);
  });

  run("D: the targeted re-read, another letter marked read during its body fetch", async () => {
    const { adapter, proxy, uids, idOf, markSeen } = await world(server()!, 3);
    proxy.hold = { when: BODY, run: () => markSeen(uids[0]!) };
    const got = await adapter.fetchByUid("INBOX", [uids.at(-1)!]);
    expect(proxy.unsolicited).toBeGreaterThanOrEqual(1);
    expectOwnLetters(got.creates, idOf, [uids.at(-1)!]);
    expect(got.absent).toEqual([]);
  });

  run("E: the targeted re-read, the asked letter marked read and the flag change ahead of the reply", async () => {
    const { adapter, proxy, uids, idOf, markSeen } = await world(server()!, 3);
    proxy.hold = { when: BODY, unsolicitedFirst: true, run: () => markSeen(uids.at(-1)!) };
    const got = await adapter.fetchByUid("INBOX", [uids.at(-1)!]);
    expect(proxy.reordered).toBeGreaterThanOrEqual(1);
    expectOwnLetters(got.creates, idOf, [uids.at(-1)!]);
  });
});

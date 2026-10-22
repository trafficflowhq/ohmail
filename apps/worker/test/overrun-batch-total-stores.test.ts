import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxFolders, messageInstances, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { breachSetAside, DeadLetterLedger } from "../src/dead-letter.js";
import { KnownSetCache } from "../src/known-set.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A BATCH-TOTAL OVERRUN IN A FOLDER WHOSE CURSOR NAMES NO LIVE EPOCH, ON THE STORE THIS RUN USES:
 * the desktop's and the phone's (`npm run test:sqlite` runs this file on the second). The real
 * ImapAdapter over a scripted server, a fresh one per cycle as a re-dial makes it, through
 * `runSyncCycle` and its own cursor build. Twelve letters each declare 10 bytes and stream 300 KB,
 * so four together cross the batch total. Sent (not a watched folder) and a customer folder are
 * read for the first time, then renumbered with one letter deleted meanwhile. Every breach must be
 * progress, as both engines judge it, and every body is fetched once per epoch.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000b7a11";
const WATCHED = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];
const eml = (id: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@lane.test>`, "", `Body of ${id}.`, "",
].join("\r\n"));
type Msg = { id: string; raw: Buffer; declared: number };
const rider = (id: string): Msg => ({ id, raw: Buffer.concat([eml(id), Buffer.alloc(300_000, 0x61)]), declared: 10 });

function server(folders: Map<string, { uidValidity: bigint; msgs: Map<number, Msg> }>) {
  const bodies: Record<string, number> = {};
  const client = () => {
    let path = "INBOX";
    const here = () => folders.get(path)?.msgs ?? new Map<number, Msg>();
    const parseSet = (range: unknown): number[] => {
      const all = [...here().keys()].sort((a, b) => a - b);
      if (Array.isArray(range)) return range.map(Number).filter((u) => here().has(u)).sort((a, b) => a - b);
      return all;
    };
    const c = {
      usable: true,
      capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true]]),
      mailbox: undefined as unknown,
      async list() {
        return [...new Set([...WATCHED, ...folders.keys()])].map((p) => ({ path: p, name: p.split("/").pop()!, delimiter: "/", flags: new Set<string>() }));
      },
      async mailboxCreate(p: string) { return { path: p }; },
      async getMailboxLock(p: string) {
        path = p;
        const keys = [...here().keys()];
        c.mailbox = { path: p, uidValidity: folders.get(p)?.uidValidity ?? 7n, uidNext: Math.max(0, ...keys) + 1, highestModseq: 0n, exists: keys.length };
        return { path: p, release() { /* nothing */ } };
      },
      async search() { return []; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(range: any, query: any) {
        for (const uid of parseSet(range)) {
          const m = here().get(uid)!;
          if (query?.source) {
            bodies[m.id] = (bodies[m.id] ?? 0) + 1;
            yield { uid, flags: new Set<string>(), envelope: { messageId: `<${m.id}@lane.test>` }, source: m.raw, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000) };
          } else if (query?.size) yield { uid, size: m.declared };
          else if (query?.headers) yield { uid, headers: Buffer.from(`Message-ID: <${m.id}@lane.test>\r\n`) };
          else if (query?.internalDate) yield { uid, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000), envelope: {} };
          else if (query?.flags) yield { uid, flags: new Set<string>() };
          else yield { uid };
        }
      },
      async logout() { /* nothing */ },
      close() { /* nothing */ },
      on() { /* no events */ },
    };
    return c;
  };
  return { bodies, client };
}

describe("a batch total in a first-read and then renumbered folder, on this store", () => {
  for (const folder of ["Archive", "Sent"]) {
    it(`${folder}: both reads drain, each body fetched once per epoch, every breach progress, the deleted letter gone`, async () => {
      const db = (await makeTestDb()) as unknown as Tx;
      const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: `s-${randomUUID().slice(0, 8)}@example.test` }).returning();
      const repo = makeDrizzleRepo(db as never);
      const deadLetters = new DeadLetterLedger();
      const knownSet = new KnownSetCache(mb!.id);
      const fleet = new FakeAdapterFleet();
      const ids = Array.from({ length: 12 }, (_, i) => `${folder}-${i + 1}`);
      const first = new Map<number, Msg>(ids.map((id, i) => [1 + i, rider(id)]));
      const folders = new Map([[folder, { uidValidity: 300n, msgs: first }]]);
      const s = server(folders);
      const outcomes: string[] = [];
      /** One cycle on a fresh connection, judged as the engines judge it. */
      const cycle = async (): Promise<boolean> => {
        const ctx = { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* the next cycle dials again */ } };
        const fake = fleet.factory({ host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } }, ctx);
        const real = new ImapAdapter({ host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } }, { client: s.client() as never });
        await real.connect();
        const adapter = {
          ...fake, capabilities: () => real.capabilities(),
          changesSince: (c) => real.changesSince(c), fetchByUid: (f, u, o) => real.fetchByUid(f, u, o),
        } as MailboxAdapter;
        try {
          const r = await runSyncCycle({
            writeAuthority: FIXTURE_LEASE, repo, adapter, accountId: ACCOUNT, mailboxId: mb!.id,
            storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(), deadLetters, knownSet,
          } as never);
          outcomes.push("served");
          return !r.hasBacklog;
        } catch (err) {
          outcomes.push(breachSetAside(err, deadLetters) ? "progress" : `failed: ${String(err)}`);
          return false;
        } finally {
          await real.close().catch(() => undefined);
        }
      };
      const drain = async (): Promise<void> => { for (let i = 0; i < 10; i++) if (await cycle()) return; };
      const instances = async (): Promise<string[]> => (await db.select({ uv: messageInstances.uidvalidity })
        .from(messageInstances).where(eq(messageInstances.folder, folder))).map((r) => String(r.uv));

      await drain();
      expect(await instances(), "the first read did not drain").toEqual(Array(12).fill("300"));
      expect(outcomes.filter((o) => o.startsWith("failed")), "a first-read breach after kept mail was a failure").toEqual([]);
      expect(outcomes, "no breach was met, so the first read proves nothing").toContain("progress");
      expect(Object.values(s.bodies), "a body was fetched more than once").toEqual(Array(12).fill(1));

      // Renumbered: the same letters under new uids and epoch 301, the last one deleted meanwhile.
      const renumbered = new Map<number, Msg>();
      for (const [uid, m] of first) if (m.id !== ids[11]) renumbered.set(100 + uid, m);
      folders.set(folder, { uidValidity: 301n, msgs: renumbered });
      const before = { ...s.bodies };
      outcomes.length = 0;
      await drain();
      const again = Object.fromEntries(Object.entries(s.bodies).map(([id, n]) => [id, n - (before[id] ?? 0)]));
      console.log(`STORES ${folder}`, JSON.stringify({ outcomes, again }));
      expect(await instances(), "the folder was not re-learned under its new epoch").toEqual(Array(11).fill("301"));
      expect(outcomes.filter((o) => o.startsWith("failed")), "a re-read breach after re-learned mail was a failure").toEqual([]);
      expect(outcomes, "no breach was met, so the re-read proves nothing").toContain("progress");
      for (const m of renumbered.values()) expect(again[m.id], `${m.id} fetched again`).toBe(1);
      expect(again[ids[11]!] ?? 0, "the deleted letter was fetched").toBe(0);
      const [gone] = await db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.subject, ids[11]!));
      expect(gone?.deletedAt, "the letter deleted during the renumbering is still shown").not.toBeNull();
      const [row] = await db.select({ uv: mailboxFolders.uidvalidity }).from(mailboxFolders).where(eq(mailboxFolders.folder, folder));
      expect(String(row?.uv)).toBe("301");
    });
  }
});

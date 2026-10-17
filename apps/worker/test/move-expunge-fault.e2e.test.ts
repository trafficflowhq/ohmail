import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { folderState, mailboxes, messageInstances, messages, rules } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { makeDb } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { DB_URL, byMessageId, refuseDriftedSharedDb } from "./_workerdb.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";
import {
  CONDSTORE_HOST, CONDSTORE_PORT, probeCondstore,
} from "../../../packages/core/test/adapters/_imapenv.js";
import {
  copiesOf as census, startFaultProxy, type ExpungeFault, type FaultProxy,
} from "../../../packages/core/test/adapters/_fault-proxy.js";

/**
 * A FILING WHOSE EXPUNGE FAILS, ON A REAL DOVECOT. The proxy hides MOVE, so filing is COPY then
 * expunge of the source, and fails the EXPUNGE in INBOX while every other command passes. Five
 * organize cycles through `runSyncCycle` (the worker's and the desktop engine's cycle), then the
 * fault clears. After every cycle: the destination holds ONE copy (never a second), the source is
 * the original still owed its expunge (flagged \Deleted, so one live copy), nothing moves back,
 * and the mirror's one row points at a message the server holds. Once an EXPUNGE goes through,
 * exactly one copy remains, at the destination, and the mirror says so.
 */

const DEST = "ohmail/News";
const CONDSTORE = await probeCondstore();

function eml(messageId: string): string {
  return [
    `Message-ID: <${messageId}>`, "From: news@feed.example", "To: mila@lichtgrat.example",
    "Subject: digest", "Date: Sat, 17 Oct 2026 07:00:00 +0000", "Content-Type: text/plain", "", "hi",
  ].join("\r\n");
}

const open: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of open.splice(0)) await c().catch(() => { /* already down */ }); });

async function world(fault: ExpungeFault, hide: string[]) {
  await refuseDriftedSharedDb();
  const proxy: FaultProxy = await startFaultProxy({ host: CONDSTORE_HOST, port: CONDSTORE_PORT }, { hide });
  open.push(() => proxy.close());
  const user = `t-${randomUUID()}@trafficflow.test`;
  const auth = { user, pass: process.env.IMAP_CONDSTORE_PASS ?? "testpass-password" };
  const viaProxy: ImapConfig = { host: "127.0.0.1", port: proxy.port, secure: false, auth };
  const direct = new ImapFlow({ host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false, auth, logger: false });
  await direct.connect();
  open.push(() => direct.logout());

  const accountId = randomUUID();
  const db = makeDb(DB_URL);
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: user }).returning();
  await db.insert(rules).values({ accountId, kind: "domain", match: "feed.example", destination: DEST, priority: 5 });
  const repo = makeDrizzleRepo(db);
  // The worker's attach: a fresh connection whenever the last one is no longer live.
  let adapter: ImapAdapter | null = null;
  const live = async (): Promise<ImapAdapter> => {
    if (adapter?.isLive()) return adapter;
    const a = new ImapAdapter(viaProxy);
    await a.connect();
    open.push(() => a.close());
    adapter = a;
    return a;
  };
  await (await live()).ensureFolders(FIXTURE_DOOR);
  expect((await (await live()).capabilities()).move).toBe(false);
  proxy.fault = fault;
  proxy.onlyMailbox = "INBOX";

  const cycle = async (): Promise<void> => {
    await runSyncCycle({
      repo, adapter: await live(), accountId, mailboxId: mb!.id,
      storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    // The deferral's backoff has elapsed: each cycle gets to retry the move.
    await db.update(folderState).set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(folderState.reconcileStatus, "pending"));
  };
  const mirror = async (messageId: string) => {
    const rows = await db.select().from(messages).where(byMessageId(mb!.id, messageId));
    const instances = rows.length === 1
      ? await db.select().from(messageInstances).where(eq(messageInstances.messageId, rows[0]!.id))
      : [];
    const state = rows.length === 1
      ? (await db.select().from(folderState).where(eq(folderState.messageId, rows[0]!.id)))[0]
      : undefined;
    return { rows, instances, state };
  };
  return { proxy, direct, cycle, mirror };
}

describe.skipIf(!CONDSTORE.ok)(
  `COPY lands, EXPUNGE fails: five organize cycles on Dovecot${CONDSTORE.ok ? "" : ` (SKIPPED: ${CONDSTORE.why})`}`,
  () => {
    beforeAll(async () => { await runMigrations(DB_URL); });

    const arms: Array<{ name: string; fault: ExpungeFault; hide: string[] }> = [
      { name: "UID EXPUNGE answered NO", fault: "no", hide: ["MOVE"] },
      { name: "EXPUNGE answered NO, no UIDPLUS", fault: "no", hide: ["MOVE", "UIDPLUS"] },
      { name: "connection dropped at the EXPUNGE", fault: "drop", hide: ["MOVE"] },
    ];
    for (const arm of arms) {
      it(`${arm.name}: one copy at the destination every cycle, one copy in all once it clears`, async () => {
        const w = await world(arm.fault, arm.hide);
        const mid = `b14-${randomUUID()}@feed.example`;
        await w.direct.append("INBOX", eml(mid));
        const [{ uid: srcUid }] = await census(w.direct, mid);

        let destUid: number | null = null;
        for (let n = 1; n <= 5; n++) {
          await w.cycle();
          const copies = await census(w.direct, mid);
          const at = (f: string) => copies.filter((c) => c.folder === f);
          console.info(`[b14 ${arm.name}] cycle ${n}: ${JSON.stringify(copies)}`);
          expect(at(DEST), `cycle ${n}: the destination never gains a second copy`).toHaveLength(1);
          expect(at("INBOX"), `cycle ${n}: the source is the original, owed its expunge`)
            .toEqual([{ folder: "INBOX", uid: srcUid, deleted: true }]);
          expect(copies).toHaveLength(2);
          expect(copies.filter((c) => !c.deleted), `cycle ${n}: one live copy`).toHaveLength(1);
          destUid ??= at(DEST)[0]!.uid;
          expect(at(DEST)[0]!.uid, `cycle ${n}: the same copy, not a re-made one`).toBe(destUid);

          const m = await w.mirror(mid);
          expect(m.rows).toHaveLength(1);
          const primary = m.instances.filter((i) => i.isPrimary);
          expect(primary.map((i) => [i.folder, i.uid])).toEqual([["INBOX", srcUid]]);
          expect(m.state).toMatchObject({ desiredFolder: DEST, reconcileStatus: "pending" });
          for (const i of m.instances) {
            expect(copies.some((c) => c.folder === i.folder && c.uid === i.uid), `instance ${i.folder}#${i.uid} is on the server`).toBe(true);
          }
        }
        expect(w.proxy.count("UID COPY"), "one COPY in five cycles").toBe(1);
        expect(w.proxy.count("UID COPY", DEST) + w.proxy.count("UID MOVE"), "nothing moves back").toBe(0);
        expect(w.proxy.log.filter((e) => e.faulted)).toHaveLength(5);

        w.proxy.fault = "pass";
        for (let n = 6; n <= 7; n++) {
          await w.cycle();
          const copies = await census(w.direct, mid);
          console.info(`[b14 ${arm.name}] cycle ${n} (fault cleared): ${JSON.stringify(copies)}`);
          expect(copies, `cycle ${n}: exactly one copy, the one made in cycle 1`)
            .toEqual([{ folder: DEST, uid: destUid, deleted: false }]);
          const m = await w.mirror(mid);
          expect(m.rows).toHaveLength(1);
          expect(m.rows[0]!.nativeLocator).toMatchObject({ folder: DEST });
          expect(m.instances.map((i) => [i.folder, i.uid, i.isPrimary])).toEqual([[DEST, destUid, true]]);
          expect(m.state).toMatchObject({ desiredFolder: DEST, observedFolder: DEST, reconcileStatus: "reconciled" });
        }
        expect(w.proxy.count("UID COPY"), "the retry adopted the copy instead of making another").toBe(1);
      }, 60_000);
    }

    it("the server expunged and the client never heard: one copy every cycle, nothing moves back", async () => {
      const w = await world("drop-after", ["MOVE"]);
      const mid = `b14-${randomUUID()}@feed.example`;
      await w.direct.append("INBOX", eml(mid));
      let destUid: number | null = null;
      for (let n = 1; n <= 5; n++) {
        await w.cycle();
        if (n === 1) w.proxy.fault = "pass";
        const copies = await census(w.direct, mid);
        console.info(`[b14 drop-after] cycle ${n}: ${JSON.stringify(copies)}`);
        expect(copies).toHaveLength(1);
        expect(copies[0]).toMatchObject({ folder: DEST, deleted: false });
        destUid ??= copies[0]!.uid;
        expect(copies[0]!.uid).toBe(destUid);
        const m = await w.mirror(mid);
        expect(m.rows).toHaveLength(1);
        if (n >= 2) {
          expect(m.instances.map((i) => [i.folder, i.uid, i.isPrimary])).toEqual([[DEST, destUid, true]]);
          expect(m.state).toMatchObject({ desiredFolder: DEST, observedFolder: DEST, reconcileStatus: "reconciled" });
        }
      }
      expect(w.proxy.count("UID COPY")).toBe(1);
      expect(w.proxy.count("UID COPY", DEST) + w.proxy.count("UID MOVE")).toBe(0);
    }, 60_000);
  },
);

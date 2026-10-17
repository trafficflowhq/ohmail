import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { folderState, messageInstances, messages, rules } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import {
  CONDSTORE_HOST, CONDSTORE_PORT, probeCondstore,
} from "../../../packages/core/test/adapters/_imapenv.js";
import { copiesOf, startFaultProxy, type ExpungeFault } from "../../../packages/core/test/adapters/_fault-proxy.js";

/**
 * THE DESKTOP ENGINE, A FILING WHOSE EXPUNGE FAILS. The engine as the shell runs it, on its own
 * store, against Dovecot behind the fault proxy (MOVE hidden, the INBOX EXPUNGE failed). Five
 * drains with the fault, then two without: the destination never holds a second copy, nothing
 * moves back, the store keeps one row whose primary is the source until the expunge lands, and
 * then exactly one copy remains at the destination. The worker's twin is
 * `apps/worker/test/move-expunge-fault.e2e.test.ts`.
 */

const DEST = "ohmail/News";
const CONDSTORE = await probeCondstore();

const open: Array<() => Promise<unknown>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!CONDSTORE.ok)(
  `the desktop engine: COPY lands, EXPUNGE fails, five drains${CONDSTORE.ok ? "" : ` (SKIPPED: ${CONDSTORE.why})`}`,
  () => {
    // NO only: a dropped connection holds the engine on its redial ladder (15 s, then 30 s …), so
    // five attempts there measure the ladder. The worker's twin drives the drop, re-dialling per cycle.
    for (const fault of ["no"] as ExpungeFault[]) {
      it(`EXPUNGE answered ${fault.toUpperCase()}: one copy at the destination, one in all once it clears`, async () => {
        const proxy = await startFaultProxy({ host: CONDSTORE_HOST, port: CONDSTORE_PORT }, { hide: ["MOVE"], onlyMailbox: "INBOX" });
        open.push(() => proxy.close());
        const auth = { user: `t-${randomUUID()}@trafficflow.test`, pass: process.env.IMAP_CONDSTORE_PASS ?? "testpass-password" };
        const direct = new ImapFlow({ host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false, auth, logger: false });
        await direct.connect();
        open.push(() => direct.logout());

        const dataDir = await freshDataDir("ohmail-expunge-fault-");
        dirs.push(dataDir);
        const s: Sidecar = await createSidecar({
          dataDir, imap: { host: "127.0.0.1", port: proxy.port, secure: false, auth },
          address: auth.user, displayName: "This Mac", pollIntervalMs: 60 * 60 * 1000,
        });
        open.push(() => s.stop());
        await grantOrganizeConsent(s);
        await s.db.insert(rules).values({
          accountId: s.world.accountId, kind: "domain", match: "feed.example", destination: DEST, priority: 5,
        });
        proxy.fault = fault;
        const mid = `b14-${randomUUID()}@feed.example`;
        await direct.append("INBOX", [
          `Message-ID: <${mid}>`, "From: news@feed.example", `To: ${auth.user}`, "Subject: digest",
          "Date: Sat, 17 Oct 2026 07:00:00 +0000", "Content-Type: text/plain", "", "hi",
        ].join("\r\n"));
        const [{ uid: srcUid }] = await copiesOf(direct, mid);
        await s.start();

        const drain = async (): Promise<void> => {
          await s.syncUntilQuiet();
          // The deferral's backoff has elapsed: each drain gets to retry the move.
          await s.db.update(folderState).set({ nextAttemptAt: new Date(Date.now() - 1000) })
            .where(eq(folderState.reconcileStatus, "pending"));
        };
        const store = async () => {
          const rows = await s.db.select().from(messages).where(eq(messages.messageIdHeader, mid));
          const instances = rows.length === 1
            ? await s.db.select().from(messageInstances).where(eq(messageInstances.messageId, rows[0]!.id))
            : [];
          return { rows, instances };
        };

        let destUid: number | null = null;
        for (let n = 1; n <= 5; n++) {
          await drain();
          const copies = await copiesOf(direct, mid);
          console.info(`[b14 engine ${fault}] drain ${n}: ${JSON.stringify(copies)}`);
          const dest = copies.filter((c) => c.folder === DEST);
          expect(dest, `drain ${n}: the destination never gains a second copy`).toHaveLength(1);
          expect(copies.filter((c) => c.folder === "INBOX")).toEqual([{ folder: "INBOX", uid: srcUid, deleted: true }]);
          expect(copies).toHaveLength(2);
          destUid ??= dest[0]!.uid;
          expect(dest[0]!.uid).toBe(destUid);
          const m = await store();
          expect(m.rows).toHaveLength(1);
          expect(m.instances.filter((i) => i.isPrimary).map((i) => [i.folder, i.uid])).toEqual([["INBOX", srcUid]]);
        }
        expect(proxy.count("UID COPY")).toBe(1);
        expect(proxy.count("UID COPY", DEST) + proxy.count("UID MOVE")).toBe(0);
        expect(proxy.log.filter((e) => e.faulted).length).toBeGreaterThanOrEqual(5);

        proxy.fault = "pass";
        for (let n = 6; n <= 7; n++) {
          await drain();
          const copies = await copiesOf(direct, mid);
          console.info(`[b14 engine ${fault}] drain ${n} (fault cleared): ${JSON.stringify(copies)}`);
          expect(copies).toEqual([{ folder: DEST, uid: destUid, deleted: false }]);
          const m = await store();
          expect(m.rows).toHaveLength(1);
          expect(m.instances.map((i) => [i.folder, i.uid, i.isPrimary])).toEqual([[DEST, destUid, true]]);
        }
        expect(proxy.count("UID COPY")).toBe(1);
      }, 180_000);
    }
  },
);

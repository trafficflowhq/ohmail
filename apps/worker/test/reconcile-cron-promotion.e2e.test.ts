import net from "node:net";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import { workerHeartbeats } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import type { LogFields } from "@trafficflow/core";
import { runReconcileCron } from "../src/reconcile-cron.js";
import { imapCfg, makeHarness, dbUrlFor } from "./_workerenv.js";

const DB_URL = dbUrlFor(import.meta.url);

/**
 * THE ROW FOLLOWS THE CLAIM — the BACKSTOP's half of the one-organizer invariant. A claim on the server
 * with the row still saying `reader` is admissible only inside the act itself: `organizer_role` is what
 * every write door consults, so an install in that window refuses its own requests `409
 * organized_elsewhere`. The landed siblings closed it by promoting ahead of `acquireLeasePermit`; this
 * pass cannot, handing the permit no `adopt`, so no reordering at the call site reaches the window —
 * hence `onClaimHeld` and a guard at the wire. WHY A PROXY, NOT A DOUBLE: `runReconcileCron` builds its
 * own `ImapAdapter`, so inventing a seam would be a product change made for a test. Reading the row
 * while the permit's `STATUS` is in flight asks with no clock in it.
 *
 * WHICH INSTANT, re-derived when the baseline reading moved to the claim's own: the reply leg, and
 * HELD. The reading is issued with the claim now and awaited after the row, so the two are
 * concurrent and "what did the row say when the STATUS went out" is a race that answers nothing
 * whichever way it lands. What the row must never be is DEPENDENT on that reading — so the REPLY is
 * held at the forwarder and the row is read until it follows the claim. Under the fix it does, with
 * the reply still held. A permit that awaited the reading in front of `onClaimHeld` can never get
 * there, and the bound expires with `reader` recorded. The bound is a stop, never the verdict.
 */

type Role = string | null;

function metaWatcher(
  to: { host: string; port: number },
  hooks: { atStamp?: () => Promise<void>; afterMetaAppend?: () => Promise<void> },
) {
  const seen = { appends: 0, stamps: 0 };
  const sockets: net.Socket[] = [];
  const server = net.createServer((client) => {
    const up = net.connect({ host: to.host, port: to.port });
    sockets.push(client, up);
    client.on("error", () => undefined);
    up.on("error", () => undefined);
    /* Commands are forwarded through ONE chain so a hook that awaits cannot let the command it is
       about overtake it. Nothing is retained and nothing but these two shapes is even matched: a
       `LOGIN` line cannot satisfy either regex, so no credential is read, stored or compared. */
    let chain: Promise<void> = Promise.resolve();
    client.on("data", (chunk: Buffer) => {
      const text = chunk.toString("latin1");
      /* THE PERMIT'S PROBE, TOLD APART AT THE WIRE. `stampMeta` is the ONLY reader in the lease
         that asks `ohmail/_meta` for UIDVALIDITY (`organizer-lease.ts`: the count probe asks
         MESSAGES, the window probe UIDNEXT, the stamp all three) — a folder stamp means nothing
         across a renumbering, so it rides the same command. The election's own probes therefore
         cannot be mistaken for it, and the verify's read, which lands between the claim and the
         decision, is correctly NOT the subject: that gap is inside the lease's own act. */
      const isStamp = /STATUS\s+"?ohmail[./]_meta"?[^\r\n]*UIDVALIDITY/i.test(text);
      const isAppend = /APPEND\s+"?ohmail[./]_meta"?/i.test(text);
      if (isAppend) seen.appends++;
      if (isStamp) seen.stamps++;
      chain = chain.then(async () => {
        up.write(chunk);
        if (isAppend) await hooks.afterMetaAppend?.();
      });
    });
    /* The reply leg, chained for the request leg's reason, and the hook HOLDS it. A STATUS reply
       names the items it was asked for, so `UIDVALIDITY` tells the permit's reading apart here
       exactly as it does above — the election's own count and window probes ask for one item each
       and cannot match. */
    let replies: Promise<void> = Promise.resolve();
    up.on("data", (c: Buffer) => {
      const isStampReply = /\*\s+STATUS\s[^\r\n]*UIDVALIDITY/i.test(c.toString("latin1"));
      replies = replies.then(async () => {
        if (isStampReply) await hooks.atStamp?.();
        client.write(c);
      });
    });
    client.on("close", () => up.destroy());
    up.on("close", () => client.destroy());
  });
  return {
    seen,
    listen: (): Promise<number> => new Promise((res) => {
      server.listen(0, "127.0.0.1", () => res((server.address() as net.AddressInfo).port));
    }),
    close: async (): Promise<void> => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}

/** Collects structured log events so a refusal can be asserted by NAME rather than by silence. */
function recordingLogger() {
  const events: Array<{ event: string; fields: LogFields }> = [];
  function mk(bound: LogFields) {
    const push = (event: string, fields?: LogFields): void => {
      events.push({ event, fields: { ...bound, ...fields } });
    };
    return {
      level: "debug" as const,
      child: (f: LogFields) => mk({ ...bound, ...f }),
      debug: push, info: push, warn: push, error: push,
    };
  }
  return { events, logger: mk({}) };
}

type Harness = Awaited<ReturnType<typeof makeHarness>>;

/**
 * THE SHAPE THAT REACHES THE PROMOTION, and the only one that does. `reconcile-cron.ts`'s reader
 * refusal returns before the dial for a reader with no press, so a row saying `reader` at the
 * promotion implies an AUTHORIZED TAKEOVER — the row `markMailboxStoodDown` and `organizeHere`
 * both leave behind, plus the stamp §4's explicit action writes.
 */
async function pressedReader(h: Harness): Promise<void> {
  await h.db.update(mailboxes).set({
    organizerRole: "reader",
    organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
    takeoverAuthorizedAt: new Date(), takeoverIntent: "takeover",
  }).where(eq(mailboxes.id, h.mailboxId));
}

function cfgFor(h: Harness, port: number) {
  return {
    databaseUrl: DB_URL, accountId: h.accountId, mailboxId: h.mailboxId,
    storageCap: UNMETERED_STORAGE_CAP,
    imap: {
      host: "127.0.0.1", port, secure: false,
      user: h.cfg.auth.user, pass: h.cfg.auth.pass,
    },
    smtp: undefined, pollIntervalMs: 60000, sentDomain: "trafficflow.test",
  };
}

describe("the backstop's becoming: the row follows the claim", () => {
  beforeAll(async () => { await runMigrations(DB_URL); }, 120_000);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });

  /**
   * TEN RUNS, because the thing this replaces was a race and a single green says nothing about
   * one. Every `STATUS` REPLY on `ohmail/_meta` is held at the forwarder while the row is read, and
   * the row must reach `organizer` WITH THE REPLY STILL HELD — which it can only do if the
   * promotion is not behind that round trip. Before the fix it was, and the read is `reader`.
   */
  it("the row follows the claim with the permit's folder reading held — ten runs", async () => {
    const roles: Role[] = [];
    let stamps = 0;
    for (let run = 0; run < 10; run++) {
      const cfg = imapCfg();
      const h = await makeHarness(cfg);
      await pressedReader(h);
      const watcher = metaWatcher({ host: cfg.host, port: cfg.port }, {
        atStamp: async () => {
          // HELD until the row follows the claim, or until the bound stops waiting — see the
          // header. The verdict is the role recorded, never the time it took.
          const until = Date.now() + 5_000;
          let role: Role = null;
          do {
            const [row] = await h.db.select({ role: mailboxes.organizerRole }).from(mailboxes)
              .where(eq(mailboxes.id, h.mailboxId));
            role = row?.role ?? null;
            if (role === "organizer") break;
            await new Promise((r) => { setTimeout(r, 25); });
          } while (Date.now() < until);
          roles.push(role);
        },
      });
      const port = await watcher.listen();
      const res = await runReconcileCron(cfgFor(h, port));
      expect(res.ran, `run ${run} swept nothing: ${res.reason ?? "no reason"}`).toBe(true);
      stamps += watcher.seen.stamps;
      expect(watcher.seen.appends,
        `run ${run}: no claim was appended, so this run observed nothing`).toBeGreaterThan(0);
      const [after] = await h.db.select({ role: mailboxes.organizerRole }).from(mailboxes)
        .where(eq(mailboxes.id, h.mailboxId));
      expect(after?.role, `run ${run}: a pressed reader was not promoted at all`).toBe("organizer");
      await watcher.close();
      // Per iteration, not at `afterEach`: ten runs would otherwise hold ten IMAP connections open
      // for the length of the case, on a fixture every other file in this directory shares.
      await h.adapter.close();
    }
    // Anti-vacuity: an assertion over an empty set passes for nothing, and the probe is the subject.
    expect(stamps, "the permit never stamped the folder, so nothing was observed")
      .toBeGreaterThanOrEqual(10);
    expect(roles.length, "no stamp REPLY was held, so the row was never read at the wait")
      .toBeGreaterThanOrEqual(10);
    expect(roles.filter((r) => r !== "organizer"),
      "the row could not be written while the permit's folder reading was held: the promotion is "
      + "behind that round trip, and for its length this install's claim stood on the server "
      + "while its own write doors refused it by name").toEqual([]);
  }, 300_000);

  /**
   * THE OTHER END. The promotion is FENCED and a fence answers `false` rather than throwing, so a
   * caller that ignores the answer believes it holds a mailbox its row gives away, with the
   * one-shot press spent. The shard is taken away where it is deterministic — right after the
   * claim's APPEND crosses the wire, which is the last thing `readMailboxLease` does before it
   * answers organize. The right end state is the one a refused write should leave: the row a
   * reader, the press unspent, the claim standing, and one line saying so.
   */
  it("a promotion the FENCE refuses leaves the row a reader with the press unspent, and says so", async () => {
    const cfg = imapCfg();
    const h = await makeHarness(cfg);
    closers.push(() => h.adapter.close());
    await pressedReader(h);
    const { events, logger } = recordingLogger();

    /* THE INJECTION IS READ BACK: a `leader = false` that matched no row would leave the fence OPEN
       and every assertion below would be about an ordinary promotion, passing for nothing. */
    let fenceClosed = false;
    /* The demotion below is this file's only durable leak: `worker_heartbeats` is keyed on
       `shard_index` alone and every backstop e2e case in this directory shares it, so the row goes
       back the way it was found rather than leaving the next file's fence closed. */
    closers.push(async () => { await h.db.delete(workerHeartbeats); });
    const watcher = metaWatcher({ host: cfg.host, port: cfg.port }, {
      afterMetaAppend: async () => {
        const rows = await h.db.update(workerHeartbeats).set({ leader: false })
          .returning({ instanceId: workerHeartbeats.instanceId });
        if (rows.length > 0) fenceClosed = true;
      },
    });
    const port = await watcher.listen();
    await runReconcileCron(cfgFor(h, port), logger);
    await watcher.close();

    expect(fenceClosed, "no heartbeat row was demoted, so the fence was never closed").toBe(true);
    const [row] = await h.db.select().from(mailboxes).where(eq(mailboxes.id, h.mailboxId));
    expect(row!.organizerRole, "a fenced promotion flipped the row anyway").toBe("reader");
    expect(row!.takeoverAuthorizedAt, "a fenced promotion spent the press").not.toBeNull();
    expect(events.filter((e) => e.event === "cron_reconcile_organizer_promotion_fenced"),
      "a fenced promotion said nothing at all").toHaveLength(1);
    expect(events.filter((e) => e.event === "cron_reconcile_organizer_promotion_failed"),
      "a write the fence refused was reported as a throw").toHaveLength(0);
  }, 120_000);
});

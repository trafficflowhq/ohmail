import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import {
  LeaseClockSkewError, META_FOLDER, formatClaim, readLeasePeek, type LeaseSelf,
} from "@trafficflow/core/adapters/organizer-lease";
import {
  LeaseUnavailableError, OrganizerStandDownError, acquireLeasePermit, assertNoLiveTwin, writeDoorOf,
  type LeasePermit,
} from "@ohmail/organizer/lease";
import {
  CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore,
} from "../../../packages/core/test/adapters/_imapenv.js";
import { LivePermitClock } from "../../../packages/organizer/test/_permit-clock.js";

/**
 * TWO INSTALLS, ONE MAILBOX, ONE INSTALL'S WALL CLOCK STEPPED — at most one organizer at every read
 * (the brief's acceptance). A organizes on a live clock pair; its wall steps
 * back 60 s and later forward again. B gates every second, presses once after A's claim lapses by
 * the SERVER's clock, and names the holder with its peek. Aged by the wall alone, A's receipt stayed
 * held a minute past the step while B took the lapsed mailbox: two doors open. Short windows so
 * real time can run: stale 20 s, skew bound 5 s, held window 15 s, TTL 2 s. On GreenMail, and on
 * Dovecot where it runs; the Dovecot half takes the GreenMail lock.
 */

const STALE_MS = 20_000;
const TTL_MS = 2_000;

function dovecotConfig(): ImapConfig {
  return {
    host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "testpass-password" },
  };
}

const CONDSTORE = await probeCondstore();
const SERVERS = [
  { name: "GreenMail", config: greenmailConfig, enabled: true, why: "" },
  { name: "Dovecot", config: dovecotConfig, enabled: CONDSTORE.ok, why: CONDSTORE.ok ? "" : CONDSTORE.why },
];

const open: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => { /* already down */ });
});

async function adapterFor(cfg: ImapConfig): Promise<ImapAdapter> {
  const a = new ImapAdapter(cfg);
  await a.connect();
  open.push(a);
  return a;
}

const selfOf = (installId: string, kind: "cloud" | "local"): LeaseSelf =>
  ({ installId, kind, displayName: `${installId} machine`, lastNonce: null });
const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });
const admits = (p: LeasePermit | null): boolean =>
  p !== null && writeDoorOf({ lease: p }).ask("move").admit;

for (const server of SERVERS) {
  if (!server.enabled) {
    console.warn(`\n[condstore] SKIPPING the permit clock race against ${server.name} — ${server.why}\n`);
    describe(`the permit keeps one clock (${server.name})`, () => {
      it.skip(`NOT RUN — ${server.why}`, () => { /* the name is the report */ });
    });
    continue;
  }

  describe(`the permit keeps one clock (${server.name})`, () => {
    it("a wall clock stepped back and forward: exactly one organizer at every read", async () => {
      const cfg = server.config();
      const a = await adapterFor(cfg);
      const b = await adapterFor(cfg);
      const clockA = new LivePermitClock();
      const mailboxId = randomUUID();
      const permitA = await acquireLeasePermit({
        adapter: a, self: selfOf("ohmail-cloud:a", "cloud"), mailboxId, hasRequestKey: false,
        ...clockA.pair, ttlMs: TTL_MS, staleAfterMs: STALE_MS,
      });
      let permitB: LeasePermit | null = null;
      const faults: string[] = [];
      const reads: Array<{ second: number; at: number; open: string[]; named: string | null }> = [];

      const tick = async (second: number): Promise<void> => {
        try { await permitA.check(); } catch (err) {
          if (err instanceof LeaseClockSkewError) faults.push("skew");
          else if (err instanceof OrganizerStandDownError) faults.push("stood_down");
          else if (err instanceof LeaseUnavailableError) faults.push(`unavailable:${err.op}`);
          else throw err;
        }
        const peek = await readLeasePeek({ io: b.leasePeekIo(), now: new Date(), staleAfterMs: STALE_MS });
        if (permitB === null && peek.state === "stopped") {
          permitB = await acquireLeasePermit({
            adapter: b, self: selfOf("this-mac", "local"), mailboxId, hasRequestKey: false,
            staleAfterMs: STALE_MS, takeover: { authorizedAt: new Date(), intent: "takeover" },
          });
        }
        const doors = [admits(permitA) ? "ohmail-cloud:a" : null, admits(permitB) ? "this-mac" : null]
          .filter((d): d is string => d !== null);
        const after = await readLeasePeek({ io: b.leasePeekIo(), now: new Date(), staleAfterMs: STALE_MS });
        reads.push({ second, at: Date.now(), open: doors, named: after.holders[0]?.installId ?? null });
      };

      for (let s = 0; s < 3; s++) { await tick(s); await sleep(1_000); }
      clockA.stepWall(-60_000);
      for (let s = 3; s < 45 && permitB === null; s++) { await tick(s); await sleep(1_000); }
      for (let s = 45; s < 48; s++) { await tick(s); await sleep(1_000); }
      clockA.stepWall(60_000);
      for (let s = 48; s < 51; s++) { await tick(s); await sleep(1_000); }

      const aLast = reads.filter((r) => r.open.includes("ohmail-cloud:a")).at(-1);
      const bFirst = reads.find((r) => r.open.includes("this-mac"));
      console.info(`[race ${server.name}] A's door last open at tick ${aLast?.second}, B's first at tick ${bFirst?.second}, ` +
        `${aLast && bFirst ? bFirst.at - aLast.at : "?"} ms apart; A's faults ${[...new Set(faults)].join(",")}`);
      const twoOpen = reads.filter((r) => r.open.length > 1);
      expect(twoOpen, `two doors open at ${JSON.stringify(twoOpen)}`).toEqual([]);
      const misnamed = reads.filter((r) => r.open.length === 1 && r.named !== r.open[0]);
      expect(misnamed, `the peek named another holder at ${JSON.stringify(misnamed)}`).toEqual([]);
      expect(permitB, "B never took the lapsed mailbox, so the race measured nothing").not.toBeNull();
      expect(faults, "A's gate never refused its stepped clock").toContain("skew");
      expect(permitA.revoked, "A came back to the right time and kept organizing").toBe(true);
    }, 120_000);

    it("the twin check reads the server's stamp: a 2099 claim refuses at once, admits after the window", async () => {
      const cfg = server.config();
      const reader = await adapterFor(cfg);
      const w = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
      await w.connect();
      open.push({ close: () => w.logout().catch(() => w.close()) });
      const path = reader.toServerPath(META_FOLDER);
      await w.mailboxCreate(path).catch(() => { /* already there */ });
      await w.append(path, formatClaim({
        installId: "ohmail-cloud:a", kind: "cloud", displayName: "ohmail Cloud",
        heartbeat: new Date("2099-01-01T00:00:00.000Z"), claimedAt: new Date(), nonce: randomUUID(),
        authorizedAt: null, capabilities: [],
      }), ["\\Seen"]);
      const verdict = async (): Promise<string> => {
        try {
          await assertNoLiveTwin({ adapter: reader, installId: "ohmail-cloud:a", now: new Date(), staleAfterMs: STALE_MS });
          return "admits";
        } catch (err) {
          if (err instanceof OrganizerStandDownError) return "refuses";
          throw err;
        }
      };
      expect(await verdict(), "a claim the server stamped a moment ago is a live twin").toBe("refuses");
      await sleep(STALE_MS + 2_000);
      expect(await verdict(), "past the window by the server's clock the 2099 stamp is no evidence").toBe("admits");
    }, 60_000);
  });
}

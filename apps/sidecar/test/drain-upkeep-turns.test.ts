import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeBatch, ImapCapabilities, ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * THE DRAIN'S UPKEEP GIVES THE LOOP A TURN BETWEEN ITS STEPS. After a drain that took mail the
 * fold, the name repair, the stamp and the tail's checkpoint ran back to back: PGlite answers in
 * microtasks, so nothing else in the process ran until the last of them returned, and a search due
 * inside waited it out. Read here as TURNS: a counter a `setImmediate` loop advances, stamped on
 * every statement at the client. The first statement of each step must run in a later turn than
 * the statement before it.
 */

class FreeLease implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number { return 4_100; }
}

/** `total` messages, all in the first batch, then quiet. */
function backlog(total: number): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const lease = new FreeLease();
  let served = false;
  return () => ({
    leaseIo: () => lease,
    async connect() {}, async close() {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders() {},
    async changesSince(): Promise<ChangeBatch> {
      const creates = served ? [] : Array.from({ length: total }, (_, i) => ({
        type: "create" as const, locator: { folder: "INBOX", ref: `1:${i + 1}` }, seen: false,
        raw: Buffer.from([`Message-ID: <turn-${i}@x>`, `From: s${i}@x.test`, "To: owner@trafficflow.test",
          `Subject: turn ${i}`, "Content-Type: text/plain", "", `body ${i}`].join("\r\n")),
      }));
      served = true;
      return { creates, moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
    },
    async move(l) { return l; }, async setFlags() {}, async scanSentRecipients() { return []; },
    async watch() { return async () => {}; },
    async send() { throw new Error("this mailbox cannot send"); },
    async fetchPart() { throw new Error("this mailbox cannot fetchPart"); },
  });
}

describe("the drain's upkeep", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  it("takes a turn of the loop before each of its steps", async () => {
    const dataDir = await freshDataDir("ohmail-upkeep-turns-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test", pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
      adapterFactory: backlog(20), log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });

    let turn = 0;
    let turning = true;
    const spin = (): void => { if (turning) { turn += 1; setImmediate(spin); } };
    setImmediate(spin);
    const seen: Array<{ turn: number; head: string }> = [];
    const client = (sidecar.db as unknown as { $client: Record<string, unknown> }).$client;
    for (const m of ["exec", "query"]) {
      const orig = (client[m] as (...a: unknown[]) => Promise<unknown>).bind(client);
      client[m] = (...a: unknown[]): Promise<unknown> => {
        const head = typeof a[0] === "string" ? a[0].replace(/\s+/g, " ").trim().slice(0, 80) : "";
        if (!/local_store_flush/.test(head)) seen.push({ turn, head });
        return orig(...a);
      };
    }
    await sidecar.start();
    turning = false;

    const firstOf = (re: RegExp, from = 0): number => seen.findIndex((s, i) => i >= from && re.test(s.head));
    const fold = firstOf(/pg_current_wal_insert_lsn\(\) -/);
    const stamp = firstOf(/update "mailboxes" set "last_sync_at"/i, Math.max(0, fold));
    const tail = seen.map((s) => s.head).lastIndexOf("CHECKPOINT;");
    expect([fold, stamp, tail].every((i) => i > 0), `an upkeep step ran no statement: fold ${fold}, stamp ${stamp}, `
      + `checkpoint ${tail} of ${seen.length}`).toBe(true);
    for (const [name, i] of [["the fold", fold], ["the stamp", stamp], ["the tail's checkpoint", tail]] as const) {
      expect(seen[i]!.turn, `${name} ran in the same turn as the statement before it — the upkeep held the loop`)
        .toBeGreaterThan(seen[i - 1]!.turn);
    }
  });
});

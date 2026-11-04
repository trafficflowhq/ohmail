import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import type { Route } from "@trafficflow/api/local";
import { createSidecar, withPullKick, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * "HAND THE MAILBOX BACK" WAKES THE GATE ON THIS DOOR (RULING-026 lane E). The organizer is this
 * process, so a release that only writes the stamp waits for the next poll — an hour here, by
 * construction. The shared route's 202 rings its runtime, as "Organize here" does; the gate's
 * first arm honours the release and the claim leaves `_meta`.
 */

class MemoryMetaFolder implements LeaseIo {
  claims: RawClaimMessage[] = [];
  appends = 0;
  private nextUid = 1;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.appends++; this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    this.claims = this.claims.filter((c) => !gone.has(c.ref));
  }
  /** The release reads this; `makeLeaseIo` always defines it, matched on the header. */
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

function quietMailbox(meta: MemoryMetaFolder): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  return () => ({
    leaseIo: () => meta,
    /* The reader arm's APPEND-less look; without it the peek reads unreadable and keeps the record. */
    leasePeekIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY }; },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe("withPullKick: the shared release route rings its own runtime", () => {
  const answered = (status: number): Route => ({
    method: "POST", pattern: "/mailboxes/:id/release", cost: "work", relay: true,
    handler: async () => new Response("{}", { status, headers: { "content-type": "application/json" } }),
  });
  it("a 202 rings that mailbox alone; an answer that recorded no request rings none", async () => {
    const rung: string[] = [];
    const rt = (id: string) => ({ ring: () => { rung.push(id); } });
    for (const status of [202, 200, 404]) {
      const [wrapped] = withPullKick([answered(status)], () => [rt("a"), rt("b")], (id) => rt(id));
      const res = await wrapped!.handler(new Request("http://local/mailboxes/b/release", { method: "POST" }), {} as never, { id: "b" });
      expect(res.status).toBe(status);
    }
    expect(rung).toEqual(["b"]);
  });
});

describe("the hand-back releases on this door within seconds, with the poll an hour away", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  const json = (s: Sidecar, path: string, body: unknown) => s.handle(new Request(`http://local${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  it("the shared release route: the claim leaves _meta within 5 s, and nothing is renewed after", async () => {
    const dir = await freshDataDir("ohmail-handback-");
    const meta = new MemoryMetaFolder();
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test",
      machineName: "handback host",
      pollIntervalMs: 60 * 60 * 1000,
      vitalsIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(meta),
      log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); });
    await sidecar.start();
    await sidecar.syncUntilQuiet();
    const consent = await json(sidecar, `/local/mailboxes/${sidecar.world.mailboxId}/organize`, { intent: "join" });
    expect(consent.status, await consent.clone().text()).toBe(200);
    expect(await waitFor(() => sidecar.organizerState().organizing, 5_000), "the premise: organizing here").toBe(true);
    expect(meta.claims).toHaveLength(1);
    const appendsAtPress = meta.appends;

    const at = Date.now();
    const res = await json(sidecar, `/mailboxes/${sidecar.world.mailboxId}/release`, {});
    expect(res.status, await res.clone().text()).toBe(202);
    const gone = await waitFor(() => meta.claims.length === 0 && !sidecar.organizerState().organizing, 5_000);
    process.stdout.write(`[handback] the shared release route: press -> no claim ${Date.now() - at} ms\n`);
    expect(gone, "the release waited for the poll").toBe(true);
    expect(meta.appends, "a claim was appended after the press").toBe(appendsAtPress);
  });

  /* THE RUNG PASS'S SETTINGS OUTCOME OUTLIVES THE CYCLES AFTER IT. The phone's Stop presses the
     route and then forces a cycle; the ring has already run the release, so that cycle and every
     later poll take the reader arm, which rebuilt the record without `settingsLeft` and a Stop that
     could not save lost its sentence. It stands until this install claims the mailbox again. */
  it("the release's settings outcome survives the forced cycle and the next poll, and goes at the next claim", async () => {
    const dir = await freshDataDir("ohmail-handback-left-");
    const meta = new MemoryMetaFolder();
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test",
      machineName: "handback host",
      pollIntervalMs: 60 * 60 * 1000,
      vitalsIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(meta),
      log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); });
    await sidecar.start();
    await sidecar.syncUntilQuiet();
    const id = sidecar.world.mailboxId;
    expect((await json(sidecar, `/local/mailboxes/${id}/organize`, { intent: "join" })).status).toBe(200);
    expect(await waitFor(() => sidecar.organizerState().organizing, 5_000), "the premise: organizing here").toBe(true);

    expect((await json(sidecar, `/mailboxes/${id}/release`, {})).status).toBe(202);
    expect(await waitFor(() => meta.claims.length === 0 && sidecar.organizerState().settingsLeft !== undefined, 5_000),
      "the rung pass recorded no settings outcome").toBe(true);
    expect(sidecar.organizerState().settingsLeft).toBe("saved");
    await sidecar.resume();
    expect(sidecar.organizerState().organizing, "the forced cycle took the mailbox back").toBe(false);
    expect(sidecar.organizerState().settingsLeft, "the forced cycle dropped it").toBe("saved");
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().settingsLeft, "the next poll dropped it").toBe("saved");

    expect((await json(sidecar, `/local/mailboxes/${id}/organize`, { intent: "join" })).status).toBe(200);
    expect(await waitFor(() => sidecar.organizerState().organizing, 5_000), "the claim again").toBe(true);
    expect(sidecar.organizerState().settingsLeft, "a claim carried the last stop's outcome").toBeUndefined();
  });
});

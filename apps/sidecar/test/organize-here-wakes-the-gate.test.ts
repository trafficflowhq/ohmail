import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import type { Route } from "@trafficflow/api/local";
import { mailboxCredentials } from "@trafficflow/db";
import { createSidecar, withPullKick, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * "ORGANIZE HERE" WAKES THE GATE ON THIS DOOR TOO (VERIFY-026 L6). The local organizer is this
 * process, so a press that only writes the stamp waits for the next poll — an hour here, by
 * construction. The shared route's 202 rings its runtime and the desktop's takeover door asks for
 * a pass, as the consent door already did (the control). The lease still decides: the press
 * claims an EMPTY `_meta`, nothing else.
 */

class MemoryMetaFolder implements LeaseIo {
  claims: RawClaimMessage[] = [];
  private nextUid = 1;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    this.claims = this.claims.filter((c) => !gone.has(c.ref));
  }
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

function quietMailbox(meta: MemoryMetaFolder): (cfg: ImapConfig) => MailboxAdapter & {
  leaseIo(): LeaseIo; leasePeekIo(): { listClaims(): Promise<RawClaimMessage[]> };
} {
  return () => ({
    leaseIo: () => meta,
    // The read-only look the real adapter has: the consent door looks before it admits a join.
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
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

describe("withPullKick: the shared organize route rings its own runtime", () => {
  const answered = (status: number): Route => ({
    method: "POST", pattern: "/mailboxes/:id/organize", cost: "connection", relay: true,
    handler: async () => new Response("{}", { status, headers: { "content-type": "application/json" } }),
  });
  it("a 202 rings that mailbox alone; an answer that wrote no press rings none", async () => {
    const rung: string[] = [];
    const rt = (id: string) => ({ ring: () => { rung.push(id); } });
    for (const status of [202, 200, 409]) {
      const [wrapped] = withPullKick([answered(status)], () => [rt("a"), rt("b")], (id) => rt(id));
      const res = await wrapped!.handler(new Request("http://local/mailboxes/b/organize", { method: "POST" }), {} as never, { id: "b" });
      expect(res.status).toBe(status);
    }
    expect(rung).toEqual(["b"]);
  });
});

describe("the press claims on this door within seconds, with the poll an hour away", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(): Promise<{ sidecar: Sidecar; meta: MemoryMetaFolder }> {
    const dir = await freshDataDir("ohmail-orgwake-");
    const meta = new MemoryMetaFolder();
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test",
      machineName: "orgwake host",
      pollIntervalMs: 60 * 60 * 1000,
      vitalsIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(meta),
      log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); });
    await sidecar.start();
    await sidecar.syncUntilQuiet();
    // The precondition: a consent-less reader over an empty folder claims nothing on its own.
    expect(sidecar.organizerState().organizing).toBe(false);
    expect(meta.claims).toHaveLength(0);
    return { sidecar, meta };
  }

  const json = (s: Sidecar, path: string, body: unknown) => s.handle(new Request(`http://local${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  const DOORS: Array<[name: string, press: (s: Sidecar) => Promise<Response>, status: number]> = [
    ["the desktop's takeover door", (s) => json(s, "/local/organizer/takeover", { mailboxId: s.world.mailboxId }), 200],
    ["the shared organize route", async (s) => {
      // The shared route asks only that a credential row exist (a paired device's press); no dial.
      await s.db.insert(mailboxCredentials).values({
        mailboxId: s.world.mailboxId, transport: "imap", secretEnc: "sealed", keyVersion: 1,
        meta: { host: "imap.invalid", port: 993, secure: true, user: "owner@trafficflow.test" },
      }).onConflictDoNothing();
      return json(s, `/mailboxes/${s.world.mailboxId}/organize`, { intent: "join" });
    }, 202],
    ["CONTROL: the consent door", (s) => json(s, `/local/mailboxes/${s.world.mailboxId}/organize`, { intent: "join" }), 200],
  ];

  for (const [name, press, status] of DOORS) {
    it(`${name}: the press claims within 5 s`, async () => {
      const { sidecar, meta } = await boot();
      const at = Date.now();
      const res = await press(sidecar);
      expect(res.status, await res.clone().text()).toBe(status);
      const claimed = await waitFor(() => sidecar.organizerState().organizing, 5_000);
      process.stdout.write(`[orgwake] ${name}: press -> organizing ${Date.now() - at} ms\n`);
      expect(claimed, "the press waited for the poll").toBe(true);
      expect(meta.claims, "exactly one claim, this install's").toHaveLength(1);
    });
  }
});

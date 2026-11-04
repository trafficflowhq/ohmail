import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createCloudSidecar, MIRROR_OWNER_FILE, type CloudSidecar } from "../src/cloud-engine.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { LEGACY_WINDOW_OUTBOX_FILE, WINDOW_OUTBOX_ROUTE } from "../src/window-outbox.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * THE WINDOW'S OUTBOX DOOR, THROUGH BOTH REAL ENGINES (DESKTOP-OUTBOX-IS-NOT-DURABLE). The Cloud
 * door is driven with the hosted account out of reach — every request it makes fails — because
 * that is when the window needs the door; a relaunch over the same directory reads the rows back.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function dir(prefix: string): Promise<string> {
  const d = await freshDataDir(prefix);
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const ROW = { type: "outbox_entry", id: "e-1", entity: { v: 3, id: "e-1", key: "k-1", n: 0, at: 1, mutation: { kind: "message_delete", messageId: "m-1" } } };

type Door = { handle(r: Request): Promise<Response>; sessionToken: string };
const at = (scope: string) => `http://sidecar${WINDOW_OUTBOX_ROUTE}?scope=${encodeURIComponent(scope)}`;

async function roundTrip(first: Door, scope: string) {
  const auth = { authorization: `Bearer ${first.sessionToken}` };
  const post = (s: string) => first.handle(new Request(at(s), {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ puts: [ROW] }),
  }));
  const foreign = await post("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  const put = await post(scope);
  const anon = await first.handle(new Request(at(scope)));
  return { put: put.status, foreign: foreign.status, anon: anon.status };
}

async function readBack(next: Door, scope: string) {
  const res = await next.handle(new Request(at(scope), { headers: { authorization: `Bearer ${next.sessionToken}` } }));
  return { status: res.status, body: await res.json() as { rows: unknown[]; next: string | null } };
}

describe("the cloud engine serves the window's outbox while the account is out of reach", () => {
  const ring = (): Record<number, Buffer> => ({ 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) });
  const asked: string[] = [];
  const unreachable = (async (input: string | URL | Request) => {
    asked.push(String(input instanceof Request ? input.url : input));
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  async function boot(dataDir: string): Promise<CloudSidecar> {
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
      tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
      keks: ring(), fetchImpl: unreachable, pollIntervalMs: 60_000,
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    await sidecar.start().catch(() => undefined);
    return sidecar;
  }

  it("records a queued change, refuses one without the bearer, and the next launch reads it back", async () => {
    const d = await dir("ohmail-outbox-cloud-");
    const first = await boot(d);
    expect(first.servedMailboxId()).not.toBe("");
    expect(await roundTrip(first, first.servedMailboxId())).toEqual({ put: 204, foreign: 409, anon: 401 });
    await first.stop();
    const next = await boot(d);
    expect(await readBack(next, next.servedMailboxId())).toEqual({ status: 200, body: { rows: [ROW], next: null } });
    expect(asked.some((u) => u.includes("/local/")), "the outbox never left the machine").toBe(false);
  });

  it("a file an earlier build wrote is its account's: read back by that account, not by another", async () => {
    const d = await dir("ohmail-outbox-cloud-legacy-");
    writeFileSync(join(d, MIRROR_OWNER_FILE), JSON.stringify({ address: "me@ohmail.test", base: "https://cloud.test" }));
    writeFileSync(join(d, LEGACY_WINDOW_OUTBOX_FILE), JSON.stringify({ v: 1, rows: [ROW] }));
    const other = await createCloudSidecar({
      dataDir: d, cloudUrl: "https://cloud.test", address: "other@ohmail.test",
      tokens: { accessToken: "access-2", refreshToken: "refresh-2" }, keks: ring(), fetchImpl: unreachable, pollIntervalMs: 60_000,
    });
    cleanups.push(() => other.stop().catch(() => undefined));
    expect(await readBack(other, other.servedMailboxId()), "another account read the change").toEqual({ status: 200, body: { rows: [], next: null } });
    expect(existsSync(join(d, LEGACY_WINDOW_OUTBOX_FILE)), "the ownerless file was left to be served").toBe(false);
    await other.stop();
    const mine = await boot(d);
    expect(await readBack(mine, mine.servedMailboxId())).toEqual({ status: 200, body: { rows: [ROW], next: null } });
  });
});

describe("the local engine serves the window's outbox", () => {
  class MemoryMetaFolder implements LeaseIo {
    private nextUid = 1;
    private readonly claims: RawClaimMessage[] = [];
    async ensureMetaFolder(): Promise<void> {}
    async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
    async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
    async removeClaims(refs: readonly unknown[]): Promise<void> {
      const gone = new Set(refs);
      for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
    uidValidity(): number | bigint | null { return 4_100; }
  }
  const quiet = (): ((cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo }) => {
    const meta = new MemoryMetaFolder();
    return () => ({
      leaseIo: () => meta,
      async connect(): Promise<void> {},
      async close(): Promise<void> {},
      async capabilities(): Promise<ImapCapabilities> {
        return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders(): Promise<void> {},
      async changesSince(): Promise<ChangeBatch> {
        return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
      },
      async move(locator) { return locator; },
      async setFlags(): Promise<void> {},
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(): Promise<() => Promise<void>> { return async () => {}; },
      async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
      async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
    });
  };

  async function boot(dataDir: string): Promise<Sidecar> {
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test", machineName: "window host", pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000, adapterFactory: quiet(),
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    await sidecar.start();
    return sidecar;
  }

  it("records a queued change, refuses one without the bearer, and the next launch reads it back", async () => {
    const d = await dir("ohmail-outbox-local-");
    const first = await boot(d);
    expect(await roundTrip(first, first.world.mailboxId)).toEqual({ put: 204, foreign: 409, anon: 401 });
    await first.stop();
    const next = await boot(d);
    expect(await readBack(next, next.world.mailboxId)).toEqual({ status: 200, body: { rows: [ROW], next: null } });
  });

  it("a file an earlier build wrote is read back as this mailbox's", async () => {
    const d = await dir("ohmail-outbox-local-legacy-");
    writeFileSync(join(d, LEGACY_WINDOW_OUTBOX_FILE), JSON.stringify({ v: 1, rows: [ROW] }));
    const first = await boot(d);
    expect(await readBack(first, first.world.mailboxId)).toEqual({ status: 200, body: { rows: [ROW], next: null } });
    expect(readdirSync(d).filter((f) => f.startsWith("window-outbox")), "kept under its owner's name").toHaveLength(1);
    expect(existsSync(join(d, LEGACY_WINDOW_OUTBOX_FILE))).toBe(false);
  });
});

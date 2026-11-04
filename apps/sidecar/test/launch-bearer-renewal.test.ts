import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sessions } from "@trafficflow/db";
import { resolveSession } from "@trafficflow/services/mail";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { openLocalDb, type LocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { mintLaunchBearer } from "../src/launch-bearer.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A WINDOW LEFT OPEN DOES NOT EXPIRE UNDER THE PERSON — both doors, on a fake clock.
 *
 * Measured at the base: once the bearer aged out, every bridge request on the Cloud-paired door answered a plain
 * `401 unauthorized`, and every shared route on the local door too, so the window latched "Sync
 * stopped" over frozen mail. The launch bearer now renews while it is used; one that ends anyway
 * is refused on both doors by the one name the window reads, `launch_session_expired`.
 */

const LAUNCH = new Date("2026-09-24T12:00:00.000Z").getTime();
const HOUR = 60 * 60 * 1000;
let clock = LAUNCH;
const now = (): Date => new Date(clock);

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  clock = LAUNCH;
});

async function codeOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  return `${res.status} ${body?.error?.code ?? "-"}`;
}
const ask = (handle: (r: Request) => Promise<Response>, token: string | null, path: string, method = "GET"): Promise<Response> =>
  handle(new Request(`http://engine${path}`, {
    method, headers: token === null ? {} : { authorization: `Bearer ${token}` },
  }));

// ── the paired door ────────────────────────────────────────────────────────────────────────

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const hosted = (async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "me@ohmail.test")]));
  if (url.pathname === "/sync") return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: new Date().toISOString() });
  if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

async function pairedDoor(): Promise<CloudSidecar> {
  const dataDir = await freshDataDir("ohmail-bearer-renewal-cloud-");
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test", fetchImpl: hosted,
    pollIntervalMs: 3_600_000, tokens: { accessToken: "a", refreshToken: "r" }, now,
  });
  cleanups.push(async () => { await sidecar.stop().catch(() => undefined); rmSync(dataDir, { recursive: true, force: true }); });
  return sidecar;
}

describe("the Cloud-paired door keeps its window's session", () => {
  it("answers past a day and past a two-day sleep, and the store agrees each time", { timeout: 60_000 }, async () => {
    const s = await pairedDoor();
    for (const at of [25, 73]) {
      clock = LAUNCH + at * HOUR;
      expect(await codeOf(await ask(s.handle, s.sessionToken, "/sync?cursor=")), `+${at} h`).toBe("200 -");
      expect(await resolveSession(s.db, s.sessionToken, now()), `the row at +${at} h`).not.toBeNull();
    }
  });

  it("an ENDED bearer is refused by name; no bearer and a foreign one are refused as before", { timeout: 60_000 }, async () => {
    const s = await pairedDoor();
    expect(await codeOf(await ask(s.handle, null, "/sync?cursor="))).toBe("401 unauthorized");
    expect(await codeOf(await ask(s.handle, "not-this-launch", "/sync?cursor="))).toBe("401 unauthorized");
    await s.stop();
    expect(await codeOf(await ask(s.handle, s.sessionToken, "/sync?cursor="))).toBe("401 launch_session_expired");
  });
});

// ── the local door ─────────────────────────────────────────────────────────────────────────

class MemoryMetaFolder implements LeaseIo {
  private claims: RawClaimMessage[] = [];
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
function quietMailbox(): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  return () => ({
    leaseIo: () => meta,
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

async function localDoor(): Promise<Sidecar> {
  const dataDir = await freshDataDir("ohmail-bearer-renewal-local-");
  const sidecar = await createSidecar({
    dataDir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
    address: "owner@trafficflow.test", machineName: "the machine left open",
    pollIntervalMs: 3_600_000, vitalsIntervalMs: 3_600_000, leaseStaleAfterMs: 60_000,
    adapterFactory: quietMailbox(), now,
  });
  cleanups.push(async () => { await sidecar.stop().catch(() => undefined); rmSync(dataDir, { recursive: true, force: true }); });
  return sidecar;
}

describe("the local door keeps its window's session (the control shape)", () => {
  it("answers past a day and past a two-day sleep, on the shared routes and its own", { timeout: 60_000 }, async () => {
    const s = await localDoor();
    for (const at of [25, 73]) {
      clock = LAUNCH + at * HOUR;
      for (const path of ["/sync?cursor=", "/mailboxes", "/local/mailboxes/connections"]) {
        expect(await codeOf(await ask(s.handle, s.sessionToken, path)), `${path} at +${at} h`).toBe("200 -");
      }
    }
  });

  it("a session revoked under it is refused BY NAME on every route, shared ones included", { timeout: 60_000 }, async () => {
    const s = await localDoor();
    await s.db.update(sessions).set({ revokedAt: now() }).where(eq(sessions.accountId, s.world.accountId));
    clock = LAUNCH + 13 * HOUR;
    for (const path of ["/sync?cursor=", "/mailboxes", "/local/mailboxes/connections"]) {
      expect(await codeOf(await ask(s.handle, s.sessionToken, path)), path).toBe("401 launch_session_expired");
    }
  });
});

// ── the holder itself ──────────────────────────────────────────────────────────────────────

type Client = Record<"query" | "exec" | "transaction", (...a: unknown[]) => Promise<unknown>>;

/** Every statement this store handle runs, counted — and, while `down`, refused. */
function storeSpy(db: LocalDb): { reads: () => number; down: (on: boolean) => void; stop: () => void } {
  const client = (db as unknown as { $client: Client }).$client;
  const originals = { query: client.query, exec: client.exec, transaction: client.transaction };
  let n = 0;
  let refusing = false;
  for (const name of ["query", "exec", "transaction"] as const) {
    const original = originals[name];
    client[name] = (...args: unknown[]) => {
      n++;
      return refusing ? Promise.reject(new Error("the store refused")) : original.apply(client, args);
    };
  }
  return { reads: () => n, down: (on) => { refusing = on; }, stop: () => Object.assign(client, originals) };
}

async function held(): Promise<{ db: LocalDb; world: Awaited<ReturnType<typeof ensureLocalWorld>> }> {
  const dataDir = await freshDataDir("ohmail-bearer-renewal-holder-");
  const opened: OpenLocalDb = await openLocalDb(dataDir);
  cleanups.push(async () => { await opened.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date(LAUNCH) });
  return { db: opened.db, world };
}
const at = (hours: number): Date => new Date(LAUNCH + hours * HOUR);
const expiryOf = async (db: LocalDb, id: string): Promise<number> =>
  (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!.accessExpiresAt.getTime();

describe("the renewing holder", () => {
  it("renews only its own bearer, from its half-life, with one write a lifetime ahead", async () => {
    const { db, world } = await held();
    const bearer = await mintLaunchBearer(db, world, at(0));
    const spy = storeSpy(db);
    await bearer.decide(bearer.token, at(11.99));
    expect(await bearer.decide("not-this-launch", at(12)), "a foreign token").toBe("unknown");
    expect(spy.reads(), "nothing is due before the half-life, and a foreign token renews nothing").toBe(0);
    expect(await bearer.decide(bearer.token, at(12))).not.toBe("refused");
    const writes = spy.reads();
    await bearer.decide(bearer.token, at(12.01));
    expect(spy.reads(), "one renewal, then quiet again").toBe(writes);
    spy.stop();
    expect(writes).toBeGreaterThanOrEqual(1);
    expect(await expiryOf(db, bearer.sessionId)).toBe(at(36).getTime());
  });

  it("a failed renewal keeps a live bearer, refuses an expired one, and heals on the next ask", async () => {
    const lines: string[] = [];
    const { db, world } = await held();
    const bearer = await mintLaunchBearer(db, world, at(0), (event) => { lines.push(event); });
    const spy = storeSpy(db);
    spy.down(true);
    expect(await bearer.decide(bearer.token, at(12)), "still inside its lifetime").not.toBe("refused");
    expect(await bearer.decide(bearer.token, at(24)), "past it, with the store refusing").toBe("refused");
    spy.down(false);
    spy.stop();
    expect(await bearer.decide(bearer.token, at(24.1)), "the store is back").not.toBe("refused");
    expect(lines.filter((l) => l === "launch_bearer_renew_failed").length).toBe(2);
    expect(await resolveSession(db, bearer.token, at(24.1))).not.toBeNull();
  });

  it("a revoked row ends the holder at its next renewal, and it stays ended", async () => {
    const lines: string[] = [];
    const { db, world } = await held();
    const bearer = await mintLaunchBearer(db, world, at(0), (event) => { lines.push(event); });
    await db.update(sessions).set({ revokedAt: at(1) }).where(eq(sessions.id, bearer.sessionId));
    expect(await bearer.decide(bearer.token, at(12))).toBe("refused");
    expect(await bearer.decide(bearer.token, at(12.5))).toBe("refused");
    expect(lines).toEqual(["launch_bearer_revoked"]);
  });
});

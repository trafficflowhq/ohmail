/**
 * OFFLINE, ONE LETTER IS ONE DRAFT — the phone's engine, its own door, and the client the phone
 * runs over it (`localEngineTransport`'s shape). Measured on android 0.25.1, standalone, network
 * cut: every Send press wrote another draft row and the composer re-armed with nothing said.
 *
 * The client creates the row (`POST /drafts`) and the engine keeps it once the send fails, so a
 * press can only be the SAME letter if the failure names its row. An unreachable mail server is a
 * passing refusal, offered again under the press's key first, so that failure is the third
 * attempt's. The network cut is the dial double refusing the way node refuses a closed port;
 * everything above it is the shipped code.
 * Runs under the SQLITE project (the device store); the default project states the premise.
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpAdapter, OhmailEngine, type EngineMutation, type MutationResult, type SqlExecutor, type SqlRow, type SqlValue,
} from "@ohmail/client-engine";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";
import { bootEngine, LOCAL_ENGINE_ORIGIN } from "../../mobile/src/engine/boot.js";
import { queuedCaptionKey } from "../../mobile/src/engine/send-waits.js";
import { installNetworkReader, networkNow, type NetworkReader } from "../../mobile/src/net/network-door.js";
import { flushQueued, liveActions } from "../../mobile/src/state/live.js";
import { sayArg } from "../../mobile/src/refusal.js";
import { Copy } from "../../mobile/src/copy.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
      columns?(): { column?: string | null; name?: string }[];
    };
  };
};

/** `phone-engine-boot.test.ts`'s statement runner, with its yield. */
function nodeExecutor(): PhoneSqlExecutor & { direct: (sql: string, params?: unknown[]) => unknown[] } {
  const raw = new sqlite.DatabaseSync(":memory:");
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(async () => {
        await yielded();
        const statement = raw.prepare(sql);
        const columns = (statement.columns?.() ?? []).map((c) => c.name ?? c.column ?? "");
        const objects = statement.all(...(params as unknown[])) as Record<string, unknown>[];
        return {
          columns,
          rows: columns.length > 0
            ? objects.map((o) => columns.map((c) => o[c]))
            : objects.map((o) => Object.values(o)),
        };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.prepare(sql).run(...(params as unknown[]));
      });
    },
    async batch(statements): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as unknown[]));
          raw.exec("COMMIT");
        } catch (err) {
          raw.exec("ROLLBACK");
          throw err;
        }
      });
    },
    async close(): Promise<void> { raw.close(); },
    direct: (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...params),
  };
}

/** An `ohmail/_meta` the gate can list and append to — `phone-claim-door.test.ts`'s. */
class MemoryMeta {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(): Promise<RawClaimMessage[] | null> { return []; }
}

/** THE CUT: node's own shape for a server that is not there (a closed port, no route). */
const refused = (): Error =>
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:993"), { code: "ECONNREFUSED", syscall: "connect" });

/** A quiet mailbox whose every dial refuses once `net.cut` is set; `sent` counts deliveries. */
function mailbox(net: { cut: boolean; sent: number }): () => MailboxAdapter {
  const meta = new MemoryMeta();
  return () => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    async connect(): Promise<void> { if (net.cut) throw refused(); },
    async close(): Promise<void> {},
    async capabilities() {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince() {
      if (net.cut) throw refused();
      return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
    },
    async move(locator: unknown): Promise<unknown> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(): Promise<{ providerMessageId: string }> {
      if (net.cut) throw refused();
      net.sent += 1;
      return { providerMessageId: `<sent-${net.sent}@phone.test>` };
    },
    async messageInSent(): Promise<boolean> { return false; },
    async fetchPart(): Promise<never> { throw new Error("this mailbox cannot fetchPart"); },
  }) as unknown as MailboxAdapter;
}

const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";

let live: PhoneEngine | null = null;
const closers: Array<() => void> = [];
afterEach(async () => {
  installNetworkReader(null);
  for (const close of closers.splice(0)) close();
  if (live) await live.stop().catch(() => undefined);
  live = null;
});

interface Scene {
  engine: PhoneEngine; client: OhmailEngine; mailboxId: string; net: { cut: boolean; sent: number };
  drafts: () => { id: string; status: string }[];
  /** The client's clock: the waits the engine names are waited out on it, never in real time. */
  advance: (ms: number) => void;
}

async function scene(): Promise<Scene> {
  let t = Date.now();
  const exec = nodeExecutor();
  const net = { cut: false, sent: 0 };
  live = await startPhoneEngine({
    exec,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } },
    machineName: "ohmail on a phone",
    installId: "install-offline-send",
    // A key ring, so the launch seals the password the send then opens — the device always has one.
    keks: { 1: "a1".repeat(32) },
    adapterFactory: mailbox(net),
  } as Parameters<typeof startPhoneEngine>[0]);
  const engine = live;
  const ids = Object.keys(engine.runtimes().organizer);
  expect(ids, "the engine did not report exactly one mailbox").toHaveLength(1);
  const client = new OhmailEngine({
    adapter: new HttpAdapter({
      baseUrl: "http://engine.invalid",
      fetch: ((url: string, init?: RequestInit) => engine.handle(new Request(url, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), authorization: `Bearer ${engine.sessionToken}` },
      }))) as unknown as typeof fetch,
    }),
    now: () => new Date(t),
  });
  const drafts = () => exec.direct("select id, status from drafts") as { id: string; status: string }[];
  return { engine, client, mailboxId: ids[0]!, net, drafts, advance: (ms) => { t += ms; } };
}

/** The phone's press (`live.ts#sent`): one dispatch, and a queued answer retried once under its key. */
async function press(client: OhmailEngine, m: EngineMutation): Promise<MutationResult> {
  const first = await client.mutate(m);
  if (first.status !== "queued") return first;
  const flushed = await client.flushPending().catch(() => [] as MutationResult[]);
  return flushed.find((r) => r.key === first.key) ?? first;
}

/**
 * A press followed to its end. A mail server that cannot be reached is a passing refusal, offered
 * again under the press's key after the wait the engine names (two more attempts); each wait is
 * waited out on the client's clock and the flush replays the key.
 */
async function pressToTheEnd(s: Scene, m: EngineMutation): Promise<{ last: MutationResult; offeredAgain: number }> {
  let last = await press(s.client, m);
  let offeredAgain = 0;
  while (last.status === "queued" && offeredAgain < 5) {
    offeredAgain += 1;
    s.advance(6_000);
    const key = last.key;
    last = (await s.client.flushPending()).find((r) => r.key === key) ?? last;
  }
  return { last, offeredAgain };
}

const letter = (mailboxId: string, draftId?: string): EngineMutation => ({
  kind: "mail_send", inReplyTo: null, mailboxId, subject: "Offline", body: "One letter",
  to: [{ name: null, address: "peer@example.test" }],
  ...(draftId ? { draftId } : {}),
});

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(process.env.OHMAIL_EXPECT_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("a Send with the network cut, on the phone's own engine", () => {
  it("is offered again, then fails, and names the draft row it left, so the next press is the same letter", async () => {
    const s = await scene();
    s.net.cut = true;
    const first = await pressToTheEnd(s, letter(s.mailboxId));
    expect(first.offeredAgain, "the unreachable mail server was not offered again under the key").toBe(2);
    expect(first.last.status, "an offline send read as delivered or still going").toBe("rolled_back");
    expect(s.drafts(), "the failed send left no row, or more than one").toHaveLength(1);
    const row = s.drafts()[0]!.id;
    expect(first.last.entityId, "the failure did not name the row it left behind").toBe(row);
    const second = await pressToTheEnd(s, letter(s.mailboxId, first.last.entityId));
    expect(second.last.status).toBe("rolled_back");
    expect(second.last.entityId).toBe(row);
    expect(s.drafts().map((d) => d.id), "a second press of one letter wrote a second draft").toEqual([row]);
    expect(s.net.sent).toBe(0);
  }, 60_000);

  it("a network back during the wait sends on the first press: one row, one delivery", async () => {
    const s = await scene();
    s.net.cut = true;
    const first = await press(s.client, letter(s.mailboxId));
    expect(first.status, "the unreachable mail server was not offered again").toBe("queued");
    s.net.cut = false;
    s.advance(6_000);
    const settled = (await s.client.flushPending()).find((r) => r.key === first.key);
    expect(settled?.status).toBe("confirmed");
    expect(s.net.sent).toBe(1);
    expect(s.drafts().map((d) => d.status)).toEqual(["sent"]);
  }, 60_000);

  it("keeps the same row on Cancel, and sends THAT row once the network is back", async () => {
    const s = await scene();
    s.net.cut = true;
    const first = (await pressToTheEnd(s, letter(s.mailboxId))).last;
    const row = first.entityId!;
    // The composer's keep on Cancel (`live.ts#draftKeep`), bound to the row: the mirror drains
    // the row it has not seen yet, then an update in place, never a create.
    if (!s.client.read().get("draft", row)) await s.client.syncOnce();
    const kept = await s.client.mutate({
      kind: "draft_save", draftId: row, subject: "Offline", body: "One letter, kept",
      to: [{ name: null, address: "peer@example.test" }], cc: [], bcc: [],
    });
    expect(kept.status, "the keep over the failed send's row was refused").toBe("confirmed");
    expect(s.drafts().map((d) => d.id)).toEqual([row]);
    // POSITIVE CONTROL: binding the row does not stop the letter from leaving.
    s.net.cut = false;
    const sent = await press(s.client, letter(s.mailboxId, row));
    expect(sent.status, "the bound press did not send once the network was back").toBe("confirmed");
    expect(s.net.sent).toBe(1);
    expect(s.drafts().map((d) => [d.id, d.status])).toEqual([[row, "sent"]]);
  }, 60_000);
});

/** The app's own mirror store over `node:sqlite`. */
function mirrorExecutor(): SqlExecutor & { close(): void } {
  const db = new sqlite.DatabaseSync(":memory:");
  return {
    async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    async batch(statements): Promise<void> {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) { db.exec("ROLLBACK"); throw err; }
    },
    close: () => { try { db.close(); } catch { /* already closed */ } },
  };
}

/** The platform's network reader, turned by hand. */
function networkDoor(): { reader: NetworkReader; set(s: "online" | "offline"): void } {
  let state: "online" | "offline" = "online";
  const listeners = new Set<(r: unknown) => void>();
  return {
    reader: { read: () => state, subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; } },
    set(s) { state = s; for (const l of [...listeners]) l(s); },
  };
}

/**
 * THE PHONE'S APP OVER ITS ENGINE, as the standalone door composes it: `bootEngine` with the network
 * door, the press (`liveActions`) and the reconnect flush. The engine's clock is the server's and
 * moves by hand; the app's is real, so the wait the server names is waited out.
 */
async function appScene() {
  let t = Date.now();
  const exec = nodeExecutor();
  const net = { cut: false, sent: 0 };
  live = await startPhoneEngine({
    exec,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } },
    machineName: "ohmail on a phone",
    installId: "install-offline-rearm",
    keks: { 1: "a1".repeat(32) },
    adapterFactory: mailbox(net),
    now: () => new Date(t),
  } as Parameters<typeof startPhoneEngine>[0]);
  const engine = live;
  const door = networkDoor();
  installNetworkReader(door.reader);
  const mirrors: Array<{ close(): void }> = [];
  const boot = await bootEngine(
    {
      openExecutor: () => { const m = mirrorExecutor(); mirrors.push(m); return m; },
      deleteDatabase: async () => undefined, uuid: () => randomUUID(),
    },
    { origin: LOCAL_ENGINE_ORIGIN, accountId: engine.accountId, localEngine: engine, network: networkNow },
  );
  if (boot.kind !== "ready") throw new Error("the app's client did not boot over the engine's door");
  closers.push(() => { boot.store.close(); for (const m of mirrors) m.close(); });
  await boot.engine.start();
  const toasts: string[] = [];
  const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid: () => randomUUID(), zone: "UTC" });
  return {
    app: boot.engine, actions, toasts, net, door, mailboxId: Object.keys(engine.runtimes().organizer)[0]!,
    rows: () => exec.direct("select status, attempts from outbound_sends") as { status: string; attempts: number }[],
    drafts: () => exec.direct("select status from drafts") as { status: string }[],
    advance: (ms: number) => { t += ms; },
  };
}

/** The wait the server names (2 s), waited out on the app's clock. */
const theServersWait = (): Promise<void> => new Promise((r) => setTimeout(r, 2_300));

/*
 * THE SERVER OFFERED IT AGAIN, THEN THE PHONE LOST ITS NETWORK. The send's dial failed as the radio
 * went (a lift, a tunnel) while the network door still read online, so the engine offered the key
 * again for two minutes; then the door read offline and held every replay. Measured before: the
 * composer said "the message goes when it is back", and a return after the two minutes rolled the
 * send back with the generic "Sending didn't work" and nothing delivered.
 */
describe.runIf(ON_DEVICE_STORE)("a Send the server offered again, then held offline, on the phone's own app", () => {
  it("never promises the return, and past the two minutes ends on the refusal it met: nothing sent", async () => {
    const s = await appScene();
    s.net.cut = true;
    const res = await s.actions.sendNew(s.mailboxId, [{ name: "R", address: "peer@example.test" }], "In a lift", "One letter");
    expect(res.outcome).toBe("queued");
    expect(s.toasts).toEqual([Copy.replyQueued]);
    s.door.set("offline");
    // The locked composer's sentence, read as it reads it (`MessageActions.tsx`).
    expect.soft(Copy[queuedCaptionKey(networkNow(), res.accepted === true, res.rearmed === true)]).toBe(Copy.replyQueued);
    expect.soft(res.rearmed, "the press did not hear that the server offered it again").toBe(true);
    await theServersWait();
    await flushQueued(s.app, s.actions.releaseConfirmed);
    expect(s.app.pendingMutations().map((p) => p.key), "the held send left the queue").toEqual([res.key]);

    s.advance(125_000);
    s.net.cut = false;
    s.door.set("online");
    const back = (await flushQueued(s.app, s.actions.releaseConfirmed)).get(res.key!);
    expect(back).toMatchObject({ status: "rolled_back", failure: "replyUnreachable" });
    expect(s.net.sent).toBe(0);
    expect(s.rows(), "the lapsed key was attempted again").toEqual([{ status: "failed", attempts: 1 }]);
    expect(s.drafts().map((d) => d.status)).toEqual(["draft"]);
  }, 60_000);

  it("CONTROL: back within the two minutes, the same key goes once", async () => {
    const s = await appScene();
    s.net.cut = true;
    const res = await s.actions.sendNew(s.mailboxId, [{ name: "R", address: "peer@example.test" }], "In a lift", "One letter");
    expect(res.outcome).toBe("queued");
    s.door.set("offline");
    await theServersWait();
    s.advance(60_000);
    s.net.cut = false;
    s.door.set("online");
    const back = (await flushQueued(s.app, s.actions.releaseConfirmed)).get(res.key!);
    expect(back?.status).toBe("confirmed");
    expect(s.net.sent).toBe(1);
    expect(s.rows()).toEqual([{ status: "sent", attempts: 2 }]);
  }, 60_000);
});

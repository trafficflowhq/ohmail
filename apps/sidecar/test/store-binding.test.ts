import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { mintMessageId, normalizeMessageId } from "@trafficflow/core/mail";
import {
  assertBinding, bindingOf, drafts, fencedAccountWrite, mailboxes, messages, onServerPool, outboundSendFingerprints,
  outboundSends, type Tx,
} from "@trafficflow/db";
import { CalendarConnectionGone, fencedConnectionWrite } from "@trafficflow/db/calendar";
import { sendService, type ServiceContext } from "@trafficflow/services/mail";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshCloudDataDir, freshDataDir } from "./_datadir.js";
import { readHandles, type HandleReadings, type Readings } from "./_handle-readings.js";
import { tearDown } from "./_teardown.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";

/**
 * WHOM A DEVICE'S HANDLES ACT FOR, read on the engine as it runs.
 *
 * A device's store holds one account and has no role and no policy, so nothing here can leak
 * across accounts. What a wrong handle costs on a device is the shared code's own check: a
 * context whose handle does not name its account, or a writer of the organizer's on a handle that
 * names nothing, is a fault in this process. So each case reads whom the statements of a request,
 * of a cycle and of a send rode (`_handle-readings.ts`), over the engine a desktop runs: its store
 * on disk, its own start, a mail server that is a double.
 */

const USER = "owner@trafficflow.test";
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

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

const EMPTY_BATCH: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

/** A mail server that takes any login, delivers what it is handed and files its Sent copy. */
function mailServer() {
  const meta = new MemoryMetaFolder();
  const sends: OutboundMessage[] = [];
  const factory = (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async listFolders(): Promise<string[]> { return ["INBOX", "Sent", "Drafts", "Trash"]; },
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY_BATCH }; },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(m: OutboundMessage, o?: { beforeRelease?: () => Promise<void> }): Promise<SendResult> {
      sends.push(m);
      await o?.beforeRelease?.();
      return {
        providerMessageId: m.messageId!, sentLocator: null, raw: null,
        unfiledCopy: Buffer.from(`Message-ID: ${m.messageId}\r\n\r\n${m.text}\r\n`),
      };
    },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox holds no part"); },
    async fileSentCopy(): Promise<null> { return null; },
    async messageInSent(): Promise<boolean> { return false; },
  } as unknown as MailboxAdapter & { leaseIo(): LeaseIo });
  return { factory, sends };
}

const sidecars: Sidecar[] = [];
const doors: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await tearDown({ stop: [sidecars, doors], remove: dirs });
}, 60_000);

interface Local {
  sidecar: Sidecar;
  /** The world's account: the one account this engine's store holds. */
  account: string;
  reads: HandleReadings;
  /** The engine's own lines, by event. */
  events: string[];
  server: ReturnType<typeof mailServer>;
}

/** A desktop's engine over a store on disk, its mailbox agreed to and its password kept. */
async function local(dataDir?: string): Promise<Local> {
  const dir = dataDir ?? await freshDataDir("ohmail-store-binding-");
  if (dataDir === undefined) dirs.push(dir);
  const events: string[] = [];
  const server = mailServer();
  const sidecar = await createSidecar({
    dataDir: dir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: USER, pass: "a-password-no-server-reads" } },
    keks: { 1: Buffer.alloc(32, 7) },
    address: USER,
    machineName: "this computer",
    pollIntervalMs: 60 * HOUR,
    vitalsIntervalMs: 60 * HOUR,
    leaseStaleAfterMs: 60_000,
    adapterFactory: server.factory,
    // No sender-signature check: its key lookup asks the network.
    dkimKeys: null,
    log: (event) => { events.push(event); },
  });
  sidecars.push(sidecar);
  await sidecar.db.update(mailboxes)
    .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
    .where(isNull(mailboxes.organizeConsentedAt));
  return { sidecar, account: sidecar.world.accountId, reads: readHandles(sidecar.db), events, server };
}

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`, "content-type": "application/json",
});

function ask(s: Sidecar | CloudSidecar, method: string, path: string, body?: unknown, key?: string): Promise<Response> {
  return s.handle(new Request(`http://local${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { ...bearer(s.sessionToken), ...(key ? { "idempotency-key": key } : {}) },
  }));
}

/** Resolve once the engine has written `event`. */
async function until(events: string[], event: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!events.includes(event)) {
    if (Date.now() > deadline) throw new Error(`the engine never wrote ${event}; it wrote ${[...new Set(events)].join(", ")}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A send the last cycle left unsettled, whose letter this store's own mirror already holds. */
async function strand(l: Local): Promise<string> {
  const at = new Date(Date.now() - 11 * MIN);
  const minted = mintMessageId("store-binding.test");
  const [d] = await l.sidecar.db.insert(drafts).values({
    accountId: l.account, mailboxId: l.sidecar.world.mailboxId, subject: "stranded", body: "the words",
    to: [{ name: null, address: "you@example.com" }], status: "sending", createdAt: at, updatedAt: at,
  }).returning();
  const [s] = await l.sidecar.db.insert(outboundSends).values({
    accountId: l.account, idempotencyKey: randomUUID(), draftId: d!.id, mintedMessageId: minted, status: "pending", createdAt: at,
  }).returning();
  await l.sidecar.db.insert(messages).values({
    accountId: l.account, mailboxId: l.sidecar.world.mailboxId, messageIdHeader: normalizeMessageId(minted)!,
    bodyHash: randomUUID(), dedupKey: randomUUID(), subject: "stranded", fromAddress: USER,
    nativeLocator: { folder: "Sent", ref: "1:7" },
  });
  return s!.id;
}

/** Write a letter and send it, as the window does. Its words are its own: the same letter is not sent twice. */
async function press(l: Local): Promise<{ status?: string; sentCopy?: string }> {
  const created = await ask(l.sidecar, "POST", "/drafts", {
    mailboxId: l.sidecar.world.mailboxId, subject: "a letter", body: `The words of ${randomUUID()}.`,
    to: [{ name: null, address: "you@example.com" }],
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const sent = await ask(l.sidecar, "POST", `/drafts/${(await created.json() as { id: string }).id}/send`, {}, randomUUID());
  expect(sent.status, await sent.clone().text()).toBe(200);
  return await sent.json() as { status?: string; sentCopy?: string };
}

/** Every handle that named an account, each account once. */
const accountsOf = (reads: Readings): string[] =>
  [...new Set(reads.all.map((r) => r.rode).filter((r) => r !== "plain" && r !== "nothing" && r !== "keyed"))].sort();

describe("a request on a device's engine", () => {
  it("rides its session's account, looks its session up under a key and no account, and rides nothing where no session is asked", async () => {
    const l = await local();
    l.reads.clear();

    // No session is asked of the health door: its probe rides a handle that names nothing.
    const health = await l.sidecar.handle(new Request("http://local/health"));
    expect(health.status).toBe(200);
    expect(l.reads.all.length, "the health door asked the store nothing").toBeGreaterThan(0);
    expect([...new Set(l.reads.all.map((r) => r.rode))]).toEqual(["nothing"]);
    l.reads.clear();

    // The window's list of mailboxes, with this launch's bearer.
    const list = await ask(l.sidecar, "GET", "/mailboxes");
    expect(list.status, await list.clone().text()).toBe(200);
    expect(l.reads.rodeOf("sessions"), "the session's look-up").toEqual(["keyed"]);
    const after = l.reads.all.filter((r) => r.table !== "sessions");
    expect(after.length, "the route asked the store nothing").toBeGreaterThan(3);
    // The session is the launch's, and its account the store's one account.
    expect([...new Set(after.map((r) => r.rode))], "what the route and its services asked").toEqual([l.account]);
    l.reads.clear();

    // A write under a key: the pipeline looks the key up on the request's own handle, before any service is asked.
    const created = await ask(l.sidecar, "POST", "/drafts", {
      mailboxId: l.sidecar.world.mailboxId, subject: "a letter", body: "The words.", to: [{ name: null, address: "you@example.com" }],
    }, randomUUID());
    expect(created.status, await created.clone().text()).toBe(201);
    expect(l.reads.rodeOf("idempotency_keys"), "the request's own handle").toEqual([l.account]);
  }, 60_000);

  it("is sent by a dial that reads the mailbox for the world's account, never on a handle that names nothing", async () => {
    const l = await local();
    l.reads.clear();

    expect(await press(l)).toMatchObject({ status: "sent" });
    expect(l.server.sends, "the letter left once").toHaveLength(1);

    // The dial reads the mailbox's credential for the world's account. The engine's own look at
    // whether that credential is for the server it runs on rides the store's own handle.
    expect(l.reads.rodeOf("mailbox_credentials")).toEqual([l.account, "plain"].sort());
    // The press itself: the reservation, the letter and its Sent copy ride the session's account.
    for (const table of ["outbound_sends", "drafts", "outbound_sent_copies", "outbound_send_fingerprints"]) {
      expect(l.reads.rodeOf(table), table).toEqual([l.account]);
    }
    expect(accountsOf(l.reads)).toEqual([l.account]);
  }, 60_000);

  it("turns the window's switch for suggestions on under the world's account", async () => {
    const l = await local();
    l.reads.clear();

    const put = await ask(l.sidecar, "PUT", "/local/auto-suggest", { on: true });
    expect(put.status, await put.clone().text()).toBe(200);
    expect(await put.json()).toMatchObject({ on: true });
    const read = l.reads.take();

    // The write is the engine's own, for the one account its store holds.
    expect(read.of("account_settings").filter((r) => r.verb === "insert").map((r) => r.rode)).toEqual([l.account]);
    expect(accountsOf(read)).toEqual([l.account]);
  }, 60_000);
});

describe("one cycle of a device's engine", () => {
  it("walks its passes on a handle that names no account and does each row under the row's own", async () => {
    const l = await local();
    const sendId = await strand(l);
    l.reads.clear();

    await l.sidecar.syncUntilQuiet();
    const cycle = l.reads.take();

    const [settled] = await l.sidecar.db.select().from(outboundSends).where(eq(outboundSends.id, sendId));
    expect(settled!.status, "the cycle did not settle the stranded send").toBe("sent");
    // The reconciler finds what is stranded on its walk, and settles the row under the row's account.
    const sends = cycle.of("outbound_sends");
    expect([...new Set(sends.filter((r) => r.verb === "select").map((r) => r.rode))], "the walk's reads").toEqual(["nothing"]);
    expect([...new Set(sends.filter((r) => r.verb === "update").map((r) => r.rode))], "the row's settling").toEqual([l.account]);
    // The scheduled sender's and the away answers' walks name no account either.
    expect(cycle.rodeOf("away_responders")).toEqual(["nothing"]);
    expect(cycle.of("drafts").filter((r) => r.verb === "select").map((r) => r.rode)).toContain("nothing");
    expect(cycle.rodeOf("drafts"), "no pass asked the letters on the store's own handle").not.toContain("plain");
    expect(accountsOf(cycle), "no handle named an account that is not this store's").toEqual([l.account]);
  }, 60_000);

  it("reads its owed Sent copies and warms the search under the world's account", async () => {
    const l = await local();
    l.reads.clear();

    await l.sidecar.syncUntilQuiet();
    await until(l.events, "search_warmed");

    expect(l.reads.rodeOf("outbound_sent_copies"), "the owed copies' read").toEqual([l.account]);
    // Nothing else of a first cycle with nothing to send names an account: what is left is the search.
    const warmUp = l.reads.all.filter((r) => r.rode === l.account && r.table !== "outbound_sent_copies");
    expect(warmUp.length, "the warm-up's search rode no handle of the world's account").toBeGreaterThan(0);
    expect(accountsOf(l.reads)).toEqual([l.account]);
  }, 60_000);

  it("leaves the organizer's own statements on the store's own handle, which no binding names", async () => {
    const l = await local();
    l.reads.clear();

    await l.sidecar.syncUntilQuiet();

    // What only the organizer asks: the folders' state, the requests of other installs, the letters set aside.
    for (const table of ["folder_state", "organizer_requests", "message_failures", "rules"]) {
      expect(l.reads.rodeOf(table), table).toEqual(["plain"]);
    }
    // The handle the engine answers with is that one: no mark, and no server pool's.
    expect(bindingOf(l.sidecar.db)).toBeUndefined();
    expect(onServerPool(l.sidecar.db)).toBe(false);
    // So the rule a device's writers are held to takes it, for the account they write under.
    expect(() => assertBinding(l.sidecar.db, l.account, "device")).not.toThrow();
    // And the two fences of the db package let it through: the account's runs its body,
    const store = l.sidecar.db as unknown as Tx;
    expect(await fencedAccountWrite(store, { accountId: l.account }, async () => "ran")).toBe("ran");
    // the connection's reaches its own question, and answers that no such connection stands.
    await expect(fencedConnectionWrite(store, { accountId: l.account, connectionId: randomUUID() }, async () => "ran"))
      .rejects.toBeInstanceOf(CalendarConnectionGone);
  }, 60_000);
});

describe("the launch of a device's engine", () => {
  it("forgets the sends the last run left unoffered under the world's account", async () => {
    const dir = await freshDataDir("ohmail-store-binding-");
    dirs.push(dir);
    const first = await local(dir);
    const at = new Date(Date.now() - 30_000);
    const [d] = await first.sidecar.db.insert(drafts).values({
      accountId: first.account, mailboxId: first.sidecar.world.mailboxId, subject: "never offered", body: "the words",
      to: [{ name: null, address: "you@example.com" }], status: "sending", createdAt: at, updatedAt: at,
    }).returning();
    const [s] = await first.sidecar.db.insert(outboundSends).values({
      accountId: first.account, idempotencyKey: randomUUID(), draftId: d!.id,
      mintedMessageId: mintMessageId("store-binding.test"), status: "pending", offerState: "unoffered", createdAt: at,
    }).returning();
    // The claim on the letter's content, which every press made on this door holds.
    await first.sidecar.db.insert(outboundSendFingerprints).values({
      accountId: first.account, mailboxId: first.sidecar.world.mailboxId, sendId: s!.id, fingerprint: "0".repeat(64),
    });
    await first.sidecar.stop();
    sidecars.splice(0);

    const asked: ServiceContext[] = [];
    const forget = sendService.forgetInherited.bind(sendService);
    vi.spyOn(sendService, "forgetInherited").mockImplementation((ctx, ids) => {
      asked.push(ctx);
      return forget(ctx, ids);
    });
    const next = await local(dir);

    expect(next.events, "the launch did not forget the unoffered send").toContain("inherited_sends_forgotten");
    const [letter] = await next.sidecar.db.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(letter!.status, "the letter is a draft again").toBe("draft");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.accountId).toBe(next.account);
    expect(bindingOf(asked[0]!.db), "the context's handle").toEqual({ account: next.account, keyed: false });
  }, 60_000);
});

/** A hosted account's server, as far as a signed-in Cloud door asks it. `who` signs in next. */
function hostedAccount(): { fetchImpl: typeof fetch; who: { email: string } } {
  const who = { email: "me@ohmail.test" };
  const send = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/auth/login") return send({ status: "twofa_required", loginToken: "lt-1" });
    if (url.pathname === "/auth/2fa/totp/verify") return send({ tokens: { accessToken: "access-2", refreshToken: "refresh-2" } });
    if (url.pathname === "/auth/session") return send({ user: { email: who.email }, scope: "full" });
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "me@ohmail.test")]));
    if (url.pathname === "/sync") {
      return send({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: new Date().toISOString() });
    }
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    if (url.pathname === "/hello") return send({ product: "ohmail", flavor: "managed", apiVersion: "1.2.3" });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, who };
}

describe("several stores in one process", () => {
  it("each names its own world's account and no other, also after a sign-out and a sign-in under another login", async () => {
    const a = await local();
    const b = await local();
    const hosted = hostedAccount();
    const cloudDir = await freshCloudDataDir("ohmail-store-binding-cloud-", { address: "me@ohmail.test", cloudUrl: "https://cloud.test" });
    dirs.push(cloudDir);
    const door = await createCloudSidecar({
      dataDir: cloudDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test", fetchImpl: hosted.fetchImpl,
      keks: { 1: Buffer.alloc(32, 9) }, tokens: { accessToken: "access-1", refreshToken: "refresh-1" }, pollIntervalMs: 60 * HOUR,
    });
    doors.push(door);
    const c = { account: door.world.accountId, reads: readHandles(door.db) };
    expect(new Set([a.account, b.account, c.account]).size, "three stores, three worlds").toBe(3);

    // Each engine is asked, runs a cycle and sends; the Cloud door answers a list and a snapshot read.
    for (const l of [a, b]) {
      l.reads.clear();
      expect((await ask(l.sidecar, "GET", "/mailboxes")).status).toBe(200);
      expect(accountsOf(l.reads.take()), "the request").toEqual([l.account]);
      await l.sidecar.syncUntilQuiet();
      const cycle = l.reads.take();
      // The engine's own work is done in its own store: its owed copies are read there, under its world.
      expect(cycle.rodeOf("outbound_sent_copies"), "the cycle's own read").toEqual([l.account]);
      expect(accountsOf(cycle), "the cycle").toEqual([l.account]);
      expect(await press(l)).toMatchObject({ status: "sent" });
    }
    expect((await ask(door, "GET", "/mailboxes")).status).toBe(200);
    expect((await ask(door, "GET", `/messages/bodies?ids=${randomUUID()}`)).status).toBe(200);
    expect(accountsOf(a.reads)).toEqual([a.account]);
    expect(accountsOf(b.reads)).toEqual([b.account]);
    expect(accountsOf(c.reads)).toEqual([c.account]);
    // The Cloud door's snapshot is one transaction under its context's account.
    const snapshot = c.reads.all.filter((r) => r.inTransaction);
    expect(snapshot.length, "the snapshot read asked nothing inside its transaction").toBeGreaterThan(0);
    expect([...new Set(snapshot.map((r) => r.rode))]).toEqual([c.account]);

    // The first engine signs out, and signs in again under another login of the same mail server.
    const out = await ask(a.sidecar, "DELETE", "/local/stored-login");
    expect(out.status, await out.clone().text()).toBe(200);
    const again = await ask(a.sidecar, "PATCH", `/local/mailboxes/${a.sidecar.world.mailboxId}`, {
      imap: { host: "imap.invalid", port: 993, secure: true, user: "another-login@trafficflow.test", pass: "another-password" },
    });
    expect(again.status, await again.clone().text()).toBe(200);
    a.reads.clear();
    b.reads.clear();
    expect(await press(a)).toMatchObject({ status: "sent" });
    expect(accountsOf(a.reads.take()), "the request, after the sign-in").toEqual([a.account]);
    // The engine's own context is the same world's: the switch for suggestions is written under it.
    expect((await ask(a.sidecar, "PUT", "/local/auto-suggest", { on: true })).status).toBe(200);
    const switched = a.reads.take();
    expect(switched.of("account_settings").filter((r) => r.verb === "insert").map((r) => r.rode), "the engine's own write, after the sign-in")
      .toEqual([a.account]);
    await a.sidecar.syncUntilQuiet();
    expect(accountsOf(a.reads.take()).filter((who) => who !== a.account), "the cycle, after the sign-in").toEqual([]);

    // The Cloud door signs out: a read is refused, and nothing rides an account's handle.
    expect((await ask(door, "DELETE", "/cloud/session")).status).toBe(200);
    c.reads.clear();
    expect((await ask(door, "GET", "/mailboxes")).status, "signed out").toBe(409);
    // Another account's sign-in is refused by the door that holds this account's mail,
    hosted.who.email = "someone-else@ohmail.test";
    const other = await ask(door, "POST", "/cloud/signin", { email: "someone-else@ohmail.test", password: "pw", totp: "123456" });
    expect(other.status, await other.clone().text()).toBe(409);
    expect((await ask(door, "GET", "/mailboxes")).status).toBe(409);
    expect(accountsOf(c.reads), "no context was made for the other account").toEqual([]);
    // and its own account's sign-in reads under this store's world again.
    hosted.who.email = "me@ohmail.test";
    const own = await ask(door, "POST", "/cloud/signin", { email: "me@ohmail.test", password: "pw", totp: "123456" });
    expect(own.status, await own.clone().text()).toBe(200);
    expect((await ask(door, "GET", "/mailboxes")).status).toBe(200);
    expect(accountsOf(c.reads)).toEqual([c.account]);
    // Nothing of the first engine's second sign-in or of the door's reached the second engine's store.
    expect(b.reads.all.filter((r) => r.rode !== "plain"), "the second engine's store was asked for another's work").toEqual([]);
  }, 120_000);
});

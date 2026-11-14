import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, contacts, folderState, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";
import { materializeMessages, type MailboxDTO, type MessageDTO } from "@trafficflow/services/mail";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, consentPartition, presentationReader, screenerSegments,
  type FetchLike, type SyncChange,
} from "@ohmail/client-engine";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { firstImportsOf } from "@ohmail/app-logic/press/consent-options";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { tearDown } from "./_teardown.js";
import {
  NOW as WORLD_NOW, SENDERS, removedMailboxWorld, type RemovedMailboxWorld,
} from "../../../packages/services/test/helpers/removed-mailbox-world.js";

/**
 * A PAIRED DESKTOP LISTS WHAT THE SERVER LISTS FOR THE SAME MAILBOX (REVIEW-026 LOW 4). The server
 * dates a held claim by its record time after the ACCOUNT's first import; the desktop mirrors that
 * record time, but its own mailbox row carries the MIRROR's first pull, so a claim Cloud recorded
 * before the pairing read as part of an import there and its sender went to History. The Cloud door
 * now carries the account's stamp under its own key, and the shell dates by it. Driven end to end:
 * the server's list, then the real Cloud door's `GET /mailboxes` through the shell's `firstImportsOf`
 * into the client partition, over the door's own mirrored messages. The desktop's parser forwards the
 * key untouched (`apps/desktop/test/desktop-facts-census.test.ts`).
 */

const OWN = "me@ohmail.test";
const H = 3_600_000;
const D = 24 * H;
const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [sidecars], remove: dirs }));

const send = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const iso = (): string => new Date().toISOString();

/** A hosted account serving one mailbox and, once, these messages. */
function hosted(box: MailboxDTO, msgs: readonly MessageDTO[]): typeof fetch {
  let served = false;
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const none = { creates: [], updates: [], moves: [], deletes: [] };
    if (url.pathname === "/mailboxes") return send(mailboxList([box]));
    if (url.pathname === "/sync/snapshot") return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    if (url.pathname === "/sync") {
      if (url.searchParams.get("types") === "rule" || served) return send({ changes: none, cursor: "end", hasMore: false, serverTime: iso() });
      served = true;
      const creates = msgs.map((m, i) => ({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: iso(), entity: m }));
      return send({ changes: { ...none, creates }, cursor: "c1", hasMore: false, serverTime: iso() });
    }
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("a Cloud claim on a paired desktop and on the server", () => {
  it("the desktop presents at the gate exactly the claims the server lists", { timeout: 30_000 }, async () => {
    const now = new Date();
    const at = (ago: number) => new Date(now.getTime() - ago);
    const importedAt = at(10 * D);
    const server = await makeTestDb();
    const accountId = randomUUID();
    await server.insert(accounts).values({ id: accountId, name: `pd-${accountId.slice(0, 8)}` });
    const [mb] = await server.insert(mailboxes).values({
      accountId, provider: "imap", address: OWN, organizerRole: "organizer", initialImportCompletedAt: importedAt,
    }).returning();
    // Both Dates are old, so only the claim can keep a sender waiting: one recorded two hours before
    // the pairing, one the account's first import recorded.
    const ids: string[] = [];
    for (const [who, recorded] of [["before", 2 * H], ["imported", 11 * D]] as const) {
      const from = `${who}@partner.invalid`;
      const dedup = `pd:${randomUUID()}`;
      const [m] = await server.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: dedup, messageIdHeader: dedup,
        subject: "Konto", snippet: "", fromAddress: from, fromName: "PayPal",
        senderCheck: "impersonation", senderCheckBrand: "PayPal", senderCheckBy: "ingest",
        date: new Date("2020-01-01T08:00:00.000Z"), arrivedAt: at(recorded), unread: false, createdAt: at(recorded),
        nativeLocator: { folder: "ohmail/Screener", ref: `1:${who}` },
      }).returning();
      await server.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
      await server.insert(folderState).values({
        messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      await server.insert(contacts).values({ accountId, address: from, source: "inferred" });
      ids.push(m!.id);
    }
    const ctx: ServiceContext = { db: server as never, accountId, userId: null, now: () => now, requestId: `pd-${randomUUID().slice(0, 8)}` };
    const serverList = (await new ScreenerService({}).list(ctx, { limit: 50 })).items.map((i) => i.sender.address).sort();
    expect(serverList).toEqual(["before@partner.invalid"]);

    const dtos = await materializeMessages(server as never, accountId, ids);
    const dir = await freshDataDir("ohmail-paired-parity-");
    dirs.push(dir);
    const sidecar = await createCloudSidecar({
      dataDir: dir, cloudUrl: "https://cloud.test", address: OWN, tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl: hosted(hostedMailbox(mb!.id, OWN, { initialImportCompletedAt: importedAt.toISOString() }), [...dtos.values()]),
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start();
    const door = (path: string) => sidecar.handle(new Request(`http://sidecar${path}`, {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    const local: MessageDTO[] = [];
    for (const id of ids) {
      let res = await door(`/messages/${id}`);
      for (let i = 0; i < 100 && res.status !== 200; i++) {
        await new Promise((r) => setTimeout(r, 100));
        res = await door(`/messages/${id}`);
      }
      expect(res.status, "the door never mirrored the claim").toBe(200);
      local.push((await res.json()) as MessageDTO);
    }

    type Row = { id: string; initialImportCompletedAt?: string | null; hostedImportCompletedAt?: string | null };
    const facts = ((await (await door("/mailboxes")).json()) as { items: Row[] }).items;
    expect(facts.map((f) => f.hostedImportCompletedAt)).toEqual([importedAt.toISOString()]);
    expect(facts[0]!.initialImportCompletedAt, "the mirror's own stamp was replaced").not.toBe(importedAt.toISOString());
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges(local.map((m, i) => ({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: m.updatedAt, entity: m })) as SyncChange[]);
    const activity = consentPartition(store, { now, firstImportDoneAt: firstImportsOf(facts) }).activity;
    const desktopList = [...activity].filter(([, v]) => v === "active").map(([k]) => k).sort();
    expect(desktopList).toEqual(serverList);
  });
});

/**
 * A REMOVED MAILBOX, ON A PAIRED DESKTOP (`helpers/removed-mailbox-world.ts`). The window asks its
 * own door, which forwards `GET /screener` with its query to the account and hands the answer back
 * whole, `gone` included, read beside the door's own copy of the account's mail and rules.
 */
function hostedWorld(w: RemovedMailboxWorld, changes: readonly SyncChange[]): typeof fetch {
  const sent = { rules: false, mail: false };
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const none = { creates: [], updates: [], moves: [], deletes: [] };
    if (url.pathname === "/mailboxes") {
      return send(mailboxList([hostedMailbox(w.liveMailbox, w.own), hostedMailbox(w.secondMailbox, "old@ohmail.test", { status: "disabled" })]));
    }
    if (url.pathname === "/sync/snapshot") return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    if (url.pathname === "/sync") {
      const rules = url.searchParams.get("types") === "rule";
      const due = rules ? !sent.rules : !sent.mail;
      if (rules) sent.rules = true; else sent.mail = true;
      const creates = due ? changes.filter((c) => (c.type === "rule") === rules) : [];
      return send({ changes: { ...none, creates }, cursor: due ? "c1" : "end", hasMore: false, serverTime: iso() });
    }
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    if (url.pathname === "/screener") return w.serve()(url.href, init as never);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("a mailbox removed with its copy kept, on a paired desktop", () => {
  it("the door forwards the window's ask and the answer's `gone`; the window lists the live strangers only", { timeout: 30_000 }, async () => {
    const w = await removedMailboxWorld("removed");
    const changes = await w.changes();
    const dir = await freshDataDir("ohmail-paired-removed-");
    dirs.push(dir);
    const sidecar = await createCloudSidecar({
      dataDir: dir, cloudUrl: "https://cloud.test", address: w.own, tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl: hostedWorld(w, changes), pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start();
    const door: FetchLike = (url, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      headers.set("authorization", `Bearer ${sidecar.sessionToken}`);
      return sidecar.handle(new Request(String(url), { ...(init as RequestInit), headers }));
    };
    for (const c of changes.filter((x) => x.type === "message")) {
      let res = await door(`http://sidecar/messages/${c.id}`, { method: "GET" });
      for (let i = 0; i < 100 && res.status !== 200; i++) {
        await new Promise((r) => setTimeout(r, 100));
        res = await door(`http://sidecar/messages/${c.id}`, { method: "GET" });
      }
      expect(res.status, "the door never mirrored the letter").toBe(200);
    }
    const http = new HttpAdapter({ baseUrl: "http://sidecar", fetch: door });
    const page = await http.screenerWaiting({ limit: 50 });
    expect(page.gone).toEqual([w.secondMailbox]);
    expect(page.items.map((i) => w.nameOf(i.messageId))).toEqual(["I.held", "B.live"]);

    const engine = new OhmailEngine({ adapter: http, store: new MemoryMirrorStore(), now: () => WORLD_NOW, storePolicy: { mode: "full" } });
    await engine.start();
    await engine.syncOnce();
    await engine.refreshScreenerWaiting();
    const part = consentPartition(engine.read(), { now: WORLD_NOW, ownAddresses: [w.own] });
    expect(part.placeOf.get(w.idOf("A.held")) ?? "History", "a removed mailbox's stranger waits").toBe("History");
    const waiting = screenerSegments(presentationReader(engine.read(), part), WORLD_NOW).waiting;
    expect(waiting.map((s) => s.from.address).sort()).toEqual([SENDERS.B, SENDERS.I].sort());
  });
});

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, contacts, folderState, mailboxes, messageBodies, messages, rules } from "@trafficflow/db";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, consentPartition,
  type EngineAdapter, type EngineMessage, type RuleDTO, type SyncChange, type SyncResponse,
} from "@ohmail/client-engine";
import { screenerRoutesGroup, type ApiDeps } from "@trafficflow/api";
import { ScreenerService } from "../src/screener-service.js";
import { cutlineCounts } from "../src/consent-cutline.js";
import { materializeMessages, messageRowToDTO, ruleRowToDTO } from "../src/dto/materialize.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE CLIENT'S HELD-CLAIM TWIN AND THE COUNT'S DECIDED ARM ASK THE LIST'S TERM: who wrote the fact
 * (`claimInside`), the person skip and its authentication half (`personSkip`, `SCREENING_AUTH_VERDICTS`).
 * A backfilled claim, a person-consented sender's claim, and the same claim failing authentication.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const SENDER = "kundendienst@karten-service.test";
/** A company's own address, whose letter the gate holds for want of confirmation (mail 0176). */
const OWNED = "service@paypal.com";
const IMPORT_DONE = new Date("2026-09-01T00:00:00.000Z");

async function world(o: {
  by: "ingest" | "backfill"; person: boolean; auth: string | null; unconfirmed?: "marked" | "unmarked"; importDone?: Date | null;
  /** A domain rule for the sender's domain, beside the sender's own; `pressed` is a person's Screener press on it. */
  domain?: "manual" | "promoted" | "pressed";
  /** The claim carries the hold's mark too, as a list address's can (mail 0176). */
  claimMarked?: true;
}) {
  const sender = o.unconfirmed === undefined ? SENDER : OWNED;
  const db = await makeTestDb();
  const accountId = randomUUID();
  const own = `me-${accountId.slice(0, 8)}@ohmail.test`;
  await db.insert(accounts).values({ id: accountId, name: `kp-${accountId.slice(0, 8)}` });
  const importDone = o.importDone === undefined ? IMPORT_DONE : o.importDone;
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: own, organizerRole: "organizer", initialImportCompletedAt: importDone,
  }).returning();
  const put = async (folder: string, held: boolean, at: Date) => {
    const claim = held && o.unconfirmed === undefined;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `kp:${randomUUID()}`, subject: "Ihre Karte", snippet: "",
      fromAddress: sender, fromName: claim ? "PostFinance" : "Anna Meier",
      senderCheck: claim ? "impersonation" : "none", senderCheckBrand: claim ? "PostFinance" : null,
      senderCheckBy: claim ? o.by : "ingest", authVerdict: held ? o.auth : null,
      ...(held && (o.unconfirmed === "marked" || (claim && o.claimMarked)) ? { unconfirmedHold: true } : {}),
      date: at, arrivedAt: at, unread: false, createdAt: at, nativeLocator: { folder, ref: `1:${randomUUID().slice(0, 4)}` },
    } as never).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: folder, observedFolder: folder, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };
  await put("INBOX", false, new Date("2026-09-30T09:00:00.000Z"));
  await put(GATE, true, new Date("2026-10-01T09:00:00.000Z"));
  await db.insert(rules).values({ accountId, kind: "sender", match: sender, destination: "INBOX", enabled: true, priority: 0, provenance: o.person ? "manual" : "promoted" });
  if (o.domain !== undefined) {
    await db.insert(rules).values({
      accountId, kind: "domain", match: sender.slice(sender.indexOf("@") + 1), destination: "INBOX", enabled: true, priority: 0,
      provenance: o.domain === "pressed" ? "promoted" : o.domain, ...(o.domain === "pressed" ? { personDecidedAt: NOW } : {}),
    });
  }
  await db.insert(contacts).values({ accountId, address: sender, source: o.person ? "person" : "inferred" });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `kp-${randomUUID().slice(0, 8)}` };
  const rows = await db.select().from(messages).where(eq(messages.accountId, accountId));
  const states = await db.select().from(folderState).where(inArray(folderState.messageId, rows.map((m) => m.id)));
  const storedRules = await db.select().from(rules).where(eq(rules.accountId, accountId));
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([
    ...rows.map((m) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: messageRowToDTO(m as never, states.find((f) => f.messageId === m.id)! as never, undefined, undefined) as unknown as EngineMessage,
    })),
    // Each rule as the wire carries it.
    ...storedRules.map((r) => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: ruleRowToDTO(r) as unknown as RuleDTO,
    })),
  ] as SyncChange[]);
  const client = consentPartition(store, {
    now: NOW, ownAddresses: [own], firstImportDoneAt: { [mb!.id]: importDone === null ? null : importDone.toISOString() },
  });
  const page = await new ScreenerService({}).list(ctx, { limit: 50 });
  const server = await cutlineCounts(ctx, {});
  return { listed: page.items.length, checked: page.items.map((i) => i.checked), server, client: client.counts };
}

describe("a decided sender's held claim: the list, the server count and the client count agree", () => {
  it("a backfilled claim of a decided sender: listed nowhere, decided on both", async () => {
    const r = await world({ by: "backfill", person: false, auth: null });
    expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders]).toEqual([0, 0, 0]);
  });
  it("a person-consented sender's ingest claim: the person skip takes it on both", async () => {
    const r = await world({ by: "ingest", person: true, auth: null });
    expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders]).toEqual([0, 0, 0]);
  });
  it("the same claim failing authentication: listed, and waiting on both counts", async () => {
    const r = await world({ by: "ingest", person: true, auth: "fail" });
    expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders]).toEqual([1, 1, 1]);
  });
  it("CONTROL: a decided sender's ingest claim inside the window: listed and waiting on both", async () => {
    const r = await world({ by: "ingest", person: false, auth: null });
    expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders]).toEqual([1, 1, 1]);
  });
});

describe("a decided sender's letter held for want of confirmation (mail 0176): the list and both counts agree", () => {
  it("held and marked: listed with its line, and waiting on both counts", async () => {
    const r = await world({ by: "ingest", person: false, auth: null, unconfirmed: "marked" });
    expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders]).toEqual([1, 1, 1]);
    expect(r.checked).toEqual([{ reason: "unverified", brand: "PayPal", domainShared: false, held: true }]);
  });
  it("a person consented to the address: the person skip takes it on both", async () => {
    const r = await world({ by: "ingest", person: true, auth: null, unconfirmed: "marked" });
    expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders]).toEqual([0, 0, 0]);
  });
  it("held while the mailbox's first import ran, or runs: dated by its record time alone, listed and waiting on every reader", async () => {
    // The gate holds only a letter young enough to check, so no such hold is a first import's old mail.
    for (const importDone of [new Date("2026-10-02T00:00:00.000Z"), null]) {
      const r = await world({ by: "ingest", person: false, auth: null, unconfirmed: "marked", importDone });
      expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders], String(importDone)).toEqual([1, 1, 1]);
    }
    // A claim the hold's mark sits beside is dated as the hold, the wire carrying the mark to the client.
    const claim = await world({ by: "ingest", person: false, auth: null, importDone: null, claimMarked: true });
    expect([claim.listed, claim.server.activeUndecidedSenders, claim.client.activeUndecidedSenders]).toEqual([1, 1, 1]);
  });
  it("a domain rule a person wrote is consent to the hold on both; one ohmail inferred is not", async () => {
    const person = await world({ by: "ingest", person: false, auth: null, unconfirmed: "marked", domain: "manual" });
    expect([person.listed, person.server.activeUndecidedSenders, person.client.activeUndecidedSenders]).toEqual([0, 0, 0]);
    const inferred = await world({ by: "ingest", person: false, auth: null, unconfirmed: "marked", domain: "promoted" });
    expect([inferred.listed, inferred.server.activeUndecidedSenders, inferred.client.activeUndecidedSenders]).toEqual([1, 1, 1]);
  });
  it("the person's own Screener press on the domain is that consent too, the wire carrying it to the client", async () => {
    const pressed = await world({ by: "ingest", person: false, auth: null, unconfirmed: "marked", domain: "pressed" });
    expect([pressed.listed, pressed.server.activeUndecidedSenders, pressed.client.activeUndecidedSenders]).toEqual([0, 0, 0]);
    // Never to a company claim, as for a domain rule a person typed.
    const claim = await world({ by: "ingest", person: false, auth: null, domain: "pressed" });
    expect([claim.listed, claim.server.activeUndecidedSenders, claim.client.activeUndecidedSenders]).toEqual([1, 1, 1]);
  });
  it("CONTROL: a person's domain rule is no consent to a company claim, on both, the hold's mark beside it or not", async () => {
    for (const claimMarked of [undefined, true] as const) {
      const r = await world({ by: "ingest", person: false, auth: null, domain: "manual", ...(claimMarked ? { claimMarked } : {}) });
      expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders], String(claimMarked)).toEqual([1, 1, 1]);
    }
  });
  it("CONTROL: the same letter unmarked is decided on every reader, which is why the mark is written", async () => {
    const r = await world({ by: "ingest", person: false, auth: null, unconfirmed: "unmarked" });
    expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders]).toEqual([0, 0, 0]);
  });
});

/**
 * A FORGED LETTER HELD DURING A MAILBOX'S FIRST IMPORT, its company address known by an inferred
 * contact alone (mail 0176): the store's queue page lists the sender, and the client over that page,
 * read through the real route, keeps the letter at the gate rather than showing it in the Ohbox.
 */
describe("a letter held for want of confirmation while the first import runs", () => {
  it("the store's page lists its sender, and the client over that page keeps it at the gate", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const own = `me-${accountId.slice(0, 8)}@ohmail.test`;
    await db.insert(accounts).values({ id: accountId, name: `ki-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: own, organizerRole: "organizer", initialImportCompletedAt: null,
    }).returning();
    const at = new Date(NOW.getTime() - 60 * 60 * 1000);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `ki:${randomUUID()}`, subject: "Your account is limited", snippet: "",
      fromAddress: OWNED, fromName: null, senderCheck: "none", senderCheckBy: "ingest", authVerdict: "unavailable",
      unconfirmedHold: true, date: at, arrivedAt: at, unread: true, createdAt: at, nativeLocator: { folder: GATE, ref: "1:7" },
    } as never).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(contacts).values({ accountId, address: OWNED, source: "inferred" });
    const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `ki-${randomUUID().slice(0, 8)}` };
    const listed = (await new ScreenerService({}).list(ctx, { limit: 50 })).items.map((i) => i.sender.address);

    const deps = {
      db, now: () => NOW, requestId: ctx.requestId, session: { accountId, userId: null, sessionId: null },
      services: { screener: new ScreenerService({}) },
    } as unknown as ApiDeps;
    const route = screenerRoutesGroup.find((r) => r.method === "GET" && r.pattern === "/screener")!;
    const http = new HttpAdapter({
      baseUrl: "http://world.test", fetch: async (url, init) => route.handler(new Request(String(url), init as RequestInit), deps, {}),
    });
    const creates = [...(await materializeMessages(db as never, accountId, [m!.id])).values()]
      .map((entity, i) => ({ type: "message", op: "create", id: entity.id, seq: i + 1, updatedAt: NOW.toISOString(), entity }));
    let sent = false;
    const adapter = {
      sync: async (): Promise<SyncResponse> => {
        const out = sent ? [] : creates;
        sent = true;
        return {
          changes: { creates: out as unknown as SyncChange[], updates: [], moves: [], deletes: [] },
          cursor: "c", hasMore: false, serverTime: NOW.toISOString(),
        } as unknown as SyncResponse;
      },
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      screenerWaiting: (p?: { cursor?: string; limit?: number }) => http.screenerWaiting(p),
    } as unknown as EngineAdapter;
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
    await engine.start();
    await engine.syncOnce();
    await engine.refreshScreenerWaiting();
    const client = consentPartition(engine.read(), { now: NOW, ownAddresses: [own], firstImportDoneAt: { [mb!.id]: null } });
    expect({ listed, place: client.placeOf.get(m!.id), waiting: client.counts.activeUndecidedSenders })
      .toEqual({ listed: [OWNED], place: GATE, waiting: 1 });
  });
});

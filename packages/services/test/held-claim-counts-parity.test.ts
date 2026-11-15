import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, contacts, folderState, mailboxes, messageBodies, messages, rules } from "@trafficflow/db";
import type { ClassifierPort } from "@trafficflow/core";
import {
  HttpAdapter, MemoryMirrorStore, consentPartition, presentationReader, screenerSegments, screenerWaitingOf,
  type EngineMessage, type RuleDTO, type ScreenerWaitingWire, type SyncChange,
} from "@ohmail/client-engine";
import { ScreenerService } from "../src/screener-service.js";
import { cutlineCounts } from "../src/consent-cutline.js";
import { messageRowToDTO } from "../src/dto/materialize.js";
import { effectiveScreeningWindows } from "../src/screening-window.js";
import type { ServiceContext } from "../src/context.js";
import { screenerAutoSuggestPass } from "../../../apps/worker/src/screener-auto-suggest.js";
import { screenerAutoActPass } from "../../../apps/worker/src/screener-auto-act.js";
import {
  LIVE_LETTERS, NOW as WORLD_NOW, SENDERS, removedMailboxWorld, type RemovedMailboxWorld,
} from "./helpers/removed-mailbox-world.js";

/**
 * THE COUNT BESIDE THE SCREENER COUNTS THE SENDER ITS LIST SHOWS (mail 0147). A decided sender
 * (the act's promoted rule, an inferred contact) whose claim the gate holds is waiting again: the
 * queue lists them, so `GET /consent`'s active-undecided count and the client partition's count
 * them too, on the one `senderHasHeldClaimSql` term. Runs on whichever store the matrix points at.
 * CONTROL: the same decided sender's held mail without the fact is listed nowhere and counted decided.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const SENDER = "kundendienst@karten-service.test";

async function world(claim: boolean, heldAt = new Date("2026-10-01T09:00:00.000Z")) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const own = `me-${accountId.slice(0, 8)}@ohmail.test`;
  await db.insert(accounts).values({ id: accountId, name: `hp-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: own, organizerRole: "organizer" }).returning();
  const put = async (folder: string, check: "impersonation" | "none", at: Date) => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `hp:${randomUUID()}`, subject: "Ihre Karte", snippet: "",
      fromAddress: SENDER, fromName: check === "impersonation" ? "PostFinance" : "Anna Meier",
      senderCheck: check, senderCheckBrand: check === "impersonation" ? "PostFinance" : null,
      date: at, unread: false, createdAt: at, nativeLocator: { folder, ref: `1:${randomUUID().slice(0, 4)}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };
  // The admitted first mail, then the held one, read and arrived inside the screening window: a claim
  // counts only there (mail 0148), and inside it the claim is what makes the decided sender waiting.
  await put("INBOX", "none", new Date("2026-09-30T09:00:00.000Z"));
  await put(GATE, claim ? "impersonation" : "none", heldAt);
  await db.insert(rules).values({ accountId, kind: "sender", match: SENDER, destination: "INBOX", enabled: true, priority: 0, provenance: "promoted" });
  await db.insert(contacts).values({ accountId, address: SENDER, source: "inferred" });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `hp-${randomUUID().slice(0, 8)}` };

  // The client's copy, through the API's own projection (`messageRowToDTO`), as the parity test builds it.
  // Two reads, not a join: the device driver refuses a statement selecting two columns named `id`.
  const rows = await db.select().from(messages).where(eq(messages.accountId, accountId));
  const states = await db.select().from(folderState).where(inArray(folderState.messageId, rows.map((m) => m.id)));
  const stored = rows.map((m) => ({ m, fs: states.find((f) => f.messageId === m.id)! }));
  const storedRules = await db.select().from(rules).where(eq(rules.accountId, accountId));
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([
    ...stored.map(({ m, fs }) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: messageRowToDTO(m as never, fs as never, undefined, undefined) as unknown as EngineMessage,
    })),
    ...storedRules.map((r) => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: {
        id: r.id, kind: r.kind, match: r.match, destination: r.destination, priority: r.priority, provenance: r.provenance,
        enabled: r.enabled, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      } as unknown as RuleDTO,
    })),
  ] as SyncChange[]);
  const client = consentPartition(store, { now: NOW, ownAddresses: [own] });
  return { ctx, client };
}

describe("a held claim from a decided sender, the queue and its counts", () => {
  it("the list shows one sender and both counts read one", async () => {
    const w = await world(true);
    const page = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(page.items.map((i) => i.sender.address)).toEqual([SENDER]);
    expect(page.total).toBe(1);
    expect(await cutlineCounts(w.ctx, {})).toEqual({ decidedSenders: 0, activeUndecidedSenders: 1, dormantUndecidedSenders: 0 });
    expect(w.client.counts.activeUndecidedSenders).toBe(page.items.length);
    expect(w.client.counts.dormantUndecidedSenders).toBe(0);
  });

  it("a claim that arrived before the window is listed nowhere, and both counts call the sender decided", async () => {
    // The merge-back's control for both cutoffs (server count and client partition): the same claim, dated 2021.
    const w = await world(true, new Date("2021-03-01T09:00:00.000Z"));
    const page = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(page.items).toEqual([]);
    expect(await cutlineCounts(w.ctx, {})).toEqual({ decidedSenders: 1, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 });
    expect(w.client.counts.activeUndecidedSenders).toBe(0);
    expect(w.client.counts.dormantUndecidedSenders).toBe(0);
  });

  it("CONTROL: the same held mail without the fact is listed nowhere and counted decided", async () => {
    const w = await world(false);
    const page = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(page.items).toEqual([]);
    expect(await cutlineCounts(w.ctx, {})).toEqual({ decidedSenders: 1, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 });
    expect(w.client.counts.activeUndecidedSenders).toBe(0);
    expect(w.client.counts.dormantUndecidedSenders).toBe(0);
  });
});

/**
 * A REMOVED MAILBOX ASKS NOTHING (`helpers/removed-mailbox-world.ts`). Read with `live`, the page
 * walk, its total, the counts beside it, one mailbox's count, both passes' choices and every live
 * letter's place equal the oracle's: the same account with the removed mailbox's mail deleted. The
 * page reaches the client through the route, the adapter's parse and the engine's own page.
 */
async function readings(w: RemovedMailboxWorld) {
  const http = new HttpAdapter({ baseUrl: "http://world.test", fetch: w.serve() });
  const walk: string[] = [];
  let page: ScreenerWaitingWire | null = await http.screenerWaiting({ limit: 1 });
  const total = page.total;
  while (page !== null) {
    walk.push(...page.items.map((i) => w.nameOf(i.messageId)));
    page = page.nextCursor === null ? null : await http.screenerWaiting({ cursor: page.nextCursor, limit: 1 });
  }
  const counts = await cutlineCounts(w.ctx, { windows: await effectiveScreeningWindows(w.ctx) });
  const inLiveMailbox = (await new ScreenerService({}).waitingCount(w.ctx, w.liveMailbox)).senders;
  const engine = await w.engine();
  const part = consentPartition(engine.read(), { now: WORLD_NOW, ownAddresses: [w.own] });
  const places = Object.fromEntries(LIVE_LETTERS.map((n) => [n, part.placeOf.get(w.idOf(n)) ?? "History"]));
  return { walk, total, counts, inLiveMailbox, places, active: part.counts.activeUndecidedSenders, dormant: part.counts.dormantUndecidedSenders };
}

/** The senders the automatic suggestion pass asks the model about. */
async function suggested(w: RemovedMailboxWorld): Promise<string[]> {
  const asked: string[] = [];
  const classifier = {
    classify: async () => { throw new Error("the ingest question is never asked here"); },
    screen: async (input: { from: { address: string } }) => {
      asked.push(input.from.address);
      return { destination: "INBOX", confidence: 0.95, rationale: "", spam: false };
    },
  } as unknown as ClassifierPort;
  await screenerAutoSuggestPass(w.db as never, { accountId: w.accountId, classifier, unmetered: true, now: () => WORLD_NOW, batch: 50 });
  return asked.sort();
}

/** The senders the act on suggestions lets in, each with confident advice on a letter of theirs. */
async function acted(w: RemovedMailboxWorld): Promise<string[]> {
  for (const n of ["A.held", "B.live", "C.held", "D.live", "I.held"]) if (w.holds(n)) await w.advise(n);
  await screenerAutoActPass(w.db as never, { accountId: w.accountId, consent: { stillGiven: async () => true }, now: () => WORLD_NOW });
  const promoted = await w.db.select({ match: rules.match }).from(rules)
    .where(and(eq(rules.accountId, w.accountId), eq(rules.provenance, "promoted")));
  return promoted.map((r) => r.match).filter((m) => m !== SENDERS.E).sort();
}

describe("a mailbox removed with its copy kept asks nothing", () => {
  it("the page walk, its total, the counts and the mailbox's count are the oracle's", async () => {
    const removed = await readings(await removedMailboxWorld("removed"));
    const oracle = await readings(await removedMailboxWorld("deleted"));
    // The oracle itself, so the comparison is about something: two strangers wait, D is dormant.
    expect(oracle.walk).toEqual(["I.held", "B.live"]);
    expect(oracle.counts).toEqual({ decidedSenders: 3, activeUndecidedSenders: 2, dormantUndecidedSenders: 1 });
    expect(removed.walk, "a removed mailbox's sender, or its letter as B's representative").toEqual(oracle.walk);
    expect(removed.total).toBe(oracle.total);
    expect(removed.counts, "the counts beside the queue").toEqual(oracle.counts);
    expect(removed.inLiveMailbox, "the live mailbox's count").toBe(oracle.inLiveMailbox);
    expect(removed.places, "a live letter's place").toEqual(oracle.places);
    expect([removed.active, removed.dormant], "the client's active and dormant counts").toEqual([oracle.active, oracle.dormant]);
  });

  it("both passes choose the oracle's senders: no advice bought and no rule written for one no surface shows", async () => {
    expect(await suggested(await removedMailboxWorld("removed"))).toEqual(await suggested(await removedMailboxWorld("deleted")));
    const oracle = await acted(await removedMailboxWorld("deleted"));
    expect(oracle).toEqual([SENDERS.B, SENDERS.I].sort());
    expect(await acted(await removedMailboxWorld("removed"))).toEqual(oracle);
  });

  it("its own letters: a rule's screen-out keeps the shelf, an admitted sender's INBOX letter the Ohbox, the rest is History", async () => {
    const w = await removedMailboxWorld("removed");
    const engine = await w.engine();
    const part = consentPartition(engine.read(), { now: WORLD_NOW, ownAddresses: [w.own] });
    const second = ["A.held", "B.second", "C.held", "C.inbox", "D.second", "E.claim", "F.inbox", "F.held", "G.held", "H.second"];
    expect(Object.fromEntries(second.map((n) => [n, part.placeOf.get(w.idOf(n)) ?? "History"]))).toEqual({
      "A.held": "History", "B.second": "History", "C.held": "History", "C.inbox": "History", "D.second": "History",
      // A held claim is no reason to wait; a thread the person wrote on never lets a held stranger in.
      "E.claim": "History", "F.inbox": "INBOX", "F.held": "History", "G.held": "ohmail/Screened", "H.second": "History",
    });
    const segments = screenerSegments(presentationReader(engine.read(), part), WORLD_NOW);
    expect(segments.waiting.map((s) => s.from.address).sort()).toEqual([SENDERS.B, SENDERS.I].sort());
    expect(segments.waitingTotal).toBe(2);
  });

  it("a removal between the stored page and a walk past it: the page is asked again, and the removed mailbox's strangers are History", async () => {
    const w = await removedMailboxWorld("stood-down");
    const engine = await w.engine({ pageLimit: 2 });
    await w.walkPastARemoval(engine);
    const part = consentPartition(engine.read(), { now: WORLD_NOW, ownAddresses: [w.own] });
    for (const name of ["A.held", "C.held", "C.inbox"]) expect(part.placeOf.get(w.idOf(name)) ?? "History", name).toBe("History");
    // The walk's page left the removed mailbox out; a page still saying nothing is gone reads that silence as let in.
    expect(screenerWaitingOf(engine.read())!.page.gone).toEqual([w.secondMailbox]);
  });

  it("CONTROL: erased counts as removed; a stood-down mailbox still asks", async () => {
    const erased = await readings(await removedMailboxWorld("erased"));
    expect(erased.walk).toEqual(["I.held", "B.live"]);
    const stood = await removedMailboxWorld("stood-down");
    const page = await new HttpAdapter({ baseUrl: "http://world.test", fetch: stood.serve() }).screenerWaiting({ limit: 50 });
    expect(page.items.map((i) => stood.nameOf(i.messageId)).sort()).toEqual(["A.held", "B.second", "C.held", "D.live", "E.claim", "I.held"]);
    expect(page.gone).toEqual([]);
  });

  it("CONTROL: asked without `live` the page lists the removed mailbox's senders, and a page without `gone` is today's partition", async () => {
    const w = await removedMailboxWorld("removed");
    const plain = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(plain.items.map((i) => w.nameOf(i.messageId))).toContain("A.held");
    expect(plain.gone).toBeUndefined();
    const older = await w.engine({ older: true });
    const part = consentPartition(older.read(), { now: WORLD_NOW, ownAddresses: [w.own] });
    expect(part.placeOf.get(w.idOf("A.held")), "an older server's page: the stranger waits, as before").toBe("ohmail/Screener");
    const live = consentPartition((await w.engine()).read(), { now: WORLD_NOW, ownAddresses: [w.own] });
    expect(live.placeOf.get(w.idOf("A.held")) ?? "History").toBe("History");
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, contacts, folderState, mailboxes, messageBodies, messageInstances, messages, routingDecisions, rules, threads,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS,
} from "@trafficflow/db";
import { screenerRoutesGroup, type ApiDeps } from "@trafficflow/api";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, screenerWaitingOf,
  type EngineAdapter, type FetchLike, type SyncChange, type SyncResponse,
} from "@ohmail/client-engine";
import { ScreenerService } from "../../src/screener-service.js";
import { materializeMessages, materializeRules } from "../../src/dto/materialize.js";
import type { ServiceContext } from "../../src/context.js";

/**
 * A REMOVED MAILBOX ASKS NOTHING — one world for every door that reads the Screener: the services'
 * own reads and the two passes, the phone, the desktop, the web and the paired desktop. The account
 * holds a live mailbox and a second one, which is removed with the copy kept, erased, stood down, or
 * (the oracle) removed with its mail deleted. The second mailbox's senders and letters:
 *
 *   A  stranger, held only there .................................. absent everywhere
 *   B  stranger, held there (newer) and here (older) ............... waits, on the live letter
 *   C  stranger, held and in the INBOX, both there ................. both in History
 *   D  stranger, an old read held letter here, a recent unread INBOX letter there .. dormant
 *   E  decided (the act's rule, an inferred contact), held here, a claim there ..... decided
 *   F  allow rule, an INBOX letter and a held letter there ......... the Ohbox; History
 *      (and an INBOX letter here, on a thread with A's held letter and the person's own to A)
 *   G  deny rule, a held letter there .............................. the screened-out shelf
 *   H  contact only, an INBOX letter there and one here ............ History; the Ohbox
 *   I  stranger, held here ......................................... waits
 *
 * Every letter is dated, arrived and recorded at one instant, and no mailbox has finished a first
 * import, so the window alone decides who is active, on the server and on the client alike.
 */

export const NOW = new Date("2026-10-20T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const GATE = "ohmail/Screener";

/** How the second mailbox stands. `deleted` is the oracle: removed, and its mail gone with it. */
export type SecondMailbox = "removed" | "erased" | "stood-down" | "deleted";

export const SENDERS = {
  A: "anna@first.test", B: "bruno@both.test", C: "cora@first.test", D: "dario@quiet.test",
  E: "kundendienst@karten-service.test", F: "fritz@allowed.test", G: "gina@denied.test",
  H: "hanna@contact.test", I: "ivo@live.test",
} as const;
export type Who = keyof typeof SENDERS;

interface Letter {
  name: string; who: Who | "own"; second: boolean; folder: "INBOX" | "Sent" | typeof GATE; daysAgo: number; unread: boolean;
  claim?: true;
  /** On the one thread: the person wrote to A on it, and F's live letter anchors it. */
  thread?: true;
}

export const LETTERS: readonly Letter[] = [
  { name: "A.held", who: "A", second: true, folder: GATE, daysAgo: 2, unread: true, thread: true },
  { name: "B.second", who: "B", second: true, folder: GATE, daysAgo: 1, unread: true },
  { name: "B.live", who: "B", second: false, folder: GATE, daysAgo: 3, unread: true },
  { name: "C.held", who: "C", second: true, folder: GATE, daysAgo: 2, unread: true },
  { name: "C.inbox", who: "C", second: true, folder: "INBOX", daysAgo: 2, unread: true },
  { name: "D.live", who: "D", second: false, folder: GATE, daysAgo: 400, unread: false },
  { name: "D.second", who: "D", second: true, folder: "INBOX", daysAgo: 1, unread: true },
  { name: "E.live", who: "E", second: false, folder: GATE, daysAgo: 2, unread: true },
  { name: "E.claim", who: "E", second: true, folder: GATE, daysAgo: 1, unread: true, claim: true },
  { name: "F.inbox", who: "F", second: true, folder: "INBOX", daysAgo: 2, unread: true },
  { name: "F.held", who: "F", second: true, folder: GATE, daysAgo: 2, unread: true },
  { name: "F.live", who: "F", second: false, folder: "INBOX", daysAgo: 1, unread: false, thread: true },
  { name: "own.sent", who: "own", second: false, folder: "Sent", daysAgo: 3, unread: false, thread: true },
  { name: "G.held", who: "G", second: true, folder: GATE, daysAgo: 2, unread: true },
  { name: "H.second", who: "H", second: true, folder: "INBOX", daysAgo: 2, unread: true },
  { name: "H.live", who: "H", second: false, folder: "INBOX", daysAgo: 2, unread: true },
  { name: "I.held", who: "I", second: false, folder: GATE, daysAgo: 2, unread: true },
];

/** The letters the live mailbox holds, by name: the ones whose place every world must agree on. */
export const LIVE_LETTERS = LETTERS.filter((l) => !l.second).map((l) => l.name);

export interface RemovedMailboxWorld {
  db: Awaited<ReturnType<typeof makeTestDb>>;
  accountId: string;
  own: string;
  ctx: ServiceContext;
  liveMailbox: string;
  secondMailbox: string;
  /** The letter's name for a message id, `?` for one this world did not write. */
  nameOf(messageId: string): string;
  /** The message id of a letter this world wrote, by name. */
  idOf(name: string): string;
  /** The account's messages and rules as `/sync` carries them. */
  changes(): Promise<SyncChange[]>;
  /** `GET /screener` through the real route; `older` answers as a server that ignores `live`, `pageLimit` cuts its pages. */
  serve(older?: boolean, pageLimit?: number): FetchLike;
  /** A client engine over this world's copy, the store's queue read through the route once. */
  engine(o?: {
    older?: boolean; pageLimit?: number; storePolicy?: ConstructorParameters<typeof OhmailEngine>[0]["storePolicy"];
  }): Promise<OhmailEngine>;
  /** The second mailbox, stood down, is removed now with its copy kept. */
  removeSecond(): Promise<void>;
  /**
   * A REMOVAL BETWEEN THE STORED PAGE AND A WALK PAST IT: {@link removeSecond} after a stored page
   * that left nothing out, then the engine reads the page after it. The engine must have been made
   * with a `pageLimit` the queue outgrows.
   */
  walkPastARemoval(engine: OhmailEngine): Promise<void>;
  /** Does this world hold that letter? The oracle holds none of the second mailbox's. */
  holds(name: string): boolean;
  /** Confident advice to screen the sender out, stored about one of their letters, each confirmed by its provider. */
  advise(name: string): Promise<void>;
}

export async function removedMailboxWorld(second: SecondMailbox): Promise<RemovedMailboxWorld> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const own = `me-${accountId.slice(0, 8)}@ohmail.test`;
  await db.insert(accounts).values({ id: accountId, name: `rm-${accountId.slice(0, 8)}`, aiEnabled: true });
  // Opted in to automatic suggestions before any of the letters arrived, except D's old one.
  await db.insert(accountSettings).values({ accountId, autoSuggestAt: new Date(NOW.getTime() - 30 * DAY) });
  const [live] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: own, organizerRole: "organizer", status: "connected",
  }).returning();
  const [old] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `old-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
    ...(second === "erased" ? { status: "connected", erasureDoneAt: new Date(NOW.getTime() - DAY) }
      : second === "stood-down" ? { status: "disabled", disabledReason: "organized_elsewhere:local" }
        : { status: "disabled", disabledReason: null }),
  }).returning();

  const byName = new Map<string, string>();
  const byId = new Map<string, string>();
  const [thread] = await db.insert(threads).values({ accountId, subject: "The thread" }).returning();
  let uid = 0;
  for (const l of LETTERS) {
    if (l.second && second === "deleted") continue;
    const at = new Date(NOW.getTime() - l.daysAgo * DAY);
    const mailboxId = l.second ? old!.id : live!.id;
    uid++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: randomUUID(), dedupKey: `rm:${randomUUID()}`,
      subject: `About ${l.name}`, snippet: "", fromAddress: l.who === "own" ? own : SENDERS[l.who],
      ...(l.who === "own" ? { toAddresses: [{ name: null, address: SENDERS.A }] } : {}),
      ...(l.thread ? { threadId: thread!.id } : {}),
      fromName: l.claim ? "PostFinance" : null, senderCheck: l.claim ? "impersonation" : "none",
      senderCheckBrand: l.claim ? "PostFinance" : null, date: at, arrivedAt: at, createdAt: at, unread: l.unread,
      nativeLocator: { folder: l.folder, ref: `1:${uid}` },
    }).returning();
    // Its copy on the server, as the ingest records one: the removal, not a missing copy, is what is asked.
    await db.insert(messageInstances).values({
      accountId, mailboxId, messageId: m!.id, folder: l.folder, uidvalidity: 1n, uid, isPrimary: true,
    });
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: l.folder, observedFolder: l.folder, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    byName.set(l.name, m!.id);
    byId.set(m!.id, l.name);
  }
  // E: the act let them in, so an inferred contact and a promoted rule — inference, which a claim outranks.
  await db.insert(rules).values({ accountId, kind: "sender", match: SENDERS.E, destination: "INBOX", enabled: true, priority: 0, provenance: "promoted" });
  await db.insert(contacts).values({ accountId, address: SENDERS.E, source: "inferred" });
  await db.insert(rules).values({ accountId, kind: "sender", match: SENDERS.F, destination: "INBOX", enabled: true, priority: 0, provenance: "manual" });
  await db.insert(rules).values({ accountId, kind: "sender", match: SENDERS.G, destination: "ohmail/Screened", enabled: true, priority: 0, provenance: "manual" });
  await db.insert(contacts).values({ accountId, address: SENDERS.H, source: "person" });

  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `rm-${accountId.slice(0, 8)}` };
  const deps = {
    db, now: () => NOW, requestId: ctx.requestId,
    session: { accountId, userId: null, sessionId: null },
    services: { screener: new ScreenerService({}) },
  } as unknown as ApiDeps;
  const route = screenerRoutesGroup.find((r) => r.method === "GET" && r.pattern === "/screener")!;

  const w: RemovedMailboxWorld = {
    db, accountId, own, ctx, liveMailbox: live!.id, secondMailbox: old!.id,
    nameOf: (id) => byId.get(id) ?? "?",
    idOf: (name) => {
      const id = byName.get(name);
      if (id === undefined) throw new Error(`this world wrote no letter ${name}`);
      return id;
    },
    async changes() {
      const ids = [...byName.values()];
      const dtos = await materializeMessages(db as never, accountId, ids);
      const ruleRows = await db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, accountId));
      const ruleDtos = await materializeRules(db as never, accountId, ruleRows.map((r) => r.id));
      let seq = 0;
      const stamp = NOW.toISOString();
      return [
        ...[...dtos.values()].map((entity) => ({ type: "message", op: "create", id: entity.id, seq: ++seq, updatedAt: stamp, entity })),
        ...[...ruleDtos.values()].map((entity) => ({ type: "rule", op: "create", id: entity.id, seq: ++seq, updatedAt: stamp, entity })),
      ] as unknown as SyncChange[];
    },
    serve(older = false, pageLimit) {
      return async (url, init) => {
        const u = new URL(String(url));
        if (older) u.searchParams.delete("live");
        if (pageLimit !== undefined) u.searchParams.set("limit", String(pageLimit));
        return route.handler(new Request(u, init as RequestInit), deps, {});
      };
    },
    async engine(o = {}) {
      const all = await w.changes();
      let sent = false;
      const http = new HttpAdapter({ baseUrl: "http://world.test", fetch: w.serve(o.older === true, o.pageLimit) });
      const adapter = {
        sync: async (): Promise<SyncResponse> => {
          const creates = sent ? [] : all;
          sent = true;
          return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: NOW.toISOString() };
        },
        mutate: async () => ({ changes: [], seq: null }),
        fetchBody: async () => null,
        screenerWaiting: (page?: { cursor?: string; limit?: number }) => http.screenerWaiting(page),
      } as unknown as EngineAdapter;
      const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: o.storePolicy ?? { mode: "full" } });
      await engine.start();
      await engine.syncOnce();
      await engine.refreshScreenerWaiting();
      return engine;
    },
    async removeSecond() {
      await db.update(mailboxes).set({ disabledReason: null }).where(eq(mailboxes.id, old!.id));
    },
    async walkPastARemoval(engine) {
      const first = screenerWaitingOf(engine.read());
      if (!first || first.page.nextCursor === null || (first.page.gone ?? []).length > 0) {
        throw new Error("the stored page must leave nothing out and go on past itself");
      }
      await w.removeSecond();
      await engine.screenerWaitingPage(first.page.nextCursor);
    },
    holds: (name) => byName.has(name),
    async advise(name) {
      // The act's deny path: a screen-out on letters their provider confirmed stands as the sender's rule.
      await db.update(messages).set({ authVerdict: "pass" }).where(eq(messages.fromAddress, SENDERS[name.split(".")[0] as Who]));
      await db.insert(routingDecisions).values({
        accountId, messageId: w.idOf(name), inputProvenance: SCREENER_SUGGESTION_PROVENANCE, destination: "ohmail/Screened",
        confidence: 0.95, rationale: "", spam: false, status: SCREENER_SUGGESTION_STATUS, senderReason: "none",
      } as never);
    },
  };
  return w;
}

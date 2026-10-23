import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drafts, mailboxes, messages, outboundSends, threadNotes, threads } from "@trafficflow/db";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  HttpAdapter, OhmailEngine, consentPartition, presentationReader, screenerSegments,
  type EngineMessage, type StorePolicy,
} from "@ohmail/client-engine";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * REMOVING ONE MAILBOX LEAVES THE OTHER'S SCREENER WHERE IT STOOD BEFORE THE ADD.
 * The window holds the newest rows of every mailbox, so the second mailbox's newer mail displaced
 * the first's oldest waiting senders; the removal took that mail and nothing brought them back.
 * Real path: the local door's removal route and the window's own engine over the bridge, with a
 * window of four rows. Mutation: drop `refillWindow()` from the drain's settle and the kept
 * mailbox's two oldest senders stay out of its Screener after the removal; delete every send
 * record in the walk and the third case reds on the kept mailbox's.
 */

class MemoryMeta implements LeaseIo {
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
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
}

interface Mail { uid: number; from: string; date: string }
interface World { user: string; host: string; meta: MemoryMeta; deliver: Mail[]; handed: boolean }
const world = (user: string, host: string, deliver: Mail[]): World =>
  ({ user, host, meta: new MemoryMeta(), deliver, handed: false });

function raw(m: Mail, to: string): Buffer {
  return Buffer.from([
    `Message-ID: <m-${m.uid}-${to}@removal.test>`, `From: ${m.from}`, `To: ${to}`,
    `Subject: mail ${m.uid}`, `Date: ${m.date}`, "Content-Type: text/plain; charset=utf-8", "", "hello",
  ].join("\r\n"), "utf8");
}

/** Each mailbox dialled as ITSELF; an unknown login throws rather than answering as the other. */
function dispatcher(worlds: World[]) {
  return (cfg: ImapConfig): MailboxAdapter & {
    leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo; messageInSent(id: string): Promise<boolean>;
  } => {
    const w = worlds.find((x) => x.user === cfg.auth.user);
    if (!w) throw new Error("this engine dialled a mailbox that is not in this test");
    const empty = { folders: {} };
    return {
      leaseIo: () => w.meta,
      leasePeekIo: () => ({ listClaims: () => w.meta.listClaims() }),
      async connect() {},
      async close() {},
      async capabilities(): Promise<ImapCapabilities> {
        return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders() {},
      async changesSince(): Promise<ChangeBatch> {
        if (w.handed) return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: empty };
        w.handed = true;
        return {
          creates: w.deliver.map((m) => ({
            type: "create" as const,
            locator: { folder: "INBOX", ref: `1:${m.uid}` } as NativeLocator,
            raw: raw(m, w.user),
          })) as ChangeBatch["creates"],
          moves: [], flagChanges: [], deletes: [], newCursor: empty,
        };
      },
      async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "7:41" }; },
      async setFlags() {},
      async scanSentRecipients() { return []; },
      async watch() { return async () => {}; },
      async send(): Promise<never> { throw new Error("no send in this rig"); },
      async messageInSent() { return false; },
      async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    } as never;
  };
}

const HOUR = 3_600_000;
const KEPT = "kept@example.test";
const GONE = "gone@example.test";
const SHARED = "shared@elsewhere.test";
/** Floor and ceiling of four rows: two newer rows of the added mailbox displace two of the kept one. */
const WINDOW: StorePolicy = { mode: "windowed", days: 1, minRows: 4, maxRows: 4 };

describe("removing a mailbox from this computer", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(worlds: World[]): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-removal-");
    const seed = worlds[0]!;
    const s = await createSidecar({
      dataDir,
      imap: {
        host: seed.host, port: 993, secure: true, auth: { user: seed.user, pass: "not-dialled-password-password" },
        smtp: { host: "smtp-a.invalid", port: 587, secure: false },
      },
      address: seed.user, machineName: "this machine", pollIntervalMs: 60 * HOUR, leaseStaleAfterMs: 60_000,
      keks: { 1: Buffer.alloc(32, 7) }, adapterFactory: dispatcher(worlds), log: () => {},
    });
    cleanups.push(async () => {
      await s.stop().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    });
    await s.start();
    return s;
  }
  const auth = (s: Sidecar): HeadersInit =>
    ({ authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" });
  const add = (s: Sidecar): Promise<Response> => s.handle(new Request("http://local/local/mailboxes", {
    method: "POST", headers: auth(s),
    body: JSON.stringify({
      provider: "imap", address: GONE,
      imap: { host: "imap-b.invalid", port: 993, secure: true, user: GONE, pass: "second-password" },
      smtp: { host: "smtp-b.invalid", port: 587, secure: false },
    }),
  }));
  const remove = (s: Sidecar, id: string): Promise<Response> =>
    s.handle(new Request(`http://local/local/mailboxes/${id}`, { method: "DELETE", headers: auth(s) }));
  const agree = (s: Sidecar, id: string): Promise<Response> =>
    s.handle(new Request(`http://local/local/mailboxes/${id}/organize`, {
      method: "POST", headers: auth(s), body: JSON.stringify({ screening: { dormancyDays: 365 } }),
    }));

  /** The window's own client, composed as `createLocalEngine()` composes it, over the bridge. */
  function windowEngine(s: Sidecar): OhmailEngine {
    return new OhmailEngine({
      adapter: new HttpAdapter({
        baseUrl: "http://sidecar",
        fetch: ((input: string | URL | Request, init?: RequestInit) => {
          const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          return s.handle(new Request(new URL(href, "http://sidecar"), init));
        }) as unknown as typeof fetch,
        headers: () => ({ authorization: `Bearer ${s.sessionToken}` }),
      }),
      storePolicy: WINDOW,
    });
  }
  /** The Screener's waiting senders, read the way the shell reads them: projected, then grouped. */
  const waiting = (e: OhmailEngine): string[] => {
    const r = e.read();
    const own = [KEPT, GONE];
    // Live mail, delivered moments ago: the instant of the read is the fixtures' clock, read once.
    const at = new Date();
    const presented = presentationReader(r, consentPartition(r, { now: at, dormancyDays: 365, ownAddresses: own }));
    return screenerSegments(presented, at, "en", "UTC", own).waiting.map((x) => x.from.address).sort();
  };

  it("keeps the other mailbox's waiting senders, the shared one included, at the count before the add", async () => {
    const kept = world(KEPT, "imap-a.invalid", [
      { uid: 11, from: "a1@elsewhere.test", date: "Mon, 01 Jun 2026 10:00:00 +0000" },
      { uid: 12, from: "a2@elsewhere.test", date: "Tue, 02 Jun 2026 10:00:00 +0000" },
      { uid: 13, from: "a3@elsewhere.test", date: "Wed, 03 Jun 2026 10:00:00 +0000" },
      { uid: 14, from: SHARED, date: "Thu, 04 Jun 2026 10:00:00 +0000" },
    ]);
    const gone = world(GONE, "imap-b.invalid", [
      { uid: 21, from: SHARED, date: "Mon, 21 Sep 2026 10:00:00 +0000" },
      { uid: 22, from: "b1@elsewhere.test", date: "Tue, 22 Sep 2026 10:00:00 +0000" },
    ]);
    const s = await boot([kept, gone]);
    await agree(s, s.world.mailboxId);
    await s.syncUntilQuiet();
    const engine = windowEngine(s);
    await engine.start();
    const before = waiting(engine);
    expect(before).toEqual(["a1@elsewhere.test", "a2@elsewhere.test", "a3@elsewhere.test", SHARED]);

    const dto = (await (await add(s)).json()) as { id: string };
    await agree(s, dto.id);
    await s.syncUntilQuiet();
    await engine.syncOnce();
    /* The shape the finding had: the added mailbox's newer mail displaced the kept one's oldest. */
    expect(waiting(engine), "the precondition: the window was displaced").not.toContain("a1@elsewhere.test");
    expect(waiting(engine)).toContain("b1@elsewhere.test");

    expect((await remove(s, dto.id)).status).toBe(200);
    await engine.syncOnce();

    const after = waiting(engine);
    expect(after, "the kept mailbox's Screener is not where it was before the add").toEqual(before);
    expect(after, "the shared sender left the kept mailbox's Screener").toContain(SHARED);
    expect(after, "the removed mailbox's own sender still waits").not.toContain("b1@elsewhere.test");
    const rows = engine.read().list<EngineMessage>("message");
    expect(rows.filter((m) => m.mailboxId === dto.id), "the removed mailbox's mail is still on screen").toEqual([]);
    expect(rows.filter((m) => m.mailboxId === s.world.mailboxId).length, "the window was not refilled").toBe(4);
  });

  it("…and a removal with nothing displaced asks for nothing it does not need", async () => {
    const kept = world(KEPT, "imap-a.invalid", [{ uid: 11, from: SHARED, date: "Mon, 21 Sep 2026 10:00:00 +0000" }]);
    const gone = world(GONE, "imap-b.invalid", [
      { uid: 21, from: SHARED, date: "Tue, 22 Sep 2026 10:00:00 +0000" },
      { uid: 22, from: "b1@elsewhere.test", date: "Tue, 22 Sep 2026 11:00:00 +0000" },
    ]);
    const s = await boot([kept, gone]);
    await agree(s, s.world.mailboxId);
    await s.syncUntilQuiet();
    const engine = windowEngine(s);
    await engine.start();
    const dto = (await (await add(s)).json()) as { id: string };
    await agree(s, dto.id);
    await s.syncUntilQuiet();
    await engine.syncOnce();
    expect(waiting(engine)).toEqual(["b1@elsewhere.test", SHARED]);

    expect((await remove(s, dto.id)).status).toBe(200);
    await engine.syncOnce();
    /* One sender waiting in both: the removal takes the removed mailbox's copy and keeps the sender. */
    expect(waiting(engine)).toEqual([SHARED]);
    expect(engine.read().list<EngineMessage>("message").map((m) => m.mailboxId)).toEqual([s.world.mailboxId]);
  });

  it("keeps what the other mailbox still holds — its reply's words, a shared conversation and its note, its send", async () => {
    /* The census's SHARED writes on this door (`erasure-coverage-census.test.ts` names this case). */
    const kept = world(KEPT, "imap-a.invalid", [{ uid: 11, from: SHARED, date: "Mon, 21 Sep 2026 10:00:00 +0000" }]);
    const gone = world(GONE, "imap-b.invalid", [
      { uid: 21, from: SHARED, date: "Tue, 22 Sep 2026 10:00:00 +0000" },
      { uid: 22, from: "b1@elsewhere.test", date: "Tue, 22 Sep 2026 11:00:00 +0000" },
    ]);
    const s = await boot([kept, gone]);
    const dto = (await (await add(s)).json()) as { id: string };
    await agree(s, s.world.mailboxId);
    await agree(s, dto.id);
    await s.syncUntilQuiet();
    const [keptMsg] = await s.db.select().from(messages).where(eq(messages.mailboxId, s.world.mailboxId));
    const [goneOwn, goneShared] = await s.db.select().from(messages).where(eq(messages.mailboxId, dto.id));
    const accountId = s.world.accountId;
    const [shared] = await s.db.insert(threads).values({ accountId }).returning();
    for (const id of [keptMsg!.id, goneShared!.id]) {
      await s.db.update(messages).set({ threadId: shared!.id }).where(eq(messages.id, id));
    }
    const own = goneOwn!.threadId!;
    await s.db.insert(threadNotes).values([
      { accountId, threadId: shared!.id, body: "both mailboxes" }, { accountId, threadId: own, body: "gone alone" },
    ]);
    const [reply] = await s.db.insert(drafts).values({
      accountId, mailboxId: s.world.mailboxId, threadId: own, inReplyToMessageId: goneOwn!.id,
      subject: "Re: from the other mailbox",
    }).returning();
    /* The removed mailbox's own unsent draft stays with its send; its SENT one goes. */
    const [goneDraft] = await s.db.insert(drafts).values({ accountId, mailboxId: dto.id, subject: "gone's own" }).returning();
    const [sentDraft] = await s.db.insert(drafts).values({
      accountId, mailboxId: dto.id, subject: "gone's sent", status: "sent",
    }).returning();
    const [keptSend] = await s.db.insert(outboundSends).values({
      accountId, draftId: reply!.id, idempotencyKey: randomUUID(), mintedMessageId: "<k@y>",
    }).returning();
    const [unsentSend] = await s.db.insert(outboundSends).values({
      accountId, draftId: goneDraft!.id, idempotencyKey: randomUUID(), mintedMessageId: "<g@y>",
    }).returning();
    const [goneSend] = await s.db.insert(outboundSends).values({
      accountId, draftId: sentDraft!.id, idempotencyKey: randomUUID(), mintedMessageId: "<h@y>", status: "sent",
    }).returning();

    expect((await remove(s, dto.id)).status).toBe(200);

    const [words] = await s.db.select().from(drafts).where(eq(drafts.id, reply!.id));
    expect(words?.subject, "a reply drafted in the other mailbox was deleted").toBe("Re: from the other mailbox");
    expect(words?.inReplyToMessageId, "the reply still points at a removed message").toBeNull();
    expect(words?.threadId, "the reply still points at a conversation that is gone").toBeNull();
    expect((await s.db.select().from(drafts).where(eq(drafts.id, goneDraft!.id))).length,
      "the removed mailbox's unsent draft was deleted").toBe(1);
    expect((await s.db.select().from(drafts).where(eq(drafts.id, sentDraft!.id))).length).toBe(0);
    const sends = (await s.db.select({ id: outboundSends.id }).from(outboundSends)).map((r) => r.id);
    expect(sends, "the other mailbox's send record was taken").toContain(keptSend!.id);
    expect(sends, "a kept draft's send record was taken").toContain(unsentSend!.id);
    expect(sends, "the removed mailbox's sent draft's send record stayed").not.toContain(goneSend!.id);
    const threadIds = (await s.db.select({ id: threads.id }).from(threads)).map((r) => r.id);
    expect(threadIds).toContain(shared!.id);
    expect(threadIds).not.toContain(own);
    const notes = await s.db.select({ threadId: threadNotes.threadId }).from(threadNotes);
    expect(notes.map((n) => n.threadId)).toEqual([shared!.id]);
    const [survivor] = await s.db.select().from(messages).where(eq(messages.id, keptMsg!.id));
    expect(survivor?.threadId, "the other mailbox's message lost its conversation").toBe(shared!.id);
    const [row] = await s.db.select().from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId));
    expect(row?.status, "the other mailbox's own row was written").not.toBe("disabled");
  });
});

import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { accountSettings, folderState, mailboxProfileMirror, mailboxes, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A READER SCREENS BY THE ORGANIZER'S WINDOW (RULING-026). A phone reading a mailbox
 * the desktop organizes said a waiting count the Screener folder did not hold: the local door's
 * `GET /screener` applied this install's own window — the default, or the one its held press
 * recorded. Now the door applies the window the organizer published in its settings document, and
 * with none read (`unread`) or none stated (`unstated`) it lists the gate whole. Through the door's
 * own composition: the resolver is the services queue's, so no flag at the door decides it.
 */

const NOW = new Date("2026-10-12T01:00:00.000Z");
const GATE = "ohmail/Screener";
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);

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

/** Every settings-document read the door makes: a request must make none (the "Organize-in-place" invariant). */
const profileReads = { n: 0 };

function quietMailbox(): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  return () => ({
    leaseIo: () => meta,
    profileIo: () => { profileReads.n += 1; throw new Error("a request dialled the settings document"); },
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY_BATCH }; },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function reader(): Promise<Sidecar> {
  const dataDir = await freshDataDir("ohmail-reader-queue-");
  const s = await createSidecar({
    dataDir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "reader@ohmail.test", pass: "mailbox-unreached-password" } },
    address: "reader@ohmail.test",
    machineName: "a phone reading the desktop's mailbox",
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    adapterFactory: quietMailbox(),
    now: () => NOW,
    log: () => {},
  });
  cleanups.push(async () => {
    await s.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await s.start();
  return s;
}

/** One letter at the gate, filed and reconciled, as an organizer elsewhere left it. */
async function held(s: Sidecar, n: number, from: string, at: Date, unread: boolean): Promise<void> {
  const dedup = `mid:${n}@reader-queue.test`;
  const [m] = await s.db.insert(messages).values({
    accountId: s.world.accountId, mailboxId: s.world.mailboxId, messageIdHeader: dedup,
    bodyHash: `hash-${n}`, dedupKey: dedup, subject: `letter ${n}`, fromAddress: from, fromName: from.split("@")[0]!,
    snippet: "", date: at, arrivedAt: at, unread, createdAt: at,
    nativeLocator: { folder: GATE, ref: `1:${n}` },
  }).returning();
  await s.db.insert(folderState).values({
    messageId: m!.id, observedFolder: GATE, desiredFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled",
  });
}

/** The tester's shape: 37 senders with recent letters, and one whose two letters are read and old. */
const OLD_SENDER = "only-old-letters@sender.test";
async function thirtyEight(s: Sidecar): Promise<void> {
  let n = 0;
  for (let i = 0; i < 37; i++) await held(s, ++n, `person${i}@sender.test`, daysAgo(1 + (i % 20)), i % 2 === 0);
  await held(s, ++n, OLD_SENDER, daysAgo(96), false);
  await held(s, ++n, OLD_SENDER, daysAgo(150), false);
}

async function queue(s: Sidecar): Promise<{ total: number; senders: string[] }> {
  const res = await s.handle(new Request("http://local/screener?limit=200", {
    headers: { authorization: `Bearer ${s.sessionToken}` },
  }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { sender: { address: string } }[]; total?: number };
  return { total: body.total ?? -1, senders: body.items.map((i) => i.sender.address) };
}

/** This store's own screening answer, as a press recorded it — a held one included. */
async function answered(s: Sidecar): Promise<void> {
  await s.db.insert(accountSettings).values({ accountId: s.world.accountId, screeningBaselineAt: daysAgo(1) })
    .onConflictDoUpdate({ target: accountSettings.accountId, set: { screeningBaselineAt: daysAgo(1) } });
}

/** The organizer's document as this install's reader cycle mirrors it, with or without a window. */
async function mirrored(s: Sidecar, screening?: { baselineAt: string | null; dormancyDays: number; scope: "window" | "all_time" }): Promise<void> {
  await s.db.insert(mailboxProfileMirror).values({
    mailboxId: s.world.mailboxId, accountId: s.world.accountId, uidvalidity: 7n, uid: 1, readAt: NOW,
    doc: {
      v: 2, updatedAt: NOW.toISOString(), producer: { kind: "local", version: "t" },
      screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
      ...(screening === undefined ? {} : { screening }),
    },
  });
}

describe("the local door's queue while this install only reads", () => {
  it("unread: lists and counts every sender the gate holds, with no answer of its own", async () => {
    const s = await reader();
    await thirtyEight(s);
    const q = await queue(s);
    expect(q.senders).toHaveLength(38);
    expect(q.senders).toContain(OLD_SENDER);
    expect(q.total).toBe(38);
  });

  it("and with the answer a held press recorded — the device's shape", async () => {
    const s = await reader();
    await answered(s);
    await thirtyEight(s);
    const q = await queue(s);
    expect(q.senders).toContain(OLD_SENDER);
    expect(q.total).toBe(38);
  });

  it("unstated: an organizer's document with no window lists the gate whole", async () => {
    const s = await reader();
    await answered(s);
    await mirrored(s);
    await thirtyEight(s);
    expect((await queue(s)).total).toBe(38);
  });

  it("organizer: the published 60-day window is the organizer's view — 37, the press's answer inert", async () => {
    const s = await reader();
    await answered(s);
    await mirrored(s, { baselineAt: daysAgo(1).toISOString(), dormancyDays: 60, scope: "window" });
    await thirtyEight(s);
    const q = await queue(s);
    expect(q.senders).not.toContain(OLD_SENDER);
    expect(q.total).toBe(37);
  });

  it("organizer: the dial at 365 on the organizer brings the old sender back", async () => {
    const s = await reader();
    await mirrored(s, { baselineAt: daysAgo(1).toISOString(), dormancyDays: 365, scope: "window" });
    await thirtyEight(s);
    expect((await queue(s)).total).toBe(38);
  });

  it("GET /screener and GET /consent answer from the mirror, never the mailbox", async () => {
    const s = await reader();
    await mirrored(s, { baselineAt: daysAgo(1).toISOString(), dormancyDays: 60, scope: "window" });
    await thirtyEight(s);
    const before = profileReads.n;
    expect((await queue(s)).total).toBe(37);
    const res = await s.handle(new Request("http://local/consent", { headers: { authorization: `Bearer ${s.sessionToken}` } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { screeningByMailbox?: Record<string, { source: string; dormancyDays: number }> };
    expect(body.screeningByMailbox?.[s.world.mailboxId]).toMatchObject({ source: "organizer", dormancyDays: 60 });
    expect(profileReads.n).toBe(before);
  });

  it("CONTROL: an install that organizes keeps its own window, and retires the old read sender", async () => {
    const s = await reader();
    await answered(s);
    await s.db.update(mailboxes).set({ organizerRole: "organizer", organizeConsentedAt: daysAgo(1) });
    await thirtyEight(s);
    const q = await queue(s);
    expect(q.senders).not.toContain(OLD_SENDER);
    expect(q.senders).toHaveLength(37);
    expect(q.total).toBe(37);
  });
});

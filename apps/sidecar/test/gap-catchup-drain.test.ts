import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import type { ProfileIo, RawProfileMessage } from "@trafficflow/core/adapters/organizer-profile";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { folderState, mailboxes, messages, rules } from "@trafficflow/db";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { requestOrganizerTakeover } from "../src/organize-here.js";

/**
 * LETTERS FROM A GAP, ON THE LOCAL ENGINE (review HIGH-1). The window is the gap the
 * reader is looking at now: a look at no live holder opens it, a held look CLOSES it, and a letter
 * first taken in while another install held the mailbox is never in it. A promotion moves nothing:
 * after a quiet drain the engine COUNTS what the person's rules would file, and only the person's
 * File press, through the real route, files that set. Letters arrive through the reader's own intake.
 */

/* The settings folder is a real, empty one: an install that cannot read it withholds the offer. */
class MemoryMetaFolder implements LeaseIo, ProfileIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  private readonly profiles: Array<{ ref: number; raw: string }> = [];
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    return this.profiles.map((p) => ({ ref: p.ref, raw: p.raw, generation: 4_100 }));
  }
  async appendProfile(raw: string): Promise<void> { this.profiles.push({ ref: this.nextUid++, raw }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.profiles.length - 1; i >= 0; i--) if (gone.has(this.profiles[i]!.ref)) this.profiles.splice(i, 1);
  }
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
  async laptopHolds(): Promise<void> {
    await this.appendClaim(formatClaim({
      installId: "the-laptop", kind: "local", displayName: "a laptop", heartbeat: new Date(),
      claimedAt: new Date(), nonce: `laptop-${this.nextUid}`, authorizedAt: null, capabilities: [],
    }));
  }
  clear(): void { this.claims.length = 0; }
}

let uid = 40;
function letter(internalDate: Date, from = "Letters <letters@news.test>"): ChangeBatch["creates"][number] {
  uid += 1;
  const raw = Buffer.from([
    `From: ${from}`, "To: owner@trafficflow.test", `Subject: letter ${uid}`,
    `Message-ID: <gap-${uid}@news.test>`, "Date: Fri, 09 Oct 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8", "", "this week's letter", "",
  ].join("\r\n"));
  return { type: "create", locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator, raw, internalDate, seen: false };
}

function server(
  meta: MemoryMetaFolder, pending: Array<ChangeBatch["creates"][number]>, moves: Array<{ from: string; to: string }>,
  settings = true,
) {
  return (_cfg: ImapConfig): MailboxAdapter & {
    leaseIo(): LeaseIo; leasePeekIo(): { listClaims(): Promise<RawClaimMessage[]> };
  } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    ...(settings ? { profileIo: () => meta } : {}),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      return { creates: pending.splice(0), moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
    },
    async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
      moves.push({ from: locator.folder, to });
      return { ...locator, folder: to };
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("no send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart"); },
  });
}

describe("letters from a gap are counted for the person and filed only on their press", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(
    meta: MemoryMetaFolder, pending: Array<ChangeBatch["creates"][number]>, moves: Array<{ from: string; to: string }>,
    settings = true,
  ): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-gap-offer-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const s = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "the phone", pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000, adapterFactory: server(meta, pending, moves, settings), log: () => {},
    });
    cleanups.push(() => s.stop().catch(() => undefined));
    await grantOrganizeConsent(s);
    await s.start();
    await s.syncUntilQuiet();
    return s;
  }
  /* The window alone first, so a case reads the same column at a tree that predates the offer. */
  const sinceOf = async (s: Sidecar) =>
    (await s.db.select({ g: mailboxes.gapSince }).from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId)))[0]!.g;
  const rowOf = async (s: Sidecar) => (await s.db.select({
    since: mailboxes.gapSince, letters: mailboxes.gapLetters, pressed: mailboxes.gapPressedAt,
  }).from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId)))[0]!;
  const strangersOf = async (s: Sidecar) => (await s.db.select({
    letters: mailboxes.gapLetters, strangers: mailboxes.gapStrangers,
  }).from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId)))[0]!;
  const newsRule = (s: Sidecar, olderThan: Date) => s.db.insert(rules).values({
    accountId: s.world.accountId, kind: "sender", match: "letters@news.test", destination: "ohmail/News",
    provenance: "manual", enabled: true, createdAt: new Date(olderThan.getTime() - 7 * 86_400_000),
    updatedAt: new Date(olderThan.getTime() - 7 * 86_400_000),
  });
  const answer = (s: Sidecar, body: unknown) => s.handle(new Request(`http://local/mailboxes/${s.world.mailboxId}/gap-letters`, {
    method: "POST", headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  async function promote(s: Sidecar): Promise<void> {
    await requestOrganizerTakeover(s.db, { mailboxId: s.world.mailboxId, now: new Date(), intent: "takeover" });
    await s.syncUntilQuiet();
    expect(s.organizerState().organizing, "the press did not promote this install").toBe(true);
    // The licence: a quiet organizing drain, then the next drain's head counts.
    for (let i = 0; i < 4; i++) await s.syncUntilQuiet();
  }

  it("a held look closes the window, and the next look that finds nobody opens a new one", async () => {
    const meta = new MemoryMetaFolder();
    const moves: Array<{ from: string; to: string }> = [];
    await meta.laptopHolds();
    const s = await boot(meta, [], moves);
    expect(s.organizerState().organizing, "premise: a reader beside the laptop").toBe(false);
    expect(await sinceOf(s), "a look at a LIVE holder opened a window").toBeNull();
    meta.clear();
    await s.syncUntilQuiet();
    const noted = await sinceOf(s);
    expect(noted, "premise: the gap was noted").not.toBeNull();
    await s.syncUntilQuiet();
    expect((await sinceOf(s))?.getTime(), "a second look at nobody moved the window").toBe(noted!.getTime());
    await meta.laptopHolds();
    await s.syncUntilQuiet();
    expect(await sinceOf(s), "a held look left the window open").toBeNull();
    meta.clear();
    await s.syncUntilQuiet();
    expect(await sinceOf(s), "the next gap was not noted").not.toBeNull();
  }, 60_000);

  it("REVIEW HIGH-1: a letter first taken in while another install held the mailbox is never offered or moved", async () => {
    const meta = new MemoryMetaFolder();
    const moves: Array<{ from: string; to: string }> = [];
    const pending: Array<ChangeBatch["creates"][number]> = [];
    await meta.laptopHolds();
    const s = await boot(meta, pending, moves);
    meta.clear();
    await s.syncUntilQuiet();
    const noted = await sinceOf(s);
    expect(noted, "premise: the gap was noted").not.toBeNull();
    await meta.laptopHolds();
    await s.syncUntilQuiet();
    await newsRule(s, noted!);
    // WHILE THE LAPTOP HOLDS the reader first takes the letter in, its arrival dated past the first note.
    pending.push(letter(new Date(noted!.getTime() + 60_000)));
    await s.syncUntilQuiet();
    const [row] = await s.db.select({ id: messages.id }).from(messages).where(eq(messages.fromAddress, "letters@news.test"));
    expect(row, "the reader did not take the letter in").toBeDefined();
    const [fs] = await s.db.select().from(folderState).where(eq(folderState.messageId, row!.id));
    expect(fs).toMatchObject({ lastSetBy: "peer", observedFolder: "INBOX", desiredFolder: "INBOX" });
    // THE LAPTOP QUITS: the next look opens a window AFTER the letter's intake; then the promotion.
    meta.clear();
    await s.syncUntilQuiet();
    await promote(s);
    expect(moves, "the letter the live laptop left in INBOX was moved").toEqual([]);
    expect(await rowOf(s), "a letter taken in while held was offered").toEqual({ since: null, letters: null, pressed: null });
  }, 90_000);

  it("a true gap's letter is counted, nothing moves unasked, and File through the route files it once", async () => {
    const meta = new MemoryMetaFolder();
    const moves: Array<{ from: string; to: string }> = [];
    const pending: Array<ChangeBatch["creates"][number]> = [];
    await meta.laptopHolds();
    const s = await boot(meta, pending, moves);
    meta.clear();
    await s.syncUntilQuiet();
    const noted = await sinceOf(s);
    expect(noted, "premise: the gap was noted").not.toBeNull();
    await newsRule(s, noted!);
    // A LETTER ARRIVES WHILE NOTHING ORGANIZES, and the reader takes it in inside the window.
    pending.push(letter(new Date()));
    await s.syncUntilQuiet();

    await promote(s);
    expect(moves, "a promotion moved mail unasked").toEqual([]);
    expect(await rowOf(s), "the gap letter was not offered").toMatchObject({ letters: 1, pressed: null });
    for (let i = 0; i < 2; i++) await s.syncUntilQuiet();
    expect(moves, "mail moved without the press").toEqual([]);

    const stale = await answer(s, { file: true, count: 2 });
    expect(stale.status, "a stale count was accepted").toBe(409);
    expect((await rowOf(s)).pressed, "a stale count stamped a press").toBeNull();

    const pressed = await answer(s, { file: true, count: 1 });
    expect(pressed.status, await pressed.clone().text()).toBe(202);
    /* THE PRESS RINGS THE DRAIN: nothing here drives one, and the poll is an hour away. */
    for (let i = 0; i < 100 && moves.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(moves, "the pressed letter was never filed").toEqual([{ from: "INBOX", to: "ohmail/News" }]);
    expect(await rowOf(s), "the window stayed open after its letters were filed").toEqual({ since: null, letters: null, pressed: null });
    for (let i = 0; i < 3; i++) await s.syncUntilQuiet();
    expect(moves, "the letter was filed more than once").toHaveLength(1);
  }, 90_000);

  it("a stand-down to another install's newer claim closes the window and its offer", async () => {
    const meta = new MemoryMetaFolder();
    const moves: Array<{ from: string; to: string }> = [];
    const pending: Array<ChangeBatch["creates"][number]> = [];
    await meta.laptopHolds();
    const s = await boot(meta, pending, moves);
    meta.clear();
    await s.syncUntilQuiet();
    await newsRule(s, (await sinceOf(s))!);
    pending.push(letter(new Date()));
    await s.syncUntilQuiet();
    await promote(s);
    expect((await rowOf(s)).letters, "premise: the letter was offered").toBe(1);
    // ANOTHER INSTALL TAKES IT, by a press newer than this install's claim: this install stands down.
    await meta.appendClaim(formatClaim({
      installId: "the-laptop", kind: "local", displayName: "a laptop", heartbeat: new Date(),
      claimedAt: new Date(), nonce: "laptop-takes-it", authorizedAt: new Date(), capabilities: [],
    }));
    for (let i = 0; i < 3 && s.organizerState().organizing; i++) await s.syncUntilQuiet();
    expect(s.organizerState().organizing, "premise: this install stood down").toBe(false);
    expect(await rowOf(s), "a stand-down left the window or its offer standing").toEqual({ since: null, letters: null, pressed: null });
    expect(moves, "the stand-down moved mail").toEqual([]);
  }, 90_000);

  it("Leave closes the offer and nothing moves", async () => {
    const meta = new MemoryMetaFolder();
    const moves: Array<{ from: string; to: string }> = [];
    const pending: Array<ChangeBatch["creates"][number]> = [];
    await meta.laptopHolds();
    const s = await boot(meta, pending, moves);
    meta.clear();
    await s.syncUntilQuiet();
    await newsRule(s, (await sinceOf(s))!);
    pending.push(letter(new Date()));
    await s.syncUntilQuiet();
    await promote(s);
    expect(moves, "a promotion moved mail unasked").toEqual([]);
    expect((await rowOf(s)).letters, "premise: the letter was offered").toBe(1);

    const left = await answer(s, { file: false });
    expect(left.status, await left.clone().text()).toBe(200);
    for (let i = 0; i < 3; i++) await s.syncUntilQuiet();
    expect(moves, "Leave moved mail").toEqual([]);
    expect(await rowOf(s)).toEqual({ since: null, letters: null, pressed: null });
  }, 90_000);

  it("a stranger's letters from the gap are counted beside the rules' and screened only by File through the route", async () => {
    const meta = new MemoryMetaFolder();
    const moves: Array<{ from: string; to: string }> = [];
    const pending: Array<ChangeBatch["creates"][number]> = [];
    await meta.laptopHolds();
    const s = await boot(meta, pending, moves);
    meta.clear();
    await s.syncUntilQuiet();
    const noted = await sinceOf(s);
    expect(noted, "premise: the gap was noted").not.toBeNull();
    await newsRule(s, noted!);
    // WHILE NOTHING ORGANIZES: one letter the rules file, and two from a sender nobody knows.
    pending.push(letter(new Date()), letter(new Date(), "New <new@stranger.test>"), letter(new Date(), "New <new@stranger.test>"));
    await s.syncUntilQuiet();
    const strangers = (await s.db.select({ id: messages.id }).from(messages)
      .where(eq(messages.fromAddress, "new@stranger.test"))).map((r) => r.id);
    expect(strangers, "premise: the reader took the stranger's letters in").toHaveLength(2);

    /* THE PROMOTION CONTROL: a promotion and quiet drains move nothing and write no Screener intent. */
    await promote(s);
    expect(await strangersOf(s), "the strangers were not offered beside the rules' letter").toEqual({ letters: 1, strangers: 2 });
    expect(moves, "a promotion moved mail unasked").toEqual([]);
    for (const id of strangers) {
      const [fs] = await s.db.select().from(folderState).where(eq(folderState.messageId, id));
      expect(fs, "a promotion screened a stranger unasked").toMatchObject({ desiredFolder: "INBOX", lastSetBy: "peer" });
    }

    const older = await answer(s, { file: true, count: 1 });
    expect(older.status, "a press that never saw the strangers was accepted").toBe(409);
    expect((await rowOf(s)).pressed).toBeNull();

    const pressed = await answer(s, { file: true, count: 1, strangers: 2 });
    expect(pressed.status, await pressed.clone().text()).toBe(202);
    for (let i = 0; i < 100 && moves.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 2; i++) await s.syncUntilQuiet();
    expect(moves.filter((m) => m.to === "ohmail/News")).toEqual([{ from: "INBOX", to: "ohmail/News" }]);
    expect(moves.filter((m) => m.to === "ohmail/Screener"), "the strangers were not screened exactly once")
      .toEqual([{ from: "INBOX", to: "ohmail/Screener" }, { from: "INBOX", to: "ohmail/Screener" }]);
    expect(await rowOf(s)).toEqual({ since: null, letters: null, pressed: null });
    const queue = await s.handle(new Request("http://local/screener", { headers: { authorization: `Bearer ${s.sessionToken}` } }));
    const body = (await queue.json()) as { items: { sender: { address: string } }[] };
    expect(body.items.map((i) => i.sender.address), "the sender is not waiting in the Screener").toContain("new@stranger.test");

    /* POSITIVE CONTROL: a stranger arriving once this install organizes is held at arrival, unasked. */
    pending.push(letter(new Date(), "Later <later@stranger.test>"));
    for (let i = 0; i < 2; i++) await s.syncUntilQuiet();
    const [later] = await s.db.select({ id: messages.id }).from(messages).where(eq(messages.fromAddress, "later@stranger.test"));
    const [fs] = await s.db.select().from(folderState).where(eq(folderState.messageId, later!.id));
    expect(fs!.desiredFolder, "premise: the live gate holds a stranger").toBe("ohmail/Screener");
  }, 120_000);

  it("an install that cannot read the settings folder withholds the offer, and the window stays open", async () => {
    const meta = new MemoryMetaFolder();
    const moves: Array<{ from: string; to: string }> = [];
    const pending: Array<ChangeBatch["creates"][number]> = [];
    await meta.laptopHolds();
    const s = await boot(meta, pending, moves, false);
    meta.clear();
    await s.syncUntilQuiet();
    await newsRule(s, (await sinceOf(s))!);
    pending.push(letter(new Date()));
    await s.syncUntilQuiet();
    await promote(s);
    const row = await rowOf(s);
    expect(row.since, "a no_folder clearance closed the window").not.toBeNull();
    expect(row.letters, "a no_folder clearance offered").toBeNull();
    expect(moves).toEqual([]);
  }, 90_000);
});

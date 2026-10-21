import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import { formatClaim, type LeaseIo, type RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  formatProfileMessage, makeProfileDoc, profileFingerprint, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { folderState, mailboxes, messages } from "@trafficflow/db";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { requestOrganizerTakeover } from "../src/organize-here.js";

/**
 * THE GAP PASS WAITS FOR SETTLED RULES, ON THE LOCAL ENGINE (the cross-install case). The laptop organized the
 * mailbox and left its settings, a News rule among them, in `ohmail/_meta`. It lets go; the phone's
 * look opens the window and a News letter arrives, adopted at the inbox. The phone, with no rules of
 * its own, organizes next with the import question open: its gap pass must not close the window on
 * its empty rules. After the import the offer counts the letter by the imported rule, with no other
 * trigger, and File files it. Declined, the window closes by the phone's own rules. The device
 * store's twin, on the phone's own engine, is in gap-window-opens-at-release.test.ts.
 */

const GENERATION = 4_100;
const NEWS = "ohmail/News";
const RULE_MADE = new Date(Date.now() - 30 * 86_400_000);

function drop<T extends { ref: unknown }>(list: T[], refs: readonly unknown[]): void {
  const gone = new Set(refs);
  for (let i = list.length - 1; i >= 0; i--) if (gone.has(list[i]!.ref)) list.splice(i, 1);
}

class MemoryMeta implements LeaseIo, ProfileIo {
  private nextUid = 1;
  readonly claims: RawClaimMessage[] = [];
  readonly profiles: Array<{ ref: number; raw: string }> = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> { drop(this.claims, refs); }
  uidValidity(): number { return GENERATION; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[]> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    return this.profiles.map((p) => ({ ref: p.ref, raw: p.raw, generation: GENERATION }));
  }
  async appendProfile(raw: string): Promise<void> { this.profiles.push({ ref: this.nextUid++, raw }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> { drop(this.profiles, refs); }
  async laptopHolds(): Promise<void> {
    await this.appendClaim(formatClaim({
      installId: "the-laptop", kind: "local", displayName: "a laptop", heartbeat: new Date(),
      claimedAt: new Date(), nonce: `laptop-${this.nextUid}`, authorizedAt: null, capabilities: ["profile"],
    }));
  }
  laptopLetsGo(): void { this.claims.length = 0; }
}

/** The laptop's settings: a News rule made a month ago, written by this version (it carries its age). */
const LAPTOP_DOC = makeProfileDoc({
  screener: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
  rules: [{
    kind: "sender", match: "letters@news.test", destination: NEWS, priority: 0, enabled: true, provenance: "manual",
    updatedAt: RULE_MADE.toISOString(),
  }],
}, { updatedAt: RULE_MADE, producer: { kind: "local", version: "dev" } });
const LAPTOP_FP = profileFingerprint(LAPTOP_DOC);

let uid = 400;
function letter(internalDate: Date): ChangeBatch["creates"][number] {
  uid += 1;
  const raw = Buffer.from([
    "From: Letters <letters@news.test>", "To: owner@trafficflow.test", `Subject: letter ${uid}`,
    `Message-ID: <settled-${uid}@news.test>`, "Date: Fri, 09 Oct 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8", "", "this week's letter", "",
  ].join("\r\n"));
  return { type: "create", locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator, raw, internalDate, seen: false };
}

function server(meta: MemoryMeta, pending: Array<ChangeBatch["creates"][number]>, moves: Array<{ from: string; to: string }>) {
  return (_cfg: ImapConfig): MailboxAdapter => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    profileIo: () => meta,
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
  } as unknown as MailboxAdapter);
}

describe("the phone that organizes next waits for its settings answer before it offers the gap", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  const rowOf = async (s: Sidecar) => (await s.db.select({
    since: mailboxes.gapSince, letters: mailboxes.gapLetters, pressed: mailboxes.gapPressedAt,
  }).from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId)))[0]!;
  const call = (s: Sidecar, path: string, body: unknown) => s.handle(new Request(`http://local${path}`, {
    method: "POST", headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  /** The cross-install world up to Organize here: the window open, the letter adopted, the phone organizing. */
  async function organizesNext(): Promise<{ s: Sidecar; moves: Array<{ from: string; to: string }> }> {
    const meta = new MemoryMeta();
    const moves: Array<{ from: string; to: string }> = [];
    const pending: Array<ChangeBatch["creates"][number]> = [];
    await meta.laptopHolds();
    await meta.appendProfile(formatProfileMessage(LAPTOP_DOC, { installId: "the-laptop" }));
    const dataDir = await freshDataDir("ohmail-gap-settled-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const s = await createSidecar({
      dataDir,
      // A refused port and a sealed credential: the import's own dial fails, so the press is handed
      // to the organizer, which reads the settings on this rig's connection.
      imap: { host: "127.0.0.1", port: 1, secure: false, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "the phone", pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0, adapterFactory: server(meta, pending, moves), log: () => {},
      keks: { 1: randomBytes(32) },
    });
    cleanups.push(() => s.stop().catch(() => undefined));
    await grantOrganizeConsent(s);
    await s.start();
    await s.syncUntilQuiet();
    expect(s.organizerState().organizing, "premise: a reader beside the laptop").toBe(false);

    // THE LAPTOP LETS GO: the phone's look opens the window.
    meta.laptopLetsGo();
    await s.syncUntilQuiet();
    expect((await rowOf(s)).since, "premise: the gap was noted").not.toBeNull();
    // A NEWS LETTER ARRIVES WHILE NOTHING ORGANIZES, adopted at the inbox.
    pending.push(letter(new Date()));
    await s.syncUntilQuiet();
    const [row] = await s.db.select({ id: messages.id }).from(messages).where(eq(messages.fromAddress, "letters@news.test"));
    expect(row, "the reader did not take the letter in").toBeDefined();
    const [fs] = await s.db.select().from(folderState).where(eq(folderState.messageId, row!.id));
    expect(fs).toMatchObject({ lastSetBy: "peer", observedFolder: "INBOX", desiredFolder: "INBOX" });

    // ORGANIZE HERE, with no rules of its own and the laptop's settings unanswered.
    await requestOrganizerTakeover(s.db, { mailboxId: s.world.mailboxId, now: new Date(), intent: "takeover" });
    await s.syncUntilQuiet();
    expect(s.organizerState().organizing, "the press did not promote this install").toBe(true);
    for (let i = 0; i < 4; i++) await s.syncUntilQuiet();
    return { s, moves };
  }

  it("withholds while the import question stands, then offers by the imported rule with no other trigger", async () => {
    const { s, moves } = await organizesNext();
    const before = await rowOf(s);
    expect(before.since, "the open import question closed the window").not.toBeNull();
    expect(before.letters, "the gap was counted by rules about to change").toBeNull();
    expect(moves).toEqual([]);

    const imported = await call(s, `/mailboxes/${s.world.mailboxId}/profile-import`, { fingerprint: LAPTOP_FP });
    expect([200, 202], await imported.clone().text()).toContain(imported.status);
    for (let i = 0; i < 2 && (await rowOf(s)).letters === null; i++) await s.syncUntilQuiet();
    expect(await rowOf(s), "the imported rule's letter was not offered").toMatchObject({ letters: 1, pressed: null });
    expect(moves, "an offer moved mail").toEqual([]);

    const pressed = await call(s, `/mailboxes/${s.world.mailboxId}/gap-letters`, { file: true, count: 1 });
    expect(pressed.status, await pressed.clone().text()).toBe(202);
    for (let i = 0; i < 100 && moves.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(moves, "the pressed letter was never filed").toEqual([{ from: "INBOX", to: NEWS }]);
    expect(await rowOf(s)).toEqual({ since: null, letters: null, pressed: null });
  }, 120_000);

  it("declined, the window closes by the phone's own rules", async () => {
    const { s, moves } = await organizesNext();
    for (let i = 0; i < 2; i++) await s.syncUntilQuiet();
    expect((await rowOf(s)).since, "the open import question closed the window").not.toBeNull();
    const declined = await call(s, `/mailboxes/${s.world.mailboxId}/profile-import/decline`, { fingerprint: LAPTOP_FP });
    expect(declined.status, await declined.clone().text()).toBe(200);
    for (let i = 0; i < 2 && (await rowOf(s)).since !== null; i++) await s.syncUntilQuiet();
    expect(await rowOf(s)).toEqual({ since: null, letters: null, pressed: null });
    expect(moves).toEqual([]);
  }, 120_000);
});

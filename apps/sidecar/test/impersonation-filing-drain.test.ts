import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  formatProfileMessage, makeProfileDoc, profileFingerprint, type OrganizerProfilePayload, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { accountSettings, folderState, messageBodies, messageInstances, messages, tags } from "@trafficflow/db";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * A STANDALONE DRAIN FILES A HELD IMPERSONATION TO SPAM, the desktop's and the phone's engine
 * (2026-11-09). The store holds a lure at the gate: a letter whose name is a company's and whose
 * address is nobody's. The organizing drain files it; a reader's drain moves nothing. With the
 * switch off nothing is filed, and the drain after it is turned on files without any mail arriving.
 * Taking over a mailbox whose settings another install left, nothing is filed while the question
 * stands; that install's off choice holds at once.
 */

const GENERATION = 4_200;
const LURE = "billing@hosting-renewals.example";

class MemoryMetaFolder implements LeaseIo, ProfileIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  private readonly profiles: Array<{ ref: number; raw: string }> = [];
  /** While set, reading the settings messages fails. */
  readFails = false;
  constructor(profiles: readonly string[] = []) {
    for (const raw of profiles) this.profiles.push({ ref: this.nextUid++, raw });
  }
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> { drop(this.claims, refs); }
  uidValidity(): number | bigint | null { return GENERATION; }
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    if (this.readFails) throw new Error("the settings folder could not be read");
    return this.profiles.map((p) => ({ ref: p.ref, raw: p.raw, generation: GENERATION }));
  }
  async appendProfile(raw: string): Promise<void> { this.profiles.push({ ref: this.nextUid++, raw }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> { drop(this.profiles, refs); }
}

function drop<T extends { ref: unknown }>(list: T[], refs: readonly unknown[]): void {
  const gone = new Set(refs);
  for (let i = list.length - 1; i >= 0; i--) if (gone.has(list[i]!.ref)) list.splice(i, 1);
}

/** A mailbox with nothing new in it, whose moves land; `ohmail/_meta` (`meta`) holds the settings messages. */
function quietMailbox(meta: MemoryMetaFolder) {
  const empty: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
  return (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo; profileIo(): ProfileIo } => ({
    leaseIo: () => meta,
    profileIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...empty }; },
    async move(locator: NativeLocator, to: string): Promise<NativeLocator> { return { ...(locator as object), folder: to } as NativeLocator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

/** Settings another install left in the mailbox a month ago. */
function laptopSettings(p: Partial<OrganizerProfilePayload>) {
  const doc = makeProfileDoc({
    screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null, ...p,
  }, { updatedAt: new Date(Date.now() - 30 * 86_400_000), producer: { kind: "local", version: "dev" } });
  return { raw: formatProfileMessage(doc, { installId: "the-laptop" }), fingerprint: profileFingerprint(doc) };
}

describe("a standalone drain files a held impersonation to Spam", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  let planted = 0;
  /** One letter held at the gate as the store keeps it; planted straight in, so no drain counts it as mail taken in. */
  async function plant(s: Sidecar, l: { name: string; from: string; at?: Date }): Promise<string> {
    const n = ++planted;
    const at = l.at ?? new Date(Date.now() - 60_000);
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId, mailboxId: s.world.mailboxId, bodyHash: `imp-${n}`, dedupKey: `imp:${n}@test`,
      subject: "Erinnerung: Bitte aktualisieren Sie Ihre Zahlungsinformationen",
      fromName: l.name, fromAddress: l.from, date: at, arrivedAt: at, createdAt: at,
      senderCheck: "impersonation", senderCheckBrand: "Metanet", noAi: true,
      nativeLocator: { folder: "ohmail/Screener", ref: `9:${n}` },
    }).returning();
    await s.db.insert(messageInstances).values({
      accountId: s.world.accountId, mailboxId: s.world.mailboxId, messageId: m!.id, folder: "ohmail/Screener", uidvalidity: 9n, uid: n, isPrimary: true,
    });
    await s.db.insert(folderState).values({
      messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await s.db.insert(messageBodies).values({ messageId: m!.id, text: "Aufgrund einer ausstehenden Zahlung", headers: {} });
    return m!.id;
  }
  const lureOf = (s: Sidecar, at?: Date) => plant(s, { name: "Metanet", from: LURE, ...(at === undefined ? {} : { at }) });

  async function boot(o: {
    organize: boolean; later?: boolean; profiles?: readonly string[]; plantFirst?: (s: Sidecar) => Promise<void>;
  }): Promise<{ sidecar: Sidecar; phish: () => Promise<string>; meta: MemoryMetaFolder }> {
    const meta = new MemoryMetaFolder(o.profiles);
    const dataDir = await freshDataDir("ohmail-impersonation-");
    const sidecar = await createSidecar({
      dataDir,
      // A refused port and a sealed credential: an Import's own dial fails, so the press is handed to
      // the organizer, which reads the settings on this rig's connection.
      imap: { host: "127.0.0.1", port: 1, secure: false, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test", machineName: "impersonation host", pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0, adapterFactory: quietMailbox(meta), log: () => {}, dkimKeys: null,
      keks: { 1: randomBytes(32) },
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    if (o.organize) await grantOrganizeConsent(sidecar);
    const w = sidecar.world;
    await sidecar.db.insert(accountSettings).values({ accountId: w.accountId, screeningScope: "all_time" })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { screeningScope: "all_time" } });
    await o.plantFirst?.(sidecar);
    let lure: Promise<string> | null = null;
    if (o.later !== true) lure = lureOf(sidecar);
    await lure;
    await sidecar.start();
    return { sidecar, phish: () => (lure ??= lureOf(sidecar)), meta };
  }

  const desiredOf = async (s: Sidecar, id: string): Promise<string> =>
    (await s.db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  const call = (s: Sidecar, path: string, body: unknown) => s.handle(new Request(`http://local${path}`, {
    method: "POST", headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  it("the organizing drain files it; a reader's drain moves nothing", async () => {
    const organizer = await boot({ organize: true });
    await organizer.sidecar.syncUntilQuiet();
    expect(await desiredOf(organizer.sidecar, await organizer.phish())).toBe("ohmail/Quarantine");

    const reader = await boot({ organize: false });
    await reader.sidecar.syncUntilQuiet();
    expect(await desiredOf(reader.sidecar, await reader.phish()), "a reader filed a letter").toBe("ohmail/Screener");
  }, 60_000);

  it("with the switch off nothing is filed, and the drain after it is turned on files with no mail arriving", async () => {
    // On, with nothing to file: the launch's run is spent, and a quiet drain owes nothing more.
    const { sidecar, phish } = await boot({ organize: true, later: true });
    await sidecar.syncUntilQuiet();
    const setOff = (at: Date | null) => sidecar.db.update(accountSettings).set({ impersonationFilingOffAt: at })
      .where(eq(accountSettings.accountId, sidecar.world.accountId));
    await setOff(new Date());
    const id = await phish();
    await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar, id), "filed with the switch off").toBe("ohmail/Screener");
    await setOff(null);
    await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar, id), "turning it on owed a run").toBe("ohmail/Quarantine");
  }, 60_000);

  it("a settings folder that cannot be read holds the filing back, and its recovery owes a run with no mail arriving", async () => {
    // On, with nothing to file: the launch's run is spent over the mailbox, and nothing more is owed.
    const { sidecar, phish, meta } = await boot({ organize: true, later: true });
    await sidecar.syncUntilQuiet();
    meta.readFails = true;
    const id = await phish();
    await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar, id), "filed while the settings question could not be read").toBe("ohmail/Screener");
    meta.readFails = false;
    await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar, id), "the read's recovery owed no run").toBe("ohmail/Quarantine");
  }, 60_000);

  it("fifty older senders it keeps do not hold the lure behind them past the next drain", async () => {
    const { sidecar, phish } = await boot({
      organize: true, later: true,
      plantFirst: async (s) => {
        const base = Date.now() - 10 * 86_400_000;
        for (let i = 0; i < 50; i++) await plant(s, { name: "Metanet Hosting Support", from: `hello@kept-${i}.example`, at: new Date(base + i * 60_000) });
      },
    });
    const lure = await phish();
    for (let i = 0; i < 2; i++) await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar, lure), "the kept senders' page held the lure").toBe("ohmail/Quarantine");
  }, 60_000);

  it("taking over settings that say off: nothing is filed while the question stands, the switch is off at once, nor after Import", async () => {
    const left = laptopSettings({ impersonationFiling: false, tagNames: ["Rechnungen"] });
    const { sidecar, phish } = await boot({ organize: true, profiles: [left.raw] });
    const id = await phish();
    for (let i = 0; i < 2; i++) await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar, id), "filed before the person answered").toBe("ohmail/Screener");
    const [row] = await sidecar.db.select({ off: accountSettings.impersonationFilingOffAt }).from(accountSettings)
      .where(eq(accountSettings.accountId, sidecar.world.accountId));
    expect(row?.off, "the other install's off choice waited for a press").not.toBeNull();

    const imported = await call(sidecar, `/mailboxes/${sidecar.world.mailboxId}/profile-import`, { fingerprint: left.fingerprint });
    expect([200, 202], await imported.clone().text()).toContain(imported.status);
    const tagged = async () => (await sidecar.db.select({ name: tags.name }).from(tags)
      .where(eq(tags.accountId, sidecar.world.accountId))).map((t) => t.name);
    for (let i = 0; i < 3 && (await tagged()).length === 0; i++) await sidecar.syncUntilQuiet();
    expect(await tagged(), "premise: the import landed").toEqual(["Rechnungen"]);
    await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar, id), "filed after the Import").toBe("ohmail/Screener");
  }, 120_000);

  it("taking over settings with a rule on the sender: nothing is filed while the question stands; Not now files with no mail arriving", async () => {
    const left = laptopSettings({
      rules: [{
        kind: "sender", match: LURE, destination: "INBOX", priority: 0, enabled: true, provenance: "manual",
        updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      }],
    });
    const { sidecar, phish } = await boot({ organize: true, profiles: [left.raw] });
    const id = await phish();
    for (let i = 0; i < 2; i++) await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar, id), "filed before the person answered, past the rule an Import would bring").toBe("ohmail/Screener");

    const declined = await call(sidecar, `/mailboxes/${sidecar.world.mailboxId}/profile-import/decline`, { fingerprint: left.fingerprint });
    expect(declined.status, await declined.clone().text()).toBe(200);
    for (let i = 0; i < 2 && (await desiredOf(sidecar, id)) === "ohmail/Screener"; i++) await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar, id), "the answer owed no run").toBe("ohmail/Quarantine");
  }, 120_000);
});

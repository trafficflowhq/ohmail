import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchByUidOptions, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult, TargetedFetch,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  UNMETERED_STORAGE_CAP, commitChange, planChange, type BlankRepairMode, type Change,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { messageFailures, messageInstances } from "@trafficflow/db";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE DESKTOP AND PHONE ENGINE RUN THE BLANK REPAIR IN THE MODE THEY WERE GIVEN
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Both run `runSyncCycle` through this composition (`createSidecar`; the phone's root calls it too),
 * and the cycle runs the blank repair at its tail. Its mode reaches the cycle as
 * `SidecarConfig.blankRepair`: the desktop fills it from `OHMAIL_BLANK_REPAIR` (`main.test.ts`), the
 * phone passes `off` (its build carries no repair: `apps/mobile/test/phone-engine-leaves-out-blank-repair.test.ts`).
 * Without it every cycle ran the repair as apply: `off` and `dry` moved the letter.
 *
 * The damage, as an older build left it: a blank at a letter's place in ohmail/Screener, filed there by
 * ohmail itself, which the mailbox double serves the letter for. Seeded before the first drain, because
 * a drain that finds nothing to repair is not asked again by this process.
 *
 * MUTATION WATCHED: drop `blankRepair` from `syncDeps` in `engine.ts` and the off and dry cases move it.
 */

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

const EPOCH = "9";
const UID = 30;
const LETTER = Buffer.from([
  "Message-ID: <hidden@x.example>", "From: anna@x.example", "To: owner@trafficflow.test",
  "Subject: hidden by a blank", "Content-Type: text/plain; charset=utf-8", "", "the letter itself",
].join("\r\n"));

interface Seen { reads: string[]; moves: Array<{ from: string; to: string }> }

/** Nothing new arrives; the one letter sits at the blank's place, re-read and moved on request. */
function blankMailbox(seen: Seen) {
  const meta = new MemoryMetaFolder();
  const empty: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
  const here = (folder: string, uid: number): boolean => folder === "ohmail/Screener" && uid === UID;
  return (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo } => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...empty }; },
    async fetchByUid(folder: string, uids: readonly number[], _opts?: FetchByUidOptions): Promise<TargetedFetch> {
      seen.reads.push(`${folder}:${uids.join(",")}`);
      const creates: Change[] = uids.filter((u) => here(folder, u))
        .map((u) => ({ type: "create", locator: { folder, ref: `${EPOCH}:${u}` }, raw: LETTER, seen: false }));
      return { uidValidity: EPOCH, creates, absent: uids.filter((u) => !here(folder, u)), oversize: [] };
    },
    async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
      seen.moves.push({ from: locator.folder, to });
      return { folder: to, ref: `${EPOCH}:900` };
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

/** The blank as an older build stored it — an empty source's parse — at the letter's place, filed by ohmail. */
async function seedBlank(sidecar: Sidecar): Promise<string> {
  const { accountId, mailboxId } = sidecar.world;
  const id = await sidecar.db.transaction(async (tx) => {
    const r = makeDrizzleRepo(tx as never);
    const change: Change = {
      type: "create", locator: { folder: "ohmail/Screener", ref: `${EPOCH}:${UID}` }, raw: Buffer.from("\r\n"), seen: false,
    };
    const plan = await planChange(change, { repo: r, accountId, mailboxId, readerMode: false });
    return (await commitChange(plan, { storageCap: UNMETERED_STORAGE_CAP, repo: r, accountId, mailboxId })).messageId;
  });
  await makeDrizzleRepo(sidecar.db as never).upsertFolderState(id, {
    desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us",
  });
  return id;
}

describe("the engine runs the blank repair in the mode its configuration names", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(seen: Seen, mode: BlankRepairMode | undefined): Promise<{ sidecar: Sidecar; blankId: string }> {
    const dataDir = await freshDataDir("ohmail-blank-repair-mode-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test",
      machineName: "blank repair host",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: blankMailbox(seen),
      log: () => {},
      ...(mode !== undefined ? { blankRepair: mode } : {}),
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await grantOrganizeConsent(sidecar);
    const blankId = await seedBlank(sidecar);
    // Two drains: the launch's, and one more.
    await sidecar.start();
    await sidecar.syncUntilQuiet();
    return { sidecar, blankId };
  }
  const placesOf = async (s: Sidecar, id: string): Promise<number> =>
    (await s.db.select({ uid: messageInstances.uid }).from(messageInstances).where(eq(messageInstances.messageId, id))).length;
  const owedOf = async (s: Sidecar): Promise<number> =>
    (await s.db.select({ uid: messageFailures.uid }).from(messageFailures).where(eq(messageFailures.mailboxId, s.world.mailboxId))).length;
  const placeReads = (seen: Seen): string[] => seen.reads.filter((r) => r.startsWith("ohmail/Screener:"));

  it("off: the repair reads nothing and moves nothing", async () => {
    const seen: Seen = { reads: [], moves: [] };
    const { sidecar, blankId } = await boot(seen, "off");
    expect(seen.moves, "off moved the letter").toEqual([]);
    expect(placeReads(seen), "off read the blank's place").toEqual([]);
    expect(await placesOf(sidecar, blankId)).toBe(1);
    expect(await owedOf(sidecar)).toBe(0);
  }, 60_000);

  it("dry: the place is read once over two drains, and nothing is moved or written", async () => {
    const seen: Seen = { reads: [], moves: [] };
    const { sidecar, blankId } = await boot(seen, "dry");
    expect(seen.moves, "dry moved the letter").toEqual([]);
    expect(placeReads(seen)).toEqual([`ohmail/Screener:${UID}`]);
    expect(await placesOf(sidecar, blankId), "dry let go of the place").toBe(1);
    expect(await owedOf(sidecar), "dry owed a re-read").toBe(0);
  }, 60_000);

  it("CONTROL: unset is apply — the letter goes back to INBOX and the blank lets go of its place", async () => {
    const seen: Seen = { reads: [], moves: [] };
    const { sidecar, blankId } = await boot(seen, undefined);
    expect(seen.moves).toContainEqual({ from: "ohmail/Screener", to: "INBOX" });
    expect(placeReads(seen)).toEqual([`ohmail/Screener:${UID}`]);
    expect(await placesOf(sidecar, blankId)).toBe(0);
  }, 60_000);
});

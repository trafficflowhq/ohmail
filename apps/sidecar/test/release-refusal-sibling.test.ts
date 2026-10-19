import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import { eq, isNull, sql } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { DEFAULT_STALE_AFTER_MS } from "@trafficflow/worker/lease";
import { mailboxes } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { releaseRefusal } from "./_release-refusal.js";

/**
 * ══ THE SIBLING REFUSAL REACHES THE ROW, AND ONLY THAT REFUSAL DOES (mail 0121) ═══════════
 *
 * The clone sequence the project's design notes rules on: a restored image leaves a FRESH claim in
 * `ohmail/_meta` under this install's id and a nonce it never wrote. A stop pressed here is then
 * refused (`nonce_unknown` — the record is live and not ours to take), the request stands, and
 * before mail 0121 the wire could not tell that refusal from an ordinary pending confirm — the
 * pane rendered "Stopping…" for ever, then a false "released" ten minutes in, over a mailbox the
 * clone kept organizing. These cases pin the three halves of the fix at the WRITER:
 *
 *   1. the refusal writes `release_refusal = 'sibling_lapse'` and the request STANDS — no local
 *      lapse flip records a release while the sibling renews;
 *   2. a could-not-look writes NO refusal (the field appears on that refusal alone);
 *   3. the sibling's own lapse heals it: a stale sibling record is released by the ordinary pass
 *      and the same write clears the refusal with the request.
 *
 * The pane's half (the sentence rendered from the DTO) is `desktop-mailboxes-sibling.test.tsx`.
 */

class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  /** The release's read refused the way the real io refuses it — see `_release-refusal.ts`. */
  releaseRefused = false;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    if (this.releaseRefused) throw releaseRefusal();
    return this.claims
      .filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`))
      .map((c) => ({ ...c }));
  }
  /** This install's own id, read off the claim its first organizing pass appended. */
  ownInstallId(): string {
    const m = /^X-Ohmail-Install-Id: (.+)$/m.exec(this.claims[0]?.raw ?? "");
    if (!m) throw new Error("no claim in the folder to read an install id from");
    return m[1]!.trim();
  }
  /**
   * The restored image's state: OUR record is out (the clone's renew expunges same-id older
   * records — the gate's own id-scoped expunge), and the clone's stands under a nonce this
   * install never wrote. `heartbeat` decides whether it is LIVE or LAPSED.
   */
  async replaceWithSibling(installId: string, heartbeat: Date): Promise<void> {
    this.claims.length = 0;
    await this.appendClaim(formatClaim({
      installId, kind: "local", displayName: "the same computer, restored",
      heartbeat, claimedAt: heartbeat, nonce: "n-clone-not-ours",
      authorizedAt: null, capabilities: [],
    }));
  }
  /** Another install's claim, appended BESIDE ours: live, and authorized by a press, so it outranks. */
  async appendForeign(installId: string, heartbeat: Date): Promise<void> {
    await this.appendClaim(formatClaim({
      installId, kind: "local", displayName: "the other computer",
      heartbeat, claimedAt: heartbeat, nonce: "n-theirs",
      authorizedAt: heartbeat, capabilities: [],
    }));
  }
  get count(): number { return this.claims.length; }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

function quietMailbox(meta: MemoryMetaFolder) {
  const factory = (_cfg: ImapConfig): MailboxAdapter & {
    leaseIo(): LeaseIo; leasePeekIo(): { listClaims(): Promise<RawClaimMessage[]> };
  } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY_BATCH }; },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this test's mailbox must never be asked to send");
    },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
  return { factory };
}

const HOUR = 60 * 60 * 1000;
const STALE_AFTER_MS = 60_000;

describe("the sibling-lapse refusal on the row", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function dataDir(): Promise<string> {
    const dir = await freshDataDir("ohmail-sibling-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  /** A log line as the engine wrote it — the event, and the detail the stand-down case reads. */
  type Line = { event: string; detail?: Record<string, unknown> };
  async function boot(
    dir: string, mailbox: ReturnType<typeof quietMailbox>, lines: Line[],
  ): Promise<Sidecar> {
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "the machine that pressed stop",
      pollIntervalMs: 60 * HOUR, // every poll below is one the test asked for
      leaseStaleAfterMs: STALE_AFTER_MS,
      adapterFactory: mailbox.factory,
      log: (event, detail) => { lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    // The precondition, written the way `reader-no-auto-resume.test.ts` argues it: this file is
    // about an install that was asked to organize, and only on a fresh store.
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    return sidecar;
  }

  const mailboxRow = async (sidecar: Sidecar) => {
    const [row] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    return row!;
  };
  const said = (lines: { event: string }[], event: string): number =>
    lines.filter((l) => l.event === event).length;

  it("a LIVE sibling refusal records `sibling_lapse`, the request stands, and nothing flips", async () => {
    const lines: { event: string }[] = [];
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(await dataDir(), mailbox, lines);
    await sidecar.start();
    expect(meta.count, "the first pass did not claim the mailbox").toBe(1);

    // The restored image: a FRESH same-id claim under a nonce this install never wrote.
    await meta.replaceWithSibling(meta.ownInstallId(), new Date());
    await sidecar.db.update(mailboxes).set({ releaseRequestedAt: new Date() })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    await sidecar.syncUntilQuiet();

    const row = await mailboxRow(sidecar);
    expect(row.releaseRefusal, "the refusal never reached the row").toBe("sibling_lapse");
    expect(row.releaseRequestedAt, "the request was spent over a release that never happened")
      .not.toBeNull();
    expect(row.organizerRole, "the row demoted over a claim that is still live").toBe("organizer");
    expect(row.organizerReleasedAt, "a release was recorded while the sibling renews").toBeNull();
    expect(meta.count, "the sibling's live claim was deleted").toBe(1);
    expect(said(lines, "organizer_claim_release_refused_sibling")).toBeGreaterThanOrEqual(1);
    expect(said(lines, "organizer_released_by_lapse"),
      "the LOCAL lapse flip recorded a release over a live sibling — the arm this file exists to refuse")
      .toBe(0);

    // The next poll asks again and nothing degrades: same refusal, same standing request.
    await sidecar.syncUntilQuiet();
    const again = await mailboxRow(sidecar);
    expect(again.releaseRefusal).toBe("sibling_lapse");
    expect(again.releaseRequestedAt).not.toBeNull();
  }, 60_000);

  it("a Stop the store's clock wrote (microseconds) records the refusal too", async () => {
    /* The pass reads a millisecond `Date`; the compare-and-set compares at that precision, or a
       stamp with digits past its millisecond never matched and the refusal never reached the row.
       407 µs: red whether the parser truncates or rounds. */
    const lines: { event: string }[] = [];
    const meta = new MemoryMetaFolder();
    const sidecar = await boot(await dataDir(), quietMailbox(meta), lines);
    await sidecar.start();
    expect(meta.count, "the first pass did not claim the mailbox").toBe(1);

    await meta.replaceWithSibling(meta.ownInstallId(), new Date());
    await sidecar.db.execute(sql`update mailboxes set release_requested_at =
      date_trunc('milliseconds', now()) + interval '407 microseconds' where id = ${sidecar.world.mailboxId}`);
    await sidecar.syncUntilQuiet();

    const row = await mailboxRow(sidecar);
    expect(row.releaseRefusal, "the refusal never reached the row").toBe("sibling_lapse");
    expect(row.releaseRequestedAt, "the request was spent over a release that never happened").not.toBeNull();
  }, 60_000);

  it("a COULD-NOT-LOOK writes NO refusal — the field appears on the sibling refusal alone", async () => {
    const lines: { event: string }[] = [];
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(await dataDir(), mailbox, lines);
    await sidecar.start();

    meta.releaseRefused = true; // the server will not enumerate — a different fact entirely
    await sidecar.db.update(mailboxes).set({ releaseRequestedAt: new Date() })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    await sidecar.syncUntilQuiet();

    const row = await mailboxRow(sidecar);
    expect(row.releaseRequestedAt, "the unconfirmed arm spent the request").not.toBeNull();
    expect(row.releaseRefusal,
      "a could-not-look was written as a sibling refusal — the discriminator discriminates nothing")
      .toBeNull();
    expect(said(lines, "organizer_claim_release_unconfirmed")).toBeGreaterThanOrEqual(1);
    expect(said(lines, "organizer_claim_release_refused_sibling")).toBe(0);
  }, 60_000);

  it("the sibling's OWN lapse heals it: the release completes and clears the refusal with the request", async () => {
    const lines: { event: string }[] = [];
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(await dataDir(), mailbox, lines);
    await sidecar.start();

    await meta.replaceWithSibling(meta.ownInstallId(), new Date());
    await sidecar.db.update(mailboxes).set({ releaseRequestedAt: new Date() })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    await sidecar.syncUntilQuiet();
    expect((await mailboxRow(sidecar)).releaseRefusal).toBe("sibling_lapse");

    // The clone stops renewing: its record ages past the staleness window and the stale term of
    // the very next release removes it — the project's design notes's lapse bound, the sibling's clock.
    // The DEFAULT window, not this boot's `leaseStaleAfterMs`: the release-route call site does
    // not pass the configured window through to `releaseOwnClaim` (filed as a gap row — the
    // one-clock rule), so the stale term measures against `DEFAULT_STALE_AFTER_MS`.
    await meta.replaceWithSibling(
      meta.ownInstallId(), new Date(Date.now() - DEFAULT_STALE_AFTER_MS - 60_000),
    );
    await sidecar.syncUntilQuiet();

    const row = await mailboxRow(sidecar);
    expect(row.releaseRequestedAt, "the release was not recorded once the sibling lapsed").toBeNull();
    expect(row.releaseRefusal, "the refusal outlived the request it explains").toBeNull();
    expect(row.organizerRole).toBe("reader");
    expect(row.organizerReleasedAt).not.toBeNull();
    expect(meta.count, "the lapsed record was left standing").toBe(0);
  }, 60_000);

  /**
   * ── THE STAND-DOWN LINE NAMES THE MAILBOX IT IS ABOUT ──────────────────────────────────────
   * A stand-down is a per-mailbox verdict, and on an install holding two mailboxes the line
   * carried the reason, the holder and the verdict with no row id — so a boot that came back
   * serving one of two could not say which had changed hands (measured on the 0.16.0 candidate). `mailboxId`
   * is on the line and on the logger's allow-list; this pins that it reaches the record.
   * Watched red: drop `mailboxId: mb.id` from the `organizer_stand_down` call in `engine.ts`.
   */
  it("a stand-down names the mailbox it is about — the line carries the row id", async () => {
    const lines: Line[] = [];
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(await dataDir(), mailbox, lines);
    await sidecar.start();
    expect(meta.count, "the premise is an install holding its claim").toBe(1);

    // Another install takes the mailbox with a press behind it; this one stands down on its next pass.
    await meta.appendForeign("another-computer-install", new Date());
    await sidecar.syncUntilQuiet();

    const stood = lines.filter((l) => l.event === "organizer_stand_down");
    expect(stood, "no stand-down was reached — this case measured something else").toHaveLength(1);
    expect(stood[0]!.detail?.mailboxId, "the stand-down line does not say which mailbox changed hands")
      .toBe(sidecar.world.mailboxId);
    expect(typeof stood[0]!.detail?.reason, "the line lost its reason sentence").toBe("string");
    expect((await mailboxRow(sidecar)).organizerRole, "the install did not become a reader").toBe("reader");
  }, 60_000);
});

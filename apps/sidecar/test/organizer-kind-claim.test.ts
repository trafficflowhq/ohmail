import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import { isNull } from "drizzle-orm";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes } from "@trafficflow/db";
import { createSidecar } from "../src/engine.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE CLAIM SAYS WHAT THIS INSTALL IS — the control for a hand-resolved merge hunk
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `createSidecar`'s `organizerKind` option exists because a phone is not a desktop, and its own
 * docblock names the cost of getting it wrong: "`organizerKind` defaulted to `local` ⇒ the phone
 * claims as a desktop and the holder line lies" — a false statement about who holds somebody's
 * mailbox, on every other device that reads the folder.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────
 *
 * The line that carries the option into the lease is `self: { installId, kind: organizerKind, … }`
 * in the engine's gate. That exact line arrived through a REBASE CONFLICT: the branch changed
 * `kind` from a hard-coded `"local"` to the option, and meanwhile the trunk rewrote the same lines
 * to extract a `leaseArgs` object so it could make a second call with it. Both sides were right
 * and the merge could not tell. Resolving it by hand and moving on would have left the option
 * reachable only by reading, and nothing anywhere named `organizerKind` — a port with no guard is
 * one careless resolution away from being silently reverted, and the revert compiles.
 *
 * So this asks the question through the whole engine: boot a composition, let it claim, and read
 * what it wrote into `ohmail/_meta`. The header is the wire, not an internal.
 *
 * ── HOW TO WATCH IT FAIL ──────────────────────────────────────────────────────────────────
 *
 * In `apps/sidecar/src/engine.ts`, change the gate's `kind: organizerKind` back to
 * `kind: "local" as const` — the trunk's side of that conflict. The first case goes red with
 * `expected 'local' to be 'mobile'`, which is the holder line lying, and the second stays green
 * because a desktop was never the half at risk. That mutation was run.
 *
 * The other half of the same resolution needs no case here and gets none: the trunk's second call
 * reads a `leaseArgs` binding, so a resolution that dropped it does not compile at all. A test for
 * a state the compiler makes unrepresentable is a case that cannot fail wearing the shape of one
 * that can.
 */

/** Keeps the raw claims, because the assertion is about the wire text the install appends. */
class RecordingMetaFolder implements LeaseIo {
  private nextUid = 1;
  readonly appended: string[] = [];
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.appended.push(raw);
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
}

/** A mailbox with nothing in it: the claim is written before any mail is read. */
const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

function quietMailbox(meta: LeaseIo): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      return { ...EMPTY_BATCH };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> {
      return locator;
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> {
      return [];
    },
    async watch(): Promise<() => Promise<void>> {
      return async () => {};
    },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this mailbox cannot send");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
}

/** The header the lease writes the kind into (`X-Ohmail-Organizer-Kind`), read off the raw claim. */
function kindOf(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const m = /^X-Ohmail-Organizer-Kind:\s*(.+?)\s*$/i.exec(line);
    if (m !== null) return m[1] as string;
  }
  return null;
}

describe("the organizer claim names the kind of install that wrote it", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function claimAs(organizerKind?: "mobile"): Promise<string[]> {
    const meta = new RecordingMetaFolder();
    // A MIGRATED PGDATA TEMPLATE: `initdb` costs ten seconds and this file is not about it.
    // `freshDataDir` copies an initialised, migrated `pgdata/` (and realpaths the temp root, which
    // PGlite's lock file needs), leaving everything else a launch writes absent — so this is still a
    // first launch in every respect but that one. The subject is which KIND the claim names, read off
    // the wire after `start()`; the template moves only the boot narration, which nothing here reads.
    const dataDir = await freshDataDir("ohmail-kind-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        // A password is what makes `start()` take the connected path at all — without one the
        // engine returns before it ever claims, and this file would assert on an empty folder.
        auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "kind control",
      ...(organizerKind === undefined ? {} : { organizerKind }),
      // Long enough that the poll timer never fires: the claim under test is the one `start()`
      // wrote, never a second cycle's.
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(meta),
      log: () => {},
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    /* SOMEBODY AGREED TO ORGANIZE, and this is a precondition rather than the subject. The
       consent check sits AHEAD of the lease read on purpose — asking the gate at all appends a
       claim, so an unconsented install must not reach it — which means without this line the
       engine reads and arranges nothing and the folder stays empty. Written after
       `createSidecar` (which makes the world) and before `start()` (which claims). */
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    await sidecar.start();
    return meta.appended;
  }

  it("a composition that declares itself mobile claims as mobile", async () => {
    const appended = await claimAs("mobile");
    expect(appended.length, "the install wrote no claim at all, so this asserts nothing")
      .toBeGreaterThan(0);
    expect(kindOf(appended[0] as string)).toBe("mobile");
  });

  it("and a desktop, which declares nothing, still claims as local", async () => {
    const appended = await claimAs();
    expect(appended.length, "the install wrote no claim at all, so this asserts nothing")
      .toBeGreaterThan(0);
    expect(kindOf(appended[0] as string)).toBe("local");
  });
});

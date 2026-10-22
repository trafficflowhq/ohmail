import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { formatClaim, isMalformed, parseClaim } from "@trafficflow/core/adapters/organizer-lease";
import { ProfileUnavailableError } from "@trafficflow/core/adapters/organizer-profile";
import {
  approvals, attachments, awayReplies, awayResponderSent, changeLog, drafts, flagState, folderOps, folderState,
  junkRescues, mailboxCredentials, mailboxFolders, mailboxProfileMirror, mailboxes, messageBodies,
  messageFailures, messageInstances, messageStates, messageTags, messages, organizerRequests,
  outboundSendFingerprints, outboundSends, routingDecisions, sessions, tags, threadNotes, threads,
  trackerEvents, unsubscribeExamined, unsubscribeRecords,
} from "@trafficflow/db";
import { upsertMessageSearch } from "@trafficflow/core/mail";
import { createSidecar, type Sidecar } from "../src/engine.js";
/* THE PRESS, as the pane presses it. `POST /local/organizer/takeover` and
   `POST /local/mailboxes/:id/organize` both call THIS — engine.ts says so where it mounts them:
   *"The ceremony is `requestOrganizerTakeover`'s and is NOT re-implemented here — this handler
   is the transport and the outcome"* — so driving the ceremony measures the door's decision and
   not a second copy of it. `reader-no-auto-resume.test.ts` presses the same way. */
import { requestOrganizerTakeover } from "../src/organize-here.js";
import { freshDataDir } from "./_datadir.js";
import { tablesTheRemovalOwes } from "./_mailbox-rows.js";
import { releaseRefusal } from "./_release-refusal.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ── THE STORE REFUSING THE WIPE, AT THE SEAM THE ROUTE CALLS ──────────────────────────────────
 *
 * `vi.hoisted` because the factory below runs before any module-level binding exists. The double
 * FAILS THE WAY THE STORE FAILS: a thrown Error carrying a Postgres code, out of the awaited call,
 * with nothing deleted — the "first statement was refused" shape, which is what a full disk
 * (`53100`) or a cancelled statement produces through drizzle. The partial shape, where some
 * tables emptied before the refusal, reaches the route through the same `throw` and leaves the
 * same decision to make with fewer rows behind it. Unarmed it is the real wipe, so every other
 * case in this file — including REMOVE THEN RE-ADD, which measures the wipe working — is
 * measuring production.
 */
const fault = vi.hoisted(() => ({ pending: 0, calls: 0 }));

vi.mock("../src/local-mirror.js", async (importOriginal) => {
  /* THE WHOLE MODULE, then the one override: a factory that names its exports leaves the others
     `undefined`, and the Cloud door's `deleteMailboxRows` is imported from here too. */
  const real = await importOriginal<typeof import("../src/local-mirror.js")>();
  return {
    ...real,
    wipeLocalMirror: async (...args: Parameters<typeof real.wipeLocalMirror>): Promise<void> => {
      fault.calls += 1;
      if (fault.pending > 0) {
        fault.pending -= 1;
        throw Object.assign(
          new Error("could not write to the local database"), { code: "53100" },
        );
      }
      await real.wipeLocalMirror(...args);
    },
  };
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE STANDALONE DOOR: A MAILBOX IS READ UNTIL SOMEBODY AGREES, AND REMOVING IT MEANS IT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two failures measured on a released build, by somebody walking the product as a stranger. They
 * are in one file because they are the two ends of one relationship — how a mailbox is taken on,
 * and how it is let go — and because the second is only observable once the first is fixed.
 *
 * ── ONE: A FRESH MAILBOX WAS RE-ARRANGED BEFORE ANYBODY WAS ASKED ─────────────────────────────
 *
 * The consult's rule is one sentence: *"Connect writes row+credential in one tx as a consent-less
 * reader → mirror builds at once, nothing moves, `ohmail/*` never created … There is no
 * half-applied mailbox because the reader mode IS the pre-consent state."* On this door it was
 * the other way round. `ensureLocalWorld` stamped `organize_consented_at` at INSERT under a
 * docblock arguing *"there is no such screen and no such second step here"* — which was true when
 * it was written and stopped being true the day the guided flow landed on this door. So a person
 * typed a password and, six seconds later, six folders existed in their mailbox and their mail had
 * been moved into them. The consent screen was reachable only afterwards, and only from Settings.
 *
 * `mayOrganize` is the gate that ran instead, and it asked the LEASE alone: an empty
 * `ohmail/_meta` reads as "nobody has ever organized this mailbox", which organizes. Nothing in
 * that path has ever read consent — the column existed and had no reader on this door.
 *
 * ── TWO: "FORGET IT AND START EMPTY" LEFT A CLAIM NOBODY HELD, AND ALL THE MAIL ────────────────
 *
 * `DELETE /local/mailboxes/:id` calls the shared `MailboxService.delete`, which tombstones the
 * row, deletes the credential and closes the appointments — correctly, and that is all it can do,
 * because it is the HOSTED door's method too. What it cannot know about is the ENGINE running
 * beside it: the poll timer kept firing, the IMAP login stayed open, and the claim in
 * `ohmail/_meta` went on being renewed every thirty seconds by an install whose own status bar
 * said "No mailbox connected, so nothing can arrive". Any other install connecting that mailbox
 * stood itself down against a phantom.
 *
 * And the mirror stayed. The row lookup excludes tombstones, so re-adding the same address
 * INSERTS A SECOND ROW — and the local database is both the server and the mirror on this door,
 * so the feed then served both rows' copies of every message. Measured: the Ohbox doubled,
 * every row a "↳ 2" conversation with itself.
 *
 * ── WHY THE ASSERTIONS ARE ABOUT THE MAIL SERVER AND NOT ABOUT THE ROW ────────────────────────
 *
 * "Did not organize" is a claim about what reached somebody's mailbox, so it is asserted on the
 * verbs the adapter was asked for — `ensureFolders`, `move` — and on what is in `ohmail/_meta`.
 * A row saying `reader` while `ensureFolders` ran would be the two halves disagreeing, which is
 * the failure this whole area keeps producing; only the server-facing count can tell them apart.
 *
 * ── HOW TO WATCH THESE FAIL ───────────────────────────────────────────────────────────────────
 *
 *  · Put `organizeConsentedAt: input.now` back on the insert in `identity.ts#ensureLocalWorld` and
 *    "NOTHING IS RE-ARRANGED" goes red on `ensureFolders` — the released behaviour exactly.
 *  · Delete the consent arm from `mayOrganize` (`engine.ts`) and it goes red the same way, with
 *    the row still saying `reader`: the row and the mailbox disagreeing, which is the shape worth
 *    naming.
 *  · Delete the `releaseMailboxClaim` call from the local remove handler and "THE CLAIM IS
 *    RELEASED" goes red with a claim still in `ohmail/_meta`.
 *  · Delete the mirror wipe and "THE MAIL GOES WITH IT" goes red with the removed mailbox's
 *    messages still in the store — which is the doubling, one step before a person can see it.
 *  · Point `sealLocalPassword` (`apps/desktop/src/doors.ts`) back at the shared
 *    `PATCH /mailboxes/:id` and "SEALING A PASSWORD STILL WORKS AN HOUR IN" goes red with a 403
 *    carrying "recent two-factor authentication required" — the released behaviour, and the one
 *    the same test's FIRST assertion proves is still reachable on the shared route.
 *  · Delete the `notePreConsentHolder()` call from that same arm and "A PRE-CONSENT INSTALL
 *    LOOKS" goes red with the holder columns null — the state in which the consent screen offers
 *    to re-arrange a mailbox without saying that something else is already organizing it.
 *
 * All six mutations were run.
 *
 * ── AND A THIRD FAILURE THIS FILE FOUND RATHER THAN GUARDED ───────────────────────────────────
 *
 * "AGREE — and only then" was red for a reason nobody had reported: `ensureFolders` runs in
 * `start()` behind its own gate, and the gate is read ONCE per launch. That was invisible while a
 * fresh install organized from boot; the moment the pre-consent state became a reader, the pass
 * that PROMOTES had no folder tree and routed into destinations the server did not have. The
 * symptom would have been the same one this whole area keeps producing — the person agrees, the
 * row says organizer, and nothing visible happens until they quit and reopen. `syncUntilQuiet`
 * ensures the tree on the pass that promotes, once per process.
 */

/** An in-memory `ohmail/_meta`. EMPTY at boot: nobody has ever organized this mailbox. */
class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /**
   * THE FOLDER'S UID GENERATION. The product's one `LeaseIo` — `makeLeaseIo` — always reports it,
   * and the takeover's confirm refuses when it is unnamed (a ref is a uid, and a uid means nothing
   * across a UIDVALIDITY change). A double that leaves the accessor out puts the gate in a state
   * no install reaches, and the press in these cases is real.
   */
  uidValidity(): number | bigint | null {
    return 4_100;
  }

  /**
   * THE SERVER CANNOT ANSWER THE RELEASE'S READ — the OTHER state a real mail server puts it in.
   *
   * A STATE rather than an absence: the product's one io always has this method. It REFUSES the
   * way that io refuses — `ClaimReleaseError`, `unreadable` with the provider's fault in `cause`
   * (a dropped read) or `over_ceiling` (a folder anyone with append rights grew past one read) —
   * and never answers `null`, a shape only a double produced. See `_release-refusal.ts`.
   */
  refuseOwnRecordSearch = false;
  /** Which of the two production refusals a refused read throws. */
  refusalCode: "unreadable" | "over_ceiling" = "unreadable";
  /**
   * EVERY RECORD IN THE FOLDER BEARING THIS INSTALL ID, asked of the SERVER — what a RELEASE reads.
   *
   * Present because `makeLeaseIo` defines it, which makes it the only shape production has. A
   * double without it is not a smaller server, it is a different one: `releaseMailboxClaim`
   * answers "the records this install owns could not be enumerated" for such an adapter and
   * throws, so every case here would exercise the failure path and none of them the path a person
   * actually walks. `reconnect-after-close.test.ts` says the same thing beside its own copy of
   * this method — a double that lacks a capability production always has is the lenient double
   * wearing a defect's clothes.
   *
   * Matched on the HEADER, the way the server matches it, and returned UNPARSED: these are
   * CANDIDATES and not claims, because a settings document in the same folder carries the same
   * header. Leaving the parse to the release is what stops a second parser here from quietly
   * disagreeing with the one that decides.
   */
  /**
   * SOMETHING HAPPENS WHILE THE RELEASE IS ASKING THE SERVER — the window, made real.
   *
   * The release's own IMAP round trip is the gap between the pass reading the row and the pass
   * writing it, and it is where a button press lands in practice: the route stays answerable
   * during a lease read on purpose (`observedTakeoverAt`'s docblock: *"the route must stay
   * answerable while a slow lease read is in flight, and making it wait on the gate would block a
   * button press behind an IMAP timeout"*). Awaited HERE rather than simulated by writing the row
   * from the test, so what lands is whatever the product's own door decides to write.
   */
  duringOwnRecordSearch: (() => Promise<void>) | null = null;
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    if (this.duringOwnRecordSearch) {
      const hook = this.duringOwnRecordSearch;
      this.duringOwnRecordSearch = null;
      await hook();
    }
    if (this.refuseOwnRecordSearch) throw releaseRefusal(this.refusalCode);
    return this.claims
      .filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`))
      .map((c) => ({ ...c }));
  }
  /**
   * Another install is already organizing this mailbox, and is still checking in.
   *
   * `authorizedAt` is the press its tenure rests on, and since 0.14.1 it is what decides whether
   * this holder KEEPS the mailbox against somebody who asks for it: kind stopped ranking and
   * decision-table rule 5 is deleted, so a live claim is refused a press only when it can point to
   * a newer press of its own. `null` — the default, and the steady state of every mailbox nobody
   * has pressed on — is exactly the holder a press now takes.
   */
  async seedForeignClaim(authorizedAt: Date | null = null): Promise<void> {
    await this.appendClaim(formatClaim({
      authorizedAt, capabilities: ["requests"],
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: new Date(), claimedAt: new Date("2026-08-30T09:00:00.000Z"), nonce: "held",
    }));
  }

  /**
   * SOMETHING ELSE TOOK OUR RECORD OUT OF THE FOLDER — the `0` a COMPLETE read answers with.
   *
   * The third state of a release, and the one that is easiest to mistake for the second: the
   * search ran, the folder was read whole, and none of the records in it are ours. That is an
   * ANSWER — a claim that aged out, or another client's expunge — and it means the same thing to
   * the person as a claim this pass removed: nothing of ours is holding the mailbox any more.
   *
   * Reachable without a fixture only by waiting out a staleness window, so it is a verb here. It
   * writes nothing to `nextUid`, because an expunge is not an append: {@link appends} must stay
   * where it was or the "did this pass renew" reads in this file would move for the wrong reason.
   */
  expungeEveryClaim(): void {
    this.claims.length = 0;
  }

  /** The install ids standing in this folder right now — the two-organizer question, answered. */
  installIds(): string[] {
    return this.claims
      // A MALFORMED record carries NO install id, and that is not a gap in the parse: it is
      // evidence that somebody claimed, which the election ranks and which produces `available`
      // rather than `organize`. What it is not is an install STANDING here, which is the question
      // this answers. `isMalformed` is the discriminant `ClaimRecord` carries — the union has no
      // tag field, and `parseClaim` returns either member. Runtime behaviour is unchanged: a
      // malformed record produced `undefined` here before and the filter below dropped it.
      .map((c) => {
        const rec = parseClaim(c.raw);
        return rec !== null && !isMalformed(rec) ? rec.installId : undefined;
      })
      .filter((v): v is string => typeof v === "string");
  }
  /** How many claims stand right now — occupancy. */
  get count(): number {
    return this.claims.length;
  }
  /**
   * How many have EVER been appended. Renewing is append-then-expunge, so this counts RENEWALS
   * where {@link count} counts occupancy — the only way from outside to see whether a pass
   * touched the lease at all, which is what "the heartbeat stopped" means.
   */
  get appends(): number {
    return this.nextUid - 1;
  }
}

const EMPTY_CURSOR = { folders: {} };

/** One message the server holds, as RFC822 bytes — `planChange` refuses a create with no `raw`. */
function arrival(uid: number): Buffer {
  return Buffer.from([
    `Message-ID: <fresh-${uid}@stranger.test>`,
    "From: stranger@elsewhere.test",
    "To: owner@trafficflow.test",
    `Subject: first mail ${uid}`,
    "Date: Wed, 02 Sep 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello",
  ].join("\r\n"), "utf8");
}

/** Every server-facing verb the cycle asked for, in order. */
interface Wire { verb: string; detail: string }

function recordingMailbox(
  wire: Wire[], meta: MemoryMeta, deliver: number[],
  /**
   * THE PROFILE STEP FAILS THE WAY IT FAILS ON A REAL PROVIDER — present and refusing.
   *
   * `onOrganize` returns immediately unless the adapter has a `profileIo` (`hasProfileIo`,
   * `apps/worker/src/profile.ts:86-88`), so a fake without one skips the profile step altogether
   * and cannot say anything about a pass whose profile step fails. With one, the read throws the
   * shape production throws: `readOrganizerProfile` wraps whatever the server did in
   * `ProfileUnavailableError` with `op: "list_profiles"` and the original as `cause`
   * (`packages/core/src/adapters/organizer-profile.ts:1443-1447`). Nothing on that path throws a
   * bare string — grep it — so a double that threw one would be measuring a fixture. `"clean"` is
   * a folder that reads cleanly and holds no settings message — the agree's sweep clearance.
   */
  profileFails: boolean | "clean" = false,
) {
  let handed = false;
  let closed = 0;
  const factory = (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } => ({
    leaseIo: () => meta,
    ...(profileFails === "clean"
      ? {
          profileIo: () => ({
            ensureMetaFolder: async (): Promise<void> => {},
            listProfileMessages: async (): Promise<never[]> => [],
            appendProfile: async (): Promise<void> => {},
            removeProfiles: async (): Promise<void> => {},
          }),
        }
      : profileFails
      ? {
          profileIo: () => ({
            ensureMetaFolder: async (): Promise<void> => {},
            listProfileMessages: async (): Promise<never> => {
              throw new ProfileUnavailableError(
                "the organizer profile in ohmail/_meta could not be read",
                { op: "list_profiles", cause: new Error("SEARCH refused") },
              );
            },
            appendProfile: async (): Promise<void> => {},
            removeProfiles: async (): Promise<void> => {},
          }),
        }
      : {}),
    /* THE READ-ONLY ACCESSOR, which the real `ImapAdapter` also exposes. A pre-consent install
       reaches for THIS and never `leaseIo()` — the whole point being that it has one method and
       cannot append. Backed by the same folder, so what it reports and what the gate would see
       cannot drift apart in this test. */
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> { closed++; },
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    /* THE VERB THAT CREATES `ohmail/*`. One call is the whole of "this install re-arranged
       somebody's mailbox before they were asked" — the folders are what a person sees. */
    async ensureFolders(): Promise<void> { wire.push({ verb: "ensureFolders", detail: "" }); },
    async changesSince(): Promise<ChangeBatch> {
      if (handed) return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR };
      handed = true;
      return {
        creates: deliver.map((uid) => ({
          type: "create" as const,
          locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator,
          raw: arrival(uid),
          // The server's receive clock, as a real FETCH reports it: the agree's window reads it.
          internalDate: new Date(),
        })) as ChangeBatch["creates"],
        moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR,
      };
    },
    async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
      wire.push({ verb: "move", detail: `${locator.ref}→${toFolder}` });
      return { folder: toFolder, ref: "7:41" };
    },
    async setFlags(locator: NativeLocator, flags: { seen?: boolean }): Promise<void> {
      wire.push({ verb: "setFlags", detail: `${locator.ref} seen=${String(flags.seen)}` });
    },
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
  return { factory, closes: () => closed };
}

const HOUR = 60 * 60 * 1000;

describe("the standalone door reads a mailbox until somebody agrees, and lets go when told", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const wire: Wire[] = [];
  /* EVERY DIAGNOSTIC THE ENGINE EMITTED, in order. `log: () => {}` stood here, which made the
     one thing a release that could not be confirmed produces — its sentence — the one thing this
     file could not read. The names are what is asserted: the details carry a mailbox id and the
     copy under test, and a test that pinned the copy would go red on a rewording. */
  const events: Array<{ event: string; detail?: unknown }> = [];

  afterEach(async () => {
    wire.length = 0;
    events.length = 0;
    fault.pending = 0;
    fault.calls = 0;
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(
    deliver: number[], meta: MemoryMeta, reuseDataDir?: string, profileFails: boolean | "clean" = false,
    /**
     * THE ENGINE'S OWN CLOCK, where a case is about a WINDOW rather than an ordering. The lapse
     * bound is "the last renewal this install wrote is staleAfter old", and the only honest way
     * to cross it in a test is to move the clock the engine reads — backdating the row would
     * move one of the two facts the bound compares and leave the other, measuring a fixture.
     * Absent, the engine reads the wall clock, which is what every case that predates this does.
     */
    clock?: () => Date,
  ): Promise<{
    sidecar: Sidecar; closes: () => number; dataDir: string;
  }> {
    /* A REUSED DATA DIRECTORY IS THE RE-ADD, and it is the only honest way to drive one here: on
       this door `enterLocalDoor` writes the shell's settings and replaces the engine, so a second
       connect of the same address is a second engine over the SAME store — the store being both
       the server and the mirror is what made the doubling visible in the first place. */
    const dataDir = reuseDataDir
      ?? await freshDataDir("ohmail-consent-");
    const mailbox = recordingMailbox(wire, meta, deliver, profileFails);
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "the machine somebody just installed it on",
      // Long enough that the timer never fires on its own: every pass here is one the test asked
      // for, so a failure is a decision and never a race.
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      adapterFactory: mailbox.factory,
      log: (event, detail) => { events.push({ event, detail }); },
      ...(clock ? { now: clock } : {}),
    });
    cleanups.push(async () => {
      await sidecar.stop().catch(() => undefined);
      if (!reuseDataDir) rmSync(dataDir, { recursive: true, force: true });
    });
    await sidecar.start();
    return { sidecar, closes: mailbox.closes, dataDir };
  }

  const auth = (s: Sidecar): HeadersInit => ({
    authorization: `Bearer ${s.sessionToken}`,
    "content-type": "application/json",
  });

  const row = async (s: Sidecar) => {
    const [r] = await s.db.select().from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId));
    return r!;
  };

  const mirrored = async (s: Sidecar): Promise<number> =>
    (await s.db.select({ id: messages.id }).from(messages)).length;

  const verbs = (): string[] => wire.map((w) => w.verb);

  /**
   * "Agree and start organizing" — the route the flow's consent screen presses.
   *
   * `pressedAt` backdates the stamp the route writes, which is the only way from out here to make
   * a press STALE against a holder that was pressed for more recently. The route itself always
   * uses the server's clock; this rewrites the column afterwards, which is the same row the gate
   * reads and is honest about being a fixture rather than a second door.
   */
  async function agree(s: Sidecar, pressedAt?: Date, intent?: "takeover"): Promise<string> {
    /* `intent: "takeover"` is the press after "Organize here instead" — over a live holder the
       door refuses any other, so the held-mailbox cases name it. */
    const res = await s.handle(new Request(
      `http://local/local/mailboxes/${s.world.mailboxId}/organize`,
      {
        method: "POST", headers: auth(s),
        body: JSON.stringify({ screening: { dormancyDays: 365 }, ...(intent ? { intent } : {}) }),
      },
    ));
    expect(res.status, "the consent route refused the agreement").toBe(200);
    if (pressedAt) {
      await s.db.update(mailboxes).set({ takeoverAuthorizedAt: pressedAt })
        .where(eq(mailboxes.id, s.world.mailboxId));
    }
    return ((await res.json()) as { outcome: string }).outcome;
  }

  /**
   * "Forget it and start empty" — the route the flow's Start over presses.
   *
   * Returns the BODY, because the route's answer is now the only place the outcome of the claim
   * release is stated: the removal is a 200 whether or not the claim came out of the folder — the
   * three acts behind it are best effort by design and none of them may turn a removal into an
   * error somebody cannot get past — so the status code cannot carry it and a helper that
   * discarded the body could not see it either.
   */
  async function forget(s: Sidecar, mailboxId?: string): Promise<{ claimReleased?: boolean }> {
    const res = await s.handle(new Request(
      `http://local/local/mailboxes/${mailboxId ?? s.world.mailboxId}`,
      { method: "DELETE", headers: auth(s) },
    ));
    expect(res.status, "the removal route refused").toBe(200);
    return (await res.json()) as { claimReleased?: boolean };
  }

  /** The removal WITHOUT asserting its status — the cases below are about what it answers. */
  async function removeRaw(s: Sidecar, mailboxId?: string): Promise<Response> {
    return s.handle(new Request(
      `http://local/local/mailboxes/${mailboxId ?? s.world.mailboxId}`,
      { method: "DELETE", headers: auth(s) },
    ));
  }

  /** The roster the Mailboxes pane renders, read through the route the pane reads it through. */
  async function listed(s: Sidecar): Promise<Array<{ id: string; status: string }>> {
    const res = await s.handle(new Request("http://local/mailboxes", { headers: auth(s) }));
    expect(res.status, "the roster route refused").toBe(200);
    return ((await res.json()) as { items: Array<{ id: string; status: string }> }).items;
  }

  /* ── ONE: THE PRE-CONSENT STATE IS A READER ────────────────────────────────────────────── */

  it("NOTHING IS RE-ARRANGED before anybody agrees — no folders, no moves, no claim", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41, 42], meta);

    /* THE MAIL SERVER'S SIDE, which is the side a person sees. `ohmail/*` is created by
       `ensureFolders` and by nothing else, so zero calls IS "the mailbox looks exactly as they
       left it". On the released build this was one call, before the first screen. */
    expect(verbs(), "this install created folders in a mailbox nobody had agreed to organize")
      .not.toContain("ensureFolders");
    expect(verbs(), "this install moved somebody's mail before asking").not.toContain("move");
    expect(meta.count, "this install claimed a mailbox nobody had agreed to hand it").toBe(0);
    expect(meta.appends, "the lease was written to at all").toBe(0);

    /* AND THE MIRROR IS BUILDING, which is the other half of the rule and the half that makes it
       a product rather than a refusal: *"mirror builds at once, nothing moves"*. A gate that
       stopped the drain would pass every assertion above and ship an empty app. */
    expect(await mirrored(sidecar), "the mirror did not build — a reader still reads").toBe(2);

    const mb = await row(sidecar);
    expect(mb.organizerRole, "the pre-consent state IS the reader mode").toBe("reader");
    expect(mb.status, "a reader is CONNECTED — not consenting is not being disconnected").toBe("connected");
    expect(mb.organizeConsentedAt, "nobody has agreed to anything yet").toBeNull();
  });

  it("AGREE — and only then does the mailbox change: folders, a claim, and the role", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    expect(verbs()).not.toContain("ensureFolders"); // the precondition, restated as a fact

    const outcome = await agree(sidecar);
    expect(outcome, "the first agreement is an authorization").toBe("authorized");

    /* The stamp is spent by the NEXT PASS — the route records a request, the lease is still the
       authority. That ordering is the route's own promise and it is what makes this safe to be a
       button at all: it cannot produce two organizers, only a request to become one. */
    await sidecar.syncUntilQuiet();

    const mb = await row(sidecar);
    expect(mb.organizerRole, "the agreement did not promote this install").toBe("organizer");
    expect(mb.organizeConsentedAt, "consent was not recorded").not.toBeNull();
    /* THE BASELINE, in the same transaction as the consent — without it the cutline is measured
       from the moment of the READ and the entire backlog is screened whatever window was chosen. */
    expect(verbs(), "the organizer did not create its folders").toContain("ensureFolders");
    expect(meta.count, "the organizer did not claim the mailbox").toBe(1);
  });

  /** The window step's press: the screen named what agreeing screens (`screenBacklog`). */
  async function agreeFromTheWindowStep(s: Sidecar, marker: boolean): Promise<void> {
    const res = await s.handle(new Request(`http://local/local/mailboxes/${s.world.mailboxId}/organize`, {
      method: "POST", headers: auth(s),
      body: JSON.stringify({ screening: { dormancyDays: 365 }, ...(marker ? { screenBacklog: true } : {}) }),
    }));
    expect(res.status).toBe(200);
  }

  const desiredOf = async (s: Sidecar): Promise<string[]> =>
    (await s.db.select({ d: folderState.desiredFolder }).from(folderState)).map((r) => r.d);

  it("AGREE FROM THE WINDOW STEP — the letter the reader already mirrored goes to the Screener", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta, undefined, "clean");
    expect(await desiredOf(sidecar)).toEqual(["INBOX"]);
    await agreeFromTheWindowStep(sidecar, true);
    await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar), "the agree's sweep did not give the letter to the Screener")
      .toEqual(["ohmail/Screener"]);
    expect(wire.filter((w) => w.verb === "move").map((w) => w.detail)).toEqual(["1:41→ohmail/Screener"]);
    expect(events.find((e) => e.event === "organizer_agree_sweep")?.detail).toMatchObject({ verdict: "swept", moved: 1 });
  });

  it("CONTROL — the same agree with no count on its screen moves nothing old", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta, undefined, "clean");
    await agreeFromTheWindowStep(sidecar, false);
    await sidecar.syncUntilQuiet();
    expect((await row(sidecar)).organizerRole).toBe("organizer");
    expect(await desiredOf(sidecar)).toEqual(["INBOX"]);
    expect(verbs()).not.toContain("move");
    expect(events.find((e) => e.event === "organizer_agree_sweep")?.detail).toMatchObject({ verdict: "not_an_agree" });
  });

  it("AN AGREE OVER A SETTINGS FOLDER THAT CANNOT BE READ moves nothing, and says why", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta, undefined, true);
    await agreeFromTheWindowStep(sidecar, true);
    await sidecar.syncUntilQuiet();
    expect((await row(sidecar)).organizerRole).toBe("organizer");
    expect(await desiredOf(sidecar), "a sweep ran over a folder nobody could read").toEqual(["INBOX"]);
    expect(verbs()).not.toContain("move");
    expect(events.find((e) => e.event === "organizer_agree_sweep")?.detail).toMatchObject({ verdict: "unread", why: "read_fault" });
  });

  it("A PRE-CONSENT INSTALL LOOKS AND DOES NOT CLAIM — the holder is on the row, unnamed nowhere", async () => {
    /*
     * The half the consent gate would otherwise take away. Returning before `readMailboxLease` is
     * required — that function APPENDS on an empty folder, so asking it is already taking the
     * mailbox — but it also means never learning WHO holds this one, and the holder is exactly
     * what the screens before consent have to say. Without the peek, somebody connecting a mailbox
     * their other machine organizes is shown the plain "here is what ohmail will do to this
     * mailbox" statement and agrees to take it without ever being told there is something to take
     * it from.
     *
     * `deriveOnboardingStep` row 3 is `organizerRole = 'reader' AND organizedBy` and Settings →
     * Mailboxes renders the same four columns, so the assertion is on the ROW: that is the fact
     * both surfaces read.
     */
    const meta = new MemoryMeta();
    await meta.seedForeignClaim();
    const before = meta.appends;
    const { sidecar } = await boot([41], meta);

    const mb = await row(sidecar);
    expect(mb.organizedByKind, "the row does not say who organizes this mailbox").toBe("cloud");
    expect(mb.organizedByName).toBe("ohmail Cloud");
    expect(mb.organizerState, "the holder is still checking in").toBe("held");
    expect(mb.organizerRole).toBe("reader");
    expect(mb.organizeConsentedAt).toBeNull();

    /* AND IT LOOKED WITHOUT TOUCHING ANYTHING. `appends` counts every write to the folder, so an
       unchanged count is the whole of "this install did not claim a mailbox somebody else is
       organizing" — which a count of standing claims could not say, since a claim appended and
       expunged leaves the same occupancy. */
    expect(meta.appends, "a pre-consent install wrote to another organizer's lease").toBe(before);
    expect(verbs()).not.toContain("ensureFolders");
    expect(verbs()).not.toContain("move");
  });

  /* ── TWO: REMOVAL MEANS REMOVAL ───────────────────────────────────────────────────────── */

  it("THE CLAIM IS RELEASED on removal — no phantom organizer left in ohmail/_meta", async () => {
    const meta = new MemoryMeta();
    const { sidecar, closes } = await boot([41], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(meta.count, "the precondition: this install holds the claim").toBe(1);
    const heldAt = meta.appends;

    const body = await forget(sidecar);

    /* THE WHOLE ASSERTION. A claim nobody holds stands another install down for the length of
       the staleness window, and the person who removed the mailbox has no way of knowing why
       their other machine will not take it. */
    expect(meta.count, "the removed install left its organizer claim standing").toBe(0);

    /* THE POSITIVE CONTROL FOR THE SENTENCE THE NEXT CASE DEMANDS. Its half of the pair asserts
       that a release which could not look SAYS SO; on its own that is a rule with no evidence it
       ever admits the ordinary removal, and a `claimReleased` wired to a constant `false` would
       satisfy it while telling every person who ever removes a mailbox that their claim was left
       behind. So the ordinary removal is asserted to report the truth too, by the same field. */
    expect(body.claimReleased, "an ordinary removal did not report its claim released").toBe(true);

    /* AND IT DOES NOT COME BACK. `syncUntilQuiet` is the poll's own body; on the released build
       it went on renewing every thirty seconds after the removal. `appends` counts renewals, so
       an unchanged count is "the lease was not touched again" — which a count of standing claims
       could not distinguish from "renewed and expunged". */
    await sidecar.syncUntilQuiet();
    expect(meta.appends, "the removed install renewed its claim on a later pass").toBe(heldAt);
    expect(closes(), "the IMAP login was left open on a mailbox that is gone").toBeGreaterThan(0);
  });

  it("A RELEASE THAT COULD NOT LOOK IS SAID SO — the removal never reports a claim it left standing", async () => {
    /*
     * THE OTHER HALF OF THE SAME INVARIANT, and the one the released build had no way to state.
     *
     * The case above is the release WORKING. This is the release failing, which is not a
     * hypothetical: `releaseMailboxClaim` enumerates this install's own records by asking the
     * server for them, and that enumeration answers "could not" when the search is refused, when
     * the descending walk comes back short, and when the folder is over its ceiling. `ohmail/_meta`
     * is a folder anyone with append rights can grow, so the last one is reachable by ordinary use.
     *
     * When it happens the claim STAYS — nothing here pretends otherwise, and it must not: a
     * partial release is worse than none, which is exactly why the release refuses rather than
     * removing what it happens to see. What was wrong is that the failure was caught, written to a
     * log nobody reads, and the person told the mailbox was gone. Their other machine then refuses
     * that mailbox for a staleness window and blames an install that no longer exists.
     *
     * So the assertion is not "the claim went away". It is that the ANSWER does not claim it did.
     */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(meta.count, "the precondition: this install holds the claim").toBe(1);

    meta.refuseOwnRecordSearch = true;

    const body = await forget(sidecar);

    /* THE PRECONDITION OF THE CASE, ASSERTED RATHER THAN ASSUMED. Without it a `refuseOwnRecordSearch`
       that did nothing would leave the claim released and `claimReleased` false for some other
       reason, and the assertion below would pass while measuring nothing. */
    expect(meta.count, "the refused search still let the claim be removed").toBe(1);

    /* THE HALF THAT WAS MISSING. Swallowed, this reads to the person as a mailbox fully let go. */
    expect(body.claimReleased, "the removal reported a claim it had not released").toBe(false);
  });

  /* ── THREE: A WIPE THAT DID NOT WIPE IS NOT A REMOVAL ─────────────────────────────────── */

  /**
   * ── THE REMOVAL THAT REPORTED SUCCESS OVER MAIL IT HAD NOT TAKEN ────────────────────────
   *
   * The wipe was wrapped in a `try/catch` that only LOGGED. So a removal whose local wipe failed
   * answered 200, dropped the runtime and told the person the mailbox was gone while every
   * message was still on their disk — and the log's own remedy, *"removing the mailbox again
   * clears it"*, could not run: the wipe needs the runtime the removal had just dropped, so the
   * second attempt skipped the wipe entirely and the person was one re-add away from seeing
   * every message twice.
   *
   * A removal that did not remove is not a removal. It is refused, the runtime and the roster row
   * stay, and the retry is the same press.
   */
  it("A FAILED WIPE FAILS THE REMOVAL — the mail is still here, and so is the mailbox", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41, 42, 43], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(await mirrored(sidecar), "the precondition: there is a mirror to fail to clear").toBe(3);
    const mailboxId = sidecar.world.mailboxId;

    fault.pending = 1;
    const res = await removeRaw(sidecar);

    /* NOT A 200. The status code is the whole of what the pane can act on before it reads a
       body, and a 200 here is the sentence "it is gone" about mail that is not. */
    expect(res.status, "a removal that left the mail on this machine answered a success").toBe(503);
    const wire = (await res.json()) as { error?: { code?: string } };
    expect(wire.error?.code, "the refusal does not name itself, so no surface can say it")
      .toBe("local_mirror_not_cleared");

    /* THE STATE IT LEFT — the two halves the released build got wrong. The mail is here, which
       is the fact the 200 was false about; and the mailbox is still on the roster the pane
       renders, so there is something to press Remove on again. */
    expect(await mirrored(sidecar), "the wipe was refused and the mail went anyway").toBe(3);
    expect(
      (await listed(sidecar)).map((m) => m.id),
      "the refused removal took the mailbox off the roster — the retry has nothing to press",
    ).toContain(mailboxId);

  });

  /**
   * ── THE RUNTIME, WHICH IS WHAT MADE THE OLD LOG'S OWN REMEDY UNREACHABLE ────────────────
   *
   * Its own case, and the status is deliberately not asserted here: this is the half the released
   * build got wrong SECOND. It logged *"removing the mailbox again clears it"* and then dropped
   * the runtime the wipe depends on, so the second attempt found no runtime, skipped the wipe
   * entirely and reported success over the same mail — with the person one re-add away from
   * seeing every message twice.
   *
   * The assertion is therefore about the SECOND press: it clears the mailbox. Nothing else can
   * tell a kept runtime from a dropped one from out here, and nothing else is what the person
   * experiences.
   */
  it("…AND THE RETRY CLEARS IT — the runtime the wipe needs is still on the roster", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41, 42, 43], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(await mirrored(sidecar)).toBe(3);

    fault.pending = 1;
    await removeRaw(sidecar);
    expect(await mirrored(sidecar), "the precondition: the first press cleared nothing").toBe(3);

    const second = await removeRaw(sidecar);
    expect(second.status, "the second removal was refused").toBe(200);
    expect(
      await mirrored(sidecar),
      "the second press reached no wipe — the first removal dropped the runtime it needs",
    ).toBe(0);
  });

  /**
   * NOTHING RETRIES SILENTLY. A person who has been told the removal did not happen must not
   * have it happen later without asking: the mail on this disk is the only copy their window
   * renders, and a background sweep taking it would be the 200 this fix removed, arriving late.
   */
  it("…and nothing retries it behind them — one attempt per press, and the mail stays", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41, 42], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();

    fault.pending = 1;
    expect((await removeRaw(sidecar)).status).toBe(503);
    const attempted = fault.calls;
    expect(attempted, "the press did not reach the wipe exactly once").toBe(1);

    /* THE POLL'S OWN BODY, which is where a silent retry would live. */
    await sidecar.syncUntilQuiet();
    expect(fault.calls, "something behind the person ran the wipe again").toBe(attempted);
    expect(await mirrored(sidecar), "the mail went without a second press").toBe(2);
  });

  /**
   * THE POSITIVE CONTROL. Without it the rule above is satisfied by a removal that always
   * refuses — which would take the door out away from everybody to protect the few whose store
   * refuses a delete.
   */
  it("CONTROL: the ordinary removal still removes, and the mail goes with it", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41, 42], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(await mirrored(sidecar)).toBe(2);

    const res = await removeRaw(sidecar);
    expect(res.status, "an ordinary removal was refused").toBe(200);
    expect(await mirrored(sidecar), "the ordinary removal left the mail behind").toBe(0);
    expect(fault.calls, "the ordinary removal did not reach the wipe").toBe(1);
  });

  it("AN AWAY REPLY DOES NOT PIN THE MAILBOX — the removal still removes, and the ledger goes", async () => {
    /* THE SHIPPED SHAPE, driven through the route a person presses. Mail 0118 keyed the away
       ledger to `messages`, so the wipe's own delete was refused for every install whose responder
       had answered anybody: the removal threw before the receipt, the mail stayed on disk and the
       window was never told. The key stays — it clears the pointer now — and the removal takes the
       ledger with the mailbox, which is what the server's erasure already did. */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41, 42], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    const [seen] = await sidecar.db.select({ id: messages.id }).from(messages);
    await sidecar.db.insert(awayReplies).values({
      accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId,
      messageId: seen!.id, sender: "correspondent@elsewhere.example", outcome: "sent",
    });

    const res = await removeRaw(sidecar);
    expect(res.status, "the away ledger row refused the removal").toBe(200);
    expect(await mirrored(sidecar), "the removal left the mail behind").toBe(0);
    expect(
      (await sidecar.db.select({ id: awayReplies.id }).from(awayReplies)).length,
      "the removed mailbox's away ledger stayed on disk",
    ).toBe(0);
  });

  /**
   * "Stop organizing here" — the route the Settings pane's button presses.
   *
   * `POST /mailboxes/:id/release` on the SHARED table, which is the route the pane's button
   * presses on this door too — `bridgeFetch` in `DesktopMailboxes.tsx` names it without a
   * `/local` prefix, and the seal case at the bottom of this file establishes that the shared
   * table is served at the root here on the same per-launch bearer. It writes ONE column
   * (`release_requested_at`) and opens no socket: the claim it is asking to give up lives in the
   * customer's IMAP folder, and expunging it is the organizer's own next pass. 202 rather than
   * 200 for exactly that reason — the ceasing has not happened yet — so the status is asserted
   * here, since a 200 would mean the route had started reporting a release it cannot have made.
   */
  async function stopOrganizing(s: Sidecar): Promise<string> {
    const res = await s.handle(new Request(
      `http://local/mailboxes/${s.world.mailboxId}/release`,
      { method: "POST", headers: auth(s), body: "{}" },
    ));
    expect(res.status, "the release route refused the press").toBe(202);
    return ((await res.json()) as { outcome: string }).outcome;
  }

  /**
   * THE RELEASE PASS THE PRESS RANG, SETTLED. The route's 202 rings this mailbox's runtime
   * (`withPullKick`), so the release pass runs on its own; a `syncUntilQuiet()` after it is a
   * SECOND pass, which spends a takeover press the release yielded to. A case that reads the row
   * as the release left it waits for that pass's own last word instead.
   */
  async function releasePassSettled(from: number): Promise<string> {
    const ends = ["organizer_claim_release_yielded_to_press", "organizer_released",
      "organizer_released_by_lapse", "organizer_claim_release_unconfirmed"];
    for (let i = 0; i < 400; i++) {
      const hit = events.slice(from).find((e) => ends.includes(e.event));
      if (hit) return hit.event;
      await new Promise((r) => setTimeout(r, 25));
    }
    return "none";
  }

  it("A RELEASE THAT COULD NOT LOOK IS NOT RECORDED AS ONE — the mailbox stays organized here", async () => {
    /*
     * THE SAME INVARIANT AS THE REMOVAL ABOVE, ON THE PATH A PERSON REACHES FIRST — and the one
     * place it was still written the other way round.
     *
     * The poll's release arm called the release, logged the outcome only when it had removed
     * something, and then flipped the row UNCONDITIONALLY: `organizer_role` to `reader`, the five
     * holder columns to null, `release_requested_at` cleared, `organizer_released_at` stamped. So
     * the one answer that means "this install may still hold the claim" produced a row byte-
     * identical to a completed release. The pane said the mailbox had been let go; the claim went
     * on standing in `ohmail/_meta`; and the person's other computer refused the mailbox for the
     * length of the staleness window, blaming an organizer this one had already reported gone.
     *
     * The request is what makes the retry ordinary: it stays on the row, so the very next poll
     * runs this arm again. Nothing loops in here — a folder that refused a search refuses it for
     * reasons that do not clear in milliseconds.
     *
     * WATCHED RED at the freeze: with the arm as it stood, `organizerRole` reads `reader` and
     * `organizerReleasedAt` is stamped on a mailbox whose claim is still in the folder below.
     */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(meta.count, "the precondition: this install holds the claim").toBe(1);

    expect(await stopOrganizing(sidecar), "the press was not recorded as a request").toBe("requested");
    /* WHAT THE ROW SAID BEFORE THE REFUSED PASS. `organizer_event_at` is what makes the check
       below a statement about the WHOLE row rather than about four columns: the release write
       stamps it, so an unchanged stamp is "this pass wrote nothing", which no write that happened
       to leave the other columns alone could satisfy. */
    const eventAtBefore = (await row(sidecar)).organizerEventAt;

    meta.refuseOwnRecordSearch = true;
    await sidecar.syncUntilQuiet();

    /* THE PRECONDITION OF THE CASE, ASSERTED RATHER THAN ASSUMED — a `refuseOwnRecordSearch`
       that did nothing would leave the claim released and every assertion below measuring a
       completed release with a fixture flag set. */
    expect(meta.count, "the refused search still let the claim be removed").toBe(1);

    const pending = await row(sidecar);
    /* THE WHOLE ASSERTION, and it is about the ROW because the row is what both surfaces read.
       A `reader` here is the product telling somebody a handover is done while the thing that
       blocks the handover is still in their mailbox. */
    expect(pending.organizerRole, "an unconfirmed release demoted this install anyway").toBe("organizer");
    expect(
      pending.releaseRequestedAt,
      "the request was spent by a pass that released nothing, so no later poll will retry it",
    ).not.toBeNull();
    expect(
      pending.organizerReleasedAt,
      "the row records a release that had not happened",
    ).toBeNull();
    /* AND THE ROW WAS NOT WRITTEN AT ALL, which is the assertion the four above add up to. Its
       own precondition is asserted first: a stamp that were null on both sides would measure
       nothing, and this is where a check like it goes vacuous.

       NOT the five holder columns. They read null for an organizer on this door — the only writer
       of `organized_by_install_id` here is `notePeekedHolder`, the READER's peek — so a check that
       they still name this install measures the fixture, not the release. Nulling them is part of
       the release write and is therefore covered by the stamp. */
    expect(
      eventAtBefore,
      "nothing had stamped the organizing event before the refused pass; this check is vacuous",
    ).not.toBeNull();
    expect(
      pending.organizerEventAt?.getTime(),
      "the refused pass wrote to the row",
    ).toBe(eventAtBefore?.getTime());

    /* THE SENTENCE, WHICH IS THE ONLY THING THIS PASS PRODUCES. `organizer_claim_release_failed`
       says the search failed; this says what the failure MEANT here, which is the thing an
       operator reads and the thing the three call sites of `releaseOwnClaim` do not share. */
    expect(events.map((e) => e.event), "the pass said nothing about a release it could not confirm")
      .toContain("organizer_claim_release_unconfirmed");
    expect(events.map((e) => e.event), "a release that could not look was announced as one")
      .not.toContain("organizer_released");
    /* THE REFUSAL AS PRODUCTION RAISES IT: the io's own class and code reach the log. The
       `null`-answering double this replaced surfaced as `search_refused`, a code the real io's
       read never produces. */
    const failed = events.find((e) => e.event === "organizer_claim_release_failed");
    expect((failed?.detail as { err?: unknown } | undefined)?.err,
      "the refused read did not reach the log as the io's own refusal")
      .toMatchObject({ name: "ClaimReleaseError", code: "unreadable" });

    /* ── AND THE NEXT CYCLE FINISHES IT, which is what makes the arm above a retry rather than a
         dead end — and is the `> 0` arm's positive control on this door: a rule whose every case
         asserts a refusal has no evidence it ever lets the ordinary release through. */
    meta.refuseOwnRecordSearch = false;
    await sidecar.syncUntilQuiet();

    expect(meta.count, "the claim is still in the folder after a readable pass").toBe(0);
    const done = await row(sidecar);
    expect(done.organizerRole, "the retry did not release the mailbox").toBe("reader");
    expect(done.releaseRequestedAt, "the honoured request was not spent").toBeNull();
    expect(done.organizerReleasedAt, "the completed release was not recorded").not.toBeNull();
    expect(done.organizedByInstallId, "a released mailbox still names a holder").toBeNull();
  });

  it("I CHANGED MY MIND — a press before the next poll cancels the release, and the mailbox is never let go", async () => {
    /*
     * THE COUNTERMAND, WHICH ON THIS DOOR HAD NO WAY OF BEING MADE. `mailbox-service.ts` rules it
     * for the hosted door and describes the failure in the person's own terms — press "Stop
     * organizing here", change your mind two seconds later, press "Organize here": 200
     * `already_organizing`, nothing written, and the release goes through a minute later anyway.
     * The exemption was never ported here, so on the desktop and the standalone install the row
     * is still `organizer` and still consented while the request stands, both terms of the
     * precondition hold, and the press wrote nothing.
     *
     * It is the release's only exit, and since the release stopped recording itself when the mail
     * server would not confirm the record is gone, "only" is literal: on a server where that read
     * keeps failing the request stands until this press cancels it.
     */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(meta.count, "the precondition: this install holds the claim").toBe(1);

    expect(await stopOrganizing(sidecar), "the press was not recorded as a request").toBe("requested");
    expect((await row(sidecar)).releaseRequestedAt, "the request was not recorded").not.toBeNull();

    /* THE SECOND PRESS, before any poll has acted on the first. */
    const answer = await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
      mailboxId: sidecar.world.mailboxId, now: new Date(),
    });
    expect(answer.outcome, "the door refused a countermand it is the only door for").toBe("authorized");
    expect(
      (await row(sidecar)).releaseRequestedAt,
      "the press left the request standing, so the next poll releases the mailbox anyway",
    ).toBeNull();

    await sidecar.syncUntilQuiet();
    await sidecar.syncUntilQuiet();
    const after = await row(sidecar);
    expect(after.organizerRole, "the mailbox was let go against the countermand").toBe("organizer");
    expect(after.organizerReleasedAt, "a release was recorded after it had been cancelled").toBeNull();
    expect(meta.count, "this install does not hold the claim it was told to keep").toBe(1);
  });

  it("…and an ordinary second press on a healthy mailbox is still not a second becoming", async () => {
    /*
     * THE POSITIVE CONTROL FOR THE RELAXATION ABOVE, and it is the precondition's own purpose
     * stated as a test: *"a second press is not a second becoming and leaves no spendable takeover
     * stamp on a healthy mailbox"*. Relaxing a refusal without this would let every press leave a
     * stamp lying around — and a spendable stamp is what lets a gate seize a mailbox past a live
     * foreign claim, so the cost of getting it wrong is two organizers.
     *
     * MUTATION: drop `row.releaseRequestedAt === null` from either door's precondition and this
     * goes red on `already_organizing`, with a stamp on the row.
     */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    const healthy = await row(sidecar);
    expect(healthy.organizerRole, "the precondition: a healthy organizer row").toBe("organizer");
    expect(healthy.releaseRequestedAt, "nothing has been asked of this mailbox").toBeNull();
    expect(healthy.takeoverAuthorizedAt, "the promotion did not spend the first press's stamp").toBeNull();

    const answer = await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
      mailboxId: sidecar.world.mailboxId, now: new Date(),
    });
    expect(answer.outcome, "a second press on a healthy mailbox was treated as a new becoming")
      .toBe("already_organizing");
    expect(
      (await row(sidecar)).takeoverAuthorizedAt,
      "a press that had nothing to ask for left a spendable stamp on the row",
    ).toBeNull();
  });

  it("A PASS WHOSE PROFILE STEP FAILS STILL HONOURS THE RELEASE — the person's instruction is not best-effort", async () => {
    /*
     * MEASURED, BECAUSE THE ORDER IS THE WHOLE CLAIM. Publishing the mailbox's portable settings is
     * best-effort — it can fail every pass on a provider whose `ohmail/_meta` will not answer the
     * way this code asks — and "stop organizing this mailbox" is not best-effort: it is the one
     * instruction a person gave explicitly and expects to see carried out.
     *
     * The two are already independent, and this case pins the ordering that makes them so:
     * `drainPass` (`engine.ts:4582`) calls `mayOrganize()` (`:4634`), whose release arm runs first
     * of all; the profile write is downstream at `:4856` (`profileSync.onOrganize`) and again in
     * `drain` at `:4329` (`armHoldFromFolder`), and both of that class's call sites catch and log
     * rather than throw (`apps/worker/src/profile.ts:540-546` and `:949-959`). So a profile step
     * that fails cannot starve the release — and this is the guard that keeps it that way, because
     * the ordering is invisible at either site and one `await` moved would reverse it.
     */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta, undefined, true);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(meta.count, "the precondition: this install holds the claim").toBe(1);
    /* THE PROFILE STEP REALLY DID RUN AND REALLY DID FAIL. Without this the case passes on a fake
       whose `profileIo` was never reached, which is exactly what a fake WITHOUT one does. */
    expect(
      events.map((e) => e.event),
      "the profile step never failed, so nothing here is about a pass that failed at it",
    ).toContain("organizer_profile_write_failed");
    /* ── AND THE FAILURE LINE CARRIES THE ERROR, NOT ITS MESSAGE STRING (0.14.1) ────────────
     *
     * `apps/worker/src/profile.ts` handed the logger `err instanceof Error ? err.message :
     * String(err)` — a STRING in the `err` slot, under a comment claiming "`err` reduces to
     * class + code in `log.ts`". The logger reduces the THROWN VALUE to class + code; handed a
     * string it reports `errorClass:"String" errorCode:null` and, by design, no message — so a
     * live provider's every profile failure logged as a bare "String" with nothing in it
     * (measured at RC3: `organizer_profile_write_failed op:list_profiles errorClass:"String"`),
     * and a real `ProfileUnavailableError` with the provider's refusal in its `cause` was
     * discarded at the call site. The thrown value itself travels now; the logger owns the
     * reduction, which is the whole point of having one.
     *
     * WATCHED RED before profile.ts was fixed: `detail.err` here was the message string. */
    const failed = events.find((e) => e.event === "organizer_profile_write_failed");
    const detail = (failed?.detail ?? {}) as { err?: unknown; op?: unknown };
    expect(detail.err, "the log line carries the message string, not the thrown error")
      .toBeInstanceOf(Error);
    expect((detail.err as Error).name, "the error's class was lost on the way to the logger")
      .toBe("ProfileUnavailableError");
    expect(detail.op, "the failing step's name was dropped").toBe("list_profiles");

    expect(await stopOrganizing(sidecar), "the press was not recorded as a request").toBe("requested");
    await sidecar.syncUntilQuiet();

    const after = await row(sidecar);
    expect(after.organizerRole, "a failing profile step withheld the release").toBe("reader");
    expect(after.releaseRequestedAt, "the request was left standing by the profile failure").toBeNull();
    expect(after.organizerReleasedAt, "the release was not recorded").not.toBeNull();
    expect(meta.count, "the claim is still in the folder").toBe(0);
  });

  it("A PRESS THAT LANDS DURING A RELEASE WINS — the release yields and the mailbox stays organized here", async () => {
    /*
     * ── THE RACE, AND IT IS THE PERSON'S LAST INSTRUCTION THAT IS AT STAKE ──────────────────
     *
     * The pass reads the row, spends an IMAP round trip releasing the claim, and then writes the
     * row. A press that lands in that gap was never offered to this pass, and the write clears
     * `takeover_authorized_at` unconditionally — so "organize here again" is answered, recorded
     * as a completed release, and the person's later instruction is reversed with nothing anywhere
     * saying so. The file already knows the shape: the stand-down's own write forty lines further
     * down clears only THE STAMP THIS PASS READ, with `IS NOT DISTINCT FROM` and a paragraph
     * about why. The release's write never learned it.
     *
     * `duringOwnRecordSearch` puts the press in the real gap, through the real ceremony, and the
     * two assertions before the row is read are what stop this from measuring nothing: that the
     * search ran at all, and that the door ACCEPTED the press. A refused press leaves no stamp,
     * and every assertion below would then pass against a release that had nothing to protect.
     */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(meta.count, "the precondition: this install holds the claim").toBe(1);

    let pressOutcome: string | null = null;
    meta.duringOwnRecordSearch = async () => {
      const answer = await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
        mailboxId: sidecar.world.mailboxId, now: new Date(),
      });
      pressOutcome = answer.outcome;
    };
    const mark = events.length;
    expect(await stopOrganizing(sidecar), "the press was not recorded as a request").toBe("requested");
    expect(await releasePassSettled(mark), "the release pass the press rang never ended").not.toBe("none");

    expect(pressOutcome, "the release never asked the server, so no press could have raced it")
      .not.toBeNull();
    /* THE DOOR HAS TO HAVE ACCEPTED IT. On a release-pending row the hosted door does — its
       `releasePending` arm exists for exactly this press and says so — and if this door refuses,
       the rest of this case measures a release with no stamp to clobber. */
    expect(pressOutcome, "the press was refused while a release was pending, so nothing was written")
      .toBe("authorized");

    const raced = await row(sidecar);
    expect(raced.takeoverAuthorizedAt, "the release cleared a press it had never seen").not.toBeNull();
    expect(raced.organizerReleasedAt, "a release recorded itself over a newer press").toBeNull();
    expect(raced.organizerRole, "the release demoted an install the person had just re-authorized")
      .toBe("organizer");

    /* ── AND THE PRESS IS HONOURED, which a yield alone does not deliver: the request is still on
         the row, so a later pass reaches the release arm again with the press now among the values
         it read, and would spend it then. Two polls, because the yielding pass claims nothing. */
    await sidecar.syncUntilQuiet();
    await sidecar.syncUntilQuiet();
    const after = await row(sidecar);
    expect(after.organizerRole, "a later poll destroyed the press after all").toBe("organizer");
    expect(after.organizerReleasedAt, "the mailbox was recorded released against the press").toBeNull();
    expect(meta.count, "the mailbox is organized here, so this install holds the claim").toBe(1);
  });

  it("…AND ON THE LAPSE ARM TOO — a press during a lapsed release wins, and the mailbox stays here", async () => {
    /*
     * The yield case above drives the CONFIRMED arm. A release the server never confirms reaches
     * the same compare-and-set through the lapse bound, so the press that lands during its round
     * trip is driven here: refused read, clock past the staleness window, press inside the read.
     * `yielded_to_press` without `unconfirmed` is what says the lapse arm reached the write.
     * MUTATION WATCHED RED: drop the compare terms when `releasedByLapse` and the press is cleared.
     */
    const meta = new MemoryMeta();
    let t = Date.now();
    const { sidecar } = await boot([41], meta, undefined, false, () => new Date(t));
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(meta.count, "the precondition: this install holds the claim").toBe(1);

    meta.refuseOwnRecordSearch = true;
    meta.refusalCode = "over_ceiling";
    let pressOutcome: string | null = null;
    meta.duringOwnRecordSearch = async () => {
      t += 61_000; // past staleAfter (60 s here) since the last renewal, so this pass's release lapses
      const answer = await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
        mailboxId: sidecar.world.mailboxId, now: new Date(t),
      });
      pressOutcome = answer.outcome;
    };
    const mark = events.length;
    expect(await stopOrganizing(sidecar), "the press was not recorded as a request").toBe("requested");
    expect(await releasePassSettled(mark), "the release pass the press rang never ended").not.toBe("none");

    expect(pressOutcome, "the release never asked the server, so no press could have raced it")
      .toBe("authorized");
    const seen = events.map((e) => e.event);
    expect(seen, "the release read was not refused, so this is not the lapse arm")
      .toContain("organizer_claim_release_failed");
    expect(seen, "the pass stopped at the unconfirmed arm and never reached the write")
      .not.toContain("organizer_claim_release_unconfirmed");
    expect(seen, "the lapse arm did not yield to the press").toContain("organizer_claim_release_yielded_to_press");

    const raced = await row(sidecar);
    expect(raced.takeoverAuthorizedAt, "the lapse cleared a press it had never seen").not.toBeNull();
    expect(raced.organizerReleasedAt, "a lapse recorded itself over a newer press").toBeNull();
    expect(raced.organizerRole, "the lapse demoted an install the person had just re-authorized")
      .toBe("organizer");

    meta.refuseOwnRecordSearch = false;
    await sidecar.syncUntilQuiet();
    await sidecar.syncUntilQuiet();
    const after = await row(sidecar);
    expect(after.organizerRole, "a later poll destroyed the press after all").toBe("organizer");
    expect(after.organizerReleasedAt, "the mailbox was recorded released against the press").toBeNull();
    expect(seen.concat(events.map((e) => e.event)), "the lapse announced a release the press overtook")
      .not.toContain("organizer_released_by_lapse");
  });

  it("A COMPLETE READ THAT FINDS NOTHING OF OURS IS AN ANSWER — 0 releases the mailbox", async () => {
    /*
     * THE THIRD ARM, and the reason the fix is a three-way split rather than a truthiness check.
     *
     * `0` is not a failure: the search ran, the folder was read whole, and no record in it is
     * ours — a claim that aged out while the person was deciding, or another client's expunge.
     * Nothing of ours holds the mailbox, which is exactly what a person pressing the button
     * asked for, so the row is flipped and stamped the same way a deletion flips it.
     *
     * Written as its own case because the cheap fix for the defect above — "flip only when
     * something was removed" — passes every assertion in that case and strands this one for ever:
     * the request would sit on the row unspent, the pane would go on saying the mailbox is
     * organized here, and no poll could ever finish it, because there is nothing left to remove.
     * MUTATION: change the caller's `released === null` arm to `released < 1` and this goes red
     * on `organizerRole`, with the request still standing.
     */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(meta.count, "the precondition: this install holds the claim").toBe(1);
    const appendsBefore = meta.appends;

    expect(await stopOrganizing(sidecar)).toBe("requested");
    /* THE CLAIM GOES AWAY WITHOUT US — an expunge, not a removal by this install, so the release
       below reads a complete folder and finds none of its own records in it. */
    meta.expungeEveryClaim();
    await sidecar.syncUntilQuiet();

    const done = await row(sidecar);
    expect(done.organizerRole, "a confirmed absence did not release the mailbox").toBe("reader");
    expect(done.releaseRequestedAt, "the honoured request was not spent").toBeNull();
    expect(done.organizerReleasedAt, "the release was not recorded").not.toBeNull();
    /* AND NOTHING WAS WRITTEN TO THE FOLDER ON THE WAY OUT. `appends` counts every write, so an
       unchanged count is the whole of "the release did not renew the claim it was giving up" —
       which the arm's ordering exists for and which an occupancy count cannot say. */
    expect(meta.appends, "the release renewed a claim it had been told to give up").toBe(appendsBefore);
  });

  /* A ONE-SHOT THE STORE'S CLOCK WROTE. The store keeps microseconds and the pass reads a
     millisecond `Date`, so an exact compare never matched it: the Stop was never recorded (every
     poll yielded "to the press") and a stand-down never spent the press it read. 407 µs is under
     500, so these are red whether the parser truncates or rounds. Postgres-only planting SQL. */
  it("a Stop the store's clock wrote is recorded on the next pass", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(meta.count, "the precondition: this install holds the claim").toBe(1);
    await sidecar.db.execute(sql`update mailboxes set release_requested_at =
      date_trunc('milliseconds', now()) + interval '407 microseconds' where id = ${sidecar.world.mailboxId}`);
    meta.expungeEveryClaim();
    await sidecar.syncUntilQuiet();

    const done = await row(sidecar);
    expect(events.map((e) => e.event), "the release yielded to the very press it was answering")
      .not.toContain("organizer_claim_release_yielded_to_press");
    expect(done.organizerReleasedAt, "the release was not recorded").not.toBeNull();
    expect(done.releaseRequestedAt, "the honoured request was not spent").toBeNull();
  });

  it("a stand-down spends a press the store's clock wrote, and later polls ring nothing", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect((await row(sidecar)).organizerRole).toBe("organizer");
    // An older press of ours, then a holder pressed for later takes the mailbox.
    await sidecar.db.execute(sql`update mailboxes set takeover_authorized_at =
      date_trunc('milliseconds', now()) - interval '1 hour' + interval '407 microseconds'
      where id = ${sidecar.world.mailboxId}`);
    await meta.seedForeignClaim(new Date());
    await sidecar.syncUntilQuiet();

    const after = await row(sidecar);
    expect(after.organizerRole, "the precondition: the later press won").toBe("reader");
    expect(after.takeoverAuthorizedAt, "the stand-down left the press it read standing").toBeNull();
    const rings = async (): Promise<number> => (await sidecar.db.select({ seq: changeLog.seq }).from(changeLog)
      .where(and(eq(changeLog.entityType, "mailbox_profile"), eq(changeLog.entityId, sidecar.world.mailboxId))))
      .length;
    const settled = await rings();
    await sidecar.syncUntilQuiet();
    await sidecar.syncUntilQuiet();
    expect(await rings(), "a later poll stood the mailbox down again and rang").toBe(settled);
  });

  it("A RELEASE THE SERVER NEVER CONFIRMS ENDS AT THE LAPSE — the idle is bounded, not for ever", async () => {
    /*
     * MEASURED ON A REAL PROVIDER AT RC3: `organizer_claim_release_failed` followed by
     * `organizer_claim_release_unconfirmed` on EVERY poll — 38 pairs in one session, surviving an
     * app restart — because the server refused the release's enumeration each time. The retry arm
     * is right per pass and unbounded as a whole: the person pressed "Stop organizing here" and
     * could never stop, and while the request stood every pass arranged nothing and renewed
     * nothing — a mailbox nothing was organizing, reported as organized here.
     *
     * The bound is the LAPSE, and it is the lease's own arithmetic: once the last renewal THIS
     * INSTALL wrote is `staleAfter` old — a fact this process holds — every other install already
     * reads the claim as stale and can take the mailbox past it. At that point "your claim is
     * still in the folder" stops meaning anything: the handover the person asked for is available
     * everywhere, so the row records the organizing as ended rather than promising a confirmation
     * the server has refused for a whole window.
     *
     * WATCHED RED at RC3-final: the second `syncUntilQuiet` below left `organizer` +
     * request standing (the 38-pairs shape), and `organizer_released_by_lapse` appeared nowhere.
     */
    const meta = new MemoryMeta();
    let t = Date.now();
    const { sidecar } = await boot([41], meta, undefined, false, () => new Date(t));
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(meta.count, "the precondition: this install holds the claim").toBe(1);
    const appendsBefore = meta.appends;

    expect(await stopOrganizing(sidecar), "the press was not recorded as a request").toBe("requested");
    meta.refuseOwnRecordSearch = true;

    /* INSIDE THE WINDOW: the retry arm, unchanged. A flip here would be spending the person's
       request on the first hiccup — the claim is still fresh to every other install, so recording
       "released" would be false in exactly the direction the unconfirmed arm exists to prevent. */
    t += 30_000;
    await sidecar.syncUntilQuiet();
    const pending = await row(sidecar);
    expect(pending.organizerRole, "the lapse fired inside the staleness window").toBe("organizer");
    expect(pending.releaseRequestedAt, "the request was spent inside the window").not.toBeNull();

    /* PAST IT (staleAfter is 60s here): the claim in the folder is stale to every reader. */
    t += 31_000;
    await sidecar.syncUntilQuiet();
    expect(meta.count, "the claim could not be removed, so the folder still holds it").toBe(1);
    const done = await row(sidecar);
    expect(done.organizerRole, "the release never ends — the row still says organizer").toBe("reader");
    expect(done.releaseRequestedAt, "the request outlived the window it promises").toBeNull();
    expect(done.organizerReleasedAt, "nothing records that the organizing ended").not.toBeNull();
    expect(events.map((e) => e.event), "the lapse said nothing about itself")
      .toContain("organizer_released_by_lapse");
    /* AND THE IDLE REALLY WAS IDLE: no pass renewed the claim while the request stood — the
       "stop means stop" half, without which the claim would never have gone stale at all. */
    expect(meta.appends, "a pending release renewed the claim it was giving up").toBe(appendsBefore);
  });

  it("…and the lapse holds across a restart — the request does not outlive the window it promises", async () => {
    /*
     * THE LIVE SHAPE EXACTLY: the stop request persists in the store, the process is restarted,
     * and on the released build the failure pair resumed on every poll of the new process. The
     * restarted process holds no memory of its own last renewal, so the bound falls back to the
     * request's own stamp — later than any renewal this install could have written after it,
     * because the release arm returns ahead of the lease read on every pass that sees the request.
     */
    const meta = new MemoryMeta();
    let t = Date.now();
    const first = await boot([41], meta, undefined, false, () => new Date(t));
    await agree(first.sidecar);
    await first.sidecar.syncUntilQuiet();
    expect(meta.count, "the precondition: this install holds the claim").toBe(1);

    expect(await stopOrganizing(first.sidecar), "the press was not recorded as a request").toBe("requested");
    meta.refuseOwnRecordSearch = true;
    await first.sidecar.syncUntilQuiet();
    expect((await row(first.sidecar)).organizerRole, "the precondition: still pending at shutdown")
      .toBe("organizer");
    await first.sidecar.stop();

    t += 61_000;
    const second = await boot([], meta, first.dataDir, false, () => new Date(t));
    await second.sidecar.syncUntilQuiet();
    const done = await row(second.sidecar);
    expect(done.organizerRole, "the restart resumed the unbounded retry").toBe("reader");
    expect(done.releaseRequestedAt, "the request survived the lapse").toBeNull();
    expect(done.organizerReleasedAt, "nothing records that the organizing ended").not.toBeNull();
    expect(events.map((e) => e.event), "the lapse said nothing about itself")
      .toContain("organizer_released_by_lapse");
  });

  it("THE MAIL GOES WITH IT — a removed mailbox leaves no mirror to be served twice", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41, 42, 43], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    expect(await mirrored(sidecar), "the precondition: there is a mirror to remove").toBe(3);

    await forget(sidecar);

    /* THE DOUBLING, ONE STEP BEFORE ANYBODY CAN SEE IT. Re-adding the same address inserts a
       SECOND row (the lookup excludes tombstones, deliberately — a tombstone is not a mailbox),
       and on this door the local database is the server as well as the mirror, so a feed that
       still held the first row's copies served every message twice: 28 became 56, every row a
       conversation with itself. The row's own copies are what has to go. */
    expect(
      await mirrored(sidecar),
      "the removed mailbox's mail is still in the store; a re-add will show all of it twice",
    ).toBe(0);
  });

  /* ── THREE: RE-CONNECTING AFTER THE STEP-UP WINDOW HAS GONE ──────────────────────────── */

  it("SEALING A PASSWORD STILL WORKS AN HOUR IN — the door has no second factor to re-assert", async () => {
    /*
     * MEASURED ON A RELEASED BUILD: re-adding a mailbox thirty-five minutes after launch answered
     * **"recent two-factor authentication required"**, on a door that has no second factor and no
     * way to acquire one. Quitting and reopening was the only cure.
     *
     * `mintLaunchSession` writes `last_twofa_at` ONCE, at boot — "there is no second factor on a
     * local install" — so every `stepUp: true` route on this door refuses from five minutes after
     * launch for the life of the process. The credential seal was on one of them.
     *
     * THE CLOCK IS MOVED, not waited out, and it is moved on the SESSION ROW rather than on the
     * engine: that row is the only input `withStepUp` reads, and pushing its stamp an hour into
     * the past is exactly the state a window that has been open an hour is in. A test that left
     * the stamp fresh would pass against the broken route as well as the fixed one — which is
     * precisely why this shipped: the FIRST connect seals seconds after the engine restarts,
     * inside the one window where the stamp is fresh, so the door's happy path passed by luck of
     * timing and only the reconnect ever met the refusal.
     */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    await sidecar.db.update(sessions)
      .set({ lastTwofaAt: new Date(Date.now() - 60 * 60 * 1000) });

    const seal = { imap: { host: "imap.invalid", port: 993, secure: true, user: "owner@trafficflow.test", pass: "a-new-app-password", smtpHost: "smtp.invalid" } };

    /* THE SHARED ROUTE, FIRST — the precondition, and the thing the door used to call. Without
       this the test could not tell "the local route works" from "the window never expired". */
    const shared = await sidecar.handle(new Request(
      `http://local/mailboxes/${sidecar.world.mailboxId}`,
      { method: "PATCH", headers: auth(sidecar), body: JSON.stringify(seal) },
    ));
    expect(
      shared.status,
      "the shared route stopped being step-up gated; this test's premise is gone",
    ).toBe(403);

    /* AND THE DOOR'S OWN ROUTE, on the identical body and the identical bearer. Not a 403: this
       tier's second factor IS the per-launch bearer, and it is being held. */
    const local = await sidecar.handle(new Request(
      `http://local/local/mailboxes/${sidecar.world.mailboxId}`,
      { method: "PATCH", headers: auth(sidecar), body: JSON.stringify(seal) },
    ));
    expect(
      local.status,
      `the local seal route refused an hour-old launch: ${await local.clone().text()}`,
    ).not.toBe(403);
  });

  it("THE SEAL ROUTE IS NOT ANONYMOUS — the per-launch bearer is the whole of its authority", async () => {
    /* The bearer is minted at boot, added shell-side and never reaches the window, so holding it
       IS being the person sitting at this machine. That is the argument for taking the step-up
       off this route, and it is only an argument while the bearer is actually required. */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    const res = await sidecar.handle(new Request(
      `http://local/local/mailboxes/${sidecar.world.mailboxId}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" },
    ));
    expect(res.status).toBe(401);
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  AGREE ON A HELD MAILBOX **TAKES** IT — and this row is the 0.14.1 ruling, inverted
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * THIS CASE ASSERTED THE OPPOSITE UNTIL 0.14.1, and the old prose is preserved because it was
   * right about the code and is now wrong about the product:
   *
   *   > *"`decideLease` rule 5 is why, and it is CORRECT: kinds rank cloud > local > unknown, and
   *   > a live Cloud holder is never displaced by a local install 'even with authorization' — §4
   *   > gives one no path over the other on purpose. So the consent route answers `authorized`,
   *   > the write lands, and the very next pass declines to become anything. Nothing here is a
   *   > defect of the engine; the defect was a CLIENT that offered the press."*
   *
   * It was measured on the released 0.13.6 against a mailbox ohmail Cloud held: Agree at 12:04:32,
   * `lease_stand_down` four seconds later, and a summary claiming the organizing at 12:05:30 — a
   * flow that told somebody it had done something it had refused to do.
   *
   * Rule 5 is deleted. "Agree and start organizing" IS the explicit human action the whole lease
   * is built around, so it now does what it says: this install takes the mailbox, the holder
   * becomes a reader on its own next gate, and its mail, credentials and mirror all stay.
   *
   * ── AND THE HALF THAT IS NOT IN THIS FILE, STATED BECAUSE IT IS THE RISK ──────────────────
   *
   * The COPY is what makes this honest rather than alarming. A person agreeing has to be told, on
   * the screen they press, that another install stops organizing this mailbox within a minute and
   * keeps reading it. The flow already has the screen — it shows the holder before consent — and
   * the sentence is the client lane's. A build with this engine and the old copy would take a
   * mailbox silently, which is what the rows below are careful to describe exactly.
   */
  it("ORGANIZE HERE INSTEAD ON A HELD MAILBOX TAKES IT — the press is the explicit action", async () => {
    const meta = new MemoryMeta();
    await meta.seedForeignClaim();
    const { sidecar } = await boot([41, 42], meta);

    expect(await agree(sidecar, undefined, "takeover"), "the consent write itself is refused").toBe("authorized");
    await sidecar.syncUntilQuiet();

    const mb = await row(sidecar);
    expect(mb.organizerRole,
      "the press was refused by a claim nobody pressed for — rule 5 is back").toBe("organizer");
    expect(mb.organizeConsentedAt, "the consent was not recorded").not.toBeNull();
    // The row names nobody: this install holds it now.
    expect(mb.organizedByKind).toBeNull();
    expect(mb.organizedByName).toBeNull();

    /* THE HANDOVER IS RECORDED IN THE SHARED MEDIUM, which is what makes the other side converge:
       the foreign claim is expunged and exactly ours stands. Without the displacement the Cloud
       side's own next election would take the mailbox straight back on incumbency. */
    expect(meta.count, "the handover was not recorded in ohmail/_meta").toBe(1);
    /* …AND IT IS OURS, not theirs. The id is the install's own uuid, minted per data directory, so
       the assertion is that the CLOUD claim is the one that went — which is the half that makes
       the other side converge: its own next election finds its claim missing and a live foreign
       one standing, which is arm 7 in every version of this table. */
    expect(meta.installIds(), "the foreign claim stands beside ours — two organizers")
      .not.toContain("ohmail-cloud:production");

    /* AND IT IS ORGANIZING, on the mail server's side — the side a person sees. */
    expect(verbs(), "the tree was never built by an install that took the mailbox")
      .toContain("ensureFolders");
    expect(await mirrored(sidecar), "the mirror did not build").toBe(2);
  });

  /**
   * …AND A HOLDER WITH A NEWER PRESS KEEPS IT. The counterweight, and it is what stops the row
   * above from being "consent promotes unconditionally": what refuses a press is another press,
   * made later, on a door somebody else was signed into. Here the holder was pressed for a minute
   * ago and this install's consent is an hour old — a stamp left on the row and never spent.
   */
  it("…but a holder pressed for MORE RECENTLY keeps the mailbox", async () => {
    const meta = new MemoryMeta();
    await meta.seedForeignClaim(new Date(Date.now() - 60_000));
    const { sidecar } = await boot([41, 42], meta);

    expect(await agree(sidecar, new Date(Date.now() - 3_600_000), "takeover")).toBe("authorized");
    await sidecar.syncUntilQuiet();

    const mb = await row(sidecar);
    expect(mb.organizerRole, "a stale press took a mailbox somebody asked for more recently")
      .toBe("reader");
    expect(mb.organizedByKind, "the row does not name who kept the mailbox").toBe("cloud");
    expect(mb.organizedByName).toBe("ohmail Cloud");
    expect(verbs(), "folders were created in a mailbox this install does not organize")
      .not.toContain("ensureFolders");
    expect(verbs(), "mail was moved by an install that stood down").not.toContain("move");
    expect(meta.count, "the foreign claim was displaced, or a second one stands beside it").toBe(1);
    expect(await mirrored(sidecar), "the reader's mirror did not build").toBe(2);
  });

  it("REMOVE THEN RE-ADD — one copy of every message, not two", async () => {
    /*
     * THE WALK THE RELEASED BUILD COULD NOT BE PUT THROUGH, because the standalone pane had no
     * Remove control: the mirror-wipe fix shipped unproven from a user's chair. Driven here as
     * the door actually drives it — `enterLocalDoor` replaces the engine over the SAME data
     * directory, and on this door that store is the server as well as the mirror.
     *
     * The doubling: the row lookup rightly does not reuse a tombstone, so the re-add INSERTS a
     * second `mailboxes` row, and before the wipe the feed served both rows' copies of every
     * message — 28 became 56, every row a conversation with itself.
     *
     * MUTATION: delete `wipeLocalMirror` from the local remove handler and the count below is 6.
     */
    const meta = new MemoryMeta();
    const first = await boot([41, 42, 43], meta);
    await agree(first.sidecar);
    await first.sidecar.syncUntilQuiet();
    expect(await mirrored(first.sidecar), "the precondition: there is a mirror to remove").toBe(3);
    const removedId = first.sidecar.world.mailboxId;

    await forget(first.sidecar);
    await first.sidecar.stop();

    /* THE RE-ADD. The same address, the same store, the same three messages on the server. */
    const again = await boot([41, 42, 43], meta, first.dataDir);
    await again.sidecar.syncUntilQuiet();

    expect(
      again.sidecar.world.mailboxId,
      "the re-add reused the tombstone, which is not what a tombstone is",
    ).not.toBe(removedId);
    expect(
      await mirrored(again.sidecar),
      "every message is in the store twice; the feed would serve each as a conversation with itself",
    ).toBe(3);

    /* AND THE ROW IT LANDED ON IS THE PRE-CONSENT STATE AGAIN — a re-added mailbox has not been
       agreed to, whatever was agreed about the one that was removed. */
    const mb = await row(again.sidecar);
    expect(mb.organizerRole).toBe("reader");
    expect(mb.organizeConsentedAt, "the re-added mailbox inherited a consent nobody gave")
      .toBeNull();

    // Stopped first: on Windows a running engine's directory cannot be removed under it.
    await again.sidecar.stop();
    rmSync(first.dataDir, { recursive: true, force: true });
  });

  it("REMOVAL IS NOT A HANDOVER — the row is a tombstone, and it stops being an organizer", async () => {
    /* The two columns that decide what the next launch does. A tombstone with a stand-down reason
       would tell the person "another ohmail install has claimed this mailbox" about a mailbox they
       deliberately removed; a tombstone still marked `organizer` would let a later launch spend a
       stamp against it. Both are `MailboxService.delete`'s contract and are asserted here because
       this door reaches it through its own transport. */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();

    await forget(sidecar);

    const mb = await row(sidecar);
    expect(mb.status).toBe("disabled");
    expect(mb.disabledReason, "a removal is not a stand-down and must not read as one").toBeNull();
    expect(mb.takeoverAuthorizedAt, "an unspent authorization must not survive a removal").toBeNull();
  });

  /* ── FOUR: "DELETED" MEANS EVERY TABLE, READ BACK ONE BY ONE ─────────────────────────────── */

  it("THE WHOLE MAILBOX GOES — every table the schema ties to it reads back empty", async () => {
    /* The seed is the oracle: every owed table holds a row before the press, so an empty read
       after it is a delete that ran. A one-mailbox install, so every row there is this one's. */
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41, 42], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    await seedEveryOwedTable(sidecar);
    const owed = tablesTheRemovalOwes();
    const before = await countsOf(sidecar, owed);
    expect(owed.filter((t) => before[t] === 0), "the seed missed a table").toEqual([]);

    await forget(sidecar);

    const after = await countsOf(sidecar, owed);
    expect(
      owed.filter((t) => after[t] !== 0).map((t) => `${t}: ${after[t]}`),
      "the removed mailbox's rows are still on disk",
    ).toEqual([]);
  });

  it("A SHARED CONVERSATION STAYS — only a thread no other mailbox is in goes", async () => {
    const meta = new MemoryMeta();
    const { sidecar } = await boot([41], meta);
    await agree(sidecar);
    await sidecar.syncUntilQuiet();
    const { accountId, mailboxId } = sidecar.world;
    const [other] = await sidecar.db.insert(mailboxes).values({
      accountId, provider: "imap", address: "second@trafficflow.test",
    }).returning();
    const [shared] = await sidecar.db.insert(threads).values({ accountId }).returning();
    const [own] = await sidecar.db.insert(threads).values({ accountId }).returning();
    await plantMessage(sidecar, mailboxId, shared!.id);
    await plantMessage(sidecar, mailboxId, own!.id);
    const kept = await plantMessage(sidecar, other!.id, shared!.id);
    await sidecar.db.insert(threadNotes).values([
      { accountId, threadId: shared!.id, body: "on the shared conversation" },
      { accountId, threadId: own!.id, body: "on the removed mailbox's own" },
    ]);
    const [reply] = await sidecar.db.insert(drafts).values({
      accountId, mailboxId: other!.id, threadId: own!.id, subject: "Re: from the other mailbox",
    }).returning();
    const threadsBefore = (await sidecar.db.select({ id: threads.id }).from(threads)).map((r) => r.id);

    await forget(sidecar);

    const threadIds = (await sidecar.db.select({ id: threads.id }).from(threads)).map((r) => r.id);
    expect(threadIds, "a conversation another mailbox is in was taken").toContain(shared!.id);
    expect(threadIds, "the removed mailbox's own conversation stayed on disk").not.toContain(own!.id);
    const notes = await sidecar.db.select({ threadId: threadNotes.threadId }).from(threadNotes);
    expect(notes.map((n) => n.threadId)).toEqual([shared!.id]);
    const [survivor] = await sidecar.db.select().from(messages).where(eq(messages.id, kept));
    expect(survivor?.threadId, "the other mailbox's message lost its conversation").toBe(shared!.id);
    const [words] = await sidecar.db.select().from(drafts).where(eq(drafts.id, reply!.id));
    expect(words?.subject, "an unsent reply in another mailbox was deleted").toBe("Re: from the other mailbox");
    expect(words?.threadId, "the reply still points at a conversation that is gone").toBeNull();

    /* AND THE WINDOW IS TOLD: one `thread` delete
       for the conversation that went, none for the one that stayed, ahead of the mailbox receipt.
       Mutation: drop the announcement from `wipeLocalMirror` and the first list is empty. */
    const log = await sidecar.db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    const threadDeletes = log.filter((r) => r.entityType === "thread" && r.op === "delete");
    const went = threadsBefore.filter((t) => !threadIds.includes(t)).sort();
    expect(went, "the precondition: the removal took conversations").toContain(own!.id);
    expect(threadDeletes.map((r) => r.entityId).sort(),
      "the window is told exactly the conversations that went").toEqual(went);
    const receipt = log.find((r) => r.entityType === "mailbox" && r.entityId === mailboxId);
    expect(receipt, "the removal wrote no receipt").toBeDefined();
    for (const r of threadDeletes) expect(Number(r.seq)).toBeLessThan(Number(receipt!.seq));
  });
});

/** Row counts of the named tables, by their own SQL names (the schema's, never typed here). */
async function countsOf(s: Sidecar, tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const res = await s.db.execute(sql.raw(`select count(*)::int as n from "${t}"`));
    out[t] = Number((res.rows[0] as { n: number }).n);
  }
  return out;
}

/** One message of `mailboxId` in `threadId`, with only the columns the schema requires. */
async function plantMessage(s: Sidecar, mailboxId: string, threadId: string): Promise<string> {
  const dedup = `mid:${randomUUID()}`;
  const [m] = await s.db.insert(messages).values({
    accountId: s.world.accountId, mailboxId, threadId, messageIdHeader: dedup,
    bodyHash: randomUUID(), dedupKey: dedup, subject: "Glaze order",
    fromAddress: "giulia@example.test", date: new Date(),
    nativeLocator: { folder: "INBOX", ref: `9:${randomUUID().slice(0, 4)}` }, snippet: "ciao",
  }).returning();
  return m!.id;
}

/** A row in every table the removal owes, hung off one fresh message of the world mailbox. */
async function seedEveryOwedTable(s: Sidecar): Promise<void> {
  const { accountId, mailboxId } = s.world;
  const db = s.db;
  const [thread] = await db.insert(threads).values({ accountId }).returning();
  const messageId = await plantMessage(s, mailboxId, thread!.id);
  const [folder] = await db.insert(mailboxFolders).values({ mailboxId, folder: "ohmail/Fixture" }).returning();
  await db.insert(messageBodies).values({ messageId, text: "the whole letter" }).onConflictDoNothing();
  await upsertMessageSearch(db as never, messageId, {
    accountId, subject: "ciao", from: null, to: [], cc: [], attachmentNames: [],
    bodyText: "the whole letter", source: "text",
  });
  await db.insert(folderState).values({
    messageId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    reconcileStatus: "reconciled", conflict: false,
  }).onConflictDoNothing();
  await db.insert(flagState).values({
    messageId, desiredSeen: true, observedSeen: false, lastSetBy: "us", reconcileStatus: "pending",
  }).onConflictDoNothing();
  await db.insert(messageInstances).values({
    accountId, mailboxId, messageId, folder: "Archive", uidvalidity: 1n, uid: 90_001, isPrimary: false,
  });
  await db.insert(messageFailures).values({
    accountId, mailboxId, folder: "INBOX", uidvalidity: 1n, uid: 90_002, code: "mime_unparseable",
  });
  const [decision] = await db.insert(routingDecisions).values({
    accountId, messageId, inputProvenance: "rule", destination: "INBOX", status: "applied",
  }).returning();
  await db.insert(approvals).values({
    accountId, messageId, routingDecisionId: decision!.id, kind: "route", action: "move",
  });
  await db.insert(messageStates).values({ accountId, messageId }).onConflictDoNothing();
  await db.insert(trackerEvents).values({ accountId, messageId, kind: "pixel" });
  await db.insert(attachments).values({ accountId, messageId, contentType: "application/pdf" });
  const [tag] = await db.insert(tags).values({ accountId, name: `Fixture-${randomUUID().slice(0, 6)}` }).returning();
  await db.insert(messageTags).values({ accountId, messageId, tagId: tag!.id });
  await db.insert(threadNotes).values({ accountId, threadId: thread!.id, body: "delivery moved" });
  const [draft] = await db.insert(drafts).values({
    accountId, mailboxId, threadId: thread!.id, inReplyToMessageId: messageId, subject: "Re: Glaze order",
  }).returning();
  const [send] = await db.insert(outboundSends).values({
    accountId, draftId: draft!.id, idempotencyKey: randomUUID(), mintedMessageId: "<x@y>",
  }).returning();
  /* A second send whose draft is already gone — the claim that only the mailbox key reaches. */
  const [sent] = await db.insert(outboundSends).values({
    accountId, draftId: null, idempotencyKey: randomUUID(), mintedMessageId: "<z@y>",
  }).returning();
  await db.insert(outboundSendFingerprints).values([
    { accountId, mailboxId, fingerprint: "ab".repeat(32), sendId: send!.id },
    { accountId, mailboxId, fingerprint: "cd".repeat(32), sendId: sent!.id },
  ]);
  const [record] = await db.insert(unsubscribeRecords).values({
    accountId, mailboxId, listKey: `list-${randomUUID().slice(0, 6)}`, state: "sent", httpStatus: 202, messageId,
  }).returning();
  await db.insert(unsubscribeExamined).values({ messageId, recordId: record!.id, accountId });
  await db.insert(awayReplies).values({
    accountId, mailboxId, messageId, sender: "giulia@example.test", outcome: "sent", sentAt: new Date(),
  });
  await db.insert(awayResponderSent).values({
    accountId, messageId, sender: "giulia@example.test", responderUpdatedAt: new Date(),
  });
  await db.insert(folderOps).values({ accountId, mailboxId, folderId: folder!.id, op: "create" });
  await db.insert(junkRescues).values({ accountId, mailboxId, folder: "Junk", uidvalidity: 7n, uid: 11 });
  await db.insert(organizerRequests).values({
    accountId, mailboxId, kind: "screener.decide",
    payload: { sender: "giulia@example.test", verdict: "screened_in" }, decidedAt: new Date(), state: "pending",
  });
  await db.insert(mailboxProfileMirror).values({
    mailboxId, accountId, uidvalidity: 1n, uid: 3,
    doc: { v: 1, awayResponder: { body: "Back on Monday." }, tagNames: ["invoices"] }, readAt: new Date(),
  }).onConflictDoNothing();
  const [cred] = await db.select({ id: mailboxCredentials.mailboxId }).from(mailboxCredentials)
    .where(eq(mailboxCredentials.mailboxId, mailboxId));
  if (!cred) {
    await db.insert(mailboxCredentials).values({
      mailboxId, transport: "imap", secretEnc: "enc:xxxx", keyVersion: 1,
    });
  }
}

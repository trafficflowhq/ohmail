import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts, changeLog, drafts, folderState, mailboxes, mailboxCredentials, messages, organizerRequests,
  rules, threads, STAND_DOWN_SEND_SENTENCES,
} from "@trafficflow/db";
import { makeDb, workerHeartbeats } from "@trafficflow/db/cloud";
import { StaticKeyProvider, type LogFields } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  formatClaim, LeaseUnavailableError, META_RECORDS_MAX_PER_FETCH, MetaEnumRefusedError, META_ENUM_RECORDS_MAX,
} from "@trafficflow/core/adapters/organizer-lease";
import { startWorker } from "../src/index.js";
import { readMailboxLease, cloudInstallId, releaseMailboxClaim, hasLeaseIo } from "../src/lease.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { ClaimReleaseError, makeLeaseIo, makeRequestOrganizerIo } from "@trafficflow/core/adapters/organizer-lease";
import { memoryImapServer, type MemoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";
import { foreign600 } from "../../../packages/core/test/adapters/_lease-fixtures.js";

/**
 * THE THREE WORKER BEHAVIOURS THE TWO-WORLDS TEST CANNOT REACH.
 *
 * `organizer-lease.e2e.test.ts` runs two real workers against one GreenMail mailbox and is the
 * slice's headline. It cannot produce these, because each of them is about a state a healthy pair
 * of workers never enters:
 *
 *  1. **A lease that cannot be READ.** It must be exempted by CLASS — no ingest, and no
 *     quarantine either. Both directions are wrong in a way that matters: reading an unreadable
 *     `_meta` as "no claim, so organize" is the dual-organizer bug through the back door, and
 *     reading it as "stand down" would permanently disable a mailbox nobody else wants on a
 *     transient network error, because a stand-down is sticky.
 *  2. **An adapter that cannot hand over a lease at all.** The dangerous default is "gate absent
 *     ⇒ organize", so the absence is a typed failure and this is where that is watched.
 *  3. **An entitlement lapse — covered in `parked-account.test.ts` since mail 0124.** Cloud
 *     releasing a claim it is no longer entitled to still matters for the reason it always did:
 *     a fresh Cloud claim stands the user's own machine down. The signal arrives through the
 *     entitlements port, and the roster composes the parked-accounts reader from it in
 *     production now (the wall); that file drives the whole park through `startWorker` against
 *     a fake plane and watches both call sites redden without their reader.
 *
 * The fake fleet's `_meta` is a REAL in-memory `LeaseIo` (see `_fakeadapter.ts`), so the gate runs
 * for real here — what is faked is the provider, not the lease.
 */

type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";

/**
 * Seed one mailbox in a shape THE PRODUCT ACTUALLY WRITES.
 *
 * `consented` is not a convenience flag; it selects between the only two shapes that exist, and
 * the pair of columns moves together in both. `MailboxService.create` writes
 * `organizer_role='reader'` beside `organize_consented_at=NULL` (`mailbox-service.ts:1273`) — a
 * fresh connect mirrors and moves nothing — and `organizeHere` / mail 0083's backfill write
 * `organizer_role='organizer'` beside a consent stamp. Neither of them writes the pair this
 * fixture used to leave behind.
 *
 * It used to name neither column, so the row took the SCHEMA DEFAULT `organizer_role='organizer'`
 * (`schema-mail.ts:151`) with `organize_consented_at` NULL — a combination no product path
 * produces. Mail 0083 put a consent gate above the lease read, so every test built on that row
 * returned `false` from `mayOrganize` before the lease was opened at all: six lease guarantees
 * below stopped exercising the lease and started exercising the consent gate, all six still
 * phrased as assertions about a stand-down that consequently never came. That is the same trap
 * `scheduled-send-stand-down.pg.test.ts` names in its own fixture — *"the fixture has to write
 * what the product writes or the tests below prove something about a state nothing produces"* —
 * and it is why the flag is explicit at every call site rather than defaulted.
 */
async function seedMailbox(
  db: Db, accountId = randomUUID(),
  opts: { consented: boolean; role?: "organizer" | "reader"; releaseRequested?: boolean }
    = { consented: false },
): Promise<{ accountId: string; mailboxId: string }> {
  await db.insert(accounts).values({ id: accountId, name: "lease" });
  const [row] = await db.insert(mailboxes)
    .values({
      accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
      /* ── THE THIRD SHAPE (mail 0088): A CONSENTED READER ───────────────────────────────────
       *
       * `role` overrides the pair above because there is a shape the two-way flag cannot express
       * and it is the one the 0.14.1 gate fix is about: `organizer_role='reader'` WITH a consent
       * stamp — an install that was asked to organize this mailbox and then lost it, or released
       * it. That is what `markMailboxStoodDown` and `markMailboxReleased` both leave behind, so it
       * is what the roster hands the gate on the very next cycle, and it is the row that used to
       * be promoted by an empty folder with nobody having asked.
       *
       * Still explicit at every call site, on this fixture's standing rule: a default here would
       * silently re-point the tests below at whichever shape the default happened to name.
       */
      organizerRole: opts.role ?? (opts.consented ? "organizer" : "reader"),
      organizeConsentedAt: opts.consented ? new Date(Date.now() - 60 * 60 * 1000) : null,
      ...(opts.releaseRequested ? { releaseRequestedAt: new Date() } : {}),
    }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

async function waitFor(pred: () => Promise<boolean>, ms = 15_000, step = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

async function rowOf(db: Db, mailboxId: string) {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return row!;
}

/**
 * A FLEET WHOSE LEASE FOLDER CAN BE ASKED A QUESTION AT TWO INSTANTS, without teaching the shared
 * double a hook every other file would carry. The wrapper delegates everything and interposes on
 * exactly two calls: `stampMeta` (the folder reading the permit's baseline is) and `appendClaim`
 * (the last thing `readMailboxLease` does before it answers organize). Both are the REAL folder's,
 * so what the gate sees is unchanged — only this file learns when they happened.
 *
 * `atStamp` HOLDS the reading and asks whether the row got written anyway. The reading is issued
 * with the claim now, so "what did the row say when the STATUS went out" is a race between two
 * concurrent things and answers nothing whichever way it lands. What the row must never be is
 * DEPENDENT on that reading — see `roleWithTheReadingHeld`.
 */
function watchingFactory(
  fleet: FakeAdapterFleet,
  hooks: { atStamp?: () => Promise<void>; afterAppend?: () => Promise<void> },
): FakeAdapterFleet["factory"] {
  return (cfg, ctx) => {
    const adapter = fleet.factory(cfg, ctx);
    /* `leaseIo` is deliberately NOT on `MailboxAdapter` — `lease.ts` says why: it is one feature's
       needs, not every caller's, and the worker probes for it structurally rather than widening an
       interface every other call site would then see. This double wraps that method, so it asks for
       the same narrow shape the worker asks for instead of reaching through the wide type. */
    if (!hasLeaseIo(adapter)) throw new Error("the fake fleet's adapter hands out no leaseIo");
    return {
      ...adapter,
      leaseIo(identity: { installId: string; mailboxId: string }) {
        const io = adapter.leaseIo(identity);
        return new Proxy(io, {
          get(target, prop): unknown {
            if (prop === "stampMeta") {
              return async () => {
                const st = await target.stampMeta!();
                await hooks.atStamp?.();
                return st;
              };
            }
            if (prop === "appendClaim") {
              return async (raw: string) => {
                await target.appendClaim(raw);
                await hooks.afterAppend?.();
              };
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        });
      },
    };
  };
}

/**
 * WHAT THE ROW SAYS WHILE THE PERMIT'S READING IS HELD — the invariant, with no clock in the verdict.
 *
 * The row must not DEPEND on that reading. So the reading is held here and the row is read until it
 * follows the claim: under the fix it does, with the reading still held, because the promotion is
 * issued without waiting on it. A permit that awaited the reading in front of the row can never get
 * there, and the bound expires with `reader` recorded. The bound is a stop, never the verdict.
 */
async function roleWithTheReadingHeld(
  read: () => Promise<string | null>,
): Promise<string | null> {
  const until = Date.now() + 5_000;
  let role = await read();
  while (role !== "organizer" && Date.now() < until) {
    await new Promise((r) => { setTimeout(r, 25); });
    role = await read();
  }
  return role;
}

/** Collects structured log events so a refusal can be asserted by NAME rather than by silence. */
function recordingLogger() {
  const events: Array<{ event: string; fields: LogFields }> = [];
  const mk = (bound: LogFields = {}): ReturnType<typeof makeLogger> => makeLogger(bound);
  function makeLogger(bound: LogFields) {
    const push = (event: string, fields?: LogFields): void => {
      events.push({ event, fields: { ...bound, ...fields } });
    };
    return {
      level: "debug" as const,
      child: (f: LogFields) => mk({ ...bound, ...f }),
      debug: push, info: push, warn: push, error: push,
    };
  }
  return { events, logger: mk() };
}

describe("the worker's organizer lease: the states two healthy workers never reach", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_lease_unit"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("an adapter with NO leaseIo is a LeaseUnavailableError, never a silent 'organize'", async () => {
    // The whole point of the class. If this returned `{ organize: true }` the gate would stop
    // existing the first time somebody composed the worker slightly differently, and nothing
    // anywhere would say so.
    const naked = { async connect() {}, async close() {} } as unknown as MailboxAdapter;
    await expect(readMailboxLease({
      adapter: naked,
      self: { installId: "x", kind: "cloud", displayName: "x", lastNonce: null },
      now: new Date(), onNonceMinted: () => undefined,
    })).rejects.toThrow(LeaseUnavailableError);
    // …and releasing on a teardown path must NOT throw for the same absence: a teardown that can
    // be aborted by bookkeeping is a teardown that leaks a connection.
    expect(await releaseMailboxClaim(naked, "x", "mb-lease-test", "n-x")).toBe(0);
  });

  /**
   * A TRUNCATED READ REFUSES IN THE EXISTING CLASS: `meta_folder_full`, never decided on. Every host
   * exempts `LeaseUnavailableError` by class, so a new class would quarantine a mailbox over a folder
   * that is not its fault; the `op` tells a folder too full to read from a read that failed. A
   * one-word verdict, because a failed `.rejects` pretty-prints a live database handle until the
   * worker dies with the pg-lock flake's text.
   */
  it("refuses meta_folder_full in the class every host already exempts", async () => {
    const flooded: Array<{ ref: number; raw: string }> = [];
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 10; i++) {
      flooded.push({ ref: i + 1, raw: `Subject: newsletter ${i}\r\n\r\nbody` });
    }
    const adapter = {
      async connect() {}, async close() {},
      leaseIo: () => ({
        async ensureMetaFolder() { /* the folder exists; it is merely too full */ },
        async listClaims(): Promise<never> {
          throw new MetaEnumRefusedError("over_ceiling", { rows: 0, total: flooded.length, ceiling: META_ENUM_RECORDS_MAX });
        },
        async removeClaims() { /* nothing to remove on a refusal */ },
      }),
    } as unknown as MailboxAdapter;

    const verdict = await readMailboxLease({
      adapter,
      self: { installId: "us", kind: "cloud", displayName: "Cloud", lastNonce: null },
      now: new Date(), onNonceMinted: () => undefined,
    }).then(
      () => "resolved",
      (err: unknown) => (err instanceof LeaseUnavailableError
        ? `LeaseUnavailableError:${(err as { op?: string }).op ?? "no-op"}`
        : `wrong-class:${(err as Error)?.name}`),
    );

    expect(verdict, "a truncated read did not refuse in the exempt class")
      .toBe("LeaseUnavailableError:meta_folder_full");
  });

  /**
   * A FOLDER TOO FULL TO READ WHOLE MUST NOT STOP THIS INSTALL LETTING GO.
   *
   * `listClaims()` refuses a `ohmail/_meta` it could not cover, because the GATE reads an
   * incomplete election as "nobody holds this mailbox" and would start organizing one somebody
   * else has. That refusal is right for the election and wrong for a release: the question here is
   * not "who holds this" but "which of these are MINE", and that is answered per record.
   *
   * Being wrong costs a DELAYED HANDOVER rather than a lost claim — our claim stays in the folder
   * and the next install waits out the whole staleness window before it may take the mailbox, on
   * the lapse, stop-organizing and remove-mailbox paths, which are exactly the moments somebody has
   * just asked this install to let go.
   *
   * MUTATION WATCHED RED: drop the over-ceiling arm in `releaseMailboxClaim` and this
   * rejects with that error instead of removing the claim.
   */
  /**
   * ═══ A RELEASE IS ADDRESSED BY (INSTALL, NONCE) ══════════════════════════════════════════
   *
   * The election has always been nonce-scoped — a restored image carries our install id and a
   * nonce we never generated, and without the nonce it reads as ourselves, i.e. two organizers.
   * The release was id-scoped, and a second profile of the same lineage had its claim deleted by
   * a sibling's stop. The clone defence is symmetric on both paths now.
   *
   * Two cases, and the second is the one the decision turns on: an install that cannot name its
   * claim does NOT fall back to the id. It refuses, the request stands, and the worker's
   * lapse-bound release arm records the release once the claim has stopped being renewed for a
   * whole staleness window — by which time it is residue whoever wrote it.
   */
  it("releases only OUR nonce's claim — a same-install-id sibling's survives", async () => {
    const mine = formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n-mine",
    });
    // THE RESTORED-IMAGE LINEAGE: the same install id, a nonce this process never generated.
    const sibling = formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n-sibling",
    });
    const raw: Array<{ ref: number; raw: string }> = [
      { ref: 1, raw: sibling }, { ref: 2, raw: mine },
    ];
    const removed: unknown[][] = [];
    const adapter = {
      async connect() {}, async close() {},
      leaseIo: () => ({
        async findOwnRecords(installId: string) {
          return raw.filter((m) => m.raw.includes(`X-Ohmail-Install-Id: ${installId}`));
        },
        async listClaims() { return raw.map((m) => ({ ...m })); },
        async removeClaims(refs: readonly unknown[]) {
          removed.push([...refs]);
          const gone = new Set(refs);
          for (let i = raw.length - 1; i >= 0; i--) {
            if (gone.has(raw[i]!.ref)) raw.splice(i, 1);
          }
        },
      }),
    } as unknown as MailboxAdapter;

    expect(await releaseMailboxClaim(adapter, "us", "mb-lease-test", "n-mine")).toBe(1);
    expect(removed, "the delete was addressed by install id, so it took both").toEqual([[2]]);
    const left = raw.map((m) => m.raw).join("\n");
    expect(left, "a sibling lineage's claim was deleted by this install's stop")
      .toContain("X-Ohmail-Nonce: n-sibling");
    expect(left, "our own claim was not released").not.toContain("X-Ohmail-Nonce: n-mine");
  });

  it("takes a STRANDED record of ours — stale past the window — and leaves a fresh one", async () => {
    /* THE SECOND TERM OF THE ADDRESS. A claim whose writer is gone can be named by nobody, so a
       nonce-only release would leave it in the folder with nothing able to remove it. It is STALE
       by definition — nothing renews it — and staleness is a fact about the record rather than
       about who is asking, which is what makes it a safe second term: a live sibling lineage's
       claim is FRESH and survives, because a live clone renews. */
    const claim = (nonce: string, heartbeat: Date) => formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
      heartbeat, claimedAt: heartbeat, nonce,
    });
    const OLD = new Date(Date.now() - 3_600_000);
    const raw = [
      // A process of ours that died an hour ago and left this behind.
      { ref: 1, raw: claim("n-gone", OLD) },
      // A LIVE sibling of the same lineage: same id, a nonce we never wrote, renewing now.
      { ref: 2, raw: claim("n-sibling", new Date()) },
    ];
    const removed: unknown[][] = [];
    const adapter = {
      async connect() {}, async close() {},
      leaseIo: () => ({
        async findOwnRecords(installId: string) {
          return raw.filter((m) => m.raw.includes(`X-Ohmail-Install-Id: ${installId}`));
        },
        async listClaims() { return raw.map((m) => ({ ...m })); },
        async removeClaims(refs: readonly unknown[]) {
          removed.push([...refs]);
          const gone = new Set(refs);
          for (let i = raw.length - 1; i >= 0; i--) {
            if (gone.has(raw[i]!.ref)) raw.splice(i, 1);
          }
        },
      }),
    } as unknown as MailboxAdapter;

    // No nonce at all — the case this term exists for. The stale record still goes.
    expect(await releaseMailboxClaim(adapter, "us", "mb-lease-test", null,
      { staleAfterMs: 60_000 })).toBe(1);
    expect(removed, "the stranded record was left for nothing to remove").toEqual([[1]]);
    const left = raw.map((m) => m.raw).join("\n");
    expect(left, "a live sibling lineage's claim was taken by the stale term")
      .toContain("X-Ohmail-Nonce: n-sibling");
    expect(left, "the stranded record survived its own release").not.toContain("X-Ohmail-Nonce: n-gone");
  });

  it("refuses when this install cannot name its claim — the lapse arm is the way out", async () => {
    const mine = formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n-mine",
    });
    const raw = [{ ref: 1, raw: mine }];
    const removed: unknown[][] = [];
    const adapter = {
      async connect() {}, async close() {},
      leaseIo: () => ({
        async findOwnRecords(installId: string) {
          return raw.filter((m) => m.raw.includes(`X-Ohmail-Install-Id: ${installId}`));
        },
        async listClaims() { return raw.map((m) => ({ ...m })); },
        async removeClaims(refs: readonly unknown[]) { removed.push([...refs]); },
      }),
    } as unknown as MailboxAdapter;

    const err = await releaseMailboxClaim(adapter, "us", "mb-lease-test", null)
      .then(() => null, (e: unknown) => e);
    expect(err, "a nonce-less release fell back to the install id").toBeInstanceOf(ClaimReleaseError);
    expect((err as { code: string }).code).toBe("nonce_unknown");
    expect(removed, "the refusal deleted something on its way out").toEqual([]);
    expect(raw, "the claim was taken by an install that could not name it").toHaveLength(1);
    /* AND IT SAYS THE SENTENCE A PERSON NEEDS, in the engine's own words. The pane cannot yet tell
       this refusal from an ordinary pending confirm — that needs a wire fact the DTO does not
       carry — so the copy key `stopOrganizingSiblingLapse` exists for the pane and this message is
       where the sentence is actually reachable today. Pinned so the two cannot drift apart, and so
       the unrendered key is a stated gap rather than a sentence nobody ever sees. */
    expect((err as Error).message,
      "the refusal does not say what happens next, so nobody can act on it")
      .toContain("Another copy of this computer keeps organizing this mailbox until its claim lapses");
  });

  it("releases its OWN claim from a folder too full to read whole", async () => {
    const ours = formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n-us",
    });
    // Flooded well past the ceiling, with this install's claim appended LAST — the shape a renewed
    // claim always has, and the reason a newest-first window is guaranteed to carry it.
    const raw: Array<{ ref: number; raw: string }> = [];
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 50; i++) {
      raw.push({ ref: i + 1, raw: `Subject: newsletter ${i}\r\n\r\nbody` });
    }
    raw.push({ ref: 9_001, raw: ours });

    const removed: unknown[][] = [];
    const adapter = {
      async connect() {}, async close() {},
      leaseIo: () => ({
        /* The server answers which records carry our id, wherever they sit. Every adapter this
         * product builds provides this; the double used to omit it and lean on the window
         * fallback, which is exactly the branch that has been deleted — a path only a double
         * could reach is a path where a double's convenience becomes the product's behaviour. */
        async findOwnRecords(installId: string) {
          return raw.filter((m) => m.raw.includes(`X-Ohmail-Install-Id: ${installId}`));
        },
        async listClaims(): Promise<never> {
          // Still raises what the bounded read raises: the folder IS too full to read whole.
          throw new MetaEnumRefusedError("over_ceiling", { rows: 0, total: raw.length, ceiling: META_ENUM_RECORDS_MAX });
        },
        /* Removal is REAL — the release confirms by re-read, so a double that only records its
           refs would report its own claim still standing. */
        async removeClaims(refs: readonly unknown[]) {
          removed.push([...refs]);
          const gone = new Set(refs);
          for (let i = raw.length - 1; i >= 0; i--) {
            if (gone.has(raw[i]!.ref)) raw.splice(i, 1);
          }
        },
      }),
    } as unknown as MailboxAdapter;

    expect(await releaseMailboxClaim(adapter, "us", "mb-lease-test", "n-us")).toBe(1);
    expect(removed).toEqual([[9_001]]);
  });

  /**
   * AND A CLAIM THE WINDOW DOES NOT REACH IS STILL RELEASED.
   *
   * The case above holds for the claim a release normally has to remove — renewed by APPENDING, so
   * newest. It is not the guarantee a release needs, and "normally" is where this goes wrong. Two
   * ordinary ways one of ours sits outside the newest window: crash residue from an interrupted
   * append-then-expunge, which is OLDER by construction, and a claim buried under a ceiling's worth
   * of later arrivals in a folder anyone with append rights can write to.
   *
   * Missing one is worse than a short read, because this function RETURNS A COUNT and the caller
   * reads that as the release having happened — so an incomplete pass reports success while a claim
   * of ours goes on holding the mailbox against the next install until it goes stale.
   *
   * Asking the SERVER which messages carry our id makes position irrelevant. The reply is a handful
   * of records rather than a folder, so nothing about the bound changes.
   *
   * MUTATION WATCHED RED: drop `findOwnRecords` from the adapter and the release finds only the
   * newest copy, removing one of the two.
   */
  /**
   * A SEARCH THE SERVER REFUSED IS NOT AN ADAPTER THAT CANNOT SEARCH.
   *
   * `findOwnRecords` answers `null` for both, and the release read them as one: a refusal fell
   * through to the newest-window fallback exactly like an older adapter with no search at all.
   *
   * Where the capability is genuinely absent the window is the best this install has ever had and
   * the fallback is honest. Where the search was REFUSED the complete answer exists on the server
   * and this pass merely did not get it -- so removing whatever the window happens to cover and
   * returning a count reports a RELEASE about a folder that may still hold older residue of ours.
   * That residue goes on holding the mailbox against the next install until it goes stale, which
   * is the delayed handover this path exists to prevent.
   *
   * The release says so instead. Every caller already wraps it and logs
   * `organizer_claim_release_failed`, whose copy states the true consequence, so a throw here
   * costs one honest log line.
   *
   * MUTATION WATCHED RED: read a refusal as the missing capability again -- fall back to the
   * window -- and this resolves with a count while the buried claim stays in the folder.
   */
  /**
   * AND AN ADAPTER THAT CANNOT SEARCH AT ALL IS THE SAME PARTIAL RELEASE, BY THE OTHER DOOR.
   *
   * The refused-search case below was closed while this one stayed open beside it, which made the
   * EXCUSE the difference rather than the outcome. Either way the window is not a complete answer:
   * records of ours outside it are not removed, and the function returns a COUNT that every caller
   * reads as the mailbox released, so a claim left behind holds it against the next install until
   * it goes stale.
   *
   * The window fallback is deleted rather than left unreachable — every adapter this product
   * builds provides the capability, so the branch could only ever be taken by a double, and a path
   * only a double can reach is where a double's convenience becomes the product's behaviour.
   *
   * MUTATION WATCHED RED: restore the fallback for an absent capability and this resolves with a
   * count while the claim it could not see is still in the folder.
   */
  it("an adapter that cannot search own records reports a partial release, not a count", async () => {
    const ours = formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n-us",
    });
    const raw: Array<{ ref: number; raw: string }> = [{ ref: 1, raw: ours }];
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 50; i++) {
      raw.push({ ref: i + 2, raw: `Subject: newsletter ${i}\r\n\r\nbody` });
    }

    const removed: unknown[][] = [];
    const adapter = {
      async connect() {}, async close() {},
      leaseIo: () => ({
        // NO `findOwnRecords` at all — an older adapter, or a connection that cannot search.
        async listClaims(): Promise<never> {
          throw new MetaEnumRefusedError("over_ceiling", { rows: 0, total: raw.length, ceiling: META_ENUM_RECORDS_MAX });
        },
        async removeClaims(refs: readonly unknown[]) { removed.push([...refs]); },
      }),
    } as unknown as MailboxAdapter;

    await expect(releaseMailboxClaim(adapter, "us", "mb-lease-test", "n-us"),
      "a release that could not enumerate reported a count anyway")
      .rejects.toThrow(/could not be enumerated/);
    expect(removed, "a release that proved nothing still expunged from the folder").toEqual([]);
  });

  it("a refused own-record search is reported, not quietly downgraded to a partial release", async () => {
    const ours = formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n-us",
    });
    // Ours FIRST and then buried: the record only a by-id search can reach, which is exactly the
    // record the window fallback would miss while reporting the release as done.
    const raw: Array<{ ref: number; raw: string }> = [{ ref: 1, raw: ours }];
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 50; i++) {
      raw.push({ ref: i + 2, raw: `Subject: newsletter ${i}\r\n\r\nbody` });
    }

    const removed: unknown[][] = [];
    const adapter = {
      async connect() {}, async close() {},
      leaseIo: () => ({
        // The capability EXISTS and the server refused the search -- the case that was invisible.
        async findOwnRecords(): Promise<null> { return null; },
        async listClaims(): Promise<never> {
          throw new MetaEnumRefusedError("over_ceiling", { rows: 0, total: raw.length, ceiling: META_ENUM_RECORDS_MAX });
        },
        async removeClaims(refs: readonly unknown[]) { removed.push([...refs]); },
      }),
    } as unknown as MailboxAdapter;

    await expect(releaseMailboxClaim(adapter, "us", "mb-lease-test", "n-us"),
      "a release that could not ask which records are ours reported success anyway")
      .rejects.toThrow(/could not be enumerated/);
    expect(removed, "a release that proved nothing still expunged from the folder").toEqual([]);
  });

  it("releases a claim of its own that the newest window does not reach", async () => {
    const claim = (nonce: string) => formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
      heartbeat: new Date(), claimedAt: new Date(), nonce,
    });
    /* OUR OWN claim at the FRONT — the oldest record in the folder, outside the newest window —
       and a superseded one at the back, a flood between them. The nonce sits on the OUT-OF-WINDOW
       record on purpose: this case is about the io's REACH, and a release is addressed by
       (install, nonce), so the record it must reach is the one bearing our nonce. */
    const residue = { ref: 7, raw: claim("n-us") };
    const live = { ref: 9_001, raw: claim("n-old") };
    const flood: Array<{ ref: number; raw: string }> = [];
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 50; i++) {
      flood.push({ ref: 100 + i, raw: `Subject: newsletter ${i}\r\n\r\nbody` });
    }
    const all = [residue, ...flood, live];

    const removed: unknown[][] = [];
    const adapter = {
      async connect() {}, async close() {},
      leaseIo: () => ({
        // The bounded read cannot see the residue — it is the OLDEST record in the folder.
        async listClaims(): Promise<never> {
          throw new MetaEnumRefusedError("over_ceiling", { rows: 0, total: all.length, ceiling: META_ENUM_RECORDS_MAX });
        },
        /* An io that CAN reach the residue. Production's `makeLeaseIo` no longer can — its locate
           is the bounded current read and refuses a folder this full — so this double is RICHER
           than production on purpose: what is pinned here is the CALLER's algebra (the count is
           every record the io named as a candidate and parsed as ours, wherever it sat), not the
           io's reach. */
        async findOwnRecords(installId: string) {
          return all.filter((m) => m.raw.includes(`X-Ohmail-Install-Id: ${installId}`));
        },
        /* Removal is REAL — the release now confirms by re-read, and a double that only records
           its refs would report its own claim still standing and fail the release it just
           performed (the fixture wearing a defect's clothes). */
        async removeClaims(refs: readonly unknown[]) {
          removed.push([...refs]);
          const gone = new Set(refs);
          for (let i = all.length - 1; i >= 0; i--) {
            if (gone.has(all[i]!.ref)) all.splice(i, 1);
          }
        },
      }),
    } as unknown as MailboxAdapter;

    expect(await releaseMailboxClaim(adapter, "us", "mb-lease-test", "n-us"),
      "a claim outside the newest window was left holding the mailbox").toBe(1);
    /* AND THE COST OF THE NONCE SCOPE, STATED WHERE IT BITES. A same-id claim carrying another
       nonce is left standing, because from the folder alone this install's own superseded record
       and a live sibling lineage's are the same shape — and taking the wrong one is a mailbox
       somebody loses. Our residue is already stale, so every reader steps over it and the handover
       is not delayed; it ages out on its own. */
    expect(all.map((m) => m.raw).join("\n"),
      "our own superseded residue was taken by a nonce-scoped release")
      .toContain("X-Ohmail-Nonce: n-old");
    // ONE delete, of the out-of-window ref, in one command — the reach and the address together.
    expect(removed).toEqual([[7]]);
  });

  it("a claim that reappears at a NEW uid fails the release — the confirm re-read is the proof", async () => {
    /*
     * THE UID-REWRITE SHAPE, measured live at RC3: the same claim reappearing at a new uid under
     * a constant UIDVALIDITY, so every delete of the located uid succeeded and the claim went on
     * standing. The delete proves the uids it was handed are gone; only a RE-READ can see a
     * record of ours the locate never named. A count returned here would be the pane telling a
     * person the mailbox was let go while their other machine goes on refusing it.
     *
     * WATCHED RED at RC3-final: `releaseMailboxClaim` resolved `1` with the rewritten record
     * still in the folder — the release reported done against a folder that still held it.
     */
    const claim = formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n-us",
    });
    let folder: Array<{ ref: number; raw: string }> = [{ ref: 5, raw: claim }];
    const adapter = {
      async connect() {}, async close() {},
      leaseIo: () => ({
        async listClaims() { return folder.map((m) => ({ ...m })); },
        async findOwnRecords() { return folder.map((m) => ({ ...m })); },
        async removeClaims(refs: readonly unknown[]) {
          const gone = new Set(refs);
          folder = folder.filter((m) => !gone.has(m.ref));
          // …and the server writes the same record back under the next uid, unasked.
          folder.push({ ref: 6, raw: claim });
        },
      }),
    } as unknown as MailboxAdapter;

    await expect(releaseMailboxClaim(adapter, "us", "mb-lease-test", "n-us"),
      "a release the folder undid reported a count anyway")
      .rejects.toMatchObject({ name: "ClaimReleaseError", code: "still_present" });
  });

  /**
   * A `_meta` TOO FULL TO READ NAMES ITSELF ON THE ROW. The refusal is `meta_folder_full`, still in
   * the exempt class (nothing quarantined, nothing stood down); the row says the folder is full,
   * because the cure is in the person's own mailbox and "cannot read" names nothing they can do.
   * The ordinary list failure beside it is the positive control: it keeps `lease_unreadable`.
   */
  async function blockReasonFor(listClaims: () => Promise<never>): Promise<string | null> {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });
    fleet.metaFor(mb.mailboxId).listClaims = listClaims;
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 600, syncBlockGraceMs: 0,
      sentDomain: "trafficflow.test", adapterFactory: fleet.factory, mailboxRetryMs: 100, maxSyncFailures: 1,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).syncBlockedReason != null),
      "the refused read wrote no reason at all").toBe(true);
    const row = await rowOf(db, mb.mailboxId);
    expect(row.status, "a refused lease read is not a broken mailbox").not.toBe("error");
    expect(row.disabledReason, "and it is not a stand-down").toBeNull();
    expect(fleet.syncs).toBe(0);
    return row.syncBlockedReason;
  }

  it("a _meta past the read ceiling says meta_folder_full on the row, not lease_unreadable", async () => {
    expect(await blockReasonFor(async () => {
      throw new MetaEnumRefusedError("over_ceiling", {
        rows: 0, total: META_ENUM_RECORDS_MAX + 10, ceiling: META_ENUM_RECORDS_MAX,
      });
    })).toBe("meta_folder_full");
  }, 60_000);

  it("a _meta past the BYTE ceiling says the same — it fires first on foreign mail", async () => {
    expect(await blockReasonFor(async () => {
      throw new MetaEnumRefusedError("bytes", { rows: 1_200, total: 1_500, ceiling: 32 * 1024 * 1024 });
    })).toBe("meta_folder_full");
  }, 60_000);

  it("an ordinary list failure still says lease_unreadable on the row", async () => {
    expect(await blockReasonFor(async () => { throw new Error("ohmail/_meta is unreachable"); }))
      .toBe("lease_unreadable");
  }, 60_000);

  /**
   * LOW-3: THE BLOCK CLEARS ON ITS OWN. A folder over the limit reads
   * `meta_folder_full`, stays connected and never `error`; made smaller, the reason clears to null
   * with no press and a cycle runs.
   */
  it("a full _meta that is made smaller clears its block with no press, and a cycle runs", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });
    const meta = fleet.metaFor(mb.mailboxId);
    const readable = meta.listClaims.bind(meta);
    let full = true;
    meta.listClaims = async () => {
      if (full) throw new MetaEnumRefusedError("over_ceiling", { rows: 0, total: META_ENUM_RECORDS_MAX + 10, ceiling: META_ENUM_RECORDS_MAX });
      return readable();
    };
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 600, syncBlockGraceMs: 0,
      sentDomain: "trafficflow.test", adapterFactory: fleet.factory, mailboxRetryMs: 100, maxSyncFailures: 1,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).syncBlockedReason === "meta_folder_full")).toBe(true);
    await new Promise((r) => { setTimeout(r, 3_000); });
    const held = await rowOf(db, mb.mailboxId);
    expect([held.status, held.syncBlockedReason, held.disabledReason]).toEqual(["connected", "meta_folder_full", null]);
    expect(fleet.syncs).toBe(0);
    full = false;
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).syncBlockedReason === null && fleet.syncs > 0),
      "the block outlived the folder that caused it").toBe(true);
    const row = await rowOf(db, mb.mailboxId);
    expect([row.status, row.disabledReason, row.errorCode]).toEqual(["connected", null, null]);
  }, 60_000);

  /** A fleet whose lease, peek and request IO are the REAL ones over one in-process server. */
  function realMetaFactory(fleet: FakeAdapterFleet, server: MemoryImapServer): FakeAdapterFleet["factory"] {
    const toPath = (c: string): string => c.replace(/\//g, ".");
    return (cfg, ctx) => ({
      ...fleet.factory(cfg, ctx),
      leaseIo: (identity: { installId: string; mailboxId: string }) => makeLeaseIo(server, toPath, identity),
      requestOrganizerIo: (identity: { installId: string; mailboxId: string }) =>
        makeRequestOrganizerIo(server, toPath, identity),
    });
  }
  const REAL_META = "INBOX.ohmail._meta";
  const oursIn = (server: MemoryImapServer): number => server.tree.get(REAL_META)!.messages
    .filter((m) => /^X-Ohmail-Install-Id: cloud-test\r?$/m.test(m.raw)).length;

  /**
   * META-SHRINK-AHEAD-OF-THE-GATE: the refused arm sweeps a folder too full to read. Thousands of records,
   * most of them our own claims two days old: the gate refuses `meta_folder_full`, the refused arm
   * sweeps with no request read, and the next pass reads the folder and organizes with no press.
   * Everything else in the folder is byte-identical by uid. MUTATION WATCHED RED: drop the
   * refused-arm call and the row stays `meta_folder_full` with zero syncs.
   */
  it("the refused arm sweeps a full _meta back under the ceiling, and the block clears with no press", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", REAL_META] });
    const twoDays = new Date(Date.now() - 2 * 86_400_000);
    const kept = new Map<number, string>();
    const keep = (raw: string, at: Date): void => { kept.set(server.seed(REAL_META, raw, at), raw); };
    for (let i = 0; i < META_ENUM_RECORDS_MAX - 1_200; i++) keep(`Subject: filed ${i}\r\n\r\nbody`, twoDays);
    for (let i = 0; i < 1_200; i++) {
      const hb = new Date(twoDays.getTime() - i * 1_000);
      server.seed(REAL_META, formatClaim({ installId: "cloud-test", kind: "cloud", displayName: "Cloud", heartbeat: hb,
        claimedAt: hb, nonce: `old-${i}`, authorizedAt: null, capabilities: [] }), hb);
    }
    /* Another install's claim past its window and inside two: not live, not residue, not ours. LAST,
       because the newest record dates the sweep's cutoff by the server's clock. */
    const lapsed = new Date(Date.now() - 90_000);
    keep(formatClaim({ installId: "them", kind: "local", displayName: "Them", heartbeat: lapsed, claimedAt: lapsed,
      nonce: "them-lapsed", authorizedAt: null, capabilities: [] }), lapsed);
    expect(server.tree.get(REAL_META)!.messages.length).toBe(META_ENUM_RECORDS_MAX + 1);
    const { events, logger } = recordingLogger();
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 600, syncBlockGraceMs: 0,
      sentDomain: "trafficflow.test", adapterFactory: realMetaFactory(fleet, server), mailboxRetryMs: 100,
      maxSyncFailures: 1, logger, organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => fleet.syncs > 0 && (await rowOf(db, mb.mailboxId)).syncBlockedReason === null, 40_000),
      "the full folder never came back under the ceiling").toBe(true);
    expect(events.some((e) => e.event === "attach_lease_unavailable" && e.fields.op === "meta_folder_full"),
      "the folder was never refused, so this case is about nothing").toBe(true);
    const shrink = events.find((e) => e.event === "meta_shrink");
    expect(shrink?.fields).toMatchObject({ mailboxId: mb.mailboxId, phase: "lease_refused", ran: true, swept: 1_000 });
    const after = new Map(server.tree.get(REAL_META)!.messages.map((m) => [m.uid, m.raw]));
    for (const [uid, raw] of kept) expect(after.get(uid), `uid ${uid} was touched`).toBe(raw);
    const row = await rowOf(db, mb.mailboxId);
    expect([row.status, row.errorCode]).toEqual(["connected", null]);
  }, 60_000);

  /**
   * META-RENEW-WITHOUT-EXPUNGE on the worker: a folder whose deletes are refused stops the renewals
   * and names itself. Connected, no error code, no stand-down, no sync while blocked; the claims
   * stop growing at k+1; the delete restored clears it with no press. MUTATIONS WATCHED RED: k to
   * Infinity (the claims keep growing), and the read-back failure counted as a refusal (a
   * FETCH-failing server blocks).
   */
  it("a _meta that takes no delete stops the renewals, says meta_undeletable, and clears when it heals", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", REAL_META] });
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 600, syncBlockGraceMs: 0,
      sentDomain: "trafficflow.test", adapterFactory: realMetaFactory(fleet, server), mailboxRetryMs: 100,
      maxSyncFailures: 1, organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(async () => fleet.syncs > 0)).toBe(true);
    const before = oursIn(server);
    server.startLyingAboutDeletes();
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).syncBlockedReason === "meta_undeletable"),
      "a folder that takes no delete was never named").toBe(true);
    const syncs = fleet.syncs;
    const claims = oursIn(server);
    expect(claims - before, "more than k+1 claims were appended").toBeLessThanOrEqual(4);
    await new Promise((r) => { setTimeout(r, 2_000); });
    expect(oursIn(server), "a blocked install kept appending").toBe(claims);
    expect(fleet.syncs, "a blocked install kept syncing").toBe(syncs);
    const held = await rowOf(db, mb.mailboxId);
    expect([held.status, held.errorCode, held.disabledReason]).toEqual(["connected", null, null]);

    server.stopLyingAboutDeletes();
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).syncBlockedReason === null && fleet.syncs > syncs),
      "the block outlived the server's fix").toBe(true);
    expect(oursIn(server), "the probe and the renew after it did not shrink the folder").toBeLessThan(claims);
  }, 60_000);

  it("CONTROL: a server whose read-back fails is never named undeletable", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", REAL_META] });
    const fetch = server.fetch.bind(server);
    server.fetch = ((range, query, opts) => (query.headers === undefined && query.internalDate === undefined
      ? (async function* () { throw new Error("connection reset by peer"); })()
      : fetch(range, query, opts))) as MemoryImapServer["fetch"];
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 600, syncBlockGraceMs: 0,
      sentDomain: "trafficflow.test", adapterFactory: realMetaFactory(fleet, server), mailboxRetryMs: 100,
      maxSyncFailures: 1, organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(async () => fleet.syncs > 0)).toBe(true);
    server.startLyingAboutDeletes();
    const syncs = fleet.syncs;
    expect(await waitFor(async () => fleet.syncs > syncs + 8)).toBe(true);
    expect((await rowOf(db, mb.mailboxId)).syncBlockedReason).toBeNull();
  }, 60_000);

  it("a lease that cannot be READ syncs nothing and quarantines nothing", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });
    // The folder is unreachable, which is what a provider erroring on SELECT looks like.
    const meta = fleet.metaFor(mb.mailboxId);
    meta.listClaims = async (): Promise<never> => { throw new Error("ohmail/_meta is unreachable"); };

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory, mailboxRetryMs: 100, maxSyncFailures: 1,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    // Several poll intervals in which to be wrong.
    await new Promise((r) => setTimeout(r, 1500));

    const row = await rowOf(db, mb.mailboxId);
    // NOT quarantined: an infrastructure fault is not a broken mailbox, and the exemption is by
    // CLASS so this holds at every tuning of `maxSyncFailures` — which is set to 1 here, the
    // tightest it can be, precisely so a threshold-based exemption could not pass this.
    expect(row.status).not.toBe("error");
    expect(row.errorCode).toBeNull();
    // NOT stood down either: "somebody else holds this" and "I could not look" must never be
    // reachable from one another. A stand-down is sticky, so a transient error must not disable
    // a mailbox nobody else wants.
    expect(row.status).not.toBe("disabled");
    expect(row.disabledReason).toBeNull();
    // And nothing organized it: the pipeline never ran.
    expect(fleet.syncs).toBe(0);
    expect(worker.stats().mailboxes).toBe(0);
  }, 60_000);

  /**
   * THE STAND-DOWN, RESTATED FOR THE READER MODEL — and what it is still allowed to mean.
   *
   * This asserted `status === 'disabled'` and `disabled_reason === 'organized_elsewhere:local'`,
   * and mail 0083 retired both: `markMailboxStoodDown` writes the ROLE and the holder columns and
   * has no writer for `disabled_reason` at all (`mailboxes.ts`, "MAIL 0083: THE ROLE, NOT THE
   * STATUS"). `disabled` went back to meaning tombstone-or-plan-disable, so waiting for it here
   * waits for a state the product no longer produces.
   *
   * What has NOT changed is the invariant underneath, and the assertions below are it:
   *
   *  · exactly one organizer — Cloud writes NO claim of its own beside the desktop's;
   *  · the loser stops ORGANIZING — no `ensureFolders`, and not one message filed;
   *  · the loser does not re-seize — still no claim after several more cycles;
   *  · and the row names the winner, because the banner reads the row and never dials IMAP.
   *
   * `fleet.syncs === 0` is deliberately NOT carried over. A reader is `connected` and syncs by
   * design — that is the whole of the reader model — so a zero there would now assert against the
   * product. `movesFor(…)` is the assertion that carries the old one's MEANING: syncing is
   * mirroring, filing is organizing, and only the second is forbidden to a reader.
   */
  it("a fresh FOREIGN local claim demotes this worker to READER, and it organizes nothing", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });
    // A desktop install got there first and is alive.
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "a-desktop-install", kind: "local", displayName: "Mila's MacBook",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n1",
    }));
    // MAIL THAT AN ORGANIZER WOULD FILE, and the rule that would file it. Without these the
    // "moves nothing" assertion below is vacuous — there is nothing to move, and a worker that
    // organized this mailbox in defiance of the lease would satisfy it just as easily as one that
    // obeyed. The rule is the same shape `_workerenv.makeHarness` seeds.
    await db.insert(rules).values({
      accountId: mb.accountId, kind: "domain", match: "feed.example",
      destination: "ohmail/News", priority: 5,
    });
    fleet.behave(mb.mailboxId, {
      deliver: [{ from: "digest@feed.example", subject: "a newsletter", messageId: `fl-${randomUUID()}@feed.example` }],
    });

    // Taken BEFORE the worker starts: `seedClaim` appends through the same `FakeMetaFolder`, so
    // the desktop's own claim already sits in this trace. A bare `toHaveLength(0)` below would be
    // asserting that the fixture did not seed.
    const organizedBefore = fleet.indicesOf(mb.mailboxId, "lease_organize").length;

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "reader"),
      "the gate did not demote against a live foreign claim").toBe(true);
    const row = await rowOf(db, mb.mailboxId);
    // NO SEIZE-BACK. `takeover_authorized_at` is NULL, so Cloud may not become the organizer over
    // a live local install even though a fresh cloud lease outranks local for CONTINUING
    // coverage. The two cases are only distinguishable through that column.
    expect(row.takeoverAuthorizedAt).toBeNull();
    // THE ROW NAMES THE WINNER. This is what `disabled_reason` used to say, said in the columns
    // that replaced it — and it says strictly more: the reason string could only ever carry the
    // KIND, and the banner needs the machine's name and whether it is still renewing.
    expect(row.organizedByKind).toBe("local");
    expect(row.organizedByName).toBe("Mila's MacBook");
    expect(row.organizerState).toBe("held");
    // A reader is in perfect health. `disabled` now means tombstone or plan-disable, and a
    // mailbox somebody else organizes is neither.
    expect(row.status).toBe("connected");
    expect(row.disabledReason).toBeNull();

    // ── EXACTLY ONE ORGANIZER, WHICH IS THE POINT OF ALL OF IT ─────────────────────────────
    // The desktop's claim is untouched — standing down releases OUR claims, never the winner's —
    // and there is no second claim beside it, because a loser that claims IS the dual-organizing
    // this gate exists to prevent.
    const claims = fleet.metaFor(mb.mailboxId).messages;
    expect(claims).toHaveLength(1);
    expect(claims[0]!.raw, "Cloud wrote a claim on a mailbox a live desktop holds")
      .toContain("a-desktop-install");
    // It never built the tree and never filed a message: the two acts reserved to an organizer.
    // `lease_organize` is the third and most direct — `FakeMetaFolder.appendClaim` notes it, and
    // `runLeaseGate` appends ONLY on an organize verdict, so it is the gate saying yes, recorded.
    expect(fleet.indicesOf(mb.mailboxId, "lease_organize").length).toBe(organizedBefore);
    expect(fleet.indicesOf(mb.mailboxId, "ensure_folders")).toHaveLength(0);
    expect(fleet.movesFor(mb.mailboxId), "a reader filed mail into ohmail/*").toHaveLength(0);

    // ── AND IT DOES NOT COME BACK ──────────────────────────────────────────────────────────
    // A reader keeps cycling, so "it stood down" is only half the guarantee: the other half is
    // that the next cycle, and the one after, reach the same verdict. Pre-0083 a loser detached
    // and this could not be asked; now it must be.
    await new Promise((r) => setTimeout(r, 1500));
    const meta = fleet.metaFor(mb.mailboxId);
    /* ONE message in `ohmail/_meta`, and it is still only the desktop's claim.
     *
     * The count is over the WHOLE folder rather than over claims, and that is what makes it worth
     * asserting: `_meta` is shared between the lease and the PORTABLE PROFILE (`FakeMetaFolder`
     * implements both `LeaseIo` and `ProfileIo` over one array, exactly as one real folder serves
     * both), and a reader must add neither record. Counting only claims would have missed what
     * this assertion actually caught — the profile write-behind appending a settings document
     * from a demoted worker onto a mailbox another install organizes.
     */
    expect(meta.messages, "the loser wrote to ohmail/_meta on a later cycle").toHaveLength(1);
    // Split out so a failure says WHICH of the two writers it was. `appends` counts the fixture's
    // own `seedClaim`, so 1 is the desktop's claim and nothing of ours.
    expect(meta.appends, "the loser claimed the mailbox on a later cycle").toBe(1);
    expect(meta.profileAppends, "a reader published the mailbox's settings").toBe(0);
    expect(fleet.indicesOf(mb.mailboxId, "lease_organize").length).toBe(organizedBefore);
    expect(fleet.movesFor(mb.mailboxId)).toHaveLength(0);
    expect((await rowOf(db, mb.mailboxId)).organizerRole).toBe("reader");
    // …and it really was READING all along, which is what makes the zeroes above a stand-down
    // rather than a worker that never woke up.
    expect(fleet.syncs, "the reader never synced, so nothing above was tested").toBeGreaterThan(0);
    /* AND IT FETCHED THE ORGANIZER PROFILE ONCE, NOT ONCE PER CYCLE.
     *
     * This assertion read `toBe(0)` and was right when it was written: a reader could not act on
     * an import decision, so asking at all was a full document fetch out of the customer's `_meta`
     * every 30 s for the life of the attachment, and "the profile module outlives the role now,
     * and a reader was still paying for it" removed it.
     *
     * Mail 0094 gives a reader a REASON to read the document — it renders the organizer's settings
     * from `mailbox_profile_mirror` instead of its own dead rows, which is ruling 6's Critical —
     * so the count can no longer be zero. What survives, and what this now pins, is the COST
     * invariant that fix established: one read per cadence, never one per poll. Measured here at
     * nine cycles: 9 before the cadence existed, 1 after. `syncProfileMirror` remembers the last
     * attempt, so the eight later cycles cost nothing even though this folder holds NO document
     * and therefore caches no row to read the age from.
     *
     * The write half is asserted three lines up and is unchanged at 0: a reader still publishes
     * nothing. That is the half that would be a dual-organizer defect. */
    expect(meta.profileReads, "a reader re-read the organizer profile on a later cycle").toBe(1);
  }, 60_000);

  it("an AUTHORIZED takeover proceeds, and spends the authorization exactly once", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "a-desktop-install", kind: "local", displayName: "Mila's MacBook",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n1",
    }));
    // The connect flow's explicit human action — "add this mailbox to Cloud".
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date(), takeoverIntent: "takeover" })
      .where(eq(mailboxes.id, mb.mailboxId));

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => worker.stats().mailboxes === 1), "the takeover must proceed").toBe(true);
    const row = await rowOf(db, mb.mailboxId);
    expect(row.status).toBe("connected");
    expect(row.disabledReason).toBeNull();
    // ONE-SHOT. Left set, a lapse-then-resubscribe months later would seize the mailbox back from
    // whatever a human deliberately moved it to — the seize-back §4 forbids.
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).takeoverAuthorizedAt === null),
      "the authorization must be spent").toBe(true);
    // Cloud's claim is now in the folder beside the desktop's; the desktop stands down on its own
    // next cycle, which is `apps/sidecar`'s half.
    const kinds = fleet.metaFor(mb.mailboxId).messages.map((m) => /Kind: (\w+)/.exec(m.raw)?.[1]);
    expect(kinds).toContain("cloud");
    // THE POSITIVE CONTROL FOR THE STAND-DOWN TESTS ABOVE AND BELOW, which assert that a reader
    // calls `ensureFolders` ZERO times. A count that is zero because the worker never builds a
    // tree in this fixture at all would make every one of those assertions vacuous, and nothing
    // in those tests can tell the two apart. Here the gate said organize, so it must be > 0.
    expect(fleet.indicesOf(mb.mailboxId, "ensure_folders").length,
      "an organizer did not build the folder tree, so the readers' zero proves nothing")
      .toBeGreaterThan(0);
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  THE STAMPLESS PROMOTION IS DELETED — it was the auto-resume, and 0.14.1 closes it
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * THIS CASE ASSERTED THE OPPOSITE, and its own prose is preserved because it was a correct
   * reading of the code and an incorrect reading of the product:
   *
   *   > *"0083 created a promotion with NEITHER [stamp nor reason]: a mailbox Cloud is consented
   *   > to organize, demoted to READER while a desktop held it, whose desktop then RELEASED its
   *   > claim cleanly. The folder is empty, `decideLease`'s first arm says organize, and no human
   *   > touched anything — no stamp is involved because none is needed."*
   *
   * **"No human touched anything" is the defect, stated as the feature.** The governing rule is
   * that ceasing to organize is automatic and BECOMING an organizer always requires an explicit
   * human action. A desktop releasing cleanly is the ordinary end of a handover somebody
   * deliberately made; sixty seconds later this worker picked the mailbox back up, created the
   * folder tree and started filing, because the folder the other install had tidied up after
   * itself was empty.
   *
   * The standalone door never had it (`apps/sidecar/test/reader-no-auto-resume.test.ts` has held
   * this line since the reader model landed), so the two doors disagreed about the product's own
   * rule with the hosted side on the wrong side of it.
   *
   * What replaces it is above: "a CONSENTED READER over an EMPTY folder never claims, over many
   * cycles", and its positive control beside it. The row-writing half this case also proved — a
   * promotion clears the holder columns with the role — is proved there too, by the pressed
   * reader that IS promoted.
   *
   * The negative control is kept whole and turned into the whole case, because it is still worth
   * asking on its own: a consent-less reader must promote nothing either, and for a different
   * reason (nobody has asked this install at all, so the gate refuses before the role is even
   * consulted).
   */
  it("a CONSENT-LESS reader over an empty folder promotes nothing either", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const other = await seedMailbox(db);
    await db.update(mailboxes).set({
      organizerRole: "reader", organizedByKind: "local", organizeConsentedAt: null,
      disabledReason: null, takeoverAuthorizedAt: null,
    }).where(eq(mailboxes.id, other.mailboxId));
    expect(fleet.metaFor(other.mailboxId).messages).toHaveLength(0);

    const second = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => second.stop());
    // Several poll intervals in which to be wrong.
    await new Promise((r) => setTimeout(r, 1500));
    expect((await rowOf(db, other.mailboxId)).organizerRole,
      "an empty lease folder promoted a mailbox nobody has asked this install to organize")
      .toBe("reader");
    expect(fleet.metaFor(other.mailboxId).messages,
      "a consent-less mailbox was claimed").toHaveLength(0);
    expect(fleet.indicesOf(other.mailboxId, "ensure_folders"),
      "the tree was built in a mailbox nobody asked this install to organize").toHaveLength(0);
  }, 90_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  THE DEMOTION AND THE CLOSE, MEETING ON REAL POSTGRES
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * `packages/services/test/scheduled-send-stand-down.pg.test.ts` proves the CLOSE against a
   * reader row, and it says so in its own fixture comment: *"the fixture has to write what the
   * product writes or the tests below prove something about a state nothing produces."* That is
   * exactly the seam `QAO-SCHEDULED-SEND-ORPHANED-BY-MIGRATION` came back through — the writer
   * moved to a new column and the reader did not — and a hand-written row on either side cannot
   * see it. So this arm supplies the missing join: the REAL gate demotes through
   * `markMailboxStoodDown`, and the appointment on that mailbox has to end up carrying the
   * sentence, with no fixture between the two.
   *
   * The draft is armed by direct insert rather than through `ScheduleService`, which this app may
   * not import at runtime; the shape that service produces (`status:'scheduled'` + `send_at` +
   * `send_key`) is pinned where it is produced, in the services pg file above.
   */
  it("a demotion CLOSES the appointment it orphans — the real write, on real Postgres", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });
    // Consented, organizing, with an appointment two hours out — the state a handover interrupts.
    await db.update(mailboxes).set({ organizeConsentedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(mailboxes.id, mb.mailboxId));
    const [draft] = await db.insert(drafts).values({
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      subject: "the appointment", body: "the words",
      to: [{ name: null, address: "you@example.com" }],
      status: "scheduled",
      sendAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      sendKey: randomUUID(),
    }).returning();

    // A desktop takes the mailbox while the appointment is pending.
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "a-desktop-install", kind: "local", displayName: "Mila's MacBook",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n1",
    }));

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "reader"),
      "the gate did not demote against a live foreign claim").toBe(true);

    const closed = await waitFor(async () => {
      const [d] = await db.select().from(drafts).where(eq(drafts.id, draft!.id));
      return d!.status === "draft";
    });
    expect(closed, "the demotion left a pending appointment nothing will ever act on").toBe(true);

    const [after] = await db.select().from(drafts).where(eq(drafts.id, draft!.id));
    // THE SENTENCE, not merely a cancellation. The person is told what happened and where the
    // message can be sent from now — which is the whole reason the close exists rather than an
    // expiry that fires inside a pass this mailbox will never run again.
    expect(after!.sendError).toBe(STAND_DOWN_SEND_SENTENCES["organized_elsewhere:local"]);
    // BOTH HANDLES GONE, so neither the demoted side nor the promoted one can find this row
    // again. That is the double-send boundary as a property of the row rather than of a schedule.
    expect(after!.sendAt).toBeNull();
    expect(after!.sendKey).toBeNull();
  }, 90_000);

  it("a demotion HANDS OVER the moves recorded in the takeover window", async () => {
    /**
     * THE WINDOW, DRIVEN. Between another install's takeover and this worker's next lease poll the
     * row still reads `organizer`, so a paired device's forwarded move passes `assertOrganizerRole`
     * and is recorded as a local `folder_state` intent — the state seeded below. The gate then
     * stands the mailbox down, correctly, and until this fix the intent stayed here: a reader's
     * reconciler skips it and the install that holds the mailbox has never heard of it, so the near
     * side showed a move that never reached the mail server.
     *
     * It leaves as the `message.move` request the door would have written. Watched failing by
     * removing the export call from the stand-down arm: the row demotes and no request appears.
     */
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });
    const [th] = await db.insert(threads).values({ accountId: mb.accountId, subject: "s" }).returning();
    const dedupKey = randomUUID().replace(/-/g, "");
    const [msg] = await db.insert(messages).values({
      accountId: mb.accountId, mailboxId: mb.mailboxId, threadId: th!.id, dedupKey,
      messageIdHeader: `<${dedupKey}@trafficflow.test>`, bodyHash: randomUUID(),
      nativeLocator: { folder: "INBOX", uidvalidity: "1", uid: 4 },
    }).returning();
    // The forwarded move, exactly as the door records it: desired only, observed preserved.
    await db.insert(folderState).values({
      messageId: msg!.id, desiredFolder: "ohmail/News", observedFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
    });

    // A desktop takes the mailbox in that window.
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "a-desktop-install", kind: "local", displayName: "Mila's MacBook",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n1",
    }));

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "reader"),
      "the gate did not demote against a live foreign claim").toBe(true);

    const handed = await waitFor(async () => (await db.select().from(organizerRequests)
      .where(eq(organizerRequests.mailboxId, mb.mailboxId))).length > 0);
    expect(handed, "the intent recorded in the takeover window was left behind").toBe(true);

    const rows = await db.select().from(organizerRequests)
      .where(eq(organizerRequests.mailboxId, mb.mailboxId));
    // ONE request, whatever the gate did afterwards: it answers `stand_down` every cycle while
    // the foreign claim stands, and only the transition hands anything over.
    expect(rows, "a request per poll would be one intent asserted many times").toHaveLength(1);
    expect(rows[0]!.kind).toBe("message.move");
    expect(rows[0]!.state).toBe("pending");
    expect(rows[0]!.payload).toEqual({ dedupKey, destination: "reads" });
  }, 90_000);

  // The ENTITLEMENT-LAPSE case stood here. The signal is now a refused access verdict from the
  // entitlements port, not a subscription this server reads, and no roster call supplies the
  // parked-accounts reader — so the arm could not be entered. `packages/api/test/access-gate.test.ts`
  // covers the refusal, `apps/worker/test/roster-adoption-query.pg.test.ts` the reader that drops
  // the account.

  /* ════════════════════════════════════════════════════════════════════════════════════════
     THE CYCLE-TOP RE-VERIFICATION, WHICH THE ATTACH GATE HIDES
     ════════════════════════════════════════════════════════════════════════════════════════

     Deleting the gate call from `cycle()` left the whole two-worlds e2e green, because the attach
     gate had already stood the loser down before a cycle ever ran. A gate nobody has watched fail
     is not evidence, so the two below exist to watch THAT one: each starts from a mailbox this
     worker legitimately organizes and changes the lease WHILE IT IS ATTACHED.

     Both are also the honest answer to "what can preempt a covering Cloud at all". Not a fresh
     local claim — `decideLease` arm 3 keeps an entitled, actively covering Cloud organizing, on
     purpose, or a desktop install could take a paying customer's mailbox by writing one message.
     What can is a peer we cannot RANK, and a peer that turns out to be using our own identity.
     ════════════════════════════════════════════════════════════════════════════════════════ */

  it("a claim from a FUTURE PROTOCOL appearing mid-life stands the worker down on its next cycle", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 60_000,
      sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    // It organizes first — the attach gate said yes, and that is what makes this test about the
    // CYCLE gate rather than about the attach gate a second time.
    expect(await waitFor(async () => worker.stats().mailboxes === 1)).toBe(true);
    const syncsWhileOrganizing = await (async () => {
      expect(await waitFor(async () => fleet.syncs > 0)).toBe(true);
      return fleet.syncs;
    })();

    // Now something we cannot understand claims the mailbox. A higher protocol must be treated as
    // FOREIGN AND FRESH — never as unparseable-so-ignored, or a future claim format would
    // silently re-enable dual organizing against every older install.
    fleet.seedClaim(mb.mailboxId, [
      "X-Ohmail-Lease: 1",
      "X-Ohmail-Organizer-Kind: cloud",
      "X-Ohmail-Install-Id: something-newer",
      "X-Ohmail-Protocol: 99",
      `X-Ohmail-Heartbeat: ${new Date().toISOString()}`,
      `X-Ohmail-Claimed-At: ${new Date().toISOString()}`,
      "X-Ohmail-Display-Name: ohmail Cloud (next)",
      "X-Ohmail-Nonce: future",
      "", "",
    ].join("\r\n"));

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "reader"),
      "the NEXT cycle must re-verify and demote").toBe(true);
    /* WHAT THE FOLDER SAYS, once the reader has looked. The stand-down writes the header's kind,
     * `cloud`; the reader's first peek rewrites it as `unknown`, the gate's own word for a claim
     * it cannot rank. This read `cloud` only while the fake offered no peek, so the fixture was
     * the last writer. Two looks, so the first one's write has landed. The one-cycle disagreement
     * between the two writers is filed (STAND-DOWN-AND-PEEK-NAME-AN-UNRANKABLE-HOLDER-TWO-WAYS). */
    const looked = fleet.peekReads.get(mb.mailboxId) ?? 0;
    expect(await waitFor(async () => (fleet.peekReads.get(mb.mailboxId) ?? 0) >= looked + 2),
      "the reader never looked at the folder").toBe(true);
    const row = await rowOf(db, mb.mailboxId);
    expect(row.organizedByKind, "the reader's holder is not the folder's reading").toBe("unknown");
    expect(row.organizedByName).toBe("ohmail Cloud (next)");
    expect(row.organizerState).toBe("held");

    /* ── DEMOTED, NOT DETACHED — AND THE OLD ASSERTIONS SAID THE OPPOSITE ─────────────────
     *
     * This block used to read: `stats().mailboxes === 0`, `openFor === 0`, and "no cycle may run
     * after the stand-down". All three described the PRE-0083 teardown, where a loser was pushed
     * onto `toStandDown`, detached, and its login closed. A loser now keeps the connection, the
     * poll timer and the mirror (`index.ts`, "THE ROLE FLIP, IN BOTH DIRECTIONS, WITHOUT A
     * RE-ATTACH"), so those three are assertions against the product — and inverting them is not
     * a weakening, because the guarantee they were standing in for is asserted directly below.
     *
     * The guarantee is: it stops ORGANIZING. Syncing continues; claiming, building the tree and
     * filing mail do not.
     */
    expect(worker.stats().mailboxes, "a reader keeps its place in the roster").toBe(1);
    expect(fleet.openFor(mb.mailboxId), "a reader keeps its login").toBe(1);
    expect(worker.stats().quarantined).toBe(0);
    expect(fleet.syncs).toBeGreaterThanOrEqual(syncsWhileOrganizing);

    // ── THE CLAIM IS RELEASED, AND NEVER RE-TAKEN ─────────────────────────────────────────
    //
    // Cloud held a claim while it organized. On demotion that claim has to GO: a frozen Cloud
    // claim left in `ohmail/_meta` reads to every other install as a live Cloud organizer for the
    // length of the staleness window, which is exactly the "ten minutes of a product that looks
    // broken" `releaseOrganizerClaim` is written to prevent, one path over.
    //
    // Then: several more reader cycles in which to be wrong. This is the half pre-0083 could not
    // ask — a detached worker cannot re-seize, a cycling reader can — and it is the one that
    // makes "exactly one active organizer" a property of the STEADY STATE rather than of a single
    // instant.
    const ours = (): number => fleet.metaFor(mb.mailboxId).messages
      .filter((m) => m.raw.includes("cloud-test")).length;
    expect(await waitFor(async () => ours() === 0),
      "the demoted worker left its own claim in ohmail/_meta").toBe(true);
    const foreign = (): number => fleet.metaFor(mb.mailboxId).messages
      .filter((m) => m.raw.includes("something-newer")).length;
    expect(foreign(), "the loser expunged the WINNER's claim").toBe(1);

    await new Promise((r) => setTimeout(r, 1500));
    expect(ours(), "the demoted worker re-seized the mailbox on a later cycle").toBe(0);
    expect(foreign(), "the winner's claim was expunged by the loser").toBe(1);
    expect((await rowOf(db, mb.mailboxId)).organizerRole).toBe("reader");
    expect(fleet.movesFor(mb.mailboxId), "a reader filed mail").toHaveLength(0);
  }, 60_000);

  /**
   * A READER'S HOLDER COLUMNS FOLLOW THE FOLDER — the peek the fake now offers, proved by a case
   * that took the blind branch before it did. A handover this reader never gated on (one desktop
   * lets go, another claims) reaches the row only through the reader's own look.
   * MUTATION WATCHED RED: `leasePeek = false` in the fake, and the row keeps naming the first holder.
   */
  it("a READER's holder columns follow a second handover it never gated on", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });
    const desktop = (installId: string, displayName: string): string => formatClaim({
      authorizedAt: null, capabilities: [], installId, kind: "local", displayName,
      heartbeat: new Date(), claimedAt: new Date(), nonce: `n-${installId}`,
    });
    fleet.seedClaim(mb.mailboxId, desktop("first-desktop", "First laptop"));

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 60_000,
      sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(async () => {
      const r = await rowOf(db, mb.mailboxId);
      return r.organizerRole === "reader" && r.organizedByName === "First laptop";
    }), "the worker did not stand down against the first desktop").toBe(true);

    const meta = fleet.metaFor(mb.mailboxId);
    await meta.removeClaims(meta.messages.filter((m) => m.raw.includes("first-desktop")).map((m) => m.ref));
    fleet.seedClaim(mb.mailboxId, desktop("second-desktop", "Second laptop"));

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizedByName === "Second laptop"),
      "the reader's row still names a holder the folder no longer has").toBe(true);
    expect(fleet.peekReads.get(mb.mailboxId) ?? 0, "the row moved without the reader looking")
      .toBeGreaterThan(0);
    expect((await rowOf(db, mb.mailboxId)).organizerRole, "a reader re-gated on the handover").toBe("reader");
  }, 60_000);

  it("a lease that becomes unreadable MID-LIFE neither quarantines the mailbox nor stands it down", async () => {
    // The `cycle()` arm of the exemption, which the attach arm hides: a mailbox that attached
    // cleanly and whose `ohmail/_meta` then stops answering. `maxSyncFailures` is 1 — the tightest
    // it can be — so an exemption written as threshold arithmetic instead of a class check could
    // not pass this.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 60_000,
      sentDomain: "trafficflow.test", adapterFactory: fleet.factory, maxSyncFailures: 1,
      mailboxRetryMs: 100,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(async () => worker.stats().mailboxes === 1)).toBe(true);
    expect(await waitFor(async () => fleet.syncs > 0)).toBe(true);

    const meta = fleet.metaFor(mb.mailboxId);
    meta.listClaims = async (): Promise<never> => { throw new Error("ohmail/_meta stopped answering"); };

    // The snapshot is taken AFTER the fault has had a poll interval to take effect, not at the
    // moment it is installed: a cycle already in flight completes legitimately, and counting it as
    // a violation would make this test fail on timing rather than on behaviour.
    await new Promise((r) => setTimeout(r, 600));
    const atFault = fleet.syncs;

    // Several more cycles in which to be wrong.
    await new Promise((r) => setTimeout(r, 1200));
    const row = await rowOf(db, mb.mailboxId);
    expect(row.status, "an unreadable lease is not a broken mailbox").not.toBe("error");
    expect(row.errorCode).toBeNull();
    expect(row.status, "and it is not a stand-down either — a stand-down is STICKY").not.toBe("disabled");
    expect(row.disabledReason).toBeNull();
    expect(worker.stats().quarantined).toBe(0);
    // …and it organized nothing while it could not prove the mailbox was ours.
    expect(fleet.syncs).toBe(atFault);
  }, 60_000);

  it("the CLONE DEFENCE bites mid-life: a live peer using our install id is foreign", async () => {
    // The hazard a shared Cloud install id creates, and the one a storage-provider cutover
    // makes concrete: two deployments with the SAME id, both alive. The second to write expunges
    // the first's claim (the renew's cleanup matches on install id) and the first then reads a
    // claim bearing its own id that it did not write. Identity matching alone would call that
    // "ours" and permit exactly the dual organizing it exists to prevent; the per-write nonce is
    // what makes it foreign.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 60_000,
      sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
      organizer: { installId: "ohmail-cloud:production", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(async () => worker.stats().mailboxes === 1)).toBe(true);
    expect(await waitFor(async () => fleet.metaFor(mb.mailboxId).messages.length === 1)).toBe(true);

    // The other deployment renews: our claim is expunged and replaced by one carrying our id and
    // a nonce we never wrote, with a newer heartbeat.
    const meta = fleet.metaFor(mb.mailboxId);
    await meta.removeClaims(meta.messages.map((m) => m.ref));
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud (elsewhere)",
      heartbeat: new Date(Date.now() + 5_000), claimedAt: new Date(), nonce: "not-the-one-we-wrote",
    }));

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "reader"),
      "a live peer wearing our identity must not be trusted").toBe(true);
    expect((await rowOf(db, mb.mailboxId)).organizedByKind).toBe("cloud");
    expect((await rowOf(db, mb.mailboxId)).organizedByName).toBe("ohmail Cloud (elsewhere)");

    /* ── AND NOW THE HALF THE PRE-0083 TEST COULD NOT ASK ─────────────────────────────────
     *
     * A loser used to detach: one stand-down, one row write, no further cycles, and the clone
     * defence was fully tested by the instant it fired. A loser is now a READER that keeps
     * polling, so the defence has to hold on every subsequent cycle too — and there is a specific
     * way for it not to.
     *
     * `runLeaseGate` releases "our" claims on a stand-down by matching on INSTALL ID ALONE
     * (`organizer-lease.ts`, `ourRefs`), while the verdict decides ours-ness by install id AND
     * nonce (`rawOurs`). Against a clone those two disagree by construction: the peer's claim
     * carries our id, so the release treats the WINNER's claim as ours and expunges it. The
     * folder then reads empty, `decideLease`'s "nobody has ever organized this mailbox" arm says
     * organize, and the loser re-seizes on its very next poll — two live deployments taking the
     * mailbox from each other for ever. That is the dual organizing this whole file exists to
     * prevent, reached through the defence that is supposed to prevent it.
     *
     * So: the peer's claim must SURVIVE, and this process must not claim again.
     */
    const peerClaims = (): number => fleet.metaFor(mb.mailboxId).messages
      .filter((m) => m.raw.includes("not-the-one-we-wrote")).length;
    expect(peerClaims(), "the loser expunged the winner's claim").toBe(1);

    const organizedBefore = fleet.indicesOf(mb.mailboxId, "lease_organize").length;
    // Several more reader cycles in which to be wrong.
    await new Promise((r) => setTimeout(r, 1500));
    expect(fleet.indicesOf(mb.mailboxId, "lease_organize").length,
      "the loser re-seized the mailbox from the peer wearing its identity").toBe(organizedBefore);
    expect(peerClaims(), "the winner's claim did not survive the loser's later cycles").toBe(1);
    expect((await rowOf(db, mb.mailboxId)).organizerRole).toBe("reader");
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  A CONSENTED READER OVER AN EMPTY FOLDER, FOR N CYCLES — the 0.14.1 REQUIRED FIX
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * THE DEFECT, AND IT WAS LIVE ON CLOUD AND ONLY ON CLOUD. `mayOrganize` ran the WRITE gate for
   * a consented reader on every cycle. `readMailboxLease` is not a report — `decideLease`'s arm 4
   * ("the folder holds no readable claim at all, so nobody has ever organized this mailbox")
   * answers `organize` and the gate APPENDS. So a reader whose organizer had released cleanly —
   * which is exactly what a well-behaved stand-down and the 0.14.1 release both produce — claimed
   * the mailbox on its next pass and the row was promoted. Auto-resume with no press, sixty
   * seconds after somebody deliberately moved organizing to another machine.
   *
   * The standalone door never had it (`apps/sidecar/test/reader-no-auto-resume.test.ts`), so the
   * two doors disagreed about the product's own governing rule — *ceasing to organize is
   * automatic; BECOMING an organizer always requires an explicit human action* — with the hosted
   * side on the wrong side of it. This is that rule's hosted half, and the sidecar file carries
   * its twin.
   *
   * N CYCLES rather than one, because the failure is a POLL and not a start-up: a single pass
   * proves only that the first tick was quiet.
   *
   * HOW TO WATCH IT FAIL: delete the `organizerRole === "reader" && takeoverAuthorizedAt === null`
   * branch from `mayOrganize` (`apps/worker/src/index.ts`) and this goes red on the claim count —
   * *"a reader claimed a mailbox nobody asked it to organize"*. Run, not assumed.
   */
  it("a CONSENTED READER over an EMPTY folder never claims, over many cycles", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    // The shape a stand-down leaves: reader, consent recorded, no holder columns yet, no stamp.
    const mb = await seedMailbox(db, undefined, { consented: true, role: "reader" });
    // MAIL AN ORGANIZER WOULD FILE, and the rule that would file it — so "moves nothing" is a
    // statement about restraint rather than about an empty mailbox.
    await db.insert(rules).values({
      accountId: mb.accountId, kind: "domain", match: "feed.example",
      destination: "ohmail/News", priority: 5,
    });
    fleet.behave(mb.mailboxId, {
      deliver: [{ from: "digest@feed.example", subject: "a newsletter", messageId: `fl-${randomUUID()}@feed.example` }],
    });

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    // Enough time for many poll intervals — the failure is a poll, so one tick proves nothing.
    expect(await waitFor(async () => fleet.syncs > 0),
      "the reader never synced, so nothing below was tested").toBe(true);
    await new Promise((r) => setTimeout(r, 1500));

    const meta = fleet.metaFor(mb.mailboxId);
    // THE FOLDER IS UNTOUCHED. Not "no claim of ours" but NOTHING — `_meta` carries the portable
    // profile as well, and a reader must add neither record.
    expect(meta.messages, "a reader wrote to ohmail/_meta").toHaveLength(0);
    expect(meta.appends, "a reader claimed a mailbox nobody asked it to organize").toBe(0);
    // NOR THE TREE, NOR ONE MESSAGE. The two acts reserved to an organizer.
    expect(fleet.indicesOf(mb.mailboxId, "ensure_folders")).toHaveLength(0);
    expect(fleet.movesFor(mb.mailboxId), "a reader filed mail into ohmail/*").toHaveLength(0);
    // …and the row was not promoted behind the person's back.
    const row = await rowOf(db, mb.mailboxId);
    expect(row.organizerRole, "an empty folder promoted a reader").toBe("reader");
    expect(row.status).toBe("connected");
    // IT REALLY WAS CYCLING, which is what makes every zero above a refusal rather than a worker
    // that never woke up.
    expect(fleet.syncs).toBeGreaterThan(0);
  }, 60_000);

  /**
   * THE POSITIVE CONTROL FOR THE ARM ABOVE — and it is what stops the fix being "readers never
   * organize", which would break every claim-back on the hosted door.
   *
   * The SAME row, plus the one thing that distinguishes it: a press. The gate runs, arm 4 fires
   * on the empty folder, and the install becomes the organizer.
   */
  it("…and the SAME reader WITH a press claims it on the next pass", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true, role: "reader" });
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date(), takeoverIntent: "takeover" })
      .where(eq(mailboxes.id, mb.mailboxId));

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "organizer"),
      "a pressed reader was not promoted").toBe(true);
    expect(fleet.metaFor(mb.mailboxId).appends,
      "a pressed reader did not claim the mailbox").toBeGreaterThan(0);
    // One-shot, as every becoming is.
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).takeoverAuthorizedAt === null))
      .toBe(true);
  }, 60_000);

  /* A READER WHOSE HOLDER IS ITS OWN LAPSED CLAIM is not waiting for a press: nobody else holds the
     mailbox and nobody stopped it, so it takes it back by itself. A released one never does. */
  it("a reader whose own lapsed claim is the holder takes it back with no press; a released one does not", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const own = await seedMailbox(db, undefined, { consented: true, role: "reader" });
    const released = await seedMailbox(db, undefined, { consented: true, role: "reader" });
    for (const mb of [own, released]) {
      await db.update(mailboxes).set({
        organizedByKind: "cloud", organizedByName: "Cloud", organizedByInstallId: "cloud-test",
        organizerState: "stopped", ...(mb === released ? { organizerReleasedAt: new Date() } : {}),
      }).where(eq(mailboxes.id, mb.mailboxId));
      fleet.seedClaim(mb.mailboxId, formatClaim({
        installId: "cloud-test", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
        heartbeat: new Date(Date.now() - 3_600_000), claimedAt: new Date(Date.now() - 7_200_000),
        nonce: "an-answer-that-was-lost",
      }));
    }
    const appendsBefore = fleet.metaFor(released.mailboxId).appends;

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, own.mailboxId)).organizerRole === "organizer"),
      "this install's own lapsed claim was never taken back").toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await rowOf(db, released.mailboxId)).organizerRole, "a released mailbox resumed by itself")
      .toBe("reader");
    expect(fleet.metaFor(released.mailboxId).appends, "a released mailbox was claimed with no press")
      .toBe(appendsBefore);
  }, 60_000);

  /**
   * The same press, written by the DATABASE clock (microseconds; the roster reads it back as a
   * millisecond `Date`). It was never spent: every roster pass reloaded it, and every visit promoted
   * again and rang the arrangement — measured on Cloud at ~7,600 change rows a day for one account.
   */
  it("…and a press the database clock wrote is spent once: later visits ring nothing", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true, role: "reader" });
    await db.update(mailboxes).set({ takeoverIntent: "takeover" }).where(eq(mailboxes.id, mb.mailboxId));
    await db.execute(sql`update mailboxes set takeover_authorized_at =
      date_trunc('milliseconds', now()) + interval '407 microseconds' where id = ${mb.mailboxId}`);
    const rings = async (): Promise<number> => (await db.select({ seq: changeLog.seq }).from(changeLog).where(and(
      eq(changeLog.entityType, "mailbox_profile"), eq(changeLog.entityId, mb.mailboxId)))).length;

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 200,
      sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => {
      const r = await rowOf(db, mb.mailboxId);
      return r.organizerRole === "organizer" && r.takeoverAuthorizedAt === null;
    }), "the press the promotion read was never spent").toBe(true);
    const settled = await rings();
    // Three more organize verdicts — each one a gate visit that reread the roster's row.
    const visits = fleet.metaFor(mb.mailboxId).appends;
    expect(await waitFor(async () => fleet.metaFor(mb.mailboxId).appends >= visits + 3),
      "the gate stopped visiting").toBe(true);
    expect(await rings(), "a later visit promoted again and rang the arrangement").toBe(settled);
  }, 60_000);

  /**
   * ════════════════════════════════════════════════════════════════════════════════════════
   *  THE ROW FOLLOWS THE CLAIM — the hosted organizer's half of the one-organizer invariant
   * ════════════════════════════════════════════════════════════════════════════════════════
   *
   * A claim on the server with the row still saying `reader` is admissible only inside the act
   * itself — never across a round trip. The two cases below are that invariant from both ends: the
   * promotion lands BEFORE the permit's STATUS probe, and a promotion the FENCE refuses says so
   * instead of leaving the process believing it holds a mailbox its row gives away.
   */

  /**
   * The baseline reading is the observer, and it is HELD. Awaiting it is the only thing that ever
   * sat between the lease decision and the row — measured at 88 ms per becoming, which is 88 ms of
   * this install answering its own requests `409 organized_elsewhere`. It is issued with the claim
   * now and awaited after the promotion, so the sharp question is no longer "what did the row say
   * when it went out" but "does the row need it at all": held, the promotion must still land. See
   * `roleWithTheReadingHeld`.
   */
  it("promotes the row without waiting on the permit's folder reading — the claim never stands over a reader", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true, role: "reader" });
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date(), takeoverIntent: "takeover" })
      .where(eq(mailboxes.id, mb.mailboxId));

    const atProbe: Array<string | null> = [];
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: watchingFactory(fleet, {
        atStamp: async () => {
          atProbe.push(await roleWithTheReadingHeld(async () => {
            const [row] = await db.select({ role: mailboxes.organizerRole }).from(mailboxes)
              .where(eq(mailboxes.id, mb.mailboxId));
            return row?.role ?? null;
          }));
        },
      }),
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "organizer"),
      "a pressed reader was not promoted").toBe(true);
    expect(atProbe.length, "the permit never read the folder, so nothing was observed").toBeGreaterThan(0);
    expect(atProbe[0],
      "the row could not be written while the permit's folder reading was held: the promotion is "
      + "behind that round trip, and for its length this install's claim was on the server while "
      + "its own write doors refused it by name").toBe("organizer");
  }, 60_000);

  /**
   * THE OTHER END. The promotion is FENCED, and a fence answers `false` rather than throwing, so
   * the old code could not tell a refused write from a landed one — it flipped the in-memory role
   * regardless and spent the press. The shard is taken away where it is deterministic: `appendClaim`
   * is the last thing `readMailboxLease` does before it answers organize, so the fence closes
   * between the claim and the row. The right end state is the one a refused permit used to leave:
   * the row a reader, the press unspent, the claim standing, and a line saying so.
   */
  it("a promotion the FENCE refuses leaves the row a reader with the claim standing, and says so", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true, role: "reader" });
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date(), takeoverIntent: "takeover" })
      .where(eq(mailboxes.id, mb.mailboxId));
    const { events, logger } = recordingLogger();

    /* THE INJECTION IS READ BACK. A `leader = false` that matched no row would leave the fence OPEN
       and every assertion below would then be about an ordinary promotion, passing for nothing —
       the heartbeat row is written by the booting worker and this hook can run before it exists. */
    let fenceClosed = false;
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test", logger,
      // Re-applied at every append, so a heartbeat that rewrites the row does not re-open the fence
      // between two cycles and promote the mailbox behind the assertions below.
      adapterFactory: watchingFactory(fleet, {
        afterAppend: async () => {
          const rows = await db.update(workerHeartbeats).set({ leader: false })
            .returning({ instanceId: workerHeartbeats.instanceId });
          if (rows.length > 0) fenceClosed = true;
        },
      }),
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    const fenced = (): unknown[] => events.filter((e) => e.event === "organizer_promotion_fenced");
    expect(await waitFor(async () => fenced().length >= 1),
      "a fenced promotion said nothing at all").toBe(true);
    expect(fenceClosed, "no heartbeat row was demoted, so the fence was never closed").toBe(true);
    const row = await rowOf(db, mb.mailboxId);
    expect(row.organizerRole, "a fenced promotion flipped the row anyway").toBe("reader");
    expect(row.takeoverAuthorizedAt, "a fenced promotion spent the press").not.toBeNull();
    expect(fleet.metaFor(mb.mailboxId).appends,
      "the claim did not stand — there is nothing for the next cycle to promote against").toBeGreaterThan(0);
    expect(events.filter((e) => e.event === "organizer_promotion_failed"),
      "a write the fence refused was reported as a throw").toHaveLength(0);
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  "STOP ORGANIZING THIS MAILBOX, KEEP MY MAIL" — the release, end to end (mail 0088)
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The control the symmetric takeover was missing. Until it existed, the only way to make a
   * hosted organizer let go was to REMOVE the mailbox, which deletes the credentials and stops the
   * mirror — so somebody who wanted their laptop to do the filing had to give up the mail arriving
   * in the browser tab they had open.
   *
   * FOUR THINGS HAVE TO HAPPEN AND THE ORDER MATTERS, so all four are asserted:
   *
   *  · the CLAIM leaves `ohmail/_meta`, while the connection that can expunge it is still open —
   *    a fresh claim left behind stands the person's own machine down for a whole staleness
   *    window, at exactly the moment they chose to move organizing;
   *  · the ROW becomes a reader with NO holder columns (nobody won it — naming a holder here is
   *    the banner lying in the most confusing direction);
   *  · the REQUEST is spent, so a later press can still be honoured;
   *  · and NOTHING RE-CLAIMS over the cycles that follow. That last one is the whole hazard: the
   *    release ends with an empty folder and a consented reader, which is the exact shape arm 4
   *    used to promote — so without the gate fix above this control undoes itself on its own next
   *    pass, and the button looks broken in the most alarming possible way.
   *
   * HOW TO WATCH IT FAIL: delete the `lease.releaseRequestedAt !== null` arm from `mayOrganize`
   * and this goes red on the row still saying `organizer`. Delete the reader peek-only branch
   * instead and it goes red on the re-claim. Both were run.
   */
  it("a RELEASE request gives the mailbox up, and nothing takes it back", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      /* THE ROSTER PASS IS WHAT CARRIES THE REQUEST TO THE GATE, and its default is thirty
         seconds — longer than this test is willing to wait. `release_requested_at` is written by
         another process (a route, here a direct UPDATE) and read onto the runtime by the roster
         refresh, exactly as `takeover_authorized_at` is; a test that waited out the default would
         be measuring the interval rather than the arm. */
      rosterIntervalMs: 200,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    // It is organizing first — otherwise "it stopped" is a statement about a worker that never
    // started.
    expect(await waitFor(async () => fleet.metaFor(mb.mailboxId).messages.length === 1),
      "the worker never claimed the mailbox, so there was nothing to release").toBe(true);
    expect((await rowOf(db, mb.mailboxId)).organizerRole).toBe("organizer");

    // ── THE PRESS ─────────────────────────────────────────────────────────────────────────
    // Written the way the route writes it: one column, no role change, no IMAP.
    await db.update(mailboxes).set({ releaseRequestedAt: new Date() })
      .where(eq(mailboxes.id, mb.mailboxId));

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "reader"),
      "the release was not honoured").toBe(true);
    const row = await rowOf(db, mb.mailboxId);
    // NOBODY WON IT. A stand-down names the winner; a release has none to name.
    expect(row.organizedByKind).toBeNull();
    expect(row.organizedByName).toBeNull();
    expect(row.organizerState).toBeNull();
    // Spent, so a later "Organize here" is not answered by this request instead.
    expect(row.releaseRequestedAt).toBeNull();
    // The mailbox is in perfect health and still connected — that is the whole product difference
    // between releasing and removing.
    expect(row.status).toBe("connected");
    expect(row.organizeConsentedAt).not.toBeNull();
    // THE CLAIM IS OUT OF THE FOLDER, so the person's own machine can take it immediately rather
    // than waiting out a staleness window it cannot see the end of.
    expect(fleet.metaFor(mb.mailboxId).messages,
      "the released organizer left its claim standing").toHaveLength(0);
    // THE NOTICE. Every writer of the (role, state, holder) triple stamps it, and this is the one
    // that would be easiest to forget — nobody else changed anything.
    expect(row.organizerEventAt, "the release did not stamp the organizing event").not.toBeNull();

    // ── AND IT STAYS RELEASED ─────────────────────────────────────────────────────────────
    const appendsAtRelease = fleet.metaFor(mb.mailboxId).appends;
    await new Promise((r) => setTimeout(r, 1500));
    expect(fleet.metaFor(mb.mailboxId).appends,
      "the released install re-claimed the mailbox on a later cycle").toBe(appendsAtRelease);
    expect(fleet.metaFor(mb.mailboxId).messages).toHaveLength(0);
    expect((await rowOf(db, mb.mailboxId)).organizerRole).toBe("reader");
    // …and it is still READING, which is the point of releasing rather than removing.
    expect(fleet.syncs).toBeGreaterThan(0);
  }, 60_000);

  /**
   * WHAT THE CLAIM THIS WORKER WRITES ACTUALLY SAYS (0.14.1, risk 5).
   *
   * Two fields, and each is a field whose content is silent in a different direction:
   *
   *  · `X-Ohmail-Capabilities` — a HOSTED worker mints the account's request key as it claims, so
   *    it can verify a reader's decision and therefore advertises `requests`. This assertion has
   *    now been inverted TWICE, and the history is the point rather than noise: it began as
   *    "advertises `requests`", became "advertises NOTHING" while request authenticity was unbuilt
   *    (an organizer that cannot verify a record must not invite one), and returns here because
   *    the key exists. What it guards in this direction is the OTHER failure: a claim that stopped
   *    advertising would make every reader believe this organizer is too old to take a decision,
   *    and every press would be refused with a sentence that is no longer true.
   *  · `X-Ohmail-Authorized-At` — absent from a claim written by an AUTHORIZED takeover, the very
   *    next election ranks the winner below the incumbent it just displaced, and the takeover
   *    reverses itself one cycle later.
   *
   * Both are asserted against the bytes in the folder rather than against a call, because the
   * folder is what the other install reads.
   */
  it("the claim this worker writes carries the press and advertises the request capability", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true, role: "reader" });
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date(), takeoverIntent: "takeover" })
      .where(eq(mailboxes.id, mb.mailboxId));

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => fleet.metaFor(mb.mailboxId).messages.length === 1)).toBe(true);
    const raw = fleet.metaFor(mb.mailboxId).messages[0]!.raw;
    expect(raw, "the capability header is GONE — every reader of this mailbox would be told this "
      + "organizer is too old to take a decision, which is no longer true")
      .toContain("X-Ohmail-Capabilities: requests");
    // The press is on an ARM-4 claim here — an empty folder — so it carries no stamp, which is
    // correct and is the row below's subject. What must be true of every claim is the identity.
    expect(raw).toContain("X-Ohmail-Install-Id: cloud-test");
  }, 60_000);

  it("an AUTHORIZED takeover stamps the press onto the claim it writes", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true, role: "reader" });
    // A live foreign organizer, so the win comes from rule 6 rather than from the empty folder.
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "a-desktop-install", kind: "local", displayName: "Mila's MacBook",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n1",
    }));
    const pressedAt = new Date();
    await db.update(mailboxes).set({ takeoverAuthorizedAt: pressedAt, takeoverIntent: "takeover" })
      .where(eq(mailboxes.id, mb.mailboxId));

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "organizer"),
      "the authorized takeover did not proceed").toBe(true);
    expect(await waitFor(async () => {
      const msgs = fleet.metaFor(mb.mailboxId).messages;
      return msgs.length === 1 && msgs[0]!.raw.includes("cloud-test");
    }), "the handover was not recorded in the folder").toBe(true);
    const raw = fleet.metaFor(mb.mailboxId).messages[0]!.raw;
    // THE STAMP THE ROW HELD, byte for byte. Without it the desktop's own next election ranks its
    // claim above ours on incumbency and takes the mailbox straight back.
    expect(raw, "the takeover's claim carries no press, so the next election reverses it")
      .toContain(`X-Ohmail-Authorized-At: ${pressedAt.toISOString()}`);
    // The SAME inversion as the test above, on the takeover's claim rather than the empty-folder
    // one: a hosted organizer mints the account's key as it claims, so every claim it writes —
    // including the one a takeover produces — advertises what it can do for a reader. Missed when
    // its sibling was re-aimed, which is why the stale trailing comment is gone with it.
    expect(raw).toContain("X-Ohmail-Capabilities: requests");

    /* AND IT SURVIVES THE RENEWAL — the half a "carry it across renewals" bug hides in. The stamp
       is spent on the ROW by the promotion, so a renew that re-derived it from the row would write
       nothing, and the takeover would undo itself one poll after it succeeded rather than
       immediately. Measured by waiting for a SECOND claim to be appended and re-reading. */
    const appendsAfterWin = fleet.metaFor(mb.mailboxId).appends;
    expect(await waitFor(async () => fleet.metaFor(mb.mailboxId).appends > appendsAfterWin),
      "the organizer stopped renewing").toBe(true);
    expect(fleet.metaFor(mb.mailboxId).messages[0]!.raw,
      "the renewal dropped the press, so the next election hands the mailbox back")
      .toContain(`X-Ohmail-Authorized-At: ${pressedAt.toISOString()}`);
  }, 60_000);

  /**
   * L18: A BLIND SERVER PAST THE WINDOW — THE MAILBOX ATTACHES AND SYNCS. The fleet's adapter with
   * its lease io on the REAL `makeLeaseIo` over an in-process server whose header SEARCH answers
   * nothing, holding more records than the window and no claim. At base the gate appended, could not find its claim
   * on read-back, and the mailbox never attached (`attach_lease_unavailable`, no sync).
   *
   * MUTATION WATCHED RED: hand the election the window again and nothing syncs.
   */
  function blindLeaseFactory(fleet: FakeAdapterFleet, server: MemoryImapServer): FakeAdapterFleet["factory"] {
    return (cfg, ctx) => {
      const adapter = fleet.factory(cfg, ctx);
      return { ...adapter, leaseIo: (identity: { installId: string; mailboxId: string }) =>
        makeLeaseIo(server, (c) => c.replace(/\//g, "."), identity) };
    };
  }
  const BLIND_META = "INBOX.ohmail._meta";

  it("L18: a blind folder past the window attaches and syncs, with no lease fault on the row", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db, undefined, { consented: true });
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", BLIND_META], headerSearch: "blind" });
    for (const r of foreign600(new Date()).filter((x) => x.kind !== "claim")) server.seed(BLIND_META, r.raw, r.internalDate);
    server.seed(BLIND_META, "Subject: one more stray\r\n\r\n.\r\n");
    const { events, logger } = recordingLogger();

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: blindLeaseFactory(fleet, server), mailboxRetryMs: 100, maxSyncFailures: 1, logger,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => fleet.syncs > 0), "a blind folder past the window never let the mailbox sync")
      .toBe(true);
    const faults = events.filter((e) => /^(attach|sync_cycle)_lease_unavailable$/.test(e.event)).map((e) => e.event);
    expect(faults, "the lease refused a folder it could read whole").toEqual([]);
    expect((await rowOf(db, mb.mailboxId)).syncBlockedReason).not.toBe("lease_unreadable");
    const ours = server.tree.get(BLIND_META)!.messages.filter((m) => /^X-Ohmail-Install-Id: cloud-test\r?$/m.test(m.raw));
    expect(ours.length, "the worker's claim piled up instead of renewing in place").toBe(1);
  }, 60_000);

  /** L18: `TF_LEASE_RESIDUE=count` on the worker removes no other install's record. */
  it("L18: residue count mode removes nothing foreign and logs the plan", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    await seedMailbox(db, undefined, { consented: true });
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", BLIND_META], headerSearch: "blind" });
    const now = Date.now();
    server.seed(BLIND_META, formatClaim({
      installId: "cloud-test", kind: "cloud", displayName: "Cloud", heartbeat: new Date(now - 5_000),
      claimedAt: new Date(now - 3_600_000), nonce: "n-cloud", authorizedAt: null, capabilities: [],
    }));
    for (let i = 0; i < 31; i++) {
      const hb = new Date(now - 5 * 3_600_000 + i * 1_000);
      server.seed(BLIND_META, formatClaim({
        installId: "install-x", kind: "local", displayName: "X", heartbeat: hb, claimedAt: hb,
        nonce: `x-${i}`, authorizedAt: null, capabilities: [],
      }), hb);
    }
    for (let i = 0; i < 480; i++) server.seed(BLIND_META, `Subject: stray ${i}\r\n\r\n.\r\n`);
    const { events, logger } = recordingLogger();

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: blindLeaseFactory(fleet, server), mailboxRetryMs: 100, maxSyncFailures: 1, logger,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000, leaseResidue: "count" },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => events.some((e) => e.event === "lease_claim_residue")),
      "count mode logged no plan").toBe(true);
    const plan = events.find((e) => e.event === "lease_claim_residue")!.fields;
    expect(plan).toMatchObject({ residue: 30, removed: 0, remaining: 30 });
    const xs = server.tree.get(BLIND_META)!.messages.filter((m) => /^X-Ohmail-Install-Id: install-x\r?$/m.test(m.raw));
    expect(xs.length, "count mode removed another install's records").toBe(31);
  }, 60_000);

  it("the Cloud install id is stable across restarts and scoped by environment", () => {
    // The one constant whose instability would disable a customer's mailbox on every failover.
    // Asserted as a property rather than a literal: it must not depend on the process, and two
    // environments must not collide.
    expect(cloudInstallId("production")).toBe(cloudInstallId("production"));
    expect(cloudInstallId("production")).not.toBe(cloudInstallId("staging"));
    expect(cloudInstallId("production")).not.toContain(process.pid.toString());
  });
});

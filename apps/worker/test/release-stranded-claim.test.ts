import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  formatClaim, META_FOLDER, META_RECORDS_MAX_PER_FETCH, MetaEnumRefusedError, META_ENUM_RECORDS_MAX,
} from "@trafficflow/core/adapters/organizer-lease";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";
import { startWorker } from "../src/index.js";
import { prepareIsolatedDb, truncateAll } from "./_isolateddb.js";
import { FakeAdapterFleet, FakeMetaFolder } from "./_fakeadapter.js";
import { markMailboxReleased } from "../src/mailboxes.js";
import { releaseMailboxClaim } from "../src/lease.js";

/**
 * ═══ GIVING UP A CLAIM THIS INSTALL LEFT BEHIND — THROUGH THE REAL SERVICE ══════════════════
 *
 * ── THE STATE ───────────────────────────────────────────────────────────────────────────────
 *
 * An install can stop organizing a mailbox without its CLAIM being taken out of the mailbox. The
 * claim is a record in the customer's own IMAP folder and only the process holding it can remove
 * it, so once that process has stood down the record simply stays: every other install reads it
 * and stands down too, and the one that left it reads their absence the same way. Nothing files
 * the mailbox and every row says something else does. It does not decay — the claim sits there
 * until a process that holds it gives it up.
 *
 * ── WHY THIS FILE EXISTS, WHICH IS A TEST-SHAPED FAILURE AND NOT ONLY A CODE ONE ────────────
 *
 * The pane got a hand-back control for exactly this row, and it was INERT. `MailboxService.release`
 * asked `organizerRole !== "organizer"` and refused everything else — and the row is
 * `organizer_role = 'reader'` BY DEFINITION in this state, because that is what standing down
 * means. So the button was reachable, the endpoint answered `not_organizing`, the stamp was never
 * written, the worker never reached `releaseOrganizerClaim`, and the claim stayed for ever.
 *
 * The client test that shipped with the control could not see any of it: it MOCKED `release` to
 * answer `{ outcome: "requested" }`. It proved the pane calls the endpoint and nothing about what
 * the endpoint does. So this file uses the REAL service, the REAL worker and the fleet's real
 * in-memory `ohmail/_meta`, and asserts the three things that actually have to happen — the stamp
 * is written, the worker's release path is reached, and the claim is GONE from the folder.
 *
 * ── AND THE CONTROLS ARE THE HALF THAT MUST NOT WIDEN ───────────────────────────────────────
 *
 * "This install's claim" is the test, not "this row is not organizing". A holder of `local` is
 * ANOTHER install's claim, which this process cannot remove and must not pretend to; a NULL holder
 * is nobody's, so there is nothing to give up. Both keep answering `not_organizing` — a success
 * rather than a refusal, since the person's intent is already true — and both must leave the
 * folder untouched.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
const INSTALL = "cloud-test";
type Db = ReturnType<typeof makeDb>;
let DB: string;
const closers: Array<() => Promise<void> | void> = [];

/**
 * A STOOD-DOWN ROW WHOSE HOLDER IS `holder`, with a matching claim in the folder.
 *
 * `organizedByKind` is written from the claim record itself by the per-cycle peek, so seeding the
 * two together is what makes the fixture the row the product actually produces rather than a shape
 * assembled to pass.
 */
async function seedStranded(
  db: Db, fleet: FakeAdapterFleet,
  holder: "cloud" | "local" | null,
  /** WHICH install wrote the claim. Defaults to this worker's own; a different one is a FOREIGN
      claim of the same KIND, which is the case a category comparison could not see. */
  installId?: string,
  /**
   * THE CLAIM'S OWN HEARTBEAT. Fresh by default, which models a claim something is renewing.
   *
   * A STRANDED claim — one whose writer is gone — is STALE by definition, and the release's second
   * term is exactly that: our own claim by nonce, OR a record of ours older than the staleness
   * window. A fresh claim bearing our id that we cannot name is a LIVE SIBLING, and the release
   * must leave it alone, so a case about a stranded claim has to age this or it is testing the
   * sibling rule instead.
   */
  heartbeat?: Date,
): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "release" });
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    organizerRole: "reader",
    organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
    ...(holder ? {
      organizedByKind: holder, organizerState: "held" as const,
      organizedByInstallId: installId ?? (holder === "cloud" ? INSTALL : "a-desktop-install"),
    } : {}),
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  if (holder) {
    fleet.seedClaim(row!.id, formatClaim({
      authorizedAt: null, capabilities: [],
      /* THE INSTALL ID IS THE WHOLE POINT of the cloud case: the release removes OUR claims, so a
         cloud claim written by this worker's own install id is the one it can take out. */
      installId: installId ?? (holder === "cloud" ? INSTALL : "a-desktop-install"),
      kind: holder, displayName: holder === "cloud" ? "Cloud" : "Mila's MacBook",
      heartbeat: heartbeat ?? new Date(), claimedAt: new Date(), nonce: "n1",
    }));
  }
  return { accountId, mailboxId: row!.id };
}


/**
 * A fleet factory whose CLAIM READ runs `onRead(mailboxId)` before delegating, and whose removal
 * runs `onRemove` before delegating.
 *
 * That is the seam every one of these races lands in: `releaseMailboxClaim` reads the folder and
 * then filters for its own id, so anything that happens between the read and the removal is what
 * the product has to survive. Injecting there needs no flag and no test-only branch in product
 * code — the adapter is already supplied.
 *
 * A Proxy rather than a spread, because the folder's methods live on its prototype and a spread
 * would silently drop them.
 */
function wrapClaimRead(
  fleet: FakeAdapterFleet, onRead: (mailboxId: string) => void,
  /** Runs when the removal is issued — AFTER `listClaims` has returned. See the note below. */
  onRemove?: (mailboxId: string) => Promise<void> | void,
): typeof fleet.factory {
  return new Proxy(fleet.factory, {
    apply(target, thisArg, args: Parameters<typeof fleet.factory>) {
      const adapter = Reflect.apply(target, thisArg, args);
      return new Proxy(adapter, {
        get(a, prop, recv) {
          if (prop !== "leaseIo") {
            const v = Reflect.get(a, prop, recv);
            return typeof v === "function" ? (v as () => unknown).bind(a) : v;
          }
          /* PASS THE IDENTITY THROUGH: `leaseIo` takes `{ installId, mailboxId }` now, and calling
             it bare made the fake refuse, the release throw, and the throw be swallowed as
             best-effort — the hook never fired and only the anti-vacuity assertion said so. */
          return (identity: unknown) => {
            const io = (a as { leaseIo: (x: unknown) => Record<string, unknown> }).leaseIo(identity);
            return new Proxy(io, {
              get(t, k, r2) {
                /* THE READ SEAM IS `findOwnRecords`, NOT `listClaims`, as of the release asking the
                   SERVER which records carry its id. This hook was on `listClaims` and stopped
                   firing when that changed — and the ANTI-VACUITY assertions are what caught it:
                   without them both cases would have gone on passing, injecting nothing and
                   asserting "the row was not stamped" against a release that never ran. */
                if (k === "findOwnRecords") {
                  return async (installId: string) => {
                    onRead(args[1].mailboxId);
                    return (t as { findOwnRecords: (i: string) => Promise<unknown> })
                      .findOwnRecords(installId);
                  };
                }
                /* THE SECOND SEAM, and the first fixture got it wrong. Injecting at `listClaims`
                   put the new claim INTO the list the removal was about to act on, so it was
                   removed along with the first and the folder ended empty — the fixture proved
                   the opposite of what it meant to. A claim that arrives after the read and
                   before the removal is the actual race, and `removeClaims` is where that is. */
                if (k === "removeClaims" && onRemove) {
                  return async (refs: readonly unknown[]) => {
                    await onRemove(args[1].mailboxId);
                    return (t as { removeClaims: (r: readonly unknown[]) => Promise<unknown> })
                      .removeClaims(refs);
                  };
                }
                const v = Reflect.get(t, k, r2);
                return typeof v === "function" ? (v as () => unknown).bind(t) : v;
              },
            });
          };
        },
      });
    },
  }) as typeof fleet.factory;
}

const ctxOn = (db: Db, accountId: string): ServiceContext =>
  ({ db: db as unknown as ServiceContext["db"], accountId, userId: null,
     now: () => new Date(), requestId: "r" });

async function rowOf(db: Db, mailboxId: string) {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return row!;
}

async function waitFor(pred: () => Promise<boolean>, ms = 15_000, step = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

describe("a claim this install left behind can be given up", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_release_stranded"); }, 120_000);
  /* THE HOOKS GET REAL TIME. `truncateAll` runs after a case that started the worker, so it waits
     on connections the worker is still letting go of; at the 10s default the two cases AFTER the
     worker case failed in the hook rather than in an assertion, which reads as a defect in the
     thing under test and is not one. */
  beforeEach(async () => { await truncateAll(DB); }, 60_000);
  afterEach(async () => { while (closers.length) await closers.pop()!(); }, 60_000);

  it("a STRANDED claim: the service accepts, and the stale term takes it out", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    /* STRANDED means the writer is gone, so the claim is not being renewed — aged past the window
       the worker runs with below. A fresh heartbeat here would model a live sibling of the same
       lineage, which the release must NOT remove, and the case would measure that rule instead. */
    const mb = await seedStranded(db, fleet, "cloud", undefined, new Date(Date.now() - 3_600_000));

    // Anti-vacuity: the folder really does hold this install's claim before anything is asked.
    expect(fleet.metaFor(mb.mailboxId).messages, "the fixture seeded no claim to give up")
      .toHaveLength(1);

    // THE REAL SERVICE. Not a mock — that is what let the defect ship.
    const service = makeMailboxService({ installId: INSTALL });
    const answer = await service.release(ctxOn(db, mb.accountId), mb.mailboxId);
    expect(answer, "the service refused a release for the row the control exists for")
      .toEqual({ outcome: "requested" });
    expect((await rowOf(db, mb.mailboxId)).releaseRequestedAt,
      "no stamp was written, so the worker has nothing to honour").not.toBeNull();

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: INSTALL, displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    /* THE CLAIM IS GONE FROM THE FOLDER, which is the only thing that actually frees the mailbox,
       and it goes inside the release's OWN call rather than a window later: no running install can
       NAME a stranded claim, and the address's second term — a record of ours older than the
       staleness window — is what reaches it. The row's columns are bookkeeping; another install
       reads the FOLDER. */
    expect(await waitFor(async () => fleet.metaFor(mb.mailboxId).messages.length === 0),
      "the worker never reached `releaseOrganizerClaim` — the claim is still in ohmail/_meta")
      .toBe(true);
    const row = await rowOf(db, mb.mailboxId);
    expect(row.releaseRequestedAt, "the request was not spent, so it will be honoured again")
      .toBeNull();
    expect(row.organizerRole).toBe("reader");
    expect(row.status, "a release is not a disconnect").toBe("connected");
  }, 60_000);

  /**
   * "STOPPING ON THE NEXT PASS" CANNOT STAND FOR EVER.
   *
   * `WORKER-RELEASE-ARM-NO-LAPSE-BOUND`. Every path that withholds the released stamp is honest
   * and every one of them was unbounded: a folder over the read ceiling can never confirm the
   * removal, so the request never cleared and the pane said "Stopping on the next pass" until
   * somebody emptied the folder by hand.
   *
   * The bound is the staleness window, because the release arm returns AHEAD of the gate — a
   * pending release means this install has not renewed its claim since the ask, so after a whole
   * window the claim has aged out of the folder on its own and the release is a fact.
   *
   * Three cases: it fires when the folder cannot be read, it does NOT fire inside the window, and
   * it does NOT step over a holder the peek actually saw (that last one is the case above, whose
   * withholding is the point).
   */
  it("a release the folder can never confirm is recorded after one staleness window", async () => {
    const fleet = new FakeAdapterFleet();
    // The "we cannot look" shape as the product io produces it: the peek refuses a folder past one
    // read, `mayMark` stays false and no holder is ever seen.
    fleet.peekRefusal = new MetaEnumRefusedError("over_ceiling", { rows: 0, total: null, ceiling: META_ENUM_RECORDS_MAX });
    const db = makeDb(DB);
    const mb = await seedStranded(db, fleet, "cloud");
    // Asked for two minutes ago, against a one-minute window.
    await db.update(mailboxes).set({ releaseRequestedAt: new Date(Date.now() - 120_000) })
      .where(eq(mailboxes.id, mb.mailboxId));

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: INSTALL, displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).releaseRequestedAt === null),
      "the request stands for ever on a folder that can never confirm it").toBe(true);
    const row = await rowOf(db, mb.mailboxId);
    expect(row.organizerRole).toBe("reader");
    expect(row.status, "a release is not a disconnect").toBe("connected");
  }, 60_000);

  it("…and INSIDE the window it still waits — the bound is a lapse, not a shortcut", async () => {
    const fleet = new FakeAdapterFleet();
    fleet.peekRefusal = new MetaEnumRefusedError("over_ceiling", { rows: 0, total: null, ceiling: META_ENUM_RECORDS_MAX });
    const db = makeDb(DB);
    const mb = await seedStranded(db, fleet, "cloud");
    // Asked for just now, against a ten-minute window: nothing has lapsed.
    await db.update(mailboxes).set({ releaseRequestedAt: new Date() })
      .where(eq(mailboxes.id, mb.mailboxId));

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: INSTALL, displayName: "Cloud", staleAfterMs: 600_000 },
    });
    closers.push(() => worker.stop());

    // Give the worker several cycles to get it wrong.
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerRole === "reader"
      && (await rowOf(db, mb.mailboxId)).releaseRequestedAt === null, 2_000),
      "a fresh request was certified by a folder nobody could read").toBe(false);
    expect((await rowOf(db, mb.mailboxId)).releaseRequestedAt,
      "the request was spent inside its own window").not.toBeNull();
  }, 60_000);

  it("…and it never steps over a holder the peek SAW, however long the ask has stood", async () => {
    /* THE CASE THAT TELLS THE TWO WITHHOLDING REASONS APART, and without it the `!sawLiveHolder`
       term is untested: removing it left all twelve rows green, because nothing paired a live
       foreign claim with an ask older than the window. `markMailboxReleased` nulls all six holder
       columns, so stamping here would put "nothing organizes this mailbox" in front of somebody
       while another install actively does. The bound is for NOT KNOWING; this is knowing. */
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    // A LOCAL install's claim is the only thing in the folder, and it is fresh.
    const mb = await seedStranded(db, fleet, "local");
    await db.update(mailboxes).set({
      releaseRequestedAt: new Date(Date.now() - 600_000), organizerRole: "organizer",
    }).where(eq(mailboxes.id, mb.mailboxId));

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: INSTALL, displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).releaseRequestedAt === null, 3_000),
      "the lapse bound certified a release over a claim another install still holds").toBe(false);
    expect(fleet.metaFor(mb.mailboxId).messages,
      "the other install's claim was disturbed").toHaveLength(1);
  }, 60_000);

  /**
   * A HAND-BACK WITHHELD BEHIND ANOTHER INSTALL'S LIVE CLAIM: the visit's own look records that
   * holder on the row, and when it lets go the release opens the gap window at the release, never
   * back at the press over that install's tenure (the evidence `markMailboxReleased` reads).
   */
  it("a withheld hand-back records the holder it saw, and the release opens the gap window after it", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedStranded(db, fleet, null);
    const pressed = new Date(Date.now() - 60_000);
    await db.update(mailboxes).set({ releaseRequestedAt: pressed, organizerRole: "organizer" })
      .where(eq(mailboxes.id, mb.mailboxId));
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [], installId: "a-desktop-install", kind: "local",
      displayName: "Laptop", heartbeat: new Date(), claimedAt: new Date(), nonce: "laptop-1",
    }));
    /* THE LAPTOP LETS GO INSIDE THE RELEASE'S OWN READ, so the visit that honours it stamps the row
       before any look can open a window: what the release statement chose is what is measured. */
    let letGo = false;
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: wrapClaimRead(fleet, (id) => { if (letGo) fleet.metaFor(id).messages.length = 0; }),
      organizer: { installId: INSTALL, displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizedByInstallId === "a-desktop-install"),
      "the visit that withheld the release did not record the holder it saw").toBe(true);
    expect((await rowOf(db, mb.mailboxId)).organizerReleasedAt, "released over a live claim").toBeNull();

    const left = Date.now();
    letGo = true;
    expect(await waitFor(async () => (await rowOf(db, mb.mailboxId)).organizerReleasedAt !== null),
      "the release was never recorded once the holder let go").toBe(true);
    const since = (await rowOf(db, mb.mailboxId)).gapSince;
    expect(since, "the release opened no gap window").not.toBeNull();
    expect(since!.getTime(), "the window reached back over the other install's tenure").toBeGreaterThan(left - 1_000);
  }, 60_000);

  it("ANOTHER INSTALL'S CLAIM IS REFUSED, and the folder is untouched", async () => {
    /* The mutation that matters most: a fix keyed on "this row is not organizing" rather than on
       "this install holds the claim" would accept this one and answer as though it had given up a
       claim it cannot reach. */
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedStranded(db, fleet, "local");

    const answer = await makeMailboxService({ installId: INSTALL }).release(ctxOn(db, mb.accountId), mb.mailboxId);
    expect(answer, "the release acted on a claim another install holds")
      .toEqual({ outcome: "not_organizing" });
    expect((await rowOf(db, mb.mailboxId)).releaseRequestedAt,
      "a stamp was written for a claim this install cannot remove").toBeNull();
    expect(fleet.metaFor(mb.mailboxId).messages, "the desktop's claim was disturbed")
      .toHaveLength(1);
  });

  it("ANOTHER CLOUD DEPLOYMENT'S CLAIM IS FOREIGN, though its KIND is ours", async () => {
    /* THE CASE A CATEGORY COMPARISON CANNOT SEE, and the reason this decides on the install id.
       `apps/worker/src/lease.ts` scopes the hosted organizer's id by environment precisely so that
       a staging deployment pointed at a production mailbox is a DIFFERENT organizer — so a row can
       read `organized_by_kind = 'cloud'` over a claim this deployment did not write and cannot
       remove. The old condition answered "ours", cleared the row, and left the claim standing. */
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedStranded(db, fleet, "cloud", "ohmail-cloud:staging");

    const answer = await makeMailboxService({ installId: INSTALL })
      .release(ctxOn(db, mb.accountId), mb.mailboxId);
    expect(answer, "the release acted on another Cloud deployment's claim")
      .toEqual({ outcome: "not_organizing" });
    expect((await rowOf(db, mb.mailboxId)).releaseRequestedAt,
      "a stamp was written for a claim this deployment cannot remove").toBeNull();
    expect(fleet.metaFor(mb.mailboxId).messages,
      "the other deployment's claim was disturbed").toHaveLength(1);
  });

  it("…and a deployment that does not know its own id gives up nothing", async () => {
    /* The safe direction, stated as a case: no id means we cannot say the claim is ours, so we do
       not say it. A refused hand-back costs a sentence; a silent one costs the trust of every
       sentence beside it. */
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedStranded(db, fleet, "cloud");
    const answer = await makeMailboxService({ signatureChecks: false }).release(ctxOn(db, mb.accountId), mb.mailboxId);
    expect(answer).toEqual({ outcome: "not_organizing" });
  });

  it("a reader with NO holder has nothing to give up", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedStranded(db, fleet, null);

    const answer = await makeMailboxService({ installId: INSTALL }).release(ctxOn(db, mb.accountId), mb.mailboxId);
    expect(answer).toEqual({ outcome: "not_organizing" });
    expect((await rowOf(db, mb.mailboxId)).releaseRequestedAt).toBeNull();
  });

  it("…and an ordinary ORGANIZER row still releases, which is what this widened from", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedStranded(db, fleet, "cloud");
    await db.update(mailboxes).set({ organizerRole: "organizer" })
      .where(eq(mailboxes.id, mb.mailboxId));

    const answer = await makeMailboxService({ installId: INSTALL }).release(ctxOn(db, mb.accountId), mb.mailboxId);
    expect(answer, "the original case regressed").toEqual({ outcome: "requested" });
    expect((await rowOf(db, mb.mailboxId)).releaseRequestedAt).not.toBeNull();
  });

  /* ══ THE ROW THE MIGRATION LEFT BEHIND ══════════════════════════════════════════════════════
   *
   * 0092 added the id column and the writers filled it, and that was not enough: the reader peek
   * writes only when the row DISAGREES with the folder, and the id was not among the columns it
   * compared. So every row that already existed — five holder columns agreeing, id NULL because
   * the column had just been added — returned early on every cycle and never got an id. NULL
   * fails closed, so the hand-back this whole slice exists for was refused for ever on exactly
   * the mailboxes that had been organized the longest.
   *
   * Nothing failed. The column was written correctly by every writer, the release arm compared
   * correctly, and every guard built by claiming a mailbox through the worker was green, because
   * a freshly claimed row gets its id on the way in. The defect lived entirely in rows that
   * predate the change, which no fixture had.
   *
   * So this case starts where the migration leaves a real deployment: the five older columns
   * seeded to EXACTLY what the peek computes from the claim, so a five-column compare finds
   * nothing to do, and the id NULL. If the compare ever loses the id again, the backfill below
   * never happens and this goes red. */
  it("A MIGRATED ROW backfills its id on the next cycle, and only then can be given up", async () => {
    const fleet = new FakeAdapterFleet();
    // The reader peek is what backfills, and this fleet does not offer it by default — see the
    // field. Without this line the case cannot fail, whatever the compare does.
    const db = makeDb(DB);
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "migrated" });
    /* The claim's own timestamp, reused for the row, because `organizedSince` is compared by
       millisecond: a row seeded with "about now" would differ from the claim and the OLD compare
       would write for that reason alone — which would make this pass without the fix. */
    const claimedAt = new Date(Date.now() - 30 * 60 * 1000);
    const [row] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
      organizerRole: "reader",
      organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
      organizedByKind: "cloud", organizerState: "held",
      organizedByName: "Cloud", organizedSince: claimedAt,
      organizedByCapabilities: null,
      // THE MIGRATION'S OWN STATE: the column exists and holds nothing.
      organizedByInstallId: null,
    }).returning();
    const enc = await KP.encrypt("pw");
    await db.insert(mailboxCredentials).values({
      mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
    });
    fleet.seedClaim(row!.id, formatClaim({
      authorizedAt: null, capabilities: [], installId: INSTALL, kind: "cloud",
      displayName: "Cloud", heartbeat: new Date(), claimedAt, nonce: "n1",
    }));

    // WHERE THE DEFECT LEAVES A PERSON: their own claim, and no way to give it up.
    const service = makeMailboxService({ installId: INSTALL });
    expect(await service.release(ctxOn(db, accountId), row!.id),
      "a NULL id must fail closed — this is the state the migration creates")
      .toEqual({ outcome: "not_organizing" });

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: INSTALL, displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => (await rowOf(db, row!.id)).organizedByInstallId === INSTALL),
      "the reader cycle never backfilled the id — the compare cannot see a column it does not carry")
      .toBe(true);

    // AND THE REMEDY IS BACK: the same call, on the same row, now that the row can name its holder.
    expect(await service.release(ctxOn(db, accountId), row!.id),
      "the id was backfilled but the hand-back is still refused")
      .toEqual({ outcome: "requested" });
  }, 60_000);

  /* ══ A TAKEOVER BETWEEN THE ARM AND THE REMOVAL ════════════════════════════════════════════
   *
   * THE WINDOW, named: `mayOrganize` is handed the lease as it was READ — `rt.lease` at the cycle
   * call (`index.ts:3774`), `leaseRow` at the attach call (`index.ts:2444`) — and the release arm
   * acts on that read later, at `index.ts:1579`, removing the claim at `index.ts:1996`. Between
   * the read and the removal the mailbox can change hands, and IMAP offers no compare-and-swap
   * that could close the gap. A precondition checked once and acted on later HAS a window; that
   * is what the name means.
   *
   * The removal matches on OUR install id, so after a takeover it removes nothing. It used to
   * return `void` and swallow that, and the caller wrote `markMailboxReleased` regardless — which
   * nulls all SIX holder columns. The row then said nobody organizes this mailbox while another
   * install actively did, and every client's banner is a row read.
   *
   * ══ WHY THE FIRST VERSION OF THIS CASE WAS WORTHLESS ═══════════════════════════════════════
   *
   * It seeded the foreign claim BEFORE the worker started. The gate stood this install down on a
   * live foreign claim and the release arm was never entered, so the case asserted an absence that
   * an empty database also satisfies: it passed with the fix, without the fix, and would have
   * passed with the mailbox deleted. Forcing `mayMark = true` — the whole fix removed — left it
   * green. A guard that cannot fail is not a guard, which is the finding this file now carries.
   *
   * So the takeover is injected AT THE SEAM instead. This install is the legitimate holder when
   * the cycle begins, with its own claim in the folder and the ask recorded; the newcomer lands
   * inside the release's own read of `ohmail/_meta`, which is exactly where the window is. No flag
   * and no test-only branch in product code — the adapter is already injected, so the takeover
   * rides the same seam the IMAP client does.
   */
  it("A TAKEOVER INSIDE THE RELEASE leaves the row naming the new holder, not empty", async () => {
    const fleet = new FakeAdapterFleet();
    /* The withholding decision reads the folder, and this fleet offers the read side only on
       request — without it the arm withholds for the OTHER reason ("we could not look"), which
       would leave the branch under test unexercised. */
    const db = makeDb(DB);
    /* ── THE ORIGINAL ORDERING, AND WHY IT IS THE RIGHT ONE AGAIN ──────────────────────────────
     *
     * The request is stamped BEFORE the worker starts, so the release arm runs on its first cycle
     * and the gate never gets to renew. That ordering was briefly wrong: while a release was
     * addressed by nonce alone, a worker that had not gated held none and refused before reading
     * the folder, so this window was never entered. The address's second term — a record of ours
     * older than the staleness window — needs a HEARTBEAT rather than a nonce, so the release
     * locates first again and the window is reached on the first cycle. The claim is aged for
     * exactly that reason.
     */
    const mb = await seedStranded(db, fleet, "cloud", undefined, new Date(Date.now() - 3_600_000));
    await db.update(mailboxes).set({ releaseRequestedAt: new Date() })
      .where(eq(mailboxes.id, mb.mailboxId));

    // Anti-vacuity: this install's own claim is what the release will look for.
    expect(fleet.metaFor(mb.mailboxId).messages, "the fixture seeded no claim of ours to remove")
      .toHaveLength(1);

    const FOREIGN = formatClaim({
      authorizedAt: null, capabilities: [], installId: "ohmail-cloud:staging", kind: "cloud",
      displayName: "Another deployment", heartbeat: new Date(), claimedAt: new Date(), nonce: "n9",
    });
    /* THE NEWCOMER ARRIVES DURING THE READ. `releaseMailboxClaim` calls `listClaims()` and then
       filters for its own id, so swapping the folder's contents inside that call is the takeover
       landing in the window — our claim expunged, theirs written — with no product code aware of
       it. A Proxy rather than a spread, because the folder's methods live on its prototype. */
    let swapped = false;
    const takeover = new Proxy(fleet.factory, {
      apply(target, thisArg, args: Parameters<typeof fleet.factory>) {
        const adapter = Reflect.apply(target, thisArg, args);
        return new Proxy(adapter, {
          get(a, prop, recv) {
            if (prop !== "leaseIo") {
              const v = Reflect.get(a, prop, recv);
              return typeof v === "function" ? (v as () => unknown).bind(a) : v;
            }
            /* PASS THE IDENTITY THROUGH: `leaseIo` takes `{ installId, mailboxId }` now, and calling
               it bare made the fake refuse, the release throw, and the throw be swallowed as
               best-effort — the hook never fired and only the anti-vacuity assertion said so. */
            return (identity: unknown) => {
              const io = (a as { leaseIo: (x: unknown) => Record<string, unknown> }).leaseIo(identity);
              return new Proxy(io, {
                get(t, k, r2) {
                  if (k === "findOwnRecords") {
                    return async (installId: string) => {
                      if (!swapped) {
                        swapped = true;
                        const meta = fleet.metaFor(args[1].mailboxId);
                        meta.messages.length = 0;
                        await meta.appendClaim(FOREIGN);
                      }
                      return (t as { findOwnRecords: (i: string) => Promise<unknown> })
                        .findOwnRecords(installId);
                    };
                  }
                  const v = Reflect.get(t, k, r2);
                  return typeof v === "function" ? (v as () => unknown).bind(t) : v;
                },
              });
            };
          },
        });
      },
    });

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: takeover as typeof fleet.factory,
      organizer: { installId: INSTALL, displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    // THE ARM WAS ENTERED: the swap only happens inside the release's own read of the folder.
    expect(await waitFor(async () => swapped, 15_000),
      "the release never read `ohmail/_meta`, so this case is measuring nothing")
      .toBe(true);
    await new Promise((r) => setTimeout(r, 2_000));

    const after = await rowOf(db, mb.mailboxId);
    expect(after.organizerReleasedAt,
      "the row was stamped released while another install holds the claim")
      .toBeNull();
    expect(fleet.metaFor(mb.mailboxId).messages.length,
      "the newcomer's claim was removed, which this install cannot do")
      .toBe(1);
  }, 60_000);


  /* ══ A LIVE CLAIM CARRYING OUR OWN ID IS STILL A LIVE CLAIM ════════════════════════════════
   *
   * `releaseMailboxClaim` removes the claims it saw in its OWN `listClaims`, so one appended
   * after that read survives the removal — an overlapping worker of this same deployment, or
   * anything else writing our id. The verification then found it and called it ours, and the row
   * was stamped free while a fresh claim stood every other install down.
   *
   * "Foreign" was the wrong unit, and the word hid it. What has to be true before saying nobody
   * organizes this mailbox is that the folder holds NO live claim; a surviving claim of ours is
   * not an exception to that, it is an unfinished release.
   */
  it("A SECOND CLAIM OF OUR OWN, appended mid-release, is not a free mailbox", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    /* Original ordering and an AGED claim — see the takeover race above for why both. Our own
       record is stale, so the address's second term reaches it without a nonce; the claim the hook
       appends is FRESH, which is what makes it a live record the row may not be stamped over. */
    const mb = await seedStranded(db, fleet, "cloud", undefined, new Date(Date.now() - 3_600_000));
    await db.update(mailboxes).set({ releaseRequestedAt: new Date() })
      .where(eq(mailboxes.id, mb.mailboxId));

    const SECOND = formatClaim({
      authorizedAt: null, capabilities: [], installId: INSTALL, kind: "cloud",
      displayName: "Cloud", heartbeat: new Date(), claimedAt: new Date(), nonce: "n2",
    });
    /* Appended INSIDE the release's own read, which is where a second worker's claim lands. */
    let listed = false;
    let added = false;
    const factory = wrapClaimRead(
      fleet,
      () => { listed = true; },
      /* AFTER the read, BEFORE the removal — the window a second worker's claim lands in. */
      /* A CLAIM OF OURS IS ALWAYS PRESENT, appended on every removal rather than once. Appending
         once tested a TRANSIENT: the standing request is re-honoured, the next cycle removes the
         leftover claim, and the folder ends empty with the row correctly stamped — so the case
         asserted a moment that had already passed and read as a defect in the fix. The invariant
         is what matters and it is stable: while the folder holds a live claim, the row must never
         say the mailbox is free. Capped so a withheld release cannot grow the folder for ever. */
      async (mailboxId) => {
        added = true;
        const meta = fleet.metaFor(mailboxId);
        if (meta.messages.length < 3) await meta.appendClaim(SECOND);
      },
    );

    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: factory,
      organizer: { installId: INSTALL, displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    expect(await waitFor(async () => listed && added, 15_000),
      "the release never reached the removal, so this case is measuring nothing").toBe(true);
    await new Promise((r) => setTimeout(r, 2_000));

    /* WHICH HALF IS WRONG, asked before the verdict: if the folder is empty the removal took the
       second claim too and the fixture is not reproducing the race; if it holds the claim, the
       verification is what let the row through. */
    expect(fleet.metaFor(mb.mailboxId).messages.length,
      "no claim of ours is in the folder, so this case is not testing the invariant")
      .toBeGreaterThan(0);
    expect((await rowOf(db, mb.mailboxId)).organizerReleasedAt,
      "the row was stamped free while a fresh claim of this install's was still in the folder")
      .toBeNull();
  }, 60_000);

  /* ══ A PRESS THAT ARRIVES AFTER THE DECISION WINS ══════════════════════════════════════════
   *
   * The worker carries a release decision from the start of its cycle to the write at the end of
   * it. In between the person can press "Organize here", which cancels the request and writes a
   * takeover. The write's predicate did not require the request to still be there, so the stale
   * write cleared the newer takeover and released the mailbox against the person's LAST press —
   * the control undoing itself.
   */
  it("A CANCELLED REQUEST cannot be honoured by a worker that already decided", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedStranded(db, fleet, "cloud");
    // The state the service leaves after "Organize here": no standing request, a takeover.
    await db.update(mailboxes).set({
      releaseRequestedAt: null, takeoverAuthorizedAt: new Date(), organizerRole: "organizer",
    }).where(eq(mailboxes.id, mb.mailboxId));

    // The stale write, exactly as the worker would issue it a moment later.
    const written = await markMailboxReleased(db as never, mb.mailboxId, {});
    expect(written, "a release was written for a request the person had already cancelled")
      .toBe(false);

    const row = await rowOf(db, mb.mailboxId);
    expect(row.takeoverAuthorizedAt, "the newer takeover was cleared by the stale release")
      .not.toBeNull();
    expect(row.organizerReleasedAt, "the row records a release that was cancelled").toBeNull();
  }, 30_000);

});

/* ══ A RELEASE NAMES EVERY NONCE THIS INSTALL MINTED HERE ════════════════════════════════════
 * A bad network leaves several claims of ours that we never heard back about. Naming only the
 * acknowledged nonce and one pending one left the others standing as "another copy of this
 * install", live for a whole window, after the person's stop. */
describe("a release takes every claim this install wrote", () => {
  it("names the acknowledged nonce and every minted one, and leaves nothing of ours", async () => {
    const meta = new FakeMetaFolder();
    for (const nonce of ["n1", "n2", "n3"]) {
      await meta.appendClaim(formatClaim({
        authorizedAt: null, capabilities: [], installId: INSTALL, kind: "cloud", displayName: "Cloud",
        heartbeat: new Date(), claimedAt: new Date(Date.now() - 60_000), nonce,
      }));
    }
    const adapter = { leaseIo: () => meta } as unknown as MailboxAdapter;
    const removed = await releaseMailboxClaim(adapter, INSTALL, randomUUID(), "n1", { mintedNonces: ["n2", "n3"] });
    expect(removed, "a claim a lost answer left was not released").toBe(3);
    expect(meta.messages, `${META_FOLDER} still holds a claim nobody is behind`).toEqual([]);
  });
});

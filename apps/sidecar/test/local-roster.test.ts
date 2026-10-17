import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import { and, eq } from "drizzle-orm";
import { drafts, mailboxes, STAND_DOWN_SEND_SENTENCES } from "@trafficflow/db";
import { ScheduleService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { openLocalDb, type LocalDb, type OpenLocalDb } from "../src/db.js";
import {
  endLegacyOrganizerPauses, ensureLocalWorld, loadLocalRoster, loadUnattachedLocalRoster,
} from "../src/identity.js";

/**
 * THE BOOT'S FIRST WRITE, AGAINST A REAL STORE — does this launch create the seed mailbox row?
 *
 * `seed-predicate.test.ts` pins the DECISION as a table over four booleans. This pins the
 * READING: that the four booleans are derived from the store the way the decision assumes, and
 * that the row `ensureLocalWorld` returns is the one the shell's single-mailbox surfaces should
 * answer for. A correct predicate fed the wrong facts is the same defect with a passing unit test
 * in front of it.
 *
 * The case that matters is the fourth: an install whose SEED was removed while a second mailbox
 * remained. `config.json` still names the removed address — removing one mailbox of several is not
 * a sign-out, so nothing clears it — and the launch after that removal must not helpfully mint the
 * row again. What it would mint is a credential-less reader row for a mailbox somebody
 * deliberately took off the machine, sitting in their pane beside the real ones.
 *
 * Mutation-checked, watched red and restored:
 *  · `shouldSeedMailbox`'s tombstone arm collapsed to `true` → the no-resurrection test;
 *  · `loadLocalRoster`'s predicate widened to the finder's (`or disabled_reason is not null`)
 *    → the paused-row test;
 *  · `endLegacyOrganizerPauses`, five mutations, each watched red on the sentence it costs:
 *    `organizerRole: "reader"` → `"organizer"` (*expected 'organizer' to be 'reader'*, and at the
 *    boot the install claims the mailbox); the reason term dropped from the predicate — the guard
 *    neutered and the suffix taken with `String(...)` so a NULL reason reaches the write — (the
 *    tombstone control, *expected [ { …(2) } ] to deeply equal []*); `live.has(address)` dropped
 *    (*duplicate key value violates unique constraint "mailboxes_active_address_uq"* — the boot
 *    itself); `live.add(address)` dropped (the same violation, on the second of two paused rows on
 *    one address); `organizerReleasedAt: null` dropped (*a stale release marker erased the reason
 *    the row is a reader*);
 *  · `loadLocalRoster`'s `.orderBy(createdAt, id)` stripped to `.orderBy(createdAt)` → the tie
 *    test, 1 failed / 23 passed. The stamp test stays GREEN under it, correctly: it does not
 *    depend on the tiebreaker. The same mutation against a TWO-row tie is decorative — measured
 *    here, the un-tiebroken read answers the same order — which is why the tie fixture is three
 *    rows whose ids descend.
 */

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const o of opens.splice(0)) await o.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date("2026-09-02T10:00:00.000Z");
const schedules = new ScheduleService();
const SEED = "seed@example.test";
const SECOND = "second@example.test";

async function store(): Promise<LocalDb> {
  const dir = await freshDataDir("ohmail-roster-");
  dirs.push(dir);
  const opened = await openLocalDb(dir, {});
  opens.push(opened);
  return opened.db;
}

/** What `DELETE /local/mailboxes/:id` leaves behind: `disabled`, reason NULL — a tombstone. */
async function tombstone(db: LocalDb, mailboxId: string): Promise<void> {
  await db.update(mailboxes)
    .set({ status: "disabled", disabledReason: null })
    .where(eq(mailboxes.id, mailboxId));
}

/**
 * WHAT A STAND-DOWN LOOKED LIKE BEFORE MAIL 0083 — the shape this fixture is modelled on.
 *
 * The 0.13.x write was `{ status: 'disabled', disabledReason: reason, takeoverAuthorizedAt: null }`
 * and named no ROLE at all, so both roles are reachable in the wild: `organizer` (the column's
 * default, i.e. a mailbox this install was organizing) and `reader` (a row 0083's backfill had
 * already promoted once, stood down again afterwards). The consent stamp is set because 0083's
 * second backfill stamped every connected row, and because an install that organized a mailbox
 * had been asked to.
 */
async function pausedByOldBuild(
  db: LocalDb, mailboxId: string, role: "organizer" | "reader",
): Promise<void> {
  await db.update(mailboxes)
    .set({
      status: "disabled",
      disabledReason: "organized_elsewhere:cloud",
      organizerRole: role,
      organizeConsentedAt: NOW,
      takeoverAuthorizedAt: null,
    })
    .where(eq(mailboxes.id, mailboxId));
}

/**
 * A second mailbox as `POST /local/mailboxes` makes one: live, consent-less reader.
 *
 * `createdAt` and `id` are PARAMETERS because the roster's order is what
 * some of these cases are about: left to the store, `created_at` is `now()` on a clock that
 * resolves to a millisecond, so rows added back to back tie and the order falls to the `id`
 * tiebreaker. A case that means to assert an order stamps it; every other case ignores both.
 */
async function addSecond(
  db: LocalDb, accountId: string, address: string,
  stamp?: { createdAt?: Date; id?: string },
): Promise<string> {
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address, status: "connected", organizerRole: "reader",
    ...(stamp?.createdAt ? { createdAt: stamp.createdAt } : {}),
    ...(stamp?.id ? { id: stamp.id } : {}),
  }).returning({ id: mailboxes.id });
  return row!.id;
}

describe("the boot's seed write", () => {
  it("creates the seed row on a fresh install, and finds it on the second launch", async () => {
    const db = await store();
    const first = await ensureLocalWorld(db, { address: SEED, now: NOW });
    expect(first.mailboxId).not.toBe("");

    const second = await ensureLocalWorld(db, { address: SEED, now: NOW });
    // The same row, not a second one — this is the whole of "nothing moves" on an upgrade.
    expect(second.mailboxId).toBe(first.mailboxId);
    expect(second.accountId).toBe(first.accountId);
    const all = await db.select({ id: mailboxes.id }).from(mailboxes);
    expect(all).toHaveLength(1);
  });

  it("does NOT resurrect the seed when it was removed and another mailbox remains", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    const secondId = await addSecond(db, world.accountId, SECOND);

    // The person removes the seed from this machine. The second mailbox is untouched.
    await tombstone(db, world.mailboxId);

    // The next launch: `config.json` still names the seed address, because removing one mailbox
    // of two is not a sign-out.
    const relaunch = await ensureLocalWorld(db, { address: SEED, now: NOW });

    // No new row. The store holds exactly the tombstone and the survivor.
    const rows = await db.select({ id: mailboxes.id, status: mailboxes.status }).from(mailboxes);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status !== "disabled").map((r) => r.id)).toEqual([secondId]);

    // …and the shell's single-mailbox surfaces answer for the SURVIVOR rather than for nothing.
    expect(relaunch.mailboxId).toBe(secondId);
    const roster = await loadLocalRoster(db, world.accountId);
    expect(roster.map((r) => r.id)).toEqual([secondId]);
  });

  it("DOES seed again when the removed mailbox was the only one", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    await tombstone(db, world.mailboxId);

    // An install with no mailboxes at all is an install at first-run. This is the 0.13.x
    // behaviour, kept deliberately: refusing here would strand a reconnect through the old door.
    const relaunch = await ensureLocalWorld(db, { address: SEED, now: NOW });
    expect(relaunch.mailboxId).not.toBe("");
    expect(relaunch.mailboxId).not.toBe(world.mailboxId);
    const roster = await loadLocalRoster(db, world.accountId);
    expect(roster.map((r) => r.id)).toEqual([relaunch.mailboxId]);
  });

  it("creates no mailbox at all when nothing names an address", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: "   ", now: NOW });
    expect(world.mailboxId).toBe("");
    expect(await db.select({ id: mailboxes.id }).from(mailboxes)).toHaveLength(0);
    expect(await loadLocalRoster(db, world.accountId)).toEqual([]);
  });

  it("seeds a consent-less READER, never an organizer", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    const [row] = await db
      .select({ role: mailboxes.organizerRole, consented: mailboxes.organizeConsentedAt })
      .from(mailboxes).where(eq(mailboxes.id, world.mailboxId));
    // The pre-consent state IS the reader mode. A row saying `organizer` with no consent is the
    // two halves disagreeing, which is the shape this area keeps producing.
    expect(row?.role).toBe("reader");
    expect(row?.consented).toBeNull();
  });
});

describe("the roster read", () => {
  /**
   * THE ORDER RULE, not the insertion order — which is what this case used to assert, and why it
   * was a flake with a real mechanism behind it. Nothing in `identity.ts` writes `created_at`, so
   * every row takes the store default, and the local store's clock resolves to a millisecond:
   * measured over 20 fresh stores at this tip, three mailboxes created back to back shared one
   * stamp twice and came back in an order other than the one they were inserted in twice. The
   * order the product keeps is `(created_at, id)`, so that is what the two cases below pin, with
   * the stamps supplied by the fixture so neither can race the clock again.
   */
  it("orders by the created_at STAMP, not by the order the rows were inserted", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    const T = new Date("2026-09-02T12:00:00.000Z");
    const at = (ms: number) => new Date(T.getTime() + ms);
    await db.update(mailboxes).set({ createdAt: at(0) }).where(eq(mailboxes.id, world.mailboxId));
    // Inserted NEWEST FIRST, so a read answering insertion order — or the heap order behind it —
    // would answer exactly backwards rather than coincide with the rule.
    const c = await addSecond(db, world.accountId, "third@example.test", { createdAt: at(3000) });
    const b = await addSecond(db, world.accountId, SECOND, { createdAt: at(2000) });
    const roster = await loadLocalRoster(db, world.accountId);
    expect(roster.map((r) => r.id)).toEqual([world.mailboxId, b, c]);
    expect(roster.map((r) => r.address)).toEqual([SEED, SECOND, "third@example.test"]);
  });

  it("breaks a created_at tie on the id, the same way on every read", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    const SAME = new Date("2026-09-02T12:00:00.000Z");
    await db.update(mailboxes).set({ createdAt: new Date(SAME.getTime() - 1000) })
      .where(eq(mailboxes.id, world.mailboxId));
    /* THE ARRANGEMENT IS THE CONTROL. Three rows on ONE stamp, inserted a, b, c, with ids
       DESCENDING — so the id order is the reverse of both the insertion order and the address
       order, and neither the heap scan nor the unique address index can coincide with it.
       Measured first, because the obvious fixture is decorative: with only TWO tied rows the
       un-tiebroken read returned the SAME order as the shipped one, so dropping the tiebreaker
       there proves nothing. With these three it reads a,b,c where the rule reads c,b,a. */
    const rows: Array<[string, string]> = [
      ["99999999-9999-4999-8999-999999999999", "a@example.test"],
      ["55555555-5555-4555-8555-555555555555", "b@example.test"],
      ["11111111-1111-4111-8111-111111111111", "c@example.test"],
    ];
    for (const [id, address] of rows) {
      await addSecond(db, world.accountId, address, { createdAt: SAME, id });
    }
    const expected = [world.mailboxId, ...rows.map(([id]) => id).reverse()].join("|");
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      seen.add((await loadLocalRoster(db, world.accountId)).map((r) => r.id).join("|"));
    }
    // ONE order over twenty reads: the roster a person sees does not reorder between two of them.
    expect([...seen]).toEqual([expected]);
  });

  it("excludes a tombstone AND a paused row — being found is not being attached", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    const paused = await addSecond(db, world.accountId, SECOND);
    const removed = await addSecond(db, world.accountId, "gone@example.test");
    await tombstone(db, removed);
    /* A row `disabled` WITH a reason is the same mailbox, paused — `ensureLocalWorld` must FIND it
       so a re-add does not duplicate it, and the roster must NOT attach it: giving it a login, a
       claim and a poll timer is exactly what "paused" means it should not have. Two questions
       about one row, and this is the one that separates them. */
    await db.update(mailboxes)
      .set({ status: "disabled", disabledReason: "organized_elsewhere:cloud" })
      .where(eq(mailboxes.id, paused));

    const roster = await loadLocalRoster(db, world.accountId);
    expect(roster.map((r) => r.id)).toEqual([world.mailboxId]);

    // …and the paused row is still found, so re-adding its address mints nothing.
    const before = await db.select({ id: mailboxes.id }).from(mailboxes);
    await ensureLocalWorld(db, { address: SECOND, now: NOW });
    const after = await db.select({ id: mailboxes.id }).from(mailboxes);
    expect(after).toHaveLength(before.length);
  });

  /**
   * AND THE ROWS IT LEFT OUT ARE NAMEABLE — the third question about one row.
   *
   * The case above proves the roster excludes a paused row and a tombstone. What nothing could
   * answer was WHICH rows the exclusion took: the boot's only roster line is a COUNT of what it
   * attached, so a mailbox this install holds and does not run had no line anywhere — no skip,
   * no row state. It is worse than a gap, because `ensureLocalWorld`'s lookup is WIDER than the
   * roster's, so a paused row can be the SEED and the `serving` line then prints the id of the
   * one mailbox with no runtime. That is the log read backwards, and it happened.
   */
  it("names every held-and-not-run row, with the reason that tells paused from removed", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    /* Stamped a second apart. The read orders by created_at, then id; two rows inserted back to
       back can share a created_at, and then the order is their random ids (red in CI on PR #34's
       run, the removed row first). The order under test is the read's, so the stamps say which
       row is older rather than the clock deciding. */
    const paused = await addSecond(db, world.accountId, SECOND, { createdAt: new Date(NOW.getTime() + 1000) });
    const removed = await addSecond(db, world.accountId, "gone@example.test", { createdAt: new Date(NOW.getTime() + 2000) });
    await tombstone(db, removed);
    await db.update(mailboxes)
      .set({ status: "disabled", disabledReason: "organized_elsewhere:cloud" })
      .where(eq(mailboxes.id, paused));

    const left = await loadUnattachedLocalRoster(db, world.accountId);
    /* BOTH, and the reason is what separates them: a reason means PAUSED (the same mailbox, this
       install stood down from it), NULL means REMOVED. Reporting them as one number would put a
       mailbox somebody deleted beside one that is waiting to come back. */
    expect(left).toEqual([
      { id: paused, disabledReason: "organized_elsewhere:cloud" },
      { id: removed, disabledReason: null },
    ]);
    // THE COMPLEMENT IS EXACT: attached ∪ left-out is every row, and the two do not overlap.
    const attached = (await loadLocalRoster(db, world.accountId)).map((r) => r.id);
    const all = (await db.select({ id: mailboxes.id }).from(mailboxes)).map((r) => r.id);
    expect([...attached, ...left.map((r) => r.id)].sort()).toEqual([...all].sort());
    expect(attached.filter((id) => left.some((r) => r.id === id))).toEqual([]);
  });

  it("names nothing on an install that runs everything it holds — the positive control", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    await addSecond(db, world.accountId, SECOND);
    expect(await loadUnattachedLocalRoster(db, world.accountId)).toEqual([]);
  });

  it("scopes to the account it is asked about, like the roster read", async () => {
    const db = await store();
    const mine = await ensureLocalWorld(db, { address: SEED, now: NOW });
    const other = await addSecond(db, "11111111-1111-4111-8111-111111111111", "other@example.test");
    await tombstone(db, other);
    expect(await loadUnattachedLocalRoster(db, mine.accountId)).toEqual([]);
  });

  it("carries each row's OWN stand-down memory, not the install's", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    const b = await addSecond(db, world.accountId, SECOND);
    /* One machine can be the organizer of one mailbox and a reader of another at the same time,
       so the memory that stops an auto-resume has to be read per row. Read once for the install
       it would stand every mailbox down because one of them was taken. */
    await db.update(mailboxes)
      .set({ organizerRole: "reader", organizedByKind: "cloud", organizeConsentedAt: NOW })
      .where(eq(mailboxes.id, b));
    await db.update(mailboxes)
      .set({ organizerRole: "organizer", organizeConsentedAt: NOW })
      .where(eq(mailboxes.id, world.mailboxId));

    const roster = await loadLocalRoster(db, world.accountId);
    const bySeed = roster.find((r) => r.id === world.mailboxId);
    const bySecond = roster.find((r) => r.id === b);
    expect(bySeed?.standDownReason).toBeNull();
    expect(bySecond?.standDownReason).toBe("organized_elsewhere:cloud");
  });

  /* AN INSTALL NOBODY ASKED HAS NO STAND-DOWN TO REMEMBER. Its own look writes the
     holder columns; read as a stand-down at the next launch, that armed the phone's claim watch,
     whose press then minted a consent nobody gave. Both reads, and the consented twin as control. */
  it("remembers no stand-down for a reader nobody consented on; the consented twin keeps it", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    await db.update(mailboxes)
      .set({ organizerRole: "reader", organizedByKind: "local", organizeConsentedAt: null })
      .where(eq(mailboxes.id, world.mailboxId));
    expect((await loadLocalRoster(db, world.accountId))[0]!.standDownReason,
      "a look at somebody else's claim was remembered as this install standing down").toBeNull();
    expect((await ensureLocalWorld(db, { address: SEED, now: NOW })).standDownReason).toBeNull();

    await db.update(mailboxes).set({ organizeConsentedAt: NOW }).where(eq(mailboxes.id, world.mailboxId));
    expect((await loadLocalRoster(db, world.accountId))[0]!.standDownReason).toBe("organized_elsewhere:local");
    expect((await ensureLocalWorld(db, { address: SEED, now: NOW })).standDownReason)
      .toBe("organized_elsewhere:local");
  });

  it("scopes to the account it is asked about", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    expect(await loadLocalRoster(db, "00000000-0000-4000-8000-000000000000")).toEqual([]);
    expect((await loadLocalRoster(db, world.accountId)).map((r) => r.id)).toEqual([world.mailboxId]);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A PAUSE AN OLDER BUILD LEFT IS ENDED AT BOOT — and what it must not touch
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `disabled` + an `organized_elsewhere:*` reason is the pre-0083 spelling of a reader, and the
 * roster read excludes it for ever: no runtime, so no lease read, so a takeover authorized on that
 * row can never be spent. The pane offers the button and nothing acts on it.
 *
 * The exclusion is right and stays; what ends is the STATE. Four properties, and each of the last
 * three is a way of getting the rewrite wrong: it makes a READER (never an organizer — the lease
 * is what promotes), it keeps the memory of WHY the row is a reader, it leaves a tombstone alone,
 * and it refuses a row a live sibling has superseded rather than violating the address index.
 */
describe("ending a pause an older build left", () => {
  it("rewrites the row to the reader it meant, and the roster then attaches it", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    await pausedByOldBuild(db, world.mailboxId, "organizer");

    // The state the gap row measured on a preserved profile: found, never run.
    expect(await loadLocalRoster(db, world.accountId)).toEqual([]);

    const ended = await endLegacyOrganizerPauses(db, world.accountId, NOW);
    expect(ended).toEqual([{ id: world.mailboxId, keptReason: "organized_elsewhere:cloud", closedSends: 0 }]);

    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, world.mailboxId));
    expect(row!.status).toBe("connected");
    // A READER. Becoming an organizer again needs the press, the stamp and the lease.
    expect(row!.organizerRole).toBe("reader");
    // The reason, kept in the column that has a writer — a `connected` row carrying a
    // `disabled_reason` would be a row saying two different things about itself.
    expect(row!.organizedByKind).toBe("cloud");
    expect(row!.disabledReason).toBeNull();
    // BEING BEATEN IS NOT RELEASING: with this marker set the memory below reads null instead.
    expect(row!.organizerReleasedAt).toBeNull();
    // Nothing was claimed and nothing was consented BY THE REWRITE: the stamp stays unspent-absent.
    expect(row!.takeoverAuthorizedAt).toBeNull();

    const roster = await loadLocalRoster(db, world.accountId);
    expect(roster.map((r) => r.id)).toEqual([world.mailboxId]);
    expect(roster[0]!.standDownReason,
      "the row came back as a mailbox nobody had ever organized")
      .toBe("organized_elsewhere:cloud");
  });

  it("does not read the ROLE, because the 0.13.x write never named one", async () => {
    // Both roles are reachable in the wild and both are the same paused mailbox — see
    // `pausedByOldBuild`. A predicate that tested for `reader` would leave the ORDINARY case
    // (a mailbox this install was organizing) paused for ever.
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    const second = await addSecond(db, world.accountId, SECOND);
    await pausedByOldBuild(db, world.mailboxId, "organizer");
    await pausedByOldBuild(db, second, "reader");

    const ended = await endLegacyOrganizerPauses(db, world.accountId, NOW);
    expect(ended.map((e) => e.id).sort()).toEqual([world.mailboxId, second].sort());
    const rows = await db.select().from(mailboxes);
    expect(rows.map((r) => r.organizerRole)).toEqual(["reader", "reader"]);
    expect(rows.every((r) => r.status === "connected")).toBe(true);
  });

  it("writes nothing on the second boot — the predicate is the marker", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    await pausedByOldBuild(db, world.mailboxId, "organizer");
    expect(await endLegacyOrganizerPauses(db, world.accountId, NOW)).toHaveLength(1);

    const [after] = await db.select().from(mailboxes).where(eq(mailboxes.id, world.mailboxId));
    // A promotion the lease made between the two boots is not undone, and not repeated.
    await db.update(mailboxes).set({ organizerRole: "organizer" })
      .where(eq(mailboxes.id, world.mailboxId));
    expect(await endLegacyOrganizerPauses(db, world.accountId, NOW)).toEqual([]);
    const [second] = await db.select().from(mailboxes).where(eq(mailboxes.id, world.mailboxId));
    expect(second!.organizerRole).toBe("organizer");
    expect(second!.organizedByKind).toBe(after!.organizedByKind);
  });

  it("clears a release marker an older build left standing beside the reason", async () => {
    /* REACHABLE, AND ONLY BY GOING BACKWARDS: `organizer_released_at` arrived in 0.14.1, so a
       ≤0.13.x build cannot have written it — but it can have written a PAUSE over it. Release the
       mailbox on a current build, roll the app back, let that build stand down, and the row carries
       both. `standDownMemory` keys its released arm on that marker, so leaving it set would make
       the promoted row report itself as a mailbox nobody ever organized: the pane's claim-back
       would name no previous holder and the launch catch-up for orphaned sends would not run.
       Being beaten is not releasing, so the rewrite says so. */
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    await pausedByOldBuild(db, world.mailboxId, "organizer");
    await db.update(mailboxes).set({ organizerReleasedAt: NOW })
      .where(eq(mailboxes.id, world.mailboxId));

    expect(await endLegacyOrganizerPauses(db, world.accountId, NOW)).toHaveLength(1);
    /* THE CONSEQUENCE FIRST, so the mutation that drops the write is watched on what it costs
       rather than on the column it forgot. */
    const roster = await loadLocalRoster(db, world.accountId);
    expect(roster[0]!.standDownReason,
      "a stale release marker erased the reason the row is a reader")
      .toBe("organized_elsewhere:cloud");
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, world.mailboxId));
    expect(row!.organizerReleasedAt).toBeNull();
  });

  it("stamps the organizing event, so the row does not change state with nobody told", async () => {
    /* The notice is derived — `organizer_event_at > coalesce(organizer_event_seen_at, …)` — and
       every writer of the (role, state, holder) triple stamps it in the same statement
       (`packages/db/test/organizer-event-census.test.ts`). This is a writer: the row comes up
       reading, with a banner naming who holds it, where it was off and offered a takeover. */
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    await pausedByOldBuild(db, world.mailboxId, "organizer");
    const [before] = await db.select().from(mailboxes).where(eq(mailboxes.id, world.mailboxId));
    expect(before!.organizerEventAt, "a row paused before mail 0088 carries no stamp").toBeNull();

    await endLegacyOrganizerPauses(db, world.accountId, NOW);

    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, world.mailboxId));
    expect(row!.organizerEventAt).toEqual(NOW);
    /* …and NOT acknowledged, which is the half that makes the notice show once rather than never:
       a stamp written beside its own `seen_at` is a notice nobody is ever shown. */
    expect(row!.organizerEventSeenAt).toBeNull();
  });

  it("closes a send the row can no longer make, with the stand-down's sentence", async () => {
    /* `QAO-SCHEDULED-SEND-ORPHANED-BY-MIGRATION` by another route, and the rewrite is what makes
       it dangerous rather than merely stale: a paused row is `disabled`, where `ScheduleService`
       and `SendService` refuse; this rewrite makes it `connected` again, and the scheduled-send
       pass lives inside the organizer drain a READER never runs. So the appointment would sit
       saying it will send, for ever. Armed through the real service on a live row, then paused —
       which is the order a person reaches it in: schedule, lose the mailbox, upgrade. */
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    await db.update(mailboxes)
      .set({ organizerRole: "organizer", organizeConsentedAt: NOW })
      .where(eq(mailboxes.id, world.mailboxId));
    const [d] = await db.insert(drafts).values({
      accountId: world.accountId,
      mailboxId: world.mailboxId,
      subject: "the appointment",
      body: "the words",
      to: [{ name: null, address: "you@example.com" }],
      status: "draft",
    }).returning();
    const ctx: ServiceContext = {
      db: db as never, accountId: world.accountId, userId: null,
      now: () => NOW, requestId: "test",
    };
    await schedules.schedule(ctx, d!.id, new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString());
    const [armed] = await db.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(armed!.status, "the appointment was never armed — the case is not set up").toBe("scheduled");

    await pausedByOldBuild(db, world.mailboxId, "organizer");
    const ended = await endLegacyOrganizerPauses(db, world.accountId, NOW);

    /* THE DRAFT FIRST, so the mutation that drops the close is watched on what it costs — a row
       that still says it will send — rather than on the count that reports it. */
    const [closed] = await db.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(closed!.status, "the row still says it will send").not.toBe("scheduled");
    expect(closed!.sendAt, "the row still names a time nothing will act on").toBeNull();
    expect(closed!.sendKey).toBeNull();
    /* The stored sentence, quoted from the module that stores it: the reason the row kept is what
       chooses it, so a reader of Drafts is told which organizer took the mailbox. */
    expect(closed!.sendError).toBe(STAND_DOWN_SEND_SENTENCES["organized_elsewhere:cloud"]);
    expect(ended.map((e) => e.closedSends), "the boot's own line reports what it closed").toEqual([1]);
  });

  it("POSITIVE CONTROL: a row the CURRENT build disabled is a tombstone and stays removed", async () => {
    // `disabled` with NO reason is a mailbox somebody took off this machine. Resuming it would
    // resurrect a removal — and this is the only shape the current build writes, so a predicate
    // that dropped the reason term would resume every removed mailbox on the next launch.
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    const removed = await addSecond(db, world.accountId, "gone@example.test");
    await tombstone(db, removed);

    expect(await endLegacyOrganizerPauses(db, world.accountId, NOW)).toEqual([]);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, removed));
    expect(row!.status, "a removal must stay removed").toBe("disabled");
    expect((await loadLocalRoster(db, world.accountId)).map((r) => r.id)).toEqual([world.mailboxId]);
  });

  it("leaves a paused row its address's LIVE sibling supersedes, rather than taking the boot down", async () => {
    /* 0083's own guard, in its own words: `mailboxes_active_address_uq` is UNIQUE on
       `(account_id, lower(address)) WHERE status <> 'disabled'`, and nothing stopped the same
       address being connected again beside a paused row — so promoting one that has a live sibling
       violates the index. Here that would throw inside the boot, before the roster is read. */
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    await pausedByOldBuild(db, world.mailboxId, "organizer");
    // Re-added through the door while the first row was paused: a second row, same address.
    const live = await addSecond(db, world.accountId, SEED);

    expect(await endLegacyOrganizerPauses(db, world.accountId, NOW)).toEqual([]);
    const [old] = await db.select().from(mailboxes).where(eq(mailboxes.id, world.mailboxId));
    expect(old!.status, "the superseded row was promoted onto a live address").toBe("disabled");
    expect(old!.disabledReason).toBe("organized_elsewhere:cloud");
    expect((await loadLocalRoster(db, world.accountId)).map((r) => r.id)).toEqual([live]);
  });

  it("promotes the OLDEST of two paused rows on one address, and leaves the rest paused", async () => {
    // Two paused rows can share an address — the partial index only constrains live ones — so the
    // live set has to grow as rows are promoted or the second promotion violates the index.
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    const twin = await addSecond(db, world.accountId, "twin@example.test");
    // The seed is paused FIRST: while it is live the index refuses the second row's address.
    await pausedByOldBuild(db, world.mailboxId, "organizer");
    await pausedByOldBuild(db, twin, "reader");
    await db.update(mailboxes).set({ address: SEED }).where(eq(mailboxes.id, twin));

    const ended = await endLegacyOrganizerPauses(db, world.accountId, NOW);
    expect(ended.map((e) => e.id)).toEqual([world.mailboxId]);
    const [second] = await db.select().from(mailboxes).where(eq(mailboxes.id, twin));
    expect(second!.status).toBe("disabled");
  });

  it("scopes to the account it is asked about", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    await pausedByOldBuild(db, world.mailboxId, "organizer");
    expect(await endLegacyOrganizerPauses(db, "00000000-0000-4000-8000-000000000000", NOW)).toEqual([]);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, world.mailboxId));
    expect(row!.status).toBe("disabled");
  });
});

/**
 * The unique index is the thing that makes "one live row per address" true rather than hoped for,
 * and the create route's 409 rides on it. Asserted here so the roster's own assumption — that two
 * live rows can never carry one address — is proved against the schema and not against a comment.
 */
describe("the address index", () => {
  it("refuses a second LIVE row for one address, and permits one beside a tombstone", async () => {
    const db = await store();
    const world = await ensureLocalWorld(db, { address: SEED, now: NOW });
    await expect(addSecond(db, world.accountId, SEED)).rejects.toThrow();
    await expect(addSecond(db, world.accountId, SEED.toUpperCase())).rejects.toThrow();

    await tombstone(db, world.mailboxId);
    const fresh = await addSecond(db, world.accountId, SEED);
    expect(
      await db.select({ id: mailboxes.id }).from(mailboxes)
        .where(and(eq(mailboxes.accountId, world.accountId), eq(mailboxes.status, "connected"))),
    ).toEqual([{ id: fresh }]);
  });
});

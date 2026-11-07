import { describe, expect, it } from "vitest";
import { LocalRoster, type LocalMailboxRuntime } from "../src/roster.js";
import { shouldSeedMailbox } from "../src/identity.js";

/**
 * THE SIX CASES OF "SHOULD THIS LAUNCH CREATE THE SEED MAILBOX ROW?"
 *
 * The predicate this pins replaces a rule that was correct for exactly one mailbox — *the
 * environment names a user, so make sure a row exists for it* — and becomes wrong the moment an
 * install can hold more than one. The failure it produces is quiet and it is the worst shape
 * available: a mailbox the person REMOVED comes back on the next launch as a credential-less
 * reader row, sitting in their pane, indistinguishable from one they had just added.
 *
 * It comes back because `config.json` still carries the seed address. Removing ONE mailbox of
 * several is not a sign-out, so nothing clears that file — and the old rule reads it, finds no
 * active row, and helpfully mints one.
 *
 * A table test rather than a scenario, because the hazard is a MISSING ARM and a scenario proves
 * only the arms it walks. All six inputs are enumerated below and each states which of the six
 * cases in `roster.ts`'s header it is.
 */

describe("the seed predicate", () => {
  const cases: ReadonlyArray<{
    name: string;
    input: Parameters<typeof shouldSeedMailbox>[0];
    seed: boolean;
    why: string;
  }> = [
    {
      name: "1 · fresh install — nothing in the store, the environment names an address",
      input: { seedAddress: "a@example.test", activeSeedRow: false, tombstonedSeed: false, rosterEmpty: true },
      seed: true,
      why: "the only path onto the first mailbox; refusing here strands every new install",
    },
    {
      name: "2 · 0.13.x upgrade — one active row already carries the seed address",
      input: { seedAddress: "a@example.test", activeSeedRow: true, tombstonedSeed: false, rosterEmpty: false },
      seed: false,
      why: "the row is already there — this is the whole of 'nothing moves'",
    },
    {
      name: "3 · remove-then-re-add through the old door — roster empty, address tombstoned",
      input: { seedAddress: "a@example.test", activeSeedRow: false, tombstonedSeed: true, rosterEmpty: true },
      seed: true,
      why: "an install with no mailboxes at all is an install at first-run; 0.13.x behaviour kept",
    },
    {
      name: "4 · the seed was removed while other mailboxes remain",
      input: { seedAddress: "a@example.test", activeSeedRow: false, tombstonedSeed: true, rosterEmpty: false },
      seed: false,
      why: "THE RESURRECTION. The same tombstone as case 3 and the opposite answer, and the only "
        + "thing that separates them is whether anything else is live",
    },
    {
      name: "5 · a removed address re-added through Add mailbox — the route made the row",
      input: { seedAddress: "a@example.test", activeSeedRow: true, tombstonedSeed: true, rosterEmpty: false },
      seed: false,
      why: "the route's row is active, so the seed has nothing to add; a second row here would be "
        + "the doubling `local-mirror.ts` exists to describe",
    },
    {
      name: "6 · no address anywhere",
      input: { seedAddress: "", activeSeedRow: false, tombstonedSeed: false, rosterEmpty: true },
      seed: false,
      why: "there is nothing to name a row after, and inventing one is how an install acquires a "
        + "mailbox nobody asked for",
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.seed ? "seed" : "no seed"}`, () => {
      expect(shouldSeedMailbox(c.input), c.why).toBe(c.seed);
    });
  }

  /**
   * The two arms that are one keystroke apart, asserted against each other rather than only
   * against a literal. A predicate that collapsed to `!activeSeedRow` passes cases 1, 2, 3 and 5
   * and fails only this one — which is exactly how the defect would ship.
   */
  it("distinguishes an empty roster from a roster holding somebody else's mailbox", () => {
    const base = { seedAddress: "a@example.test", activeSeedRow: false, tombstonedSeed: true };
    expect(shouldSeedMailbox({ ...base, rosterEmpty: true })).toBe(true);
    expect(shouldSeedMailbox({ ...base, rosterEmpty: false })).toBe(false);
  });

  /** A cloud door serves a mailbox the account already has rather than mint one the refresh retires. */
  it("a cloud door with a servable row does not seed an address the store has never heard of", () => {
    const fresh = { seedAddress: "a@example.test", activeSeedRow: false, tombstonedSeed: false };
    expect(shouldSeedMailbox({ ...fresh, rosterEmpty: false, door: "cloud", servableRow: true })).toBe(false);
    expect(shouldSeedMailbox({ ...fresh, rosterEmpty: true, door: "cloud", servableRow: false })).toBe(true);
    expect(shouldSeedMailbox({ ...fresh, rosterEmpty: false, door: "local", servableRow: true })).toBe(true);
    expect(shouldSeedMailbox({ ...fresh, rosterEmpty: false, servableRow: true })).toBe(true);
  });

  /** A null or whitespace address is the absent case, not an address of its own. */
  it("treats a blank address as no address", () => {
    for (const seedAddress of [null, undefined, "", "   "]) {
      expect(
        shouldSeedMailbox({ seedAddress, activeSeedRow: false, tombstonedSeed: false, rosterEmpty: true }),
      ).toBe(false);
    }
  });
});

/**
 * THE ROSTER'S ORDERING CONTRACT — insertion order is `created_at` order, and `seed()` answers the
 * matching address before it answers the oldest row.
 *
 * `ready.mailboxId` is this answer, so a wrong one points the whole window at the wrong mailbox.
 */
describe("the roster", () => {
  const rt = (mailboxId: string, address: string): LocalMailboxRuntime =>
    ({ mailboxId, address }) as unknown as LocalMailboxRuntime;

  it("answers the row matching the seed address, whatever its position", () => {
    const roster = new LocalRoster();
    roster.add(rt("m1", "first@example.test"));
    roster.add(rt("m2", "Second@Example.Test"));
    expect(roster.seed("second@example.test")?.mailboxId).toBe("m2");
    // Case-insensitively, because an address is not case-sensitive and `config.json` records
    // whatever the person typed.
    expect(roster.seed("SECOND@example.test")?.mailboxId).toBe("m2");
  });

  it("falls back to the OLDEST live row when the seed address has no row", () => {
    const roster = new LocalRoster();
    roster.add(rt("m1", "first@example.test"));
    roster.add(rt("m2", "second@example.test"));
    // This is the seed-was-removed state: `config.json` names an address nothing serves. Answering
    // nothing would leave a working install reporting itself unconfigured.
    expect(roster.seed("gone@example.test")?.mailboxId).toBe("m1");
  });

  it("answers nothing when there are no mailboxes", () => {
    expect(new LocalRoster().seed("anything@example.test")).toBeUndefined();
  });

  it("lists oldest first and forgets a removed row", () => {
    const roster = new LocalRoster();
    roster.add(rt("m1", "a@example.test"));
    roster.add(rt("m2", "b@example.test"));
    roster.add(rt("m3", "c@example.test"));
    expect(roster.all().map((r) => r.mailboxId)).toEqual(["m1", "m2", "m3"]);
    expect(roster.delete("m2")).toBe(true);
    expect(roster.all().map((r) => r.mailboxId)).toEqual(["m1", "m3"]);
    expect(roster.size).toBe(2);
    expect(roster.has("m2")).toBe(false);
    // …and the seed fallback follows the deletion rather than a stale first entry.
    expect(roster.seed("gone@example.test")?.mailboxId).toBe("m1");
  });
});

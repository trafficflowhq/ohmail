import { describe, expect, it } from "vitest";
import {
  STORAGE_CARD_FULL_SNOOZE_MS, storageCardLevelOf, storageCardOf, storageDismissalOf, type StorageCardFacts,
} from "@trafficflow/db/cloud";

/** THE STORAGE CARD and its dismissal (cloud 0057), decided on the server for every surface. */

const GB = 1_000_000_000;
const DAY = 86_400_000;
const NOW = new Date("2026-11-07T12:00:00.000Z");
const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);

const facts = (over: Partial<StorageCardFacts> = {}): StorageCardFacts => ({
  usedBytes: 1 * GB, capBytes: 4 * GB, planBytes: null, dropsAt: null, emptiedForSpace: 0, emptyingNow: false, ...over,
});

describe("the storage card's level", () => {
  it("near from 80% of the cap, full at it or while the cap empties text, drop when the plan's own limit is below use", () => {
    expect(storageCardLevelOf(facts({ usedBytes: 3.1 * GB }))).toBeNull();
    expect(storageCardLevelOf(facts({ usedBytes: 3.2 * GB }))).toBe("near");
    expect(storageCardLevelOf(facts({ usedBytes: 4 * GB }))).toBe("full");
    expect(storageCardLevelOf(facts({ usedBytes: 3.6 * GB, emptyingNow: true }))).toBe("full");
    // A Solo trial: 3.1 GB stored, a 4 GB trial room, Solo's 2 GB from a date not yet known.
    expect(storageCardLevelOf(facts({ usedBytes: 3.1 * GB, planBytes: 2 * GB }))).toBe("drop");
    // Full outranks a drop; a drop outranks near.
    expect(storageCardLevelOf(facts({ usedBytes: 4 * GB, planBytes: 2 * GB }))).toBe("full");
    expect(storageCardLevelOf(facts({ usedBytes: 3.5 * GB, planBytes: 2 * GB }))).toBe("drop");
    expect(storageCardLevelOf(facts({ usedBytes: 1.5 * GB, planBytes: 2 * GB }))).toBeNull();
  });
});

describe("the dismissal table", () => {
  it("near hides until the level or the cap changes", () => {
    const f = facts({ usedBytes: 3.3 * GB });
    const d = storageDismissalOf("near", f, NOW);
    expect(storageCardOf(f, d, at(30))).toBeNull();
    expect(storageCardOf({ ...f, usedBytes: 4 * GB }, d, at(1)), "full comes through").toBe("full");
    expect(storageCardOf({ ...f, capBytes: 4.1 * GB }, d, at(1)), "a new cap").toBe("near");
  });

  it("full hides 7 days, back sooner when more letters are emptied or the cap changes", () => {
    const f = facts({ usedBytes: 3.6 * GB, emptyingNow: true, emptiedForSpace: 120 });
    const d = storageDismissalOf("full", f, NOW);
    expect(storageCardOf(f, d, at(6))).toBeNull();
    expect(storageCardOf(f, d, new Date(NOW.getTime() + STORAGE_CARD_FULL_SNOOZE_MS))).toBe("full");
    expect(storageCardOf({ ...f, emptiedForSpace: 121 }, d, at(1)), "more emptied").toBe("full");
    expect(storageCardOf({ ...f, emptiedForSpace: 100 }, d, at(1)), "fewer is no news").toBeNull();
    expect(storageCardOf({ ...f, capBytes: 5 * GB, usedBytes: 5 * GB }, d, at(1)), "a new cap").toBe("full");
  });

  it("drop hides until its date or the plan's own limit changes", () => {
    const f = facts({ usedBytes: 3.1 * GB, planBytes: 2 * GB, dropsAt: null });
    const d = storageDismissalOf("drop", f, NOW);
    expect(d).toMatchObject({ level: "drop", capBytes: 2 * GB, dropsAt: null });
    expect(storageCardOf(f, d, at(90))).toBeNull();
    // The first payment dates the drop: the date changed, so the card is back.
    const dated = { ...f, dropsAt: "2026-12-05T10:00:00.000Z" };
    expect(storageCardOf(dated, d, at(1))).toBe("drop");
    const again = storageDismissalOf("drop", dated, at(1));
    expect(storageCardOf(dated, again, at(2))).toBeNull();
    expect(storageCardOf({ ...dated, planBytes: 5 * GB, usedBytes: 6 * GB, capBytes: 10 * GB }, again, at(2)), "another plan").toBe("drop");
  });

  it("no dismissal, or one of another level, hides nothing", () => {
    const f = facts({ usedBytes: 3.3 * GB });
    expect(storageCardOf(f, null, NOW)).toBe("near");
    expect(storageCardOf(f, storageDismissalOf("full", f, NOW), NOW)).toBe("near");
  });
});

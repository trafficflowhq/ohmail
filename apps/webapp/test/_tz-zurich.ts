/**
 * A FILE WHOSE SNAPSHOTS WERE TAKEN IN Europe/Zurich IMPORTS THIS FIRST, so it renders its times in
 * that zone whatever zone the machine runs in (a CI runner is UTC). An ES module's imports evaluate
 * in order, so this runs before any module the test imports reads a clock; each test file runs in a
 * process of its own, so the zone goes no further than the file that asked for it.
 */
process.env.TZ = "Europe/Zurich";

export const PINNED_TZ = "Europe/Zurich";

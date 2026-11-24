import { describe, expect, it } from "vitest";
import { CLOCK_ROWS } from "../../server/src/clocks.js";
import { API_CLOCK_LOCK_KEY } from "../../server/src/clock-lock.js";
import { API_CLOCKS_LEADER_KEY, API_CRON_TARGETS } from "../src/api-cron.js";

/**
 * TWO TABLES, ONE ANSWER PER PASS. The API program's clock table says which passes it drives itself
 * (`hold: null`); the worker's schedule says which rows it leaves to an API program that leads
 * (`apiDrives`). A row the two disagree on has two clocks, or none. Neither app imports the other,
 * so the agreement is held here.
 */
describe("the worker's schedule and the API program's clocks agree", () => {
  it("row for row, on who drives the pass", () => {
    expect(API_CRON_TARGETS.map((t) => [t.target, t.apiDrives]))
      .toEqual(CLOCK_ROWS.map((row) => [row.target, row.hold === null]));
  });

  it("on the lock the leading copy holds", () => {
    expect(API_CLOCKS_LEADER_KEY).toBe(API_CLOCK_LOCK_KEY);
  });
});

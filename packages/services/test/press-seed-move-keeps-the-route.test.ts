import { describe, it } from "vitest";
import {
  beltArm, claimedUndoArm, decidedArm, oneOverrideArm, patchArm, pauseArm, undoArm, unmarkedDemotes, world,
} from "./_press-seed-move-route.js";

/**
 * THE SHEET'S SEED MOVE DOES NOT SWITCH OFF THE ROUTE ITS OWN PRESS REWRITES (PGlite; the `.pg`
 * twin runs the same cases on the server's Postgres). Cases in `_press-seed-move-route.ts`.
 */
describe("a sheet press's seed move is not an override of the route it rewrites", () => {
  it("the PATCH after a marked seed move leaves the rule on, at the place pressed", async () => { await patchArm(await world()); });
  it("Undo inside the window leaves the learned rule as it was", async () => { await undoArm(await world()); });
  it("Undo of a claimed press (marked inverse) leaves the learned rule on", async () => { await claimedUndoArm(await world(), true); });
  it("POSITIVE CONTROL: an unmarked inverse of a claimed press demotes the route", async () => { await claimedUndoArm(await world(), false); });
  it("POSITIVE CONTROL: unmarked, the same move demotes the route", async () => { await unmarkedDemotes(await world()); });
  it("an older client's PATCH naming a place switches the demoted row back on", async () => { await beltArm(await world()); });
  it("CONTROL: with one override only the rule stays on and moves", async () => { await oneOverrideArm(await world()); });
  it("CONTROL: a person's pause stays off under a destination PATCH", async () => { await pauseArm(await world()); });
  it("a marked move decides no place of its own; a hand move does", async () => { await decidedArm(await world()); });
});

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { dialect } from "../src/dialect/index.js";
import { controlFreshIntentWithoutTrigger, runFreshIntentShapes } from "./folder-state-outstanding-cases.js";

/**
 * MAIL 0163 on whichever store this run is (the sqlite project runs this file too): a new filing
 * starts its schedule fresh, whichever writer makes it. The cases are in
 * `folder-state-outstanding-cases.ts`. (The copy of the account that two triggers kept on pending
 * rows, mail 0160 and 0181, went with mail 0201: the row carries its account itself.)
 */

describe("mail 0163: a new filing starts its schedule fresh", () => {
  it("resets on a new desired folder, keeps on the same one and on a deferral", async () => {
    const db = await makeTestDb();
    await runFreshIntentShapes(db, "t");
  });

  it("control: without the trigger the new filing keeps the old refusal", async () => {
    const db = await makeTestDb();
    await runFreshIntentShapes(db, "c");
    await controlFreshIntentWithoutTrigger(db, dialect(db).name === "sqlite", "c");
  });
});

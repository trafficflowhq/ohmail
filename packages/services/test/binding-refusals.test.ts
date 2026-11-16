import { describe } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import type { Db } from "../src/context.js";
import { bindingRefusalCases } from "./helpers/binding-refusal-cases.js";

/** The refusals on a device's store: one person's, with no role behind a statement. They hold there too. */
describe("a transaction on a handle that does not name its context's account: a device's store", () => {
  bindingRefusalCases(async () => (await makeTestDb()) as unknown as Db);
});

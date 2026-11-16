import { describe, expect, it } from "vitest";
import { listBoundLines, normalizedLine } from "../src/profile.js";

/**
 * PAST A LIST'S BOUND THE SETTINGS DOCUMENT CARRIES THE NEWEST ONLY, and the worker says so once
 * per change of the figure: the other computer receiving fewer rules than this one holds was in
 * no log and no sentence (gap row PROFILE-EXPORT-BOUND-SAYS-NOTHING).
 */
const payload = { rules: new Array(5000).fill({}), screener: [], notifyRules: [], tagNames: [] };
const none = { screener: 0, rules: 0, notifyRules: 0, tagNames: 0 };

describe("the list bound is said once per change", () => {
  it("a list past its bound is one line, naming what it kept and what it left out", () => {
    expect(listBoundLines({}, { ...none, rules: 3 }, payload)).toEqual([{ list: "rules", kept: 5000, leftOut: 3 }]);
  });
  it("the same figure next tick says nothing; a new figure says it again, and back to 0 is said", () => {
    expect(listBoundLines({ ...none, rules: 3 }, { ...none, rules: 3 }, payload)).toEqual([]);
    expect(listBoundLines({ ...none, rules: 3 }, { ...none, rules: 4 }, payload)).toEqual([{ list: "rules", kept: 5000, leftOut: 4 }]);
    expect(listBoundLines({ ...none, rules: 4 }, none, payload)).toEqual([{ list: "rules", kept: 5000, leftOut: 0 }]);
  });
  it("CONTROL: an account under every bound logs nothing, from the first tick on", () => {
    expect(listBoundLines({}, none, payload)).toEqual([]);
  });
});

describe("entries published as a reader reads them are said once per change", () => {
  it("one line naming the lists and counting the entries; the same figures say nothing; back to 0 is said", () => {
    expect(normalizedLine({}, none)).toBeNull();
    expect(normalizedLine({}, { ...none, rules: 1, tagNames: 2 })).toEqual({ sections: ["rules", "tagNames"], count: 3 });
    expect(normalizedLine({ ...none, rules: 1, tagNames: 2 }, { ...none, rules: 1, tagNames: 2 })).toBeNull();
    expect(normalizedLine({ ...none, rules: 1 }, none)).toEqual({ sections: [], count: 0 });
  });
});

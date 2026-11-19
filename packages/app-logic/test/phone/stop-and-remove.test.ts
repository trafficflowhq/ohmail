import { describe, expect, it } from "vitest";
import {
  stopAndRemoveAsks,
  stopAndRemoveKept,
  stopAndRemoveLines,
  stopAndRemoveVerb,
} from "../../src/phone/stop-and-remove.js";

/*
 * REMOVING THIS PHONE'S OWN MAILBOX NAMES WHAT ONLY THE PHONE HOLDS FIRST, as the old Servers screen decided it
 * (`apps/mobile/test/removal-names-the-drafts.test.ts` holds that screen's sentences): the press asks first whenever
 * the store holds unsent drafts or settings the mailbox lacks, or cannot say; a known zero and a known `none` keep the
 * single press. The lines and the verb are keys of the phone's catalogue (`servers`); the page's cases say them.
 */

describe("what Stop and remove asks first", () => {
  it("asks for unsent drafts, and for a count it cannot read", () => {
    expect(stopAndRemoveAsks(2, "none")).toEqual({ drafts: 2, settings: null });
    expect(stopAndRemoveAsks(null, "none")).toEqual({ drafts: null, settings: null });
  });

  it("CONTROL: a known zero and nothing left only here keeps the single press", () => {
    expect(stopAndRemoveAsks(0, "none")).toBeNull();
  });

  it("asks for settings that wait, that a newer ohmail holds, or that it cannot read, in the door's word too", () => {
    expect(stopAndRemoveAsks(0, "answer")).toEqual({ drafts: 0, settings: "answer" });
    expect(stopAndRemoveAsks(0, "newer")).toEqual({ drafts: 0, settings: "newer" });
    expect(stopAndRemoveAsks(0, null)).toEqual({ drafts: 0, settings: "unknown" });
    expect(stopAndRemoveAsks(0, "unknown")).toEqual({ drafts: 0, settings: "unknown" });
  });

  it("lists drafts first, then the settings, and says Remove anyway while settings are at risk", () => {
    const both = stopAndRemoveAsks(3, "answer")!;
    expect({ lines: stopAndRemoveLines(both), verb: stopAndRemoveVerb(both) }).toEqual({
      lines: [{ key: "remove.drafts", values: { count: 3 } }, { key: "remove.settingsAnswer" }],
      verb: "remove.removeAnyway",
    });
    const drafts = stopAndRemoveAsks(1, "none")!;
    expect({ lines: stopAndRemoveLines(drafts), verb: stopAndRemoveVerb(drafts) }).toEqual({
      lines: [{ key: "remove.drafts", values: { count: 1 } }],
      verb: "remove.removeDrafts",
    });
    expect(stopAndRemoveLines(stopAndRemoveAsks(null, "newer")!)).toEqual([
      { key: "remove.draftsUnknown" },
      { key: "remove.settingsNewer" },
    ]);
    expect(stopAndRemoveLines(stopAndRemoveAsks(0, null)!)).toEqual([{ key: "remove.settingsUnknown" }]);
  });

  it("after the hand-back kept the store: the settings alone, Remove anyway, and Keep opens it again", () => {
    const ask = stopAndRemoveKept("unsaved");
    expect({ ask, lines: stopAndRemoveLines(ask), verb: stopAndRemoveVerb(ask) }).toEqual({
      ask: { drafts: 0, settings: "unsaved", kept: true },
      lines: [{ key: "remove.settingsUnsaved" }],
      verb: "remove.removeAnyway",
    });
  });
});

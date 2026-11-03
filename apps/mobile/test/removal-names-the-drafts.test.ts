import { describe, expect, it } from "vitest";
import { DE } from "../src/copy.de";
import { EN } from "../src/copy.en";
import { stopAndRemoveAsks, stopAndRemoveKept, stopAndRemoveLines, stopAndRemoveVerb } from "../src/ui/standalone-form";

/**
 * REMOVING THIS PHONE'S OWN MAILBOX NAMES WHAT ONLY THE PHONE HOLDS FIRST.
 *
 * "Stop and remove" deletes the engine store. An unsent draft is on no server, and settings waiting for
 * the settings question (or behind a newer ohmail's copy) are not in the mailbox, so each went with the
 * store on one press. The press now asks first whenever the store holds either, or cannot say; a known
 * zero and a known `none` keep the single press. A pairing's Forget is unchanged.
 */

describe("§2 what the press asks", () => {
  it("unsent drafts on this phone: asks first", () => {
    expect(stopAndRemoveAsks(2, "none")).toEqual({ drafts: 2, settings: null });
  });
  it("a count it cannot read: asks first too", () => {
    expect(stopAndRemoveAsks(null, "none")).toEqual({ drafts: null, settings: null });
  });
  it("CONTROL: a known zero and nothing left only here keeps the single press", () => {
    expect(stopAndRemoveAsks(0, "none")).toBeNull();
  });
  it("settings waiting for the settings question, or behind a newer ohmail: asks first, with no drafts", () => {
    expect(stopAndRemoveAsks(0, "answer")).toEqual({ drafts: 0, settings: "answer" });
    expect(stopAndRemoveAsks(0, "newer")).toEqual({ drafts: 0, settings: "newer" });
  });
  it("an engine that cannot say: asks, failing closed", () => {
    expect(stopAndRemoveAsks(0, null)).toEqual({ drafts: 0, settings: "unknown" });
  });
  it("drafts and settings: one confirm lists both, and the danger verb is Remove anyway", () => {
    const ask = stopAndRemoveAsks(3, "answer")!;
    expect({ lines: stopAndRemoveLines(ask), verb: stopAndRemoveVerb(ask) }).toEqual({
      lines: [EN.serversStopHereDrafts(3), EN.serversStopHereSettingsAnswer], verb: EN.serversStopHereAnyway,
    });
  });
  it("drafts alone keep their verb", () => {
    const ask = stopAndRemoveAsks(1, "none")!;
    expect({ lines: stopAndRemoveLines(ask), verb: stopAndRemoveVerb(ask) })
      .toEqual({ lines: [EN.serversStopHereDrafts(1)], verb: EN.serversStopHereDelete });
  });
  it("settings alone say nothing about drafts", () => {
    expect(stopAndRemoveLines(stopAndRemoveAsks(0, "newer")!)).toEqual([EN.serversStopHereSettingsNewer]);
    expect(stopAndRemoveLines(stopAndRemoveAsks(0, null)!)).toEqual([EN.serversStopHereSettingsUnknown]);
  });
  it("after the hand-back kept the store: the settings alone, Remove anyway, and Keep opens it again", () => {
    const ask = stopAndRemoveKept("unsaved");
    expect({ ask, lines: stopAndRemoveLines(ask), verb: stopAndRemoveVerb(ask), newer: stopAndRemoveLines(stopAndRemoveKept("newer")) })
      .toEqual({
        ask: { drafts: 0, settings: "unsaved", kept: true }, lines: [EN.serversStopHereSettingsUnsaved],
        verb: EN.serversStopHereAnyway, newer: [EN.serversStopHereSettingsNewer],
      });
  });
});

describe("§3 the sentences", () => {
  it("names the count, says no server has them, in English and German", () => {
    expect(EN.serversStopHereDrafts(2)).toContain("2 unsent drafts");
    expect(EN.serversStopHereDrafts(1)).toContain("the unsent draft");
    expect(EN.serversStopHereDraftsUnknown).toContain("any unsent drafts");
    for (const said of [EN.serversStopHereDrafts(1), EN.serversStopHereDrafts(2), EN.serversStopHereDraftsUnknown]) {
      expect(said).toContain("No mail server");
    }
    for (const said of [DE.serversStopHereDrafts(1), DE.serversStopHereDrafts(2), DE.serversStopHereDraftsUnknown]) {
      expect(said).toContain("Kein Mailserver");
    }
    expect(DE.serversStopHereDrafts(2)).toContain("2 nicht gesendeten");
  });
  it("the settings sentences say what to do first, in English and German", () => {
    expect(EN.serversStopHereSettingsAnswer).toContain("settings question");
    expect(EN.serversStopHereSettingsNewer).toContain("Update ohmail first");
    expect(EN.serversStopHereSettingsUnknown).toContain("may delete settings");
    expect(DE.serversStopHereSettingsAnswer).toContain("Beantworte sie zuerst");
    expect(DE.serversStopHereSettingsNewer).toContain("Aktualisiere ohmail zuerst");
    expect(DE.serversStopHereSettingsUnknown).toContain("vielleicht Einstellungen");
    expect(EN.serversStopHereSettingsUnsaved).toContain("could not be saved to the mailbox, so nothing was removed");
    expect(DE.serversStopHereSettingsUnsaved).toContain("darum wurde nichts entfernt");
    expect({ en: EN.serversStopHereAnyway, de: DE.serversStopHereAnyway }).toEqual({ en: "Remove anyway", de: "Trotzdem entfernen" });
  });
});

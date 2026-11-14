import { describe, expect, it } from "vitest";
import { clock } from "@ohmail/client-engine";
import { headStamp, placeOfFolder } from "../../src/reader/head-model.js";

/** THE HEAD'S STAMP on the reader's own calendar, read on Tuesday 10 November 2026 at 11:30 in Zurich. */
const NOW = new Date("2026-11-10T10:30:00.000Z");
const words = { yesterday: (time: string) => `yesterday ${time}` };
const at = (iso: string, zone = "Europe/Zurich", locale = "en") =>
  headStamp(iso, NOW, zone, locale, words).when;

describe("the head's stamp", () => {
  it("today the clock, yesterday the word, this year the day, before it the year", () => {
    expect(at("2026-11-10T05:40:00.000Z")).toBe("06:40");
    expect(at("2026-11-09T16:00:00.000Z")).toBe("yesterday 17:00");
    expect(at("2026-11-04T12:37:00.000Z")).toBe("Wed 4 Nov 13:37");
    expect(at("2025-03-14T10:20:00.000Z")).toBe("Fri 14 Mar 2025 11:20");
  });

  it("falls on the reader's midnights, not the server's", () => {
    // 23:30 UTC on the 9th is already the 10th in Zurich.
    expect(at("2026-11-09T23:30:00.000Z")).toBe("00:30");
    expect(at("2026-11-09T23:30:00.000Z", "UTC")).toBe("yesterday 23:30");
  });

  it("names the day in the reader's language, and says nothing without a date", () => {
    expect(at("2026-11-04T12:37:00.000Z", "Europe/Zurich", "de")).toMatch(/^Mi\.? 4 Nov\.? 13:37$/);
    expect(headStamp(null, NOW, "UTC", "en", words)).toEqual({ when: "", full: "", short: "" });
  });

  it("has a short form, the day and the month, for a narrow head; its clock is the engine's", () => {
    const four = headStamp("2026-11-04T12:37:00.000Z", NOW, "Europe/Zurich", "en", words);
    expect(four.short).toBe("4 Nov");
    expect(four.when.endsWith(` ${clock(new Date("2026-11-04T12:37:00.000Z"), "Europe/Zurich")}`)).toBe(true);
    // Today and yesterday are short already.
    expect(headStamp("2026-11-10T05:40:00.000Z", NOW, "Europe/Zurich", "en", words).short).toBe("06:40");
  });
});

describe("the place a letter's folder is shown in", () => {
  it("names the place of a folder a place shows, and none for any other", () => {
    expect(placeOfFolder("INBOX")).toBe("ohbox");
    expect(placeOfFolder("ohmail/News")).toBe("reads");
    expect(placeOfFolder("Archive/2026")).toBeNull();
    expect(placeOfFolder(null)).toBeNull();
  });
});

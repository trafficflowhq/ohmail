/**
 * TWO PHONE SENTENCES THAT SAID SOMETHING ELSE. The Servers page read "48 messages on this device ·
 * cursor MjM1", a sync cursor nobody can read or act on; a Screened out card read "Screened 01:03"
 * for a sender screened out at 03:52, because the time is the newest held letter's arrival.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import { setActiveLocale } from "../src/i18n/locale";

afterEach(() => { setActiveLocale("en"); });

describe("the Servers page counts what this device holds", () => {
  it("the count alone, in both languages", () => {
    expect([Copy.connectMirrored(48), Copy.connectMirrored(1)]).toEqual(["48 messages on this device", "1 message on this device"]);
    setActiveLocale("de");
    expect([Copy.connectMirrored(48), Copy.connectMirrored(1)]).toEqual(["48 Nachrichten auf diesem Gerät", "1 Nachricht auf diesem Gerät"]);
  });
});

describe("a Screened out card dates the letter it shows", () => {
  it("names the time as the newest letter's, never as the screening's", () => {
    expect(Copy.screenedNote("01:03", 1)).toMatch(/^Newest letter 01:03 · 1 held, all shown\./);
    setActiveLocale("de");
    expect(Copy.screenedNote("01:03", 2)).toMatch(/^Neueste Mail 01:03 · 2 zurückgehalten, vollständig gezeigt\./);
  });
});

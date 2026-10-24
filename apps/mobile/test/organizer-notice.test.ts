/**
 * THE NOTIFICATION'S WORDS OVER A REFUSED GATE (ANDROID-NOTIFICATION-SAYS-ORGANIZING-OVER-A-REFUSED-GATE):
 * the strip's sentence where the gate refused `ohmail/_meta`, "Organizing <address>" otherwise, in
 * the active language. The re-post at the watch tick is `background-organizing.test.ts`'s.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { organizerNoticeBody } from "../src/engine/organizer-notice";

afterEach(() => { resetLocaleRegisterForTests(); });

describe("the notification's body", () => {
  it("says the strip's sentence over a full or undeletable meta folder", () => {
    expect(organizerNoticeBody("mila@example.com", { mb1: { unreadableReason: "meta_folder_full" } })).toBe(EN.phoneStateMetaFolderFull);
    expect(organizerNoticeBody("mila@example.com", { mb1: { unreadableReason: null }, mb2: { unreadableReason: "meta_undeletable" } }))
      .toBe(EN.phoneStateMetaUndeletable);
    expect(organizerNoticeBody("mila@example.com", { mb1: { unreadableReason: "clock_off" } })).toBe(EN.phoneStateClockOff);
  });
  it("says Organizing over every other state, an older engine's included (control)", () => {
    expect(organizerNoticeBody("mila@example.com", { mb1: { unreadableReason: null } })).toBe(EN.notifBody("mila@example.com"));
    expect(organizerNoticeBody("mila@example.com", { mb1: { unreadableReason: "lease_unreadable" } })).toBe(EN.notifBody("mila@example.com"));
    expect(organizerNoticeBody("mila@example.com", { mb1: {} })).toBe(EN.notifBody("mila@example.com"));
  });
  it("in German too", () => {
    setActiveLocale("de");
    expect(organizerNoticeBody("mila@example.com", { mb1: { unreadableReason: "meta_folder_full" } })).toBe(DE.phoneStateMetaFolderFull);
    expect(organizerNoticeBody("mila@example.com", { mb1: { unreadableReason: "clock_off" } })).toBe(DE.phoneStateClockOff);
  });
});

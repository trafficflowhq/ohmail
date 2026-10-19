import { describe, expect, it } from "vitest";
import {
  BLANK_DEDUP_KEYS, BLANK_FINGERPRINT_KEY, BLANK_LEGACY_KEY, blankPlaceAction, blankRepairModeFrom,
  type BlankMessageRow, type BlankPlace,
} from "../src/blank-repair.js";
import { normalizeMime } from "../src/mime.js";
import { fingerprintDedupKey, legacyDedupKey, messageFingerprint } from "../src/identity.js";

/**
 * WHAT A BLANK MESSAGE IS, AND WHAT ITS REPAIR DOES AT ONE PLACE (IMAP-STREAMING-FETCH-TAKES-
 * UNSOLICITED-FLAGS). The keys are literals so the store can match them; this recomputes both from
 * an empty source, so a change to the fingerprint or the parse that moves them is red here rather
 * than a repair that silently matches nothing.
 */

describe("the blank keys are what an empty source normalizes to", () => {
  it("fp1 and the legacy body key, recomputed", async () => {
    const empty = await normalizeMime(Buffer.alloc(0));
    expect(fingerprintDedupKey(messageFingerprint(empty))).toBe(BLANK_FINGERPRINT_KEY);
    expect(legacyDedupKey(empty.canonical)).toBe(BLANK_LEGACY_KEY);
    expect(BLANK_DEDUP_KEYS).toEqual([BLANK_FINGERPRINT_KEY, BLANK_LEGACY_KEY]);
  });

  it("the columns an empty parse leaves empty are the ones the store's guard reads", async () => {
    const empty = await normalizeMime(Buffer.alloc(0));
    expect({
      mid: empty.canonical.messageIdHeader, subject: empty.subject, from: empty.from.address,
      date: empty.date, to: empty.to, files: empty.attachments.length,
    }).toEqual({ mid: null, subject: "", from: "", date: null, to: [], files: 0 });
  });

  it("a real letter with no content (one blank line) carries the same key: only its bytes tell", async () => {
    const crlf = await normalizeMime(Buffer.from("\r\n"));
    expect(fingerprintDedupKey(messageFingerprint(crlf))).toBe(BLANK_FINGERPRINT_KEY);
  });
});

describe("blankPlaceAction", () => {
  const screener: BlankPlace = { folder: "ohmail/Screener", uidValidity: "7", uid: 4, isPrimary: true };
  const movedByUs: BlankMessageRow["folderState"] = { desired: "ohmail/Screener", observed: "ohmail/Screener", lastSetBy: "us" };

  it("a letter the blank's own move filed away goes back to INBOX", () => {
    expect(blankPlaceAction("letter", screener, movedByUs, "organizer")).toBe("return");
  });

  it("every other letter is re-read where it stands", () => {
    // Not the primary place: the move only ever carried the primary.
    expect(blankPlaceAction("letter", { ...screener, isPrimary: false }, movedByUs, "organizer")).toBe("reread");
    // A reader moves nothing.
    expect(blankPlaceAction("letter", screener, movedByUs, "reader")).toBe("reread");
    // The person moved it, not ohmail.
    expect(blankPlaceAction("letter", screener, { ...movedByUs, lastSetBy: "external" }, "organizer")).toBe("reread");
    // A move still owed: the letter has not left where it was.
    expect(blankPlaceAction("letter", { ...screener, folder: "INBOX" }, { ...movedByUs, observed: "INBOX" }, "organizer")).toBe("reread");
    // Settled elsewhere than this place, in INBOX, or in a folder ohmail does not organize.
    expect(blankPlaceAction("letter", screener, { ...movedByUs, desired: "ohmail/News", observed: "ohmail/News" }, "organizer")).toBe("reread");
    expect(blankPlaceAction("letter", { ...screener, folder: "INBOX" }, { desired: "INBOX", observed: "INBOX", lastSetBy: "us" }, "organizer")).toBe("reread");
    expect(blankPlaceAction("letter", { ...screener, folder: "Archive" }, { desired: "Archive", observed: "Archive", lastSetBy: "us" }, "organizer")).toBe("reread");
    expect(blankPlaceAction("letter", screener, null, "organizer")).toBe("reread");
  });

  it("a real content-free letter is kept, a place the server no longer holds released, a failed read skipped", () => {
    expect(blankPlaceAction("blank", screener, movedByUs, "organizer")).toBe("keep");
    expect(blankPlaceAction("gone", screener, movedByUs, "organizer")).toBe("release");
    expect(blankPlaceAction("unreadable", screener, movedByUs, "organizer")).toBe("skip");
  });
});

describe("OHMAIL_BLANK_REPAIR", () => {
  it("unset is apply; off, dry and apply are themselves; anything else is refused", () => {
    expect(blankRepairModeFrom(undefined)).toBe("apply");
    expect(blankRepairModeFrom("  ")).toBe("apply");
    expect(blankRepairModeFrom("DRY")).toBe("dry");
    expect(blankRepairModeFrom("off")).toBe("off");
    expect(blankRepairModeFrom("apply")).toBe("apply");
    expect(blankRepairModeFrom("yes")).toBe(null);
  });
});

/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import type { ReaderFile, ReaderFiles } from "../../../packages/app/src/reader/index.js";
import { letter, mountLetters } from "./_reader-1-letters.js";

/**
 * AN INVITATION WHOSE CALENDAR BODY IS ITS ONE COPY OF THE EVENT KEEPS IT AS A FILE. The file door leaves a letter's
 * calendar alternative out of its list only where a listed calendar file carries the same event (Google's
 * `invite.ics`, `withoutCalendarBodies`); Exchange's and Outlook's alternative is the only calendar part, the one copy
 * a person can save or add to a calendar, and the door lists it. The reader draws what the door lists (share reader-1,
 * found sorting `invitation-event-card-once.test.tsx`: the reader dropped every calendar body a second time).
 */
afterEach(cleanup);

const file = (over: Partial<ReaderFile>): ReaderFile => ({
  id: "f",
  filename: "f.bin",
  mimeType: "application/octet-stream",
  sizeBytes: 2048,
  state: "idle",
  inline: false,
  ...over,
});

function doorListing(items: readonly ReaderFile[]): ReaderFiles {
  return {
    hold: () => () => undefined,
    itemsOf: () => ({ state: "ready", items }),
    open: () => undefined,
    ensure: () => undefined,
    downloadAll: () => undefined,
    downloadingAll: () => false,
    cidImagesOf: () => new Map(),
    needCidImages: () => undefined,
  };
}

const INVITE = letter("m1", { hasAttachments: true, attachmentCount: 1, unread: false, subject: "Site visit" });

describe("an invitation's calendar body the door lists", () => {
  it("is drawn as the letter's file: Exchange's one copy of the event can be saved", () => {
    const body = file({ id: "cal", filename: "invite.ics", mimeType: "text/calendar", calendarBody: true });
    mountLetters({ letters: [INVITE], open: "m1", parts: { files: doorListing([body]) } });
    expect(screen.queryAllByRole("button", { name: "Download invite.ics" }), "the event's one copy is not offered").not.toHaveLength(0);
  });

  it("beside the files the door lists, in the door's order (control: Google's pair reaches the reader as one file)", () => {
    const named = file({ id: "ics", filename: "invite.ics", mimeType: "application/ics" });
    const pdf = file({ id: "pdf", filename: "agenda.pdf", mimeType: "application/pdf" });
    mountLetters({ letters: [INVITE], open: "m1", parts: { files: doorListing([pdf, named]) } });
    expect(screen.queryAllByRole("button", { name: "Download invite.ics" })).not.toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Download agenda.pdf" })).not.toHaveLength(0);
  });
});

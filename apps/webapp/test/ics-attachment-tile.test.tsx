/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import type { ReaderFile, ReaderFiles } from "../../../packages/app/src/reader/index.js";
import { letter, mountReader } from "../../../packages/app/test/reader/support/mail.js";

/**
 * A CALENDAR ATTACHMENT IS A PLAIN FILE IN THE LETTER's FILES, WITH ITS SAVE. Moved from `ics-event-card.test.tsx`
 * (its strip case, over today's AttachmentStrip) to the new reader's files over the file door: the event card is the
 * calendar's part above the letter's text; the files draw the calendar file as its tile, never as a card, and offer
 * its Download.
 */
afterEach(cleanup);

const calItem: ReaderFile = {
  id: "c1",
  filename: "invite.ics",
  mimeType: "text/calendar; charset=utf-8; method=REQUEST",
  sizeBytes: 900,
  state: "ready",
  inline: false,
};

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

describe("the event block draws where the text parses, and degrades honestly", () => {
  it("the strip keeps the calendar part as a plain tile with its Save", () => {
    mountReader({
      letters: [letter("m1", { hasAttachments: true, attachmentCount: 1, subject: "Tech check" } as never)],
      open: "m1",
      parts: { files: doorListing([calItem]) },
    });
    const pane = screen.getByRole("region", { name: "Reading" });
    /* No card: the files draw no event (the reader's invitation part, the calendar's, is handed none here). */
    expect(within(pane).queryByRole("dialog")).toBeNull();
    expect(within(pane).queryAllByRole("button", { name: "Download invite.ics" })).not.toHaveLength(0);
    expect(pane.textContent).toContain("invite.ics");
  });
});

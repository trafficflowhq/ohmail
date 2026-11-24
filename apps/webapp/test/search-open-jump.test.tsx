import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { readerMessageFor } from "@ohmail/app-logic/search/open-target";

// The open contract still owes this case. The Search hit already has the row,
// but the mounted reader asks for it again and cannot open it without that answer.
const ISO = "2026-08-04T09:00:00.000Z";

const msg = (over: Partial<EngineMessage> = {}): EngineMessage =>
  ({
    id: "m-1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "s", from: { name: "Lena", address: "lena@example.invalid" },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: "snip", unread: false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
    remoteContent: "none", updatedAt: ISO,
    ...over,
  }) as unknown as EngineMessage;

describe("the reader opens a message the mirror does not hold", () => {
  const wire = msg({ id: "archive-1", subject: "WG: from the archive" });
  const none = () => undefined;
  const notGone = () => false;

  it("shows the row the opener carried in — the sheet used to stay shut", () => {
    // `open={readerMessage != null}`: with `?? null` alone this was `false` and clicking an
    // archive-only hit did nothing whatever. Restore the `??` and this is the red.
    expect(readerMessageFor("archive-1", none, wire, notGone)).toBe(wire);
  });
});

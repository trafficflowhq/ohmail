import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { openTargetFor } from "@ohmail/app-logic/search/open-target";

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

const noRow = (): string | null => null;

describe("the decision: a hit is never sent to a pile that does not hold it", () => {
  const M = "m-1";
  const holdsNothing = () => false;
  const holdsEverything = () => true;

  it("a Reads hit the Reads pile does not hold opens the READER, not the stream", () => {
    // The archive-only case, which is the one the reader met live: the wire item says
    // `ohmail/News`, the mirror has no row, and navigating to Reads leaves them looking at a
    // pile the message is not in. Drop the `holds` consultation and this goes back to
    // `{ kind: "stream" }` — the scroll-to-nowhere.
    expect(
      openTargetFor(msg({ folder: "ohmail/News" }), false, noRow, undefined, undefined, holdsNothing),
    ).toEqual({ kind: "reader", id: M });
  });

  it("a Receipts hit the Receipts pile does not hold opens the READER", () => {
    expect(
      openTargetFor(msg({ folder: "ohmail/Receipts" }), false, noRow, undefined, undefined, holdsNothing),
    ).toEqual({ kind: "reader", id: M });
  });

  it("an Ohbox hit the Ohbox does not hold opens the READER — the split pane would show nothing", () => {
    // `selectedOhbox` is a `find` over the pile, so an id it does not contain resolves to null
    // and the reading column renders its empty state. Same defect, quieter surface.
    expect(
      openTargetFor(msg({ folder: "INBOX" }), false, noRow, undefined, undefined, holdsNothing),
    ).toEqual({ kind: "reader", id: M });
  });

  it("the pile that DOES hold it is still where the message opens — no regression", () => {
    // The ordinary case, which is the majority of every search: unchanged.
    expect(
      openTargetFor(msg({ folder: "ohmail/News" }), false, noRow, undefined, undefined, holdsEverything),
    ).toEqual({ kind: "stream", view: "reads", id: M });
    expect(
      openTargetFor(msg({ folder: "INBOX" }), false, noRow, undefined, undefined, holdsEverything),
    ).toEqual({ kind: "ohbox", id: M, reader: false });
  });

  it("with no pile knowledge at all it routes exactly as it did before — folder, then place", () => {
    // A harness mounted without a shell passes no predicate, and must not be told every message
    // is homeless. `undefined` means "not asked", never "no".
    expect(openTargetFor(msg({ folder: "ohmail/News" }), false, noRow)).toEqual({
      kind: "stream", view: "reads", id: M,
    });
    expect(
      openTargetFor(msg({ folder: "INBOX" }), false, noRow, new Map([[M, null]])),
    ).toEqual({ kind: "reader", id: M });
  });

  it("History still wins over the pile question — it is asked first and answers alone", () => {
    // A history-cut message is pile-less by construction, so `holds` is not consulted for it and
    // the answer cannot depend on what the piles happen to contain.
    expect(
      openTargetFor(msg({ folder: "INBOX" }), false, noRow, new Map([[M, null]]), undefined, holdsEverything),
    ).toEqual({ kind: "reader", id: M });
  });
});

import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { readerMoveRefusal } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * THE MESSAGE VERBS' REFUSAL KNOWS THE HOLDER STOPPED. Moved word for word out of
 * `reader-sentences-know-the-holder-stopped.test.tsx` (whose other cases draw the Screener's surfaces): the refusal a
 * reader's move or file press meets is the press layer's own (`packages/app-logic/src/press/message-verbs.ts` and
 * the selection verbs call it), so it holds over the new shell as it stands.
 */

const HOLDER = "Studio laptop";
const LIVE_ROW = {
  id: "mb", address: "me@example.test", status: "connected", disabledReason: null,
  organizerRole: "reader" as const,
  organizedBy: { kind: "local", name: HOLDER, since: "2026-09-01T09:00:00.000Z" },
  organizerState: "held" as const,
  organizeConsentedAt: "2026-09-01T09:00:00.000Z",
};
/** The same claim, left by a machine that stopped renewing it. */
const STOPPED_ROW = { ...LIVE_ROW, organizerState: "stopped" as const };
const named = (s: string) => s.replace("{name}", HOLDER);

describe("the message verbs' refusal (readerMoveRefusal)", () => {
  const say = (cat: typeof en) => ({
    named: (name: string) => cat.screener.readerMoveRefused.replace("{name}", name),
    unknown: () => cat.screener.readerMoveRefusedUnknown,
    nobody: () => cat.screener.readerMoveRefusedNobody,
  });

  it("a holder that stopped: nothing organizes it, en and de", () => {
    const roster = { kind: "known" as const, rows: [STOPPED_ROW] };
    expect(readerMoveRefusal(roster, ["mb"], say(en))).toBe(en.screener.readerMoveRefusedNobody);
    expect(readerMoveRefusal(roster, ["mb"], say(de as typeof en))).toBe(de.screener.readerMoveRefusedNobody);
  });

  it("CONTROL: a holder that still renews is named, and a pending roster names nobody", () => {
    expect(readerMoveRefusal({ kind: "known", rows: [LIVE_ROW] }, ["mb"], say(en)))
      .toBe(named(en.screener.readerMoveRefused));
    expect(readerMoveRefusal({ kind: "pending" }, ["mb"], say(en))).toBe(en.screener.readerMoveRefusedUnknown);
  });
});

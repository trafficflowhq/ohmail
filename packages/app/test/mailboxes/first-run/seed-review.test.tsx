/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSeedOffer, type SeedOffer } from "@ohmail/app-logic/mailboxes/first-run/seed-offer";
import {
  useSeedReview,
  type SeedReviewWireLike,
} from "@ohmail/app-logic/mailboxes/first-run/use-seed-review";
import { SeedReview } from "../../../src/mailboxes/first-run/SeedReview.js";
import { sayOf } from "../../../src/mailboxes/first-run/words.js";
import { TextProvider, useTextLookup } from "../../../src/text/index.js";
import screener from "../../../messages/screener.en.json" with { type: "json" };

/**
 * THE SENT-MAIL REVIEW as the stage draws it, over a wire double: everyone starts ticked but whoever is decided, a
 * press sends the ticked with a key of its own, a refused press keeps every tick; and the offer's "Not now" is kept for
 * the scope it was handed and no other.
 */
const S = screener.seed;
const settle = (): Promise<void> => act(async () => {});
const REVIEW = {
  candidates: [
    {
      address: "ada@lichtgrat.example",
      name: "Ada",
      messages: 4,
      lastWrittenAt: null,
      alreadyDecided: false,
    },
    { address: "bo@lichtgrat.example", name: null, messages: 1, lastWrittenAt: null, alreadyDecided: true },
    { address: "cy@lichtgrat.example", name: "Cy", messages: 2, lastWrittenAt: null, alreadyDecided: false },
  ],
  excluded: [{ address: "noreply@lichtgrat.example", reason: "robot-recipient" }],
  scannedMessages: 30,
  truncated: false,
};
const offer = (over: Partial<SeedOffer> = {}): SeedOffer => ({
  owed: true,
  reopened: false,
  reopen: vi.fn(),
  later: vi.fn(),
  nothingToDecide: vi.fn(),
  done: vi.fn(),
  ...over,
});
/* The review read as the mail ground reads it (`first-run-owed.ts`), drawn by the stage's step. */
function Review(p: { wire: SeedReviewWireLike; offer: SeedOffer }) {
  const review = useSeedReview({
    wire: p.wire,
    onDone: p.offer.done,
    ...(p.offer.reopened ? {} : { onNothingToDecide: p.offer.nothingToDecide }),
  });
  return <SeedReview review={review} offer={p.offer} say={sayOf(useTextLookup())} />;
}
const draw = (wire: SeedReviewWireLike, o: SeedOffer) =>
  render(
    <TextProvider locale="en" messages={screener as never} timeZone="UTC">
      <Review wire={wire} offer={o} />
    </TextProvider>,
  );
const ticks = (): boolean[] => screen.getAllByRole("checkbox").map((c) => (c as HTMLInputElement).checked);

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("the review", () => {
  it("starts everyone ticked but whoever is decided, and a press sends the ticked with a key of its own", async () => {
    const confirm = vi.fn(async () => ({}));
    const o = offer();
    draw({ read: async () => REVIEW, confirm }, o);
    await settle();
    expect(ticks()).toEqual([true, false, true]);
    fireEvent.click(screen.getAllByRole("checkbox")[2]!);
    fireEvent.click(screen.getByRole("button", { name: /Let 1/ }));
    await settle();
    expect(confirm.mock.calls).toEqual([[["ada@lichtgrat.example"], { idempotencyKey: expect.any(String) }]]);
    expect(o.done).toHaveBeenCalledTimes(1);
  });

  it("a refused press keeps every tick, says the server's own sentence, and the retry is a new press", async () => {
    const said = "The rules could not be written.";
    const confirm = vi
      .fn()
      .mockRejectedValueOnce({ status: 500, code: "internal", message: said, details: {} })
      .mockResolvedValueOnce({});
    draw({ read: async () => REVIEW, confirm }, offer());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Let 2/ }));
    await settle();
    expect(screen.getByText(said)).toBeTruthy();
    expect(ticks()).toEqual([true, false, true]);
    fireEvent.click(screen.getByRole("button", { name: /Let 2/ }));
    await settle();
    const [first, second] = confirm.mock.calls as [string[], { idempotencyKey: string }][];
    expect(second![0]).toEqual(first![0]);
    expect(second![1].idempotencyKey).not.toBe(first![1].idempotencyKey);
  });

  it("with nobody to decide about, an offer hands the stage back; opened from Settings, it says so", async () => {
    const decided = { ...REVIEW, candidates: REVIEW.candidates.map((c) => ({ ...c, alreadyDecided: true })) };
    const o = offer();
    draw({ read: async () => decided, confirm: vi.fn() }, o);
    await settle();
    expect(o.nothingToDecide).toHaveBeenCalledTimes(1);
    cleanup();
    draw({ read: async () => decided, confirm: vi.fn() }, offer({ reopened: true }));
    await settle();
    expect(screen.getAllByText(S.nothingToDecide).length).toBeGreaterThan(0);
  });
});

describe("the seed offer's Not now is the scope's own", () => {
  const input = { demo: false, known: true, supported: true, seedConfirmedAt: null, hasMailbox: true };

  it("is kept under the handed scope, and another scope's answer never applies", async () => {
    const a = renderHook(() => useSeedOffer({ ...input, scope: "acct-a" }));
    expect(a.result.current.owed).toBe(true);
    act(() => a.result.current.later());
    expect(a.result.current.owed).toBe(false);
    expect(localStorage.getItem("ohmail.ui.seed.notNow.acct-a")).toBe("1");
    const b = renderHook(() => useSeedOffer({ ...input, scope: "acct-b" }));
    await settle();
    expect(b.result.current.owed).toBe(true);
    const again = renderHook(() => useSeedOffer({ ...input, scope: "acct-a" }));
    await settle();
    expect(again.result.current.owed).toBe(false);
  });

  it("is owed only for a known, supported account with a mailbox, never on the demo", () => {
    for (const over of [{ demo: true }, { known: false }, { supported: false }, { hasMailbox: null }]) {
      const h = renderHook(() => useSeedOffer({ ...input, ...over, scope: "acct-c" }));
      expect(h.result.current.owed).toBe(false);
    }
  });
});

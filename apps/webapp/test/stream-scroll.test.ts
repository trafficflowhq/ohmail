/**
 * The previous card's size estimates and pending reservations, still owed by the
 * mounted stream, plus the shared body viewer's horizontal overflow controls.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateCardHeight, estimateClipReserve, STREAM_CARD_FALLBACK_PX, STREAM_RESERVE_MIN_PX } from "@ohmail/ui";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("estimateCardHeight", () => {
  it("answers the old constant when there is no width to reason from", () => {
    // A card that has never been laid out, and every jsdom render: `offsetWidth` is 0 there, and
    // a card in a unit test must reserve exactly what it reserved before this function existed.
    expect(estimateCardHeight({ width: 0, subject: "x", preview: "y" })).toBe(STREAM_CARD_FALLBACK_PX);
    expect(STREAM_CARD_FALLBACK_PX).toBe(200);
  });

  it("grows with the subject's own length, at the card's own width", () => {
    const short = estimateCardHeight({ width: 620, subject: "Invoice for July", preview: "One line." });
    const long = estimateCardHeight({
      width: 620,
      subject: "Invoice for July — a longer subject line, because real mail has them and a card head that wraps to a second line is a different height from one that does not",
      preview: "One line.",
    });
    expect(long).toBeGreaterThan(short);
    // The same long subject in a phone-width card wraps further and reserves more again.
    expect(estimateCardHeight({ width: 358, subject: "Invoice for July — a longer subject line, because real mail has them and a card head that wraps to a second line is a different height from one that does not", preview: "One line." }))
      .toBeGreaterThan(long);
  });

  it("grows with the preview's length and stops at the clamp", () => {
    const two = estimateCardHeight({ width: 620, subject: "s", preview: "a".repeat(120) });
    const many = estimateCardHeight({ width: 620, subject: "s", preview: "a".repeat(1200) });
    expect(many).toBeGreaterThan(two);
    // Past the clamp the preview cannot contribute more, so a very long preview and a
    // longer one reserve the same box — which is what `.sc-clip{max-height:348px}` does.
    expect(estimateCardHeight({ width: 620, subject: "s", preview: "a".repeat(12_000) })).toBe(many);
  });

  it("reserves the card's own estimate, clamped to [120, 348], for a body still being fetched", () => {
    // 348 is a ceiling, not the height: the reservation is the preview's estimate held between a
    // floor (a short letter barely moves when it lands) and the clamp. The same number is the
    // card's `--sc-reserve`, so the CSS box and the intrinsic-size estimate cannot disagree.
    const fromSnippet = estimateCardHeight({ width: 620, subject: "s", preview: "Two lines of snippet." });
    const clamped = estimateCardHeight({ width: 620, subject: "s", preview: "Two lines of snippet.", clamped: true });
    expect(clamped).toBeGreaterThan(fromSnippet);
    expect(estimateClipReserve(620, "Two lines of snippet.")).toBe(STREAM_RESERVE_MIN_PX);
    expect(estimateClipReserve(620, "a".repeat(900))).toBeGreaterThan(STREAM_RESERVE_MIN_PX);
    expect(estimateClipReserve(620, "a".repeat(12_000))).toBe(348);
    expect(estimateClipReserve(0, "anything")).toBe(STREAM_RESERVE_MIN_PX);
    // A long preview reserves more, up to the clamp: the estimate is the card's own.
    expect(estimateCardHeight({ width: 620, subject: "s", preview: "a".repeat(900), clamped: true })).toBeGreaterThan(clamped);
  });

  it("is deterministic — the same inputs, the same answer", () => {
    const input = { width: 620, subject: "The kiln schedule", preview: "Two sentences, so the preview is taller.", recipients: true };
    expect(estimateCardHeight(input)).toBe(estimateCardHeight(input));
  });

  it("counts the recipients block when the head draws one", () => {
    const bare = estimateCardHeight({ width: 620, subject: "s", preview: "p" });
    expect(estimateCardHeight({ width: 620, subject: "s", preview: "p", recipients: true })).toBeGreaterThan(bare);
  });
});

describe("one scroll owner per reading stream (the source census)", () => {
  it("the wide-content wrappers are horizontal only, and contain their own overscroll", () => {
    const css = read("packages/letter-body/src/message-body.css");
    for (const cls of [".msg-pre-wrap", ".msg-table-wrap"]) {
      const rule = css.split("}").find((b) => b.includes(`${cls} {`));
      expect(rule, `${cls} has no rule`).toBeTruthy();
      expect(rule).toMatch(/overflow-x:\s*auto/);
      expect(rule).toMatch(/overflow-y:\s*hidden/);
      expect(rule).toMatch(/overscroll-behavior-x:\s*contain/);
    }
  });

  it("a collapsed stream card's preview box is at most the clamp, and its body is asked for a viewport ahead", () => {
    const css = read("packages/ui/src/mail/Reading/message.css");
    expect(css).toMatch(/\.oh-message-clip \{\s*--oh-message-clip-lines: 6;/);
    expect(css).toMatch(/\.oh-message-clip\[data-shut\]\s*\{\s*max-height: calc\(var\(--oh-message-clip-lines\) \* var\(--lh-read\) \* var\(--t-read\)\);/);
    expect(css).toMatch(/\.oh-message-clip\[data-shut\]\[data-pending\][\s\S]*?min-block-size:\s*min\(\s*var\(--stream-preview-reserve\)/);
    expect(read("packages/app/src/stream/use-stream-column.ts")).toContain('{ root: scroller, rootMargin: "100% 0px" }');
    expect(read("packages/ui/src/mail/Reading/Message.tsx")).toContain('data-shut={shut ? "" : undefined}');
    const clamps = [...css.matchAll(/([^{}]+)\{[^{}]*?max-height:[^{}]+\}/g)];
    expect(clamps.map(([, selector]) => selector!.trim())).toEqual([".oh-message-clip[data-shut]"]);
  });

  it("the intrinsic size of a stream card is the card's own estimate", () => {
    const css = read("apps/webapp/app/app.css");
    expect(css).toMatch(/contain-intrinsic-size:\s*auto var\(--sc-est,\s*200px\)/);
    // The flat constant may only survive as the property's fallback.
    expect(css).not.toMatch(/contain-intrinsic-size:\s*auto 200px/);
  });


  it("a card waiting for its body keeps the box and the fade it will settle with", () => {
    // The two rules that used to fire only while a card was waiting — the fade off and the pill's
    // extra margins — cost a measured 16px of the card's height at the moment its mail arrived.
    const css = read("packages/ui/src/composites/stream.css");
    expect(css).not.toMatch(/\.scast\.short\.pend \.sc-fade\{display:none\}/);
    expect(css).toMatch(/\.scast\.open \.sc-x\{margin-top:16px;margin-bottom:22px\}/);
    // …and the pill itself stays reachable on a card whose text is short only because it has not
    // arrived yet, which is the half of that pair that was never the problem.
    expect(css).toMatch(/\.scast\.short\.pend \.sc-x\{display:flex\}/);
  });

  it("a scale-to-fit message document is taken out of the wheel's chain, and only that one", () => {
    const src = read("packages/letter-body/src/MessageBody.tsx");
    // The rule is dormant in every document and driven by one attribute, like the dark and scale
    // rules beside it.
    expect(src).toMatch(/:root\[data-ohmail-fitclip\]\{overflow:hidden\}/);
    // …and the attribute is written in the same place as the height it is a fact about, gated on
    // the mail NOT having been clamped by the frame ceiling — a document that really is taller
    // than its frame must keep its scroller or its tail becomes unreachable.
    expect(src).toMatch(/toggleAttribute\("data-ohmail-fitclip", scale < 1 && !clampedByCeiling && h > 0\)/);
  });
});

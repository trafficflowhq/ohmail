/**
 * THE READING STREAM'S TWO SCROLL RULES, AT THE LEVEL A UNIT TEST CAN REACH.
 *
 * The behaviour itself is a browser fact and is measured by `scripts/scroll-shift.mjs` against
 * the real shell in headless Chromium — a jsdom run has no layout, so it can prove nothing about
 * where a viewport ends up. What IS provable here is the arithmetic the fix rests on and the
 * shape of the stylesheets it lives in:
 *
 *   · `estimateCardHeight` is a pure function of a card's own data, and it is what replaced the
 *     flat 200px `contain-intrinsic-size` that was the largest single source of the stream moving
 *     under a reader. Three card shapes, plus the two answers that are contracts rather than
 *     estimates (no width ⇒ the old constant; a clamped card ⇒ the clamp).
 *   · the CSS CENSUS: no rule in any stylesheet the reading stream loads may leave a descendant
 *     of a collapsed card vertically scrollable. This is a SOURCE scan, deliberately: the
 *     computed-style version of the same question is in the browser gate, and the two catch
 *     different things — the browser answers for the mail that happens to be on screen, the scan
 *     answers for every rule that could ever apply.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateCardHeight, estimateClipReserve, STREAM_CARD_FALLBACK_PX, STREAM_RESERVE_MIN_PX } from "@ohmail/ui";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

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
  /**
   * Every stylesheet a reading-stream card can load. `stream.css` is the card, `app.css` the
   * view around it, and `message-body.css` the sanitized message inside it — which is where the
   * two wide-content wrappers live and therefore where the census would otherwise not look.
   */
  const SHEETS = [
    "packages/ui/src/composites/stream.css",
    "apps/webapp/app/app.css",
    "apps/webapp/app/letter-body/message-body.css",
  ];

  /**
   * `overflow-x: auto` WITH NO `overflow-y` IS A VERTICAL SCROLL CONTAINER, and that is the
   * whole of what this looks for. CSS coerces a computed `visible` to `auto` on the other axis
   * the moment one axis scrolls, so a wrapper written for wide tables is also a vertical
   * scroller — measured inside a collapsed card: computed `overflow-y: auto` with 18 507px of
   * horizontal content, i.e. one classic scrollbar away from taking the reader's wheel.
   */
  it("no rule declares overflow-x without naming overflow-y", () => {
    const offenders: string[] = [];
    for (const sheet of SHEETS) {
      const text = read(sheet);
      for (const block of text.split("}")) {
        if (!/overflow-x\s*:\s*(auto|scroll)/.test(block)) continue;
        if (/overflow-y\s*:/.test(block)) continue;
        const selector = block.slice(block.lastIndexOf("*/") + 2).split("{")[0]?.trim() ?? "?";
        offenders.push(`${sheet}: ${selector.slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the wide-content wrappers are horizontal only, and contain their own overscroll", () => {
    const css = read("apps/webapp/app/letter-body/message-body.css");
    for (const cls of [".msg-pre-wrap", ".msg-table-wrap"]) {
      const rule = css.split("}").find((b) => b.includes(`${cls} {`));
      expect(rule, `${cls} has no rule`).toBeTruthy();
      expect(rule).toMatch(/overflow-x:\s*auto/);
      expect(rule).toMatch(/overflow-y:\s*hidden/);
      expect(rule).toMatch(/overscroll-behavior-x:\s*contain/);
    }
  });

  it("a collapsed stream card's preview box is at most the clamp, and its body is asked for a viewport ahead", () => {
    // The fixed 348 box held 250-500px of empty card under every short letter on a phone. The
    // ceiling lets a card settle once, when its body lands; the approach observer asking a whole
    // viewport ahead in both directions is what keeps that landing off screen.
    const css = read("packages/ui/src/composites/stream.css");
    expect(css).toMatch(/\.scast\.viewer:not\(\.open\)\s+\.sc-clip\{max-height:348px\}/);
    expect(css).toMatch(/\.scast\.pend\s+\.sc-clip\{min-height:var\(--sc-reserve,120px\)\}/);
    expect(read("apps/webapp/app/shell/StreamShell.tsx")).toContain('{ root: el, rootMargin: "100% 0px" }');
    // …and the OPEN card is still released, or a long mail could not be read.
    expect(css).toMatch(/\.scast\.viewer\.open\s+\.sc-clip\{max-height:none/);
  });

  it("the intrinsic size of a stream card is the card's own estimate", () => {
    const css = read("apps/webapp/app/app.css");
    expect(css).toMatch(/contain-intrinsic-size:\s*auto var\(--sc-est,\s*200px\)/);
    // The flat constant may only survive as the property's fallback.
    expect(css).not.toMatch(/contain-intrinsic-size:\s*auto 200px/);
  });

  it("the reading stream is the only thing anchoring the reading stream", () => {
    // Two anchors on one scroller is two writers on one offset. Measured with both the browser's
    // and the stream's own: 200px added above the reader moved `scrollTop` by 400 and left the
    // held card 200px from where it started — as wrong as no anchoring, in the other direction.
    const css = read("apps/webapp/app/app.css");
    // The whole rule, not "a block that mentions the streams": `.view-reads .stream` appears in
    // several rules (the desktop edge-to-edge one among them), and a search that took the first
    // match asserted `overflow-anchor` of a block about margins.
    expect(css).toMatch(/\.view-reads \.stream,\s*\.view-receipts \.stream \{\s*overflow-anchor: none;\s*\}/);
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

  /**
   * …AND THE QUESTION THE ARM ABOVE DOES NOT ASK. `overflow-x: auto` with no `overflow-y` is one
   * way a card descendant scrolls vertically; `overflow-y: auto` outright is the other, and the
   * census was blind to it — measured 2026-09-22 by planting `.scast .sc-clip{overflow-y:auto;
   * max-height:200px}`, the captor this row names, and reading 13 passed.
   *
   * The population is DERIVED from the stream's own components, so `.stream` — the scroller the
   * wheel is meant to reach — is the one exception and everything else inside a card is a captor.
   * A derived set can derive to nothing and pass for it, so it is asserted before it is used.
   */
  const STREAM_COMPONENTS = [
    "packages/ui/src/composites/StreamCard.tsx",
    "apps/webapp/app/shell/StreamShell.tsx",
    "apps/webapp/app/views/ReadsView.tsx",
    "apps/webapp/app/views/ReceiptsView.tsx",
  ];

  /** Every class name the reading stream's own components put on an element. */
  function streamClasses(): Set<string> {
    const out = new Set<string>();
    for (const f of STREAM_COMPONENTS) {
      for (const m of read(f).matchAll(/className=\{?["`']([^"`']+)["`']/g)) {
        for (const w of m[1]!.split(/\s+/)) if (w) out.add(w);
      }
    }
    return out;
  }

  /** Every rule in `sheet` that makes a VERTICAL scroller, as `[selector, rightmost class]`. */
  function verticalScrollers(sheet: string): { selector: string; last: string }[] {
    const out: { selector: string; last: string }[] = [];
    // ONE left-to-right pass over the comments, never a two-regex strip: a block-comment opener
    // quoted inside a line comment is what makes the naive version delete live source.
    for (const block of withoutComments(read(sheet)).split("}")) {
      if (!/overflow(?:-y)?\s*:\s*(?:auto|scroll)/.test(block)) continue;
      const selector = (block.split("{")[0] ?? "").trim().replace(/\s+/g, " ");
      if (!selector) continue;
      const classes = [...selector.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]!);
      out.push({ selector, last: classes[classes.length - 1] ?? "" });
    }
    return out;
  }

  it("the derived class set is the card's own, and it is not empty", () => {
    // The CELL-COUNT rule: a census whose population derives to nothing reports zero offenders
    // for the wrong reason. These four are the card's structure — if the markup is renamed the
    // set moves with it, and if the extraction breaks this arm says so instead of the next one
    // passing in silence.
    const classes = streamClasses();
    expect(classes.size).toBeGreaterThan(10);
    for (const c of ["sc-clip", "sc-body", "sc-head", "stream"]) expect(classes.has(c)).toBe(true);
  });

  it("no rule makes a vertical scroller of anything inside a card — only the stream itself", () => {
    const classes = streamClasses();
    const captors: string[] = [];
    for (const sheet of SHEETS) {
      for (const { selector, last } of verticalScrollers(sheet)) {
        // `.stream` IS the scroller. Every other class the stream renders is inside a card, and a
        // scroller there takes the wheel from the list — which is the whole defect.
        if (last === "stream") continue;
        if (classes.has(last)) captors.push(`${sheet}: ${selector.slice(0, 90)}`);
      }
    }
    expect(captors).toEqual([]);
  });

  it("the census SEES a captor — the planted one, in the rule's own shape", () => {
    /* A refusal rule with no case that reaches it is a rule nobody has watched work. The planted
       text is the one measured green against the older arm, so this pins the reading that changed
       rather than a shape invented for the guard. */
    const classes = streamClasses();
    const planted = withoutComments(".scast .sc-clip{overflow-y:auto;max-height:200px}");
    const found = planted.split("}").flatMap((block) => {
      if (!/overflow(?:-y)?\s*:\s*(?:auto|scroll)/.test(block)) return [];
      const sel = (block.split("{")[0] ?? "").trim();
      const cs = [...sel.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]!);
      const last = cs[cs.length - 1] ?? "";
      return last !== "stream" && classes.has(last) ? [sel] : [];
    });
    expect(found).toEqual([".scast .sc-clip"]);
  });

  it("a scale-to-fit message document is taken out of the wheel's chain, and only that one", () => {
    const src = read("apps/webapp/app/letter-body/MessageBody.tsx");
    // The rule is dormant in every document and driven by one attribute, like the dark and scale
    // rules beside it.
    expect(src).toMatch(/:root\[data-ohmail-fitclip\]\{overflow:hidden\}/);
    // …and the attribute is written in the same place as the height it is a fact about, gated on
    // the mail NOT having been clamped by the frame ceiling — a document that really is taller
    // than its frame must keep its scroller or its tail becomes unreachable.
    expect(src).toMatch(/toggleAttribute\("data-ohmail-fitclip", scale < 1 && !clampedByCeiling && h > 0\)/);
  });
});

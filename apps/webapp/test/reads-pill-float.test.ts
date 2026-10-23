/**
 * ═══ THE READING CARD'S VERBS FLOAT, AND EVERY PINNED THING CLEARS THE HOME INDICATOR ═══════
 *
 * The Reads and Receipts card's action bar was `position: static`, overriding the reading
 * pane's own `position: sticky; bottom: 12px`. The comment beside the override said a sticky bar
 * "would resolve against the STREAM and float over every other card as this one passed" — which
 * is not how sticky works: a sticky box is confined to its containing block, and the containing
 * block is the card. The cost of that mistake was the whole verb row. On a long card the reader
 * was inside the message and its verbs were a screen or more below: measured at y 2712 in an
 * 844px window at 390, y 1648 in a 900px one at 1440.
 *
 * WHAT THIS FILE CAN AND CANNOT SAY. These are stylesheet pins — the rules, read as text. Where
 * the bar actually GOES is a browser question and is measured in `scripts/fit-render.mjs`'s
 * `reads-pill` subject at 390 and 1440, on both faces and in both locales, by asking the page
 * what is painted at the bar's own centre. The two halves are deliberate: the geometry gate
 * cannot see `env(safe-area-inset-bottom)` at all, because it resolves to 0 in every browser
 * this repository can drive, so the safe-area clauses below are the ONLY guard those have.
 *
 * Every assertion here was watched red by making the change it forbids — the list is on each
 * `it`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** Comments stripped: this file's subject is what the stylesheet DECLARES, and every rule here
    is documented in prose that quotes the declaration it is about. */
const css = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const stream = (): string => css("../../../packages/ui/src/composites/stream.css");
const toast = (): string => css("../../../packages/ui/src/primitives/toast.css");
const app = (): string => css("../app/app.css");
const abar = (): string => css("../app/shell/action-bar.css");

/** The rule whose selector begins a line — the base rule, never a scoped override. */
const ruleFor = (src: string, selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc}\\s*\\{[^}]*\\}`, "m").exec(src)?.[0] ?? "";
};
/**
 * Every `@media` block whose condition contains `needle`, joined.
 *
 * ALL of them, not the first: `app.css` carries several separate phone-band `@media` blocks
 * and the rules here live in the fourth. Taking the first returned an empty string for rules that
 * are plainly declared, which reads exactly like "the rule is gone" — a guard failing for a
 * reason that has nothing to do with the product. Caught by watching this file red before
 * believing it.
 */
const mediaBlock = (src: string, needle: string): string => {
  const re = new RegExp(`@media[^{]*${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{`, "g");
  const out: string[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    out.push(src.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return out.join("\n");
};

describe("the reading card's pill floats", () => {
  it("THE CARD'S BAR IS STICKY, AND NOTHING IN THE FILE PUTS IT BACK", () => {
    /* Mutation watched red: restore `position:static` on `.scast .sc-actions` — this assertion
       fails, and so does `fit-render`'s reads-pill subject with "its verbs are 1983px below the
       window". */
    const rule = ruleFor(stream(), ".scast .sc-actions");
    expect(rule, "the card's bar is not declared at all").not.toBe("");
    expect(rule).toContain("position:sticky");
    expect(rule).toContain("bottom:calc(12px + env(safe-area-inset-bottom,0px))");
    /* The whole file, not just this rule: a `static` anywhere on `.sc-actions` — in a media
       block, on a narrower selector — puts the bar back at the foot of a card nobody can see. */
    expect(stream(), "some rule still sets the card's bar static")
      .not.toMatch(/\.sc-actions[^{}]*\{[^}]*position:\s*static/);
  });

  it("THE BOTTOM RESERVATION IS A FLOW SPACER, NOT PADDING — that is what makes 12px mean 12px", () => {
    /**
     * Chromium builds the sticky rectangle from the scrollport's CONTENT box, so bottom padding
     * on the scroller pushes the pinned bar up by exactly that much: with `padding-bottom: 48px`
     * a bar at `bottom: 12px` rested 60px off the edge, 70px on a phone. Subtracting the padding
     * back out in the offset is a bet on how an engine builds that rectangle, and the desktop app
     * is WebKitGTK. A `::after` reserves the same space in flow instead.
     *
     * Mutation watched red: put `48px` back in `.stream`'s padding — `fit-render` reports "the
     * bar's bottom is 60px off the scrollport's edge, not 12" at 1440 on both faces.
     */
    const src = stream();
    const rule = ruleFor(src, ".stream");
    // Plus the first-sync pill's own height, 0 unless that pill is drawn (SyncBar's `--pill-h`).
    expect(rule).toContain("--stream-tail:calc(48px + var(--pill-h, 0px))");
    expect(rule, "the scroller is padding its bottom again — the pinned offset is now that much larger")
      .toMatch(/padding:2px 12px 0[;}]/);
    const spacer = ruleFor(src, ".stream::after");
    expect(spacer, "the spacer that replaced the padding is gone").not.toBe("");
    expect(spacer).toContain("height:var(--stream-tail)");
    expect(spacer).toContain('content:""');
  });

  it("THE PINNED OFFSET CARRIES THE SAFE AREA, AND THE SPACER CANNOT DO IT FOR HIM", () => {
    /**
     * The reservation's `env()` governs where the bar comes to rest IN FLOW at the card's end.
     * While the card is taller than the room the bar is not in flow — it is pinned against the
     * scrollport's bottom edge, and on a phone whose viewport reaches under the home indicator
     * that edge is the glass. So the offset needs the inset too.
     *
     * No browser this repository can drive reports a non-zero inset, so this assertion is the
     * only guard on the clause. Mutation watched red: delete the `bottom:` line from the ≤640
     * block.
     */
    expect(ruleFor(stream(), ".scast .sc-actions"))
      .toContain("bottom:calc(12px + env(safe-area-inset-bottom,0px))");
    /* UNCONDITIONALLY, and this assertion is the one that says so. The design ruling scoped the
       clause to ≤640; the scroller's reservation carries the inset from 900 down, so a 640 scope
       leaves 641–900 — a tablet in a standalone window — resting clear of the indicator and
       pinning into it, which is the mismatch the clause exists to remove. A `@media` wrapper
       around it is therefore a defect, not a narrowing. */
    expect(mediaBlock(stream(), "max-width"), "the offset was moved back inside a width block")
      .not.toMatch(/\.sc-actions[^{}]*\{[^}]*bottom:/);

    /* And the spacer's own phone value, which lives in the app's phone block (≤699.98, the
       width ladder's one-column band) because that is where the phone's stream padding has
       always been declared. */
    const wide = mediaBlock(app(), "max-width: 699.98px");
    expect(wide, "app.css has no phone block").not.toBe("");
    const viewStream = /\.view \.stream \{[^}]*\}/.exec(wide)?.[0] ?? "";
    // The first-sync pill's height (`--pill-h`, 0 unless the pill is drawn) and the sending pill's
    // (`--send-pill-h`) join the spacer, so the last card rests clear of both; the safe area stays last.
    expect(viewStream).toContain("--stream-tail: calc(48px + var(--pill-h, 0px) + var(--send-pill-h, 0px) + env(safe-area-inset-bottom, 0px))");
    expect(viewStream, "the phone's stream is padding its bottom again, which moves the pinned bar up")
      .toMatch(/padding: 0 6px 0;/);
  });

  it("THE TOAST CLEARS THE PILL AND THE HOME INDICATOR", () => {
    /* 72px was measured against a pill resting 12px off the bottom. Both are viewport-relative,
       so if the pill's edge moves down under an indicator and the toast's does not, the two end
       up in the same strip — the toast covering the Undo it is offering to replace.
       Mutation watched red: put the bare `bottom:72px` back. */
    expect(ruleFor(toast(), ".toast"))
      .toContain("bottom:calc(72px + env(safe-area-inset-bottom,0px))");
  });

  it("THE READING COLUMN'S 12px IS DELIBERATELY BARE, AND THE READER SHEET'S IS NOT", () => {
    /**
     * These two look like the same omission and are not, which is why the difference is written
     * down rather than levelled.
     *
     * `.msg-actions{bottom:12px}` in the reading column is one half of a pair: `.msg` pads 12px
     * at its bottom and `.read-col` pads none, so the bar's RESTING gap and its PINNED gap are
     * the same 12px — the invariant `action-bar.test.ts` calls "the resting position is the
     * pinned position". Adding an inset to the pinned half alone breaks that pair, and the
     * assertion below is what says so.
     *
     * THE REASON THIS IS CHEAP TO LEAVE IS NARROWER THAN IT FIRST READ, AND THE FIRST VERSION OF
     * THIS COMMENT WAS WRONG. It said the column is not rendered under 700px. Classic layout does
     * collapse it there, but Zero layout keeps the split alive and renders `.read-col` from 722px
     * (`zero-layout.css`, the `min-width:722px and max-width:1023.98px` tier) — inside the band where
     * a phone or tablet can have a bottom inset. So the honest statement is the trade, not an
     * absence: in that band the resting gap and the pinned gap stay equal to each other, and both
     * sit 12px above a scrollport whose own reservation already carries the inset. Levelling the
     * pinned half alone would buy indicator clearance by breaking the pair. If that trade is ever
     * to be revisited it has to move BOTH halves together.
     *
     * The reader sheet is the opposite case — on a phone the overlay IS the whole viewport — and
     * it carries the inset already, scoped to itself.
     */
    const message = css("../../../packages/ui/src/composites/message.css");
    expect(ruleFor(message, ".msg-actions")).toContain("bottom:12px");
    expect(css("../../../packages/ui/src/composites/reader.css"))
      .toContain(".reader .msg-actions{bottom:calc(12px + env(safe-area-inset-bottom,0px))}");
    /* AND NO SCOPED OVERRIDE SMUGGLES THE INSET BACK IN. Checking only the base declaration left
       the invariant open to a `.read-col .msg-actions{bottom:calc(12px + env(…))}` added beside
       it — which breaks the pair exactly as editing the base would, and passed. Review found it.
       Any rule that targets the column's bar and sets `bottom` is the thing being forbidden. */
    for (const file of ["message.css", "reader.css"]) {
      const src = css(`../../../packages/ui/src/composites/${file}`);
      expect(src, `${file} gives the reading column's bar its own bottom offset — the resting and pinned gaps are no longer the same 12px`)
        .not.toMatch(/\.read-col[^{}]*\.msg-actions[^{}]*\{[^}]*bottom:/);
    }
  });

  it("KEYCAPS DO NOT RENDER WHERE THERE ARE NO KEYS", () => {
    /**
     * `touch-keys.css` hides the top bar's ⌘K, the reader's "esc to return", the decision
     * capsules' letters and the rail's Command row — and it never reached the action pill, so
     * `r` and `⇧f` were on screen at 390px on every message and Reads pill, and `⇧U` and `esc`
     * on the selection strip.
     *
     * The rule lives in `action-bar.css` and not in `touch-keys.css` because the declaration it
     * has to beat is `.abar kbd` in that same file, where order settles it; a cross-file
     * override would need the specificity games every selector in `touch-keys.css` plays.
     *
     * Mutation watched red: change the declaration to `display:inline-block` — `fit-render`
     * reports "8 keycap(s) are laid out on a coarse-pointer device" at 390 on both faces.
     */
    const coarse = mediaBlock(abar(), "pointer: coarse");
    expect(coarse, "action-bar.css has no coarse-pointer block").not.toBe("");
    expect(coarse).toMatch(/\.abar kbd\s*\{[^}]*display:\s*none/);
  });

  it("THE SCREENER'S FULL-SCREEN READ RESERVES WHAT EVERY OTHER SCROLLER DOES", () => {
    /**
     * `.view-screener.scn-full .scn-read` and `.scn-mails` reserved 60px for a control that is
     * not there: the full-screen read's verbs are the decision bar, sticky at the TOP (234–253px
     * tall at 390), and the last body line ends ~156px above the viewport's bottom. The 60
     * cleared nothing and never had. What a scroller whose box is `position: fixed; inset: 0`
     * actually owes is the falloff every other scroller in that block reserves plus the home
     * indicator — so it is that number now rather than a third one.
     *
     * Mutation watched red: put either `60px` back.
     */
    const wide = mediaBlock(app(), "max-width: 699.98px");
    const read = /\.view-screener\.scn-full \.scn-read \{[^}]*\}/.exec(wide)?.[0] ?? "";
    expect(read, "the full-screen read rule is gone").not.toBe("");
    expect(read).toContain("padding-bottom: calc(48px + env(safe-area-inset-bottom, 0px))");
    expect(read, "the stale 60px reservation is back").not.toMatch(/padding-bottom: 60px/);
    const mails = /\.scn-mails \{[^}]*\}/.exec(wide)?.[0] ?? "";
    expect(mails).toContain("padding: 16px 18px calc(48px + env(safe-area-inset-bottom, 0px))");
  });
});

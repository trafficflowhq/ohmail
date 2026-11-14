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
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionPanel } from "@ohmail/ui/mail";
import { entryCss } from "../../../packages/ui/test/compare/harness.js";
import { launch } from "../../../test/compare/render.mjs";

/** Comments stripped: this file's subject is what the stylesheet DECLARES, and every rule here
    is documented in prose that quotes the declaration it is about. */
const css = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const stream = (): string => css("../../../packages/ui/src/composites/stream.css");
const toast = (): string => css("../../../packages/ui/src/primitives/toast.css");
const app = (): string => css("../app/app.css");
const touchKeys = (): string => css("../../../packages/app/src/keys/touch-keys.css");

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
    expect(rule).toContain("--stream-tail:48px");
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
    // The sending pill's height (`--send-pill-h`) joins the spacer, so the last card rests clear of it;
    // the safe area stays last.
    expect(viewStream).toContain("--stream-tail: calc(48px + var(--send-pill-h, 0px) + env(safe-area-inset-bottom, 0px))");
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

  it("KEYCAPS DO NOT RENDER WHERE THERE ARE NO KEYS", async () => {
    const touch = touchKeys();
    const coarse = mediaBlock(touch, "pointer: coarse");
    expect(coarse, "touch-keys.css has no coarse-pointer block").not.toBe("");
    expect(coarse).toMatch(/button kbd\s*\{[^}]*display:\s*none/);

    const { chromium } = createRequire(resolve(process.cwd(), "package.json"))("@playwright/test") as
      typeof import("@playwright/test");
    const browser = await launch(chromium);
    try {
      const panel = renderToStaticMarkup(createElement(ActionPanel, {
        label: "Actions",
        keysShown: true,
        items: [
          { id: "reply", label: "Reply", keyHint: "r", onPress: () => {} },
          { id: "forward", label: "Forward", keyHint: "⇧f", onPress: () => {} },
        ],
      }));
      const styles = await entryCss("mail");
      // Keep the frame's touch stamp unset here to exercise the pointer media rule itself.
      const markup = `<!doctype html><html data-face="paper" data-scheme="light"><head>
        <style>${styles}
${touch}</style></head><body><div class="oh-root">${panel}</div></body></html>`;

      for (const hasTouch of [false, true]) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch });
        try {
          await page.setContent(markup);
          expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(hasTouch);
          const toolbar = page.getByRole("toolbar", { name: "Actions" });
          const reply = toolbar.getByRole("button", { name: "Reply" });
          const forward = toolbar.getByRole("button", { name: "Forward" });
          expect(await reply.isVisible()).toBe(true);
          expect(await forward.isVisible()).toBe(true);
          expect(await toolbar.locator("kbd:visible").allTextContents()).toEqual(hasTouch ? [] : ["r", "⇧f"]);
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
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

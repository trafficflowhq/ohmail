import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionPanel } from "@ohmail/ui/mail";
import { entryCss } from "../../../packages/ui/test/compare/harness.js";
import { launch } from "../../../test/compare/render.mjs";
/**
 * KEYBOARD CHROME ON A DEVICE WITH NO KEYBOARD.
 *
 * ── WALKED AT PHONE WIDTH ON A LIVE ACCOUNT ─────────────────────────────────────────────
 *
 * Three pieces of key chrome, on a phone:
 *
 *   1. a **⌘K pill in the mobile top bar** whose entire label is a chord;
 *   2. **"esc to return"** over the reading overlay;
 *   3. the **"Command ⌘K"** control — a real button wearing a keycap nobody can press. (It was
 *      a capsule floating over the page when this was walked; it is a row at the foot of the
 *      rail now, and the rule and this file followed it there.)
 *
 * The precedent is from the same day: the reader's action bar rests at `opacity:.35` and lifts
 * on hover, which on touch means it is PERMANENTLY dimmed because the hover never comes. That
 * was fixed under `@media (hover: none)` at `action-bar.css:242`. This is the same idea aimed
 * at the other half — an affordance describing an INPUT the device does not have — so it keys
 * on `(pointer: coarse)`.
 *
 * ── WHAT A GUARD CAN AND CANNOT SEE HERE, SAID PLAINLY ─────────────────────────────────
 *
 * **jsdom evaluates no CSS.** No test in this repository can watch a media query take effect,
 * and pretending otherwise with a `getComputedStyle` assertion would be a guard that passes
 * whatever the stylesheet says. A media query needs two independent things to be true, and
 * both of them ARE observable:
 *
 *   · the RULE exists, is inside `@media (pointer: coarse)`, and hides the element;
 *   · its SELECTOR really does match the element it names, in the DOM the app renders.
 *
 * The second half is the one that rots. `.topbar > .tb-btn:last-child` stops matching the
 * moment somebody appends a button to the top bar, and nothing about the stylesheet would look
 * wrong. So the selectors are read OUT OF the stylesheet and run against real mounted output —
 * the shipped `AppShell` for the top bar and the rail's dock rows, and the shipped `@ohmail/ui`
 * components for the other two. A selector that has stopped matching fails here rather than on
 * somebody's phone.
 */


/** Read from the repo root — vitest's `root`, and the one path shape that survives jsdom. */
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
/* Comments carry no braces, so a naive scan folds them into the selector before them. */
const css = read("packages/app/src/keys/touch-keys.css").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The body of the one `@media (pointer: coarse)` block, or the empty string.
 *
 * Deliberately naive brace matching over a file this slice owns and keeps small — a CSS parser
 * as a test dependency would be a bigger claim than the thing under test.
 */
function coarseBlock(): string {
  const at = css.indexOf("@media (pointer: coarse)");
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

/** Every selector in the block that is hidden outright. */
function hiddenSelectors(): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  const block = coarseBlock();
  while ((m = re.exec(block)) !== null) {
    if (/display\s*:\s*none/.test(m[2]!)) out.push(m[1]!.trim().replace(/\s+/g, " "));
  }
  return out;
}

describe("the rules exist, and they are the ones the audit asked for", () => {
  it("all four hints are hidden under (pointer: coarse), and nothing else is", () => {
    /**
     * Mutation: delete any one of the rules, or change the query to
     * `@media (max-width: 699.98px)`. `coarseBlock()` returns "" for the latter and every
     * assertion below fails at once — which is the right shape, because width is not the
     * question. A 1440px touchscreen has no ⌘ key and a 500px browser window has one.
     *
     * THE SET IS STILL CLOSED, AND IT GREW BY ONE ON PURPOSE. The list is
     * exhaustive so that a rule added here has to be argued for; `.decide .dbtn button kbd`
     * is that argument. The decision bar already carried a keycap on touch — the AI
     * capsule's hand-typed `y` — which this audit did not catch, and a later change puts a letter on
     * all five capsules and a shifted twin on each ✓. One unpressable cap became ten, on
     * the surface a phone user taps most. Same defect, same remedy, named rather than
     * quietly admitted by relaxing this to `toContain`.
     *
     * AND BY ONE MORE, with the same argument to make: the pane-foot hint strips. They hold
     * only the `? shortcuts` affordance now (`ShortcutHint`), and that is the ⌘K pill's case
     * verbatim — a tappable control whose label is a keycap and whose product, the `?`
     * sheet, is a list of keys a coarse-pointer device does not have. `app.css` hides the
     * strips under 700px; this rule is the wide tablet, where the pointer is still coarse.
     * That the selector matches what the app renders is proven where the strip is mounted:
     * `screener-cloud.test.ts` finds the affordance under `.view-screener .list-hints`, on a
     * root that carries `view view-screener`.
     */
    /* AND IT FOLDED. A phone still showed "Send Ctrl ↵", "Compose c", "Search /"
       and "Mark all spam s": every one a keycap on a button. `button kbd` is that class, and it
       holds the capsules' and the dock row's caps the two narrower rules held; the key-only hints
       join `.reader-hint`'s shape. `touch-keys-census.test.tsx` reads every keycap the app renders
       against this set. */
    expect(coarseBlock(), "no (pointer: coarse) block at all").not.toBe("");
    expect(hiddenSelectors().sort()).toEqual([
      ".reader-hint:has(kbd)",
      ".reply-hint:has(kbd), .fr-foot .esc:has(kbd), .palette .pal-list li .keys, .palette .pal-foot",
      ".topbar > .tb-btn:last-child",
      ".view .list-hints, .view .stream-hints",
      "button kbd",
    ]);
  });

  it("the stylesheet is in the bundle — a rule nobody imports is a rule nobody has", () => {
    // `touch-keys.css` has no component of its own, so the only thing that puts it in the route
    // bundle is this import. Deleting it leaves every assertion in this file green and the
    // product unfixed, which is exactly the failure mode worth one line of grep. The registry
    // is the frame's own now (`OwnKeys` of `Frame.tsx`, mounted by every host's frame): the
    // stylesheet rides with it there, as it rode with today's `KeymapProvider`.
    const keymap = read("packages/app/src/frame/Frame.tsx");
    expect(keymap).toContain('import "../keys/touch-keys.css"');
  });
});

describe("the current decision panel on touch", () => {
  it("hides keyboard hints and keeps all five filing controls", async () => {
    const { chromium } = createRequire(resolve(process.cwd(), "package.json"))("@playwright/test") as
      typeof import("@playwright/test");
    const browser = await launch(chromium);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 740 }, hasTouch: true });
      const verbs = ["Ohbox", "News", "Receipts", "Screen out", "Spam"];
      const keys = ["o", "r", "c", "n", "x"];
      const body = renderToStaticMarkup(h(ActionPanel, {
        label: "Actions", keysShown: true,
        items: verbs.map((label, i) => ({ id: label, label, keyHint: keys[i], onPress: () => {} })),
      }));
      await page.setContent(`<!doctype html><html data-face="paper" data-scheme="light" data-touch="0">
        <head><style>${await entryCss("mail")}</style></head><body><div class="oh-root">${body}</div></body></html>`);
      expect(await page.locator("kbd:visible").allTextContents()).toEqual(keys);
      await page.evaluate(() => { document.documentElement.dataset.touch = "1"; });
      expect(await page.locator("kbd:visible").count()).toBe(0);
      const panel = page.getByRole("toolbar", { name: "Actions" });
      expect(await panel.getByRole("button").count()).toBe(5);
      for (const name of verbs) expect(await panel.getByRole("button", { name }).isVisible()).toBe(true);
    } finally {
      await browser.close();
    }
  });
});

/**
 * THE DELETED COMPONENT LEFT NOTHING BEHIND — the sweep, as a guard rather than as a memory.
 *
 * The floating capsule is gone and its two controls are rows at the foot of the rail. A deletion
 * like that leaves three kinds of debris, and none of them fails anything on its own:
 *
 *   · a `.dock` RULE in a stylesheet, which is a statement about the app that has stopped being
 *     true — `body.reading .dock` and `body.scn-full-open .dock` both hid a thing that no longer
 *     exists, and a rule that matches nothing is indistinguishable from one that works;
 *   · an EXPORT with no consumer, which is the built-tested-unreachable pattern: it compiles, the
 *     smoke test renders it, and nobody can reach it in the product;
 *   · a `--msg-paper` left declared and unread, ditto (asserted in `action-bar.test.ts`, where
 *     the rest of the pill's geometry lives).
 *
 * Read with `readFileSync` rather than shelled out to `grep` on purpose: this repository's `grep`
 * is a function wrapping a binary-skipping tool, and a single NUL byte anywhere in a file makes
 * it skip the whole file and exit 1 — which is indistinguishable from "the string is not there",
 * i.e. from this guard passing.
 */
describe("the floating capsule is gone, and so is everything that referred to it", () => {
  const bare = (p: string): string =>
    readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("no stylesheet still carries a `.dock` selector", () => {
    // `.rail-dock` is deliberately not matched: the `.` binds to `rail`, so the new group's
    // rules are not swept up by the check that removes the old one's.
    for (const p of [
      "packages/ui/src/composites/reader.css",
      "packages/ui/src/composites/rail.css",
      "packages/ui/src/composites/message.css",
      "packages/ui/src/primitives/toast.css",
      "apps/webapp/app/app.css",
      "apps/webapp/app/shell/action-bar.css",
      "packages/app/src/keys/touch-keys.css",
    ]) {
      expect(bare(p), `${p} still styles a component that no longer exists`)
        .not.toMatch(/\.dock[\s.,:>{[]|\.dock$/m);
    }
  });

  it("the component and its stylesheet are deleted, not merely unused", () => {
    expect(existsSync(resolve(process.cwd(), "packages/ui/src/composites/Dock.tsx"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), "packages/ui/src/composites/dock.css"))).toBe(false);
  });

  it("`@ohmail/ui` exports nothing that cannot be reached", async () => {
    const ui = await import("@ohmail/ui");
    // `SearchHit` joins the list on the same ground and from the other direction: it was never
    // deleted from anywhere, it was simply never rendered by a product surface. The webapp's own
    // result row grew a second control (the sender's address) and a button may not hold
    // interactive content, so the shipped row is a div — `SearchHitRow` in SearchView — and this
    // export was a second, unreachable answer to a question already answered once.
    for (const name of ["Dock", "DockKey", "DockIcon", "DockSep", "SearchHit"]) {
      expect(name in ui, `${name} is still exported with no consumer`).toBe(false);
    }
  });
});

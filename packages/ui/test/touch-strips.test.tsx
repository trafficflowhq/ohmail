/** @vitest-environment jsdom */
/**
 * ═══ THE FOLDER ROW'S TWO CONTROLS THAT WERE STILL UNDER 44, AND WHAT EACH ONE PRESSES NOW ═══
 *
 * `.ftw` (14 wide) and `.fmore` took neither the drawn 44 nor a hit strip. They are the remainder
 * of the touch-target pass, and the reason they were left is the reason they need reading rather
 * than a blanket rule: each sits beside another control, and the strip rule forbids a strip that
 * overlaps one. (The reader's open glyph and the (i) note's summary left with today's reader.)
 *
 * ── WHAT A "GEOMETRY CASE" IS IN JSDOM ───────────────────────────────────────────────────────
 *
 * jsdom performs no layout, so nothing here measures a rendered box. What it DOES have is a real
 * CSS parser: the stylesheet is injected and read back through the CSSOM, so every number below
 * comes from the declarations the browser would use — `@media` condition, selector, `position`,
 * `top`, `height`, `translate` — and not from a regular expression over the file's text. A regex
 * would pass for a rule inside the wrong media block, for a strip on a host with no containing
 * block, and for `height:44px` written where `top` is missing; each of those renders a pressable
 * area that is not 44.
 *
 * So the shape of every case is: derive the strip's vertical extent from its declarations, and
 * refuse unless the four facts that make that extent real are all present. `pressableHeight`
 * throws with the missing fact named rather than returning a number nobody can trust.
 *
 * ── AND THE ONE THAT IS NOT A STRIP ──────────────────────────────────────────────────────────
 *
 * `.ftw` is 14px WIDE. The deficiency is horizontal, and the rule's own words are "Vertical only
 * — neighbours in a row sit 0–6px apart horizontally, so a horizontal strip would overlap the
 * control beside it": `.ritem` begins 0px to the twisty's right and is itself a control. What
 * the twisty needs is the ROW to be 44, which it then fills (`align-self:stretch`). That arm
 * reads the row's floor and the stretch together, because either alone is a control that presses
 * 14×20 while looking finished.
 */
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderFold } from "../src/mail/Lists/FolderFold.js";
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = [resolve(__dirname, "..", "..", ".."), resolve(__dirname, "..", "..")]
  .find((r) => existsSync(resolve(r, "packages/ui/src/base.css")))!;

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

/** The phone block every stylesheet in this system writes its touch rules into. */
const PHONE = "(max-width: 640px)";

interface Parsed { media: string | null; selector: string; style: CSSStyleDeclaration }

/**
 * Every style rule in a stylesheet, each tagged with the media condition it stands under.
 * Parsed by the DOM, so an unparseable declaration is absent here exactly as it would be absent
 * in the browser.
 */
const rules = (css: string): Parsed[] => {
  const el = document.createElement("style");
  el.textContent = css;
  document.head.append(el);
  const sheet = el.sheet!;
  const out: Parsed[] = [];
  const walk = (list: CSSRuleList, media: string | null): void => {
    for (const rule of Array.from(list)) {
      if (rule.type === 4 /* CSSMediaRule */) {
        const m = rule as CSSMediaRule;
        walk(m.cssRules, m.media.mediaText);
      } else if (rule.type === 1 /* CSSStyleRule */) {
        const r = rule as CSSStyleRule;
        for (const selector of r.selectorText.split(",")) {
          out.push({ media, selector: selector.trim(), style: r.style });
        }
      }
    }
  };
  walk(sheet.cssRules, null);
  el.remove();
  return out;
};

const find = (all: Parsed[], selector: string, media: string | null): CSSStyleDeclaration | null =>
  all.find((r) => r.selector === selector && r.media === media)?.style ?? null;

/**
 * One declaration, ALWAYS through `getPropertyValue`.
 *
 * jsdom's CSSStyleDeclaration implements camelCase accessors for only a subset of properties —
 * `position`, `top` and `height` are there, `min-height`, `align-self`, `align-items`,
 * `margin-top` and `padding-top` are not, and an unimplemented one reads `undefined`. So
 * `style.minHeight === ""` is a comparison that can never be true, which is a case that cannot
 * fail: it reads as "no floor is declared" for a stylesheet that declares one. Every read below
 * goes through the property name.
 */
const val = (style: CSSStyleDeclaration, prop: string): string => style.getPropertyValue(prop);

/**
 * The rule, or a throw that NAMES what is missing.
 *
 * `find(...)!` reads well and fails as `Cannot read properties of null` — a red that says nothing
 * about the stylesheet and reads, to whoever meets it next, as a broken test rather than a missing
 * rule. Watched: deleting `.frow`'s floor produced exactly that message on two cases before this
 * existed.
 */
const must = (all: Parsed[], selector: string, media: string | null): CSSStyleDeclaration => {
  const style = find(all, selector, media);
  if (!style) throw new Error(`no rule for \`${selector}\`${media ? ` under ${media}` : " outside any media block"}`);
  return style;
};

/**
 * The strip's vertical extent, in pixels — or a throw naming the fact that is missing.
 *
 * Four facts make the extent real, and every one of them has a failure mode that renders as a
 * control that is still 26 tall:
 *
 *   · the HOST is `position:relative` inside the same media block — without it the strip's
 *     containing block is some ancestor and `top:50%` is half of that ancestor, so the strip
 *     lands somewhere else entirely (this is the one that looks right in the file and is wrong
 *     on screen);
 *   · the strip is `position:absolute` — a static `::before` is a box in the flow, which would
 *     change the drawn size, which is the thing the strip exists to avoid;
 *   · `content` is declared — a `::before` with no content generates no box at all;
 *   · `top:50%` with `translate:0 -50%` centres it on the host. `top` alone hangs the strip off
 *     the host's midpoint downward, so it covers 22px of whatever is below and 0 of the control.
 */
const pressableHeight = (all: Parsed[], host: string, strip: string): number => {
  const h = find(all, host, PHONE);
  if (!h) throw new Error(`no phone rule for the host \`${host}\` — the strip has no containing block`);
  if (val(h, "position") !== "relative") throw new Error(`\`${host}\` is not position:relative under ${PHONE}`);
  const s = find(all, strip, PHONE);
  if (!s) throw new Error(`no phone rule for \`${strip}\``);
  if (val(s, "position") !== "absolute") throw new Error(`\`${strip}\` is not position:absolute — it is a box in the flow`);
  if (!val(s, "content")) throw new Error(`\`${strip}\` declares no content — no box is generated`);
  if (val(s, "top") !== "50%") throw new Error(`\`${strip}\` is not anchored at top:50% (got ${val(s, "top") || "nothing"})`);
  if (val(s, "translate").replace(/\s+/g, " ").trim() !== "0 -50%") {
    throw new Error(`\`${strip}\` is not centred — translate is \`${val(s, "translate")}\``);
  }
  const px = /^(\d+(?:\.\d+)?)px$/.exec(val(s, "height"));
  if (!px) throw new Error(`\`${strip}\` has no pixel height (got ${val(s, "height") || "nothing"})`);
  return Number(px[1]);
};

describe("the folder row: the twisty gets the ROW, the ⋯ gets a strip", () => {
  const all = rules(read("packages/ui/src/composites/rail.css"));

  it("`.fmore` gains a centred 44px strip, which is exactly the row it sits in", () => {
    const strip = pressableHeight(all, ".fmore", ".fmore::before");
    expect(strip).toBeGreaterThanOrEqual(44);
    /* Equal to the row's floor, so the strip reaches past neither end of the row — the only
       thing it could overlap vertically. Horizontally `.ritem` ends where `.fmore` begins. */
    expect(strip).toBe(Number(/^(\d+)px$/.exec(val(must(all, ".frow", PHONE), "min-height"))![1]));
  });

  it("and keeps its drawn padding box", () => {
    expect(val(must(all, ".fmore", null), "padding")).toBe("2px 7px");
    expect(val(must(all, ".fmore", PHONE), "min-height")).toBe("");
  });

  /* A strip outside the media block would be a 44px pressable area on the desktop, where the
     density is a design the wider layout was drawn around — and it would silently swallow the
     rows above and below a control that is small there by choice. */
  it("its strip stands under the phone block and nowhere else: no `height:44px` strip at any other width", () => {
    const strips = all.filter((r) => r.selector.includes("::before") && val(r.style, "height") === "44px");
    expect(strips.length, "rail.css declares no 44px strip at all").toBeGreaterThan(0);
    for (const st of strips) expect(st.media, `rail.css: \`${st.selector}\` stands outside the phone block`).toBe(PHONE);
  });
});

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test") as typeof import("@playwright/test");
const touchCSS = [
  "packages/tokens/src/design/tokens.css",
  "packages/ui/src/base/base.css",
  "packages/ui/src/mail/Shell/rail-entry.css",
  "packages/ui/src/mail/Lists/folder-fold.css",
].map(read).join("\n");

describe("the folder branch under a finger", () => {
  it("fills its row without taking the adjacent folder's target", async () => {
    const markup = renderToStaticMarkup(
      <FolderFold
        label="All folders"
        none="No folders"
        groups={[{ folders: [{ id: "team", name: "Team", branch: { label: "Expand Team", expanded: false } }] }]}
      />,
    );
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      await page.setContent(`<!doctype html><html data-device="phone" data-touch="1"><head>
        <meta name="viewport" content="width=device-width,initial-scale=1"><style>${touchCSS}</style>
        </head><body>${markup}</body></html>`);
      const branch = page.getByRole("button", { name: "Expand Team" });
      const folder = page.getByRole("button", { name: "Team", exact: true });
      const folderBox = await folder.boundingBox();
      expect(folderBox).not.toBeNull();
      const target = await branch.evaluate((item) => {
        const { left, right, top, bottom, height } = item.getBoundingClientRect();
        const x = (left + right) / 2;
        return {
          top, right, height,
          hits: [top + 1, bottom - 1].every((y) => item.contains(document.elementFromPoint(x, y))),
        };
      });
      expect(target.height).toBeGreaterThanOrEqual(44);
      expect(target.height).toBe(folderBox!.height);
      expect(target.top).toBe(folderBox!.y);
      expect(target.hits).toBe(true);
      const boundary = await folder.evaluate((item, right) => {
        const { top, height } = item.getBoundingClientRect();
        const y = top + height / 2;
        return {
          underBranch: item.contains(document.elementFromPoint(right - 1, y)),
          besideBranch: item.contains(document.elementFromPoint(right + 1, y)),
        };
      }, target.right);
      expect(boundary).toEqual({ underBranch: false, besideBranch: true });
    } finally {
      await browser.close();
    }
  });
});

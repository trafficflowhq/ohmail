import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RulesPane, rulesStates } from "@ohmail/app/settings/rules";
import { TextProvider, type Messages } from "@ohmail/app/text";
import messages from "../messages/en.json";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test") as typeof import("@playwright/test");
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const touchSheets = [
  "../../../packages/tokens/src/design/tokens.css",
  "../../../packages/ui/src/base/base.css",
  "../../../packages/ui/src/base/Primitives/seg.css",
  "../../../packages/ui/src/mail/Settings/setting-filter.css",
].map(read).join("\n");

/** The declarations each selector gets inside the `@media` blocks whose prelude matches. */
function inMedia(text: string, prelude: RegExp): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const m of text.matchAll(/@media([^{]*)\{/g)) {
    if (!prelude.test(m[1]!.trim())) continue;
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (let i = end; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}" && --depth === 0) { end = i; break; }
    }
    const body = text.slice(m.index! + m[0].length, end);
    for (const r of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls: Record<string, string> = {};
      for (const d of r[2]!.split(";")) {
        const kv = d.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
        if (kv) decls[kv[1]!] = kv[2]!;
      }
      for (const sel of r[1]!.split(",").map((s) => s.trim())) out.set(sel, { ...out.get(sel), ...decls });
    }
  }
  return out;
}

describe("the block reader reads a planted stylesheet (positive control)", () => {
  it("finds a declaration inside a matching block and nothing inside another", () => {
    const planted = "@media (max-height: 480px){.a{height:1px}}@media (min-width: 1px){.b{height:2px}}";
    expect(inMedia(planted, /max-height:\s*480px/).get(".a")).toEqual({ height: "1px" });
    expect(inMedia(planted, /max-height:\s*480px/).has(".b")).toBe(false);
  });
});

describe("under a coarse pointer each control reaches 44px (R19-03)", () => {
  it("the Rules filter chips: 44 wide, a 44px strip, and a row gap the strips cannot cross", async () => {
    const facets = [
      { folder: "INBOX", name: "Ohbox" },
      { folder: "News", name: "News" },
      { folder: "Receipts", name: "Receipts" },
    ];
    const { rest } = rulesStates({
      rules: [], intro: "Mail rules", introHeld: "", facets, waiting: [], refusal: { lead: "", why: null }, locked: "",
    });
    const markup = renderToStaticMarkup(h(TextProvider, {
      locale: "en", messages: messages as Messages, timeZone: "UTC", children: h(RulesPane, { model: rest.model }),
    }));
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      await page.setContent(`<!doctype html><html data-touch="1" data-device="phone"><head>
        <meta name="viewport" content="width=device-width,initial-scale=1"><style>${touchSheets}</style>
        </head><body>${markup}</body></html>`);
      const group = page.getByRole("group", { name: messages.rules.facetLabel });
      const buttons = group.getByRole("button");
      expect(await buttons.allTextContents()).toEqual([messages.rules.facetAll, ...facets.map(({ name }) => name)]);
      const measured = await buttons.evaluateAll((controls) => controls.map((control) => {
        const { left, right, top, bottom, width, height } = control.getBoundingClientRect();
        const x = (left + right) / 2;
        const hits = [top + 1, bottom - 1].every((y) => control.contains(document.elementFromPoint(x, y)));
        return { left, right, top, bottom, width, height, hits };
      }));
      for (const [i, chip] of measured.entries()) {
        expect(chip.width).toBeGreaterThanOrEqual(44);
        expect(chip.height).toBeGreaterThanOrEqual(44);
        expect(chip.hits).toBe(true);
        for (const next of measured.slice(i + 1)) {
          const overlaps = chip.left < next.right && chip.right > next.left
            && chip.top < next.bottom && chip.bottom > next.top;
          expect(overlaps).toBe(false);
        }
      }
    } finally {
      await browser.close();
    }
  });
});

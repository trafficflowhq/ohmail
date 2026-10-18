import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

/**
 * THE SIGN-IN CARD IS CENTRED, AT ANY WIDTH, IN EVERY LOOK. Reported from a 2000 px window: the card
 * stood far right of centre, the left half of the page empty. `.login` centres it (a full-width flex
 * column, `align-items: center`), and the same build measured centred to the pixel at 2000 and 390 px,
 * so the report reads as a browser side panel narrowing the page, not the stylesheet. This keeps it
 * so: the real `LoginScreen` markup under the shipped cascade, in headless Chromium, at 2000×1100 and
 * at 390×844, under both layouts, both faces and the web door's text sizes (`zoom` on <html>).
 * The RED CONTROL pushes the card aside and the same measurement reads it.
 */

process.env.NEXT_PUBLIC_API_BASE = "/api";
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, push() {} }) }));

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

/** The cascade the sign-in page renders under, in the order the product document loads it. */
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
  "packages/ui/src/base.css",
  "packages/ui/src/primitives/button.css",
  "packages/ui/src/primitives/text-field.css",
  "apps/webapp/app/app.css",
  "apps/webapp/app/zero-layout.css",
].map(css).join("\n");

let card = "";
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

beforeAll(async () => {
  const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
  card = renderToStaticMarkup(React.createElement(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", children: React.createElement(LoginScreen, {}),
  }));
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

interface Look { layout: "classic" | "zero"; face: "paper" | "ohmarchy"; size: 100 | 125 | 150 }

/** The card's box in the viewport, laid out at `width`×`height` under `look`, `extra` CSS last. */
async function measure(width: number, height: number, look: Look, extra = "") {
  const zoom = look.size === 100 ? "" : ` style="zoom:${look.size / 100};--ui-zoom:${look.size / 100}"`;
  const attrs = `${look.layout === "zero" ? ' data-layout="zero"' : ""}${look.face === "ohmarchy" ? ' data-face="ohmarchy"' : ""}${zoom}`;
  const page = await browser!.newPage({ viewport: { width, height } });
  try {
    await page.setContent(`<!doctype html><html${attrs}><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${SHEETS}${extra}</style><style>*{animation:none!important}</style></head>
      <body class="mo-canvas app-body">${card}</body></html>`);
    return (await page.locator(".login-card").boundingBox())!;
  } finally {
    await page.close();
  }
}

const LOOKS: Look[] = (["classic", "zero"] as const).flatMap((layout) =>
  (["paper", "ohmarchy"] as const).flatMap((face) => ([100, 125, 150] as const).map((size) => ({ layout, face, size }))));

describe("the sign-in card is centred", () => {
  it("the markup measured is the sign-in card", () => {
    expect(card).toContain('class="login-card"');
    expect(card).toContain("<em>oh</em>mail");
  });

  for (const [width, height] of [[2000, 1100], [390, 844]] as const) {
    it(`${width}×${height}: centred within 8 px and inside the window, in every look`, async () => {
      for (const look of LOOKS) {
        const box = await measure(width, height, look);
        const where = `${look.layout}/${look.face}/${look.size}%: ${JSON.stringify(box)}`;
        expect(Math.abs(box.x + box.width / 2 - width / 2), `off centre at ${where}`).toBeLessThanOrEqual(8);
        expect(box.x, `past the left edge at ${where}`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `past the right edge at ${where}`).toBeLessThanOrEqual(width);
      }
    }, 60_000);
  }

  it("RED CONTROL: a card pushed to the end of its row reads as off centre", async () => {
    const box = await measure(2000, 1100, { layout: "classic", face: "paper", size: 100 }, ".login{align-items:flex-end}");
    expect(Math.abs(box.x + box.width / 2 - 1000)).toBeGreaterThan(8);
  });
});

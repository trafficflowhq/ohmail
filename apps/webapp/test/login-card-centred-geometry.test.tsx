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
 * The door cards on the same `.gate` box are held the same way, inside the body the product layout
 * renders (`Providers`: its boot scripts and the toast regions beside the page): the resume splash
 * while it says "Checking your sign-in…" (reported off centre, low right, on Omarchy Chrome; the
 * production build measured centred there too, in Chrome 151 at every size, scale and text size),
 * the paid return and the erased-account wall. Each stands alone in its column: centred on both axes.
 */

process.env.NEXT_PUBLIC_API_BASE = "/api";
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, push() {} }) }));
// Past the grace: the splash renders the waiting sentence the report showed.
vi.mock("../app/shell/loading-grace.js", () => ({ useLoadingGrace: (active: boolean) => active }));

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
  "packages/ui/src/primitives/toast.css",
  "packages/ui/src/primitives/spinner.css",
  "apps/webapp/app/app.css",
  "apps/webapp/app/zero-layout.css",
].map(css).join("\n");

let card = "";
/** Each door card's whole body, as the product layout renders it. */
const doors: Record<string, string> = {};
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

const inLayout = (el: React.ReactElement, Providers: React.ComponentType<{ children: React.ReactNode }>): string =>
  renderToStaticMarkup(React.createElement(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", children: React.createElement(Providers, null, el),
  }));

beforeAll(async () => {
  const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
  card = renderToStaticMarkup(React.createElement(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", children: React.createElement(LoginScreen, {}),
  }));
  const { Providers } = await import("../app/(product)/providers.js");
  const { ResumeScreen } = await import("../app/(product)/resume/ResumeScreen.js");
  const { SubscribedScreen } = await import("../app/(product)/subscribed/SubscribedScreen.js");
  const { ErasedWall } = await import("../app/(product)/mailbox/ErasedWall.js");
  doors.resume = inLayout(React.createElement(ResumeScreen, { initialOwner: "acct_A" }), Providers);
  doors.subscribed = inLayout(React.createElement(SubscribedScreen), Providers);
  doors.erased = inLayout(React.createElement(ErasedWall, { blocked: false }), Providers);
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

interface Look { layout: "classic" | "zero"; face: "paper" | "ohmarchy"; size: 100 | 125 | 150 }

/** The card's box in the viewport, laid out at `width`×`height` under `look`, `extra` CSS last. */
async function measure(width: number, height: number, look: Look, extra = "", body = card, selector = ".login-card") {
  const zoom = look.size === 100 ? "" : ` style="zoom:${look.size / 100};--ui-zoom:${look.size / 100}"`;
  const attrs = `${look.layout === "zero" ? ' data-layout="zero"' : ""}${look.face === "ohmarchy" ? ' data-face="ohmarchy"' : ""}${zoom}`;
  const page = await browser!.newPage({ viewport: { width, height } });
  try {
    await page.setContent(`<!doctype html><html${attrs}><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${SHEETS}${extra}</style><style>*{animation:none!important}</style></head>
      <body class="mo-canvas app-body">${body}</body></html>`);
    return (await page.locator(selector).boundingBox())!;
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

describe("the door cards on the gate box are centred on both axes", () => {
  it("the markup measured is each door's card, the splash saying what it waits for", () => {
    expect(doors.resume).toContain(messages.resume.workingBody);
    expect(doors.subscribed).toContain(messages.subscribed.continuing);
    expect(doors.erased).toContain(messages.accessLock.erasedTitle);
    for (const body of Object.values(doors)) expect(body).toContain('class="toast-slot"');
  });

  for (const [width, height] of [[2000, 1100], [1280, 720], [390, 844]] as const) {
    it(`${width}×${height}: each door card centred within 8 px, in every look`, async () => {
      for (const [name, body] of Object.entries(doors)) {
        for (const look of LOOKS) {
          const box = await measure(width, height, look, "", body, ".gate-card");
          const where = `${name} ${look.layout}/${look.face}/${look.size}%: ${JSON.stringify(box)}`;
          expect(Math.abs(box.x + box.width / 2 - width / 2), `off centre at ${where}`).toBeLessThanOrEqual(8);
          expect(Math.abs(box.y + box.height / 2 - height / 2), `high or low at ${where}`).toBeLessThanOrEqual(8);
        }
      }
    }, 120_000);
  }

  it("RED CONTROL: a splash card pushed low and right reads as off centre on both axes", async () => {
    const box = await measure(2000, 1100, { layout: "classic", face: "ohmarchy", size: 100 },
      ".gate{align-items:flex-end;justify-content:flex-end}", doors.resume, ".gate-card");
    expect(Math.abs(box.x + box.width / 2 - 1000)).toBeGreaterThan(8);
    expect(Math.abs(box.y + box.height / 2 - 550)).toBeGreaterThan(8);
  });
});

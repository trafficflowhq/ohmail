/** @vitest-environment jsdom */
/** The frame keeps its token values when the host also loads the original document styles. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListHead } from "@ohmail/ui/mail";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen, within } from "@testing-library/react";
import type { EngineMessage } from "@ohmail/wire";
import { chromium, pageOf } from "../../../../packages/app/test/support/browser-page.js";
import { message, mountMailFrame, unmountAll } from "../_registered-mail-frame.js";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

/* The new design first, today's after it: the order in which a page that loads both is most likely to hurt the frame. */
const NEW = ["packages/tokens/src/design/tokens.css", "packages/ui/src/base/base.css", "packages/app/src/frame/seam.generated.css"];
const TODAY = [
  "packages/tokens/src/tokens.css", "packages/tokens/src/faces.css", "packages/tokens/src/ohmarchy.css",
];
const LOOKS = [
  { face: "paper", theme: "light" }, { face: "paper", theme: "dark" },
  { face: "ohmarchy", theme: "light" }, { face: "ohmarchy", theme: "dark" },
] as const;

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

describe("the seam between today's views and the frame", () => {
  for (const look of LOOKS) {
    it(`${look.face}, ${look.theme}: --float is a colour inside .today and a shadow inside .oh-root`, async () => {
      const page = await browser!.newPage();
      const documentFor = (sheets: readonly string[], body: string) =>
        `<!doctype html><html data-face="${look.face}" data-theme="${look.theme}" data-scheme="${look.theme}"><head><style>${sheets.map(css).join("\n")}</style></head><body class="today">${body}</body></html>`;
      const value = () => page.locator("#sample").evaluate((el) => getComputedStyle(el).getPropertyValue("--float").trim());
      await page.setContent(documentFor(TODAY, '<i id="sample"></i>'));
      const views = await value();
      const frameMarkup = '<div class="oh-root"><i id="sample"></i></div>';
      await page.setContent(documentFor(NEW, frameMarkup));
      const expectedFrame = await value();
      await page.setContent(documentFor([...NEW, ...TODAY], frameMarkup));
      const frame = await value();
      expect(frame).toBe(expectedFrame);
      await page.close();
      // A shadow has an offset and a blur; a colour is one value.
      expect(frame, "the frame's --float is not a shadow").toMatch(/px/);
      expect(views, "today's --float is not a colour").not.toMatch(/px/);
      expect(views.length).toBeGreaterThan(0);
    });
  }
});

/** The list header the mail place renders stays visible on the phone, fold and desktop. */
describe("a view's own heading inside the frame", () => {
  const sheets = [...NEW, ...TODAY, "packages/ui/src/mail/Lists/list-head.css", "apps/webapp/app/app.css"];
  const header = renderToStaticMarkup(createElement(ListHead, { title: "Trash" }));
  for (const [width, height] of [[390, 844], [719, 781], [1440, 900]] as const) {
    it(`stands on screen at ${width} by ${height}`, async () => {
      const page = await browser!.newPage({ viewport: { width, height } });
      await page.setContent(`<!doctype html><html><head><style>${sheets.map(css).join("\n")}</style></head>
        <body class="mo-canvas app-body today"><div class="oh-root"><div class="fr-columns"><section class="fr-list">
        ${header}</section></div></div></body></html>`);
      const visible = await page.getByRole("heading", { name: "Trash" }).isVisible();
      await page.close();
      expect(visible, "no name of the place on screen").toBe(true);
    });
  }
});

function letters(prefix: string, count: number, fields: Partial<EngineMessage> = {}) {
  return Array.from({ length: count }, (_, i) => message(`${prefix}-${i}`, fields));
}

function pile(prefix: string, count: number, state: "reply_later" | "set_aside" | "bubbled_up") {
  const at = "2026-11-10T09:00:00.000Z";
  return letters(prefix, count, { unread: false }).map((letter) => ({
    ...letter,
    triage: {
      messageId: letter.id, state, setAt: at, updatedAt: at,
      bubbleUpAt: state === "bubbled_up" ? "2099-01-01T09:00:00.000Z" : null,
    },
  }));
}

it("shows mailbox counts after a pointer click and reveals the number keys on keyboard focus", async () => {
  onTestFinished(unmountAll);
  localStorage.clear();
  sessionStorage.clear();
  const waiting = letters("waiting", 8, { folder: "ohmail/Screener" }).map((letter, i) => ({
    ...letter,
    from: { name: "Waiting sender", address: `waiting-${i % 4}@example.test` },
  }));
  await mountMailFrame("#/ohbox", [
    ...letters("inbox", 9),
    message("read-inbox", { unread: false }),
    ...letters("news", 12, { folder: "ohmail/News" }),
    message("read-news", { folder: "ohmail/News", unread: false }),
    ...letters("receipt", 300, { folder: "ohmail/Receipts" }),
    ...waiting,
    ...pile("later", 8, "reply_later"),
    ...pile("resurface", 10, "bubbled_up"),
  ]);
  const counts = {
    Ohbox: "9",
    News: "12",
    Receipts: "300",
    Screener: "4",
    "Answer Later": "8",
    Parked: "",
    Resurface: "10",
  };
  const rail = within(screen.getByRole("navigation", { name: "Places" }));
  for (const [name, count] of Object.entries(counts)) {
    await rail.findByRole("button", { name: count ? `${name} ${count}` : name });
  }

  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const root = [...document.documentElement.attributes]
      .filter(({ name }) => name !== "data-face" && name !== "data-theme")
      .map(({ name, value }) => `${name}="${value}"`).join(" ");
    await page.setContent(pageOf({ html: document.body.innerHTML, root }));
    const places = page.getByRole("navigation", { name: "Places" });
    const ohbox = places.getByRole("button", { name: "Ohbox 9", exact: true });
    await ohbox.click();
    const line = async (name: string, count: string) => {
      const text = await places.getByRole("button", {
        name: count ? `${name} ${count}` : name,
        exact: true,
      }).innerText();
      return text.trim().split(/\s+/).join(" ");
    };
    const visible = async () => Promise.all(Object.entries(counts).map(([name, count]) => line(name, count)));
    expect(await visible()).toEqual(["Ohbox 9", "News 12", "Receipts 300", "Screener 4", "Answer Later 8", "Parked", "Resurface 10"]);

    await page.keyboard.press("Tab");
    expect(await visible()).toEqual(["Ohbox 1 9", "News 2 12", "Receipts 3 300", "Screener 4 4", "Answer Later 5 8", "Parked 6", "Resurface 7 10"]);
  } finally {
    await page.close();
  }
});

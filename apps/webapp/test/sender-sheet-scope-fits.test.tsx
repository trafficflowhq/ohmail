import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryMirrorStore, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SenderMenu } from "../app/shell/SenderMenu";
import { senderScreening } from "@ohmail/app-logic/press/sender-screening";

/**
 * THE SCOPE CARD FITS THE SHEET. A long domain ("Everyone at <domain>") was one unbreakable word:
 * the card grew past the sheet, the sheet scrolled sideways and the name was cut, at 390 and at
 * 1440 px. Measured in Chromium on the rendered sheet under its own stylesheet.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/ui/src/base.css",
  "apps/webapp/app/app.css",
  "apps/webapp/app/shell/sender-sheet.css",
].map(css).join("\n");

const DOMAIN = "verwaltung-und-buchhaltung.kantonsspital-graubuenden-und-engadin.example";

const msg = (id: string, from: string): EngineMessage => ({
  id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Subject ${id}`,
  from: { name: null, address: from }, to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: "ohmail/News",
  snippet: "s", unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
} as unknown as EngineMessage);

let sheet = "";
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([msg("a", `no-reply@${DOMAIN}`), msg("b", `billing@${DOMAIN}`)].map((m, i): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: m.updatedAt, entity: m,
  })));
  sheet = renderToStaticMarkup(h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC",
    children: h(SenderMenu, {
      state: { messageId: "a", x: 0, y: 0 }, sender: senderScreening(store, "a")!,
      onChoose: () => {}, onOpenDetail: () => {}, onClose: () => {},
    }),
  } as never));
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

async function measure(width: number, extra = ""): Promise<{ sideways: boolean; cut: boolean; text: string }> {
  const page = await browser!.newPage({ viewport: { width, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${SHEETS}${extra}</style>
      <style>*{animation:none!important}</style></head><body class="mo-canvas">${sheet}</body></html>`);
    return await page.evaluate(() => {
      const box = document.querySelector(".senderm") as HTMLElement;
      const card = [...document.querySelectorAll<HTMLElement>(".sm-scope button")].find((b) => b.textContent?.includes("Everyone at"))!;
      const b = box.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      return {
        sideways: box.scrollWidth > box.clientWidth + 0.5,
        cut: c.right > b.right + 0.5 || card.scrollWidth > card.clientWidth + 0.5,
        text: card.textContent ?? "",
      };
    });
  } finally {
    await page.close();
  }
}

describe("the Everyone-at card keeps a long domain inside the sheet", () => {
  for (const width of [390, 1440]) {
    it(`${width}px: no sideways scroll, the card inside the sheet, the whole domain in it`, async () => {
      const m = await measure(width);
      expect(m.text).toContain(`Everyone at ${DOMAIN}`);
      expect(m.sideways, "the sheet scrolls sideways").toBe(false);
      expect(m.cut, "the card runs past the sheet").toBe(false);
    });
  }

  it("red control: a card that may not wrap runs past the sheet, and the measurement says so", async () => {
    const m = await measure(390, ".sm-scope button{overflow-wrap:normal!important;word-break:normal!important}");
    expect(m.sideways || m.cut).toBe(true);
  });
});

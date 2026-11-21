import type { EngineMessage } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SenderMenu } from "../app/components/sender-menu/SenderMenu";
import { senderScreening } from "@ohmail/app-logic/press/sender-screening";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/design/tokens.css",
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


describe("the sender sheet covers the list beneath it", () => {
  for (const width of [390, 1440]) {
    it(`${width}px: the surface is opaque above a list row`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(`<!doctype html><html data-device="${width < 700 ? "phone" : "desktop"}"><head><style>${SHEETS}</style>
          <style>*{animation:none!important}.list-row{position:fixed;inset:0;background:repeating-linear-gradient(red 0 30px,blue 30px 60px)}</style>
          </head><body><div class="list-row">List row</div>${sheet}</body></html>`);
        const dialog = page.getByRole("dialog");
        const surface = await dialog.evaluate((box) => {
          const rect = box.getBoundingClientRect();
          const style = getComputedStyle(box);
          const top = document.elementFromPoint(rect.left + 5, rect.top + 5);
          return { background: style.backgroundColor, opacity: style.opacity, above: top === box || box.contains(top) };
        });
        if (process.env.SHEET_PROOF) await page.screenshot({ path: `${process.env.SHEET_PROOF}/${width}.png` });
        expect(surface.above).toBe(true);
        expect(surface.opacity).toBe("1");
        expect(surface.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(surface.background).not.toMatch(/rgba\([^)]*,\s*0(?:\.\d+)?\)$/);
      } finally { await page.close(); }
    });
  }
});

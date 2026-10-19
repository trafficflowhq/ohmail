import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ListPane } from "@ohmail/ui";
import type { FiledSince } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { setActiveCatalog } from "../app/shell/locale";
import { MarkAllRead } from "../app/components/MarkAllRead";
import { OhboxWhereLine } from "../app/shell/OhboxWhereLine";

/**
 * THE WHERE-LINE AT PHONE WIDTHS, MEASURED IN CHROMIUM: at 360 and 390 px, in English and German,
 * with all four piles counted, the line wraps inside the list column, nothing overflows, and the
 * header's title row ("N unread" and "Mark all read") stays on one line. The red control re-applies
 * a no-wrap line, which the same measurement must catch.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;

vi.mock("../app/shell/MailStateProvider", () => {
  const readAt = Date.now();
  return {
    useMailState: () => ({
      state: {
        key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null, asOf: null, address: null,
        minutes: null, slow: false, screenerCandidate: false, pending: 0, filing: null, continuesAtFolder: null,
        settled: true, owed: false,
      },
      mailboxes: [{
        id: "mb_1", address: "rig@example.invalid", status: "connected", errorCode: null, disabledReason: null,
        syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: new Date(readAt - 50 * 60_000).toISOString(),
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
      factsReadAt: () => readAt,
      refresh: () => {},
    }),
  };
});

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/ui/src/base.css",
  "packages/ui/src/composites/list-pane.css",
  "apps/webapp/app/components/mark-all-read.css",
  "apps/webapp/app/app.css",
].map(css).join("\n");

const FILED: FiledSince = {
  at: "2026-10-19T08:00:00.000Z",
  counts: [
    { pile: "reads", count: 1238 },
    { pile: "receipts", count: 304 },
    { pile: "screened", count: 712 },
    { pile: "spam", count: 95 },
  ],
};

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

function header(locale: "en" | "de"): string {
  setActiveCatalog(locale, locale === "en" ? null : (de as never));
  try {
    return renderToStaticMarkup(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, timeZone: "UTC",
      children: h(ListPane, {
        title: "Ohbox",
        meta: locale === "en" ? "12 unread" : "12 ungelesen",
        action: h(MarkAllRead, { unreadCount: 12, onMarkAllRead: () => {} }),
        header: h(OhboxWhereLine, { filed: FILED, demo: false }),
        children: h("div", { className: "rows" }),
      }),
    } as never));
  } finally {
    setActiveCatalog("en", null);
  }
}

interface Reading { lines: number; overflow: boolean; outside: boolean; titleRowOneLine: boolean; text: string }

async function measure(width: number, locale: "en" | "de", extra = ""): Promise<Reading> {
  const page = await browser!.newPage({ viewport: { width, height: 800 } });
  try {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${SHEETS}${extra}</style>
      <style>body{margin:0;font-family:var(--font-ui)}</style></head>
      <body class="mo-canvas"><div class="view view-ohbox" style="width:${width}px;display:block">${header(locale)}</div></body></html>`);
    return await page.evaluate(() => {
      const line = document.querySelector(".ohbox-where") as HTMLElement;
      const col = document.querySelector(".list-col") as HTMLElement;
      const lh = parseFloat(getComputedStyle(line).lineHeight) || parseFloat(getComputedStyle(line).fontSize) * 1.4;
      const r = line.getBoundingClientRect();
      const c = col.getBoundingClientRect();
      const row = [...document.querySelectorAll<HTMLElement>(".vhead > *")]
        .filter((e) => getComputedStyle(e).display !== "none");
      const tops = row.map((e) => e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2);
      const kids = [...line.querySelectorAll<HTMLElement>("a, time")];
      return {
        lines: Math.round(r.height / lh),
        overflow: line.scrollWidth > line.clientWidth + 0.5
          || document.documentElement.scrollWidth > document.documentElement.clientWidth,
        outside: r.right > c.right + 0.5 || kids.some((k) => k.getBoundingClientRect().right > c.right + 0.5),
        titleRowOneLine: Math.max(...tops) - Math.min(...tops) < 12,
        text: line.textContent ?? "",
      };
    });
  } finally {
    await page.close();
  }
}

describe("the where-line at phone widths", () => {
  for (const width of [360, 390]) {
    for (const locale of ["en", "de"] as const) {
      it(`${width}px, ${locale}: wraps, overflows nothing, keeps the title row on one line`, async () => {
        const m = await measure(width, locale);
        expect(m.text).toContain(locale === "en" ? "1,238 to News" : "1.238 in News");
        expect(m.lines, "four counts do not fit one line at a phone width").toBeGreaterThan(1);
        expect(m.overflow).toBe(false);
        expect(m.outside).toBe(false);
        expect(m.titleRowOneLine).toBe(true);
      });
    }
  }

  it("red control: a line that may not wrap overflows, and the measurement says so", async () => {
    const m = await measure(360, "de", ".ohbox-where{white-space:nowrap;overflow-wrap:normal;overflow:hidden}");
    expect(m.lines).toBe(1);
    expect(m.overflow).toBe(true);
  });
});

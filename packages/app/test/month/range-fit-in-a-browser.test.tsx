/** @vitest-environment jsdom */
/**
 * GERMAN AT TEXT SIZE 1.5, IN A REAL BROWSER: Month, Year, Agenda and Search are drawn here (jsdom has no cascade, so
 * only their markup is taken), then laid out in Chromium under every sheet the product page loads and their own, the
 * text size stamped on the root as Settings stamps it. Every word the views write themselves (a heading, a day's
 * number, a weekday, a count, a notice, a button) stands whole inside its part. An event's own title may end in its
 * ellipsis: that is the person's text, cut where its line ends.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgendaView } from "../../src/agenda/index.js";
import { SearchView } from "../../src/calsearch/index.js";
import { MonthView } from "../../src/month/index.js";
import { YearView } from "../../src/year/index.js";
import { chromium, pageOf, REPO } from "../support/browser-page.js";
import { actLog, FIRST_REACH, NO_EDGE, rangeInput, Words } from "../support/range-world.js";

const OWN = ["month/month.css", "year/year.css", "agenda/agenda.css", "calsearch/calsearch.css"]
  .map((f) => readFileSync(join(REPO, "packages/app/src", f), "utf8"))
  .join("\n");
/** The words a view writes itself. */
const WORDS = [
  ".oh-groupheading",
  ".oh-notice-say",
  ".oh-button",
  ".oh-mo-date",
  ".oh-mo-wd-name",
  ".oh-mo-more",
  ".oh-mini-wd",
  ".oh-mini-day",
  ".cal-yr-name",
  ".cal-sr-count",
  ".cal-sr-held",
  ".oh-empty-label",
  ".oh-erow-time",
  ".oh-weeknum",
].join(", ");

type Device = "phone" | "fold" | "desktop";
const ROOMS: readonly (readonly [Device, number, number])[] = [
  ["phone", 390, 844],
  ["fold", 719, 781],
  ["desktop", 1440, 900],
];

function markup(view: ReactNode): string {
  render(<Words lang="de">{view}</Words>);
  const html = document.body.innerHTML;
  act(() => cleanup());
  return html;
}

const views = (device: Device): [string, ReactNode][] => {
  const { acts } = actLog();
  const edge = { earlier: "2026-11-10", later: null, load: async () => true };
  const input = rangeInput({ device, weekNumbers: true });
  return [
    ["Month", <MonthView key="m" input={input} acts={acts} edge={edge} />],
    ["Year", <YearView key="y" input={input} acts={acts} edge={edge} />],
    [
      "Agenda",
      <AgendaView
        key="a"
        input={{ ...input, anchor: "2026-11-09" }}
        acts={acts}
        edge={edge}
        {...FIRST_REACH}
      />,
    ],
    [
      "Search",
      <SearchView
        key="s"
        input={input}
        acts={acts}
        query="tehc check"
        onQuery={() => undefined}
        held={{ from: "2026-05-10", to: "2027-05-09" }}
      />,
    ],
    [
      "Search, nothing",
      <SearchView key="n" input={input} acts={acts} query="marzipan" onQuery={() => undefined} held={null} />,
    ],
  ];
};

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

describe("German at text size 1.5", () => {
  for (const [device, width, height] of ROOMS) {
    it(`${device}, ${width} by ${height}: no word of the views' own stands cut or outside its part`, async () => {
      const page = await browser!.newPage({ viewport: { width, height } });
      const cut: string[] = [];
      for (const [name, view] of views(device)) {
        const html = `<div style="display:flex;flex-direction:column;height:100%;width:100%;background:var(--sheet)">${markup(view)}</div>`;
        await page.setContent(
          pageOf(
            { html, root: `lang="de" data-product="cal" style="zoom:1.5;--ui-zoom:1.5"` },
            `${OWN} html,body{overflow:hidden}`,
          ),
        );
        const found = await page.evaluate((sel) => {
          const out: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>(sel)) {
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") continue;
            const text = (el.textContent ?? "").trim();
            if (!text) continue;
            if (el.scrollWidth > el.clientWidth + 1)
              out.push(`${text} (${el.scrollWidth} > ${el.clientWidth})`);
            const part = el.parentElement!.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            if (
              box.width > 0 &&
              (box.right > part.right + 1.5 || box.left < part.left - 1.5) &&
              el.closest("[data-scroll], .oh-mo, .oh-mini, .cal-sr-top")
            )
              out.push(`${text} outside its part`);
          }
          return out;
        }, WORDS);
        cut.push(...found.map((f) => `${name}: ${f}`));
      }
      await page.close();
      expect(cut).toEqual([]);
    }, 60_000);
  }
});

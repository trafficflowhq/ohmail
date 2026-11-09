/**
 * THE JUDGE: a reader's frame document loaded as a page in a real engine at the frame's size (w × 600),
 * every request aborted and counted, the OS colour scheme emulated, and read as a person sees it: the
 * page colour painted, whether the letter is inverted, the words' contrast against the nearest painted
 * ground (the inversion applied), and how many conditional rules the sender's sheets still hold. The
 * letter as sent is read the same way, so a frame is held to the letter's own contrast at that width.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Browser, BrowserType, Page } from "@playwright/test";

export type JudgeEngine = "chromium" | "webkit";
export type OsScheme = "light" | "dark";

type Playwright = Record<JudgeEngine, BrowserType>;
const playwright = (): Playwright => createRequire(resolve(process.cwd(), "package.json"))("@playwright/test") as Playwright;

/** The engines this host runs: Chromium always, WebKit when its build is installed. */
export function judgeEngines(): JudgeEngine[] {
  const engines: JudgeEngine[] = ["chromium"];
  try {
    if (existsSync(playwright().webkit.executablePath())) engines.push("webkit");
  } catch {
    // No WebKit build on this host.
  }
  return engines;
}

export interface Judged {
  /** The page as painted (the body's background, else the root's, else white), before any inversion. */
  page: [number, number, number];
  inverted: boolean;
  /** The words against the nearest painted ground, as shown. */
  contrast: number;
  /** The words are laid out on screen (no `display:none` on them or around them). */
  visible: boolean;
  /** `@media`, `@supports` and `@container` rules in every sheet of the document. */
  conditional: number;
  requests: number;
}

/** Read in the page: everything it needs travels as the one argument. */
function measure(words: string): Omit<Judged, "requests"> | null {
  const doc = document;
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let at: Element | null = null;
  while (walk.nextNode()) {
    if (walk.currentNode.textContent!.includes(words)) {
      at = walk.currentNode.parentElement;
      break;
    }
  }
  if (at === null) return null;
  const ctx = doc.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const rgba = (c: string): number[] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  };
  const painted = (el: Element): number[] | null => {
    const s = getComputedStyle(el);
    const c = rgba(s.backgroundColor);
    if (c[3]! >= 128) return c;
    if (/gradient/.test(s.backgroundImage)) {
      const stop = /(?:rgba?|color)\([^)]*\)/.exec(s.backgroundImage)?.[0];
      if (stop) return rgba(stop);
    }
    return null;
  };
  const inverted = getComputedStyle(doc.body).filter.includes("invert");
  const lum = (c: number[]): number => {
    const [r, g, b] = c.slice(0, 3).map((x) => (inverted ? 255 - x : x) / 255).map((s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  let under: Element | null = at;
  while (under !== null && painted(under) === null) under = under.parentElement;
  const page = painted(doc.body) ?? painted(doc.documentElement) ?? [255, 255, 255, 255];
  const ground = under === null ? page : painted(under)!;
  const ink = rgba(getComputedStyle(at).color);
  const visible = at.getClientRects().length > 0 && getComputedStyle(at).visibility === "visible";
  const [x, y] = [lum(ink), lum(ground)];
  let conditional = 0;
  const count = (rules: CSSRuleList): void => {
    for (const r of [...rules]) {
      if (r instanceof CSSMediaRule || r instanceof CSSSupportsRule || (typeof CSSContainerRule !== "undefined" && r instanceof CSSContainerRule)) conditional++;
      const inner = (r as CSSRule & { cssRules?: CSSRuleList }).cssRules;
      if (inner) count(inner);
    }
  };
  for (const s of [...doc.styleSheets]) count(s.cssRules);
  return {
    page: [page[0]!, page[1]!, page[2]!],
    inverted,
    contrast: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05),
    visible,
    conditional,
  };
}

export class LetterJudge {
  private readonly pages = new Map<string, { page: Page; requests: number }>();
  private readonly raws = new Map<string, number>();

  private constructor(private readonly browser: Browser) {}

  static async open(engine: JudgeEngine): Promise<LetterJudge> {
    return new LetterJudge(await playwright()[engine].launch());
  }

  private async pageAt(width: number, scheme: OsScheme): Promise<{ page: Page; requests: number }> {
    const key = `${width}|${scheme}`;
    let held = this.pages.get(key);
    if (!held) {
      const page = await this.browser.newPage({ viewport: { width, height: 600 }, colorScheme: scheme });
      const slot = { page, requests: 0 };
      await page.route("**/*", async (route) => {
        slot.requests++;
        await route.abort();
      });
      this.pages.set(key, slot);
      held = slot;
    }
    return held;
  }

  /** A frame's document, judged as a page `width` wide on an OS in `scheme`. */
  async judge(doc: string, words: string, width: number, scheme: OsScheme): Promise<Judged> {
    const held = await this.pageAt(width, scheme);
    held.requests = 0;
    await held.page.setContent(doc, { waitUntil: "load" });
    const seen = await held.page.evaluate(measure, words);
    if (seen === null) throw new Error(`the frame does not draw "${words}"`);
    return { ...seen, requests: held.requests };
  }

  /** The letter as sent, on its own page: the contrast its words have at this width. */
  async raw(html: string, words: string, width: number, scheme: OsScheme): Promise<number> {
    const key = `${width}|${scheme}|${html}`;
    const known = this.raws.get(key);
    if (known !== undefined) return known;
    const held = await this.pageAt(width, scheme);
    await held.page.setContent(html, { waitUntil: "load" });
    const seen = await held.page.evaluate(measure, words);
    const contrast = seen === null ? 1 : seen.contrast;
    this.raws.set(key, contrast);
    return contrast;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

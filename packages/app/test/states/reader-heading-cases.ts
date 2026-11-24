import { expect, it } from "vitest";
import type { Browser, Locator } from "@playwright/test";

async function read(port: Locator, top: number) {
  return port.evaluate(async (el, top) => {
    el.scrollTop = top;
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    const head = el.querySelector<HTMLElement>(".oh-readinghead")!;
    const title = head.querySelector<HTMLElement>("h2")!;
    const names = head.querySelector<HTMLElement>(".oh-readinghead-names")!;
    const compact = head.querySelector<HTMLElement>(".oh-readinghead-short")!;
    const first = el.querySelector("[data-conv-id] [data-read-body]")!;
    const box = el.getBoundingClientRect();
    const rect = head.getBoundingClientRect();
    const style = getComputedStyle(title);
    return {
      top: el.scrollTop,
      height: rect.bottom - box.top,
      edgeOpacity: Number(getComputedStyle(head, "::after").opacity),
      widthGaps: [rect.left - box.left, box.left + el.clientWidth - rect.right],
      letterTop: first.getBoundingClientRect().top - box.top + el.scrollTop,
      targetHeight: Math.round(
        (parseFloat(style.getPropertyValue("--t-ui")) * title.offsetHeight) / parseFloat(style.fontSize) +
          2 * parseFloat(style.getPropertyValue("--s2")),
      ),
      travel: parseFloat(head.style.getPropertyValue("--oh-head-travel")),
      face: document.documentElement.dataset.face,
      family: style.fontFamily,
      weight: style.fontWeight,
      scale: new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform).a,
      names: Number(getComputedStyle(names).opacity),
      titleOpacity: Number(style.opacity),
      compactOpacity: Number(getComputedStyle(compact).opacity),
      compactTransition: getComputedStyle(compact).transitionProperty,
      compactDuration: getComputedStyle(compact).transitionDuration,
    };
  }, top);
}

export function readerHeadingCases(
  open: () => { browser: Browser; html: string; baseCss: string },
  origin: string,
) {
  it.each([
    { width: 1440, height: 900, device: "desktop", face: "paper", scheme: "light" },
    { width: 390, height: 844, device: "phone", face: "paper", scheme: "dark" },
    { width: 720, height: 540, device: "fold", face: "ohmarchy", scheme: "light" },
  ])(
    "morphs and reverses the heading as a thread scrolls on $device",
    async ({ width, height, device, face, scheme }) => {
      const { browser, html } = open();
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.route(`${origin}/**`, (route) =>
          route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
        );
        await page.goto(
          `${origin}/?open=rd-a&read=1&screen=reading&motion=full&device=${device}&face=${face}&scheme=${scheme}`,
        );
        const port = page.locator("[data-reading-scroll]");
        await page.getByRole("button", { name: /^Message 1 of 3/ }).click();
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const start = await read(port, 0);
        const end = await read(port, 315);
        expect(end.height).toBeLessThan(start.height - 8);
        expect(end.height).toBeGreaterThan(20);
        if (device !== "fold") {
          expect(Math.abs(end.height - end.targetHeight), JSON.stringify({ start, end })).toBeLessThanOrEqual(
            2,
          );
        }
        const halfway = (start.height - end.height) / 2;
        const middle = await read(port, halfway);
        expect(middle.height).toBeCloseTo(start.height - middle.top, 0);
        expect(middle.family).toBe(start.family);
        expect(end.family).toBe(start.family);
        expect(middle.weight).toBe(start.weight);
        expect(end.weight).toBe(start.weight);
        expect(start.scale).toBe(1);
        expect(middle.scale).toBeLessThan(start.scale);
        expect(middle.scale).toBeGreaterThan(end.scale);
        expect(start.names).toBe(1);
        expect(middle.names).toBeLessThan(start.names);
        expect(end.names).toBe(0);
        if (face === "paper") {
          expect(start.edgeOpacity).toBe(0);
          expect(end.edgeOpacity).toBe(1);
        }
        for (const sample of [start, middle, end]) {
          expect(Math.abs(sample.letterTop - start.letterTop)).toBeLessThanOrEqual(1);
          for (const gap of sample.widthGaps) expect(Math.abs(gap)).toBeLessThanOrEqual(1);
        }
        expect(await read(port, 0)).toEqual(start);
        expect(await read(port, halfway)).toEqual(middle);
      } finally {
        await page.close();
      }
    },
    30_000,
  );

  it("crossfades the expanded and compact subjects when motion is reduced", async () => {
    const { browser, html, baseCss } = open();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.route(`${origin}/**`, (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: html.replace("</head>", `<style>${baseCss}</style></head>`),
        }),
      );
      await page.goto(`${origin}/?open=rd-a&read=1&screen=reading`);
      const port = page.locator("[data-reading-scroll]");
      await page.getByRole("button", { name: /^Message 1 of 3/ }).click();
      await expect.poll(async () => (await read(port, 0)).titleOpacity).toBe(1);
      const start = await read(port, 0);
      expect(start.compactOpacity).toBe(0);
      await expect.poll(async () => (await read(port, 315)).compactOpacity).toBe(1);
      const end = await read(port, 315);
      expect(end.titleOpacity).toBe(0);
      expect(end.compactTransition).toBe("opacity");
      expect(end.compactDuration).toBe("0.15s");
      expect(end.scale).toBe(start.scale);
      await expect.poll(async () => (await read(port, 0)).titleOpacity).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  it.each([
    { width: 1440, height: 900, device: "desktop" },
    { width: 390, height: 844, device: "phone" },
    { width: 1100, height: 900, device: "foldl" },
  ])(
    "fades only the clipped end of a long names line on $device",
    async ({ width, height, device }) => {
      const { browser, html } = open();
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.route(`${origin}/**`, (route) =>
          route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
        );
        await page.goto(`${origin}/?open=rd-a&read=1&screen=reading&device=${device}`);
        const names = page.locator(".oh-readinghead-names");
        const style = () =>
          names.evaluate((el) => {
            const css = getComputedStyle(el);
            return {
              clipped: el.scrollWidth > el.clientWidth,
              mask: css.maskImage,
              overflow: css.textOverflow,
              whiteSpace: css.whiteSpace,
            };
          });
        if (device === "foldl") {
          const byline = names.locator("..");
          expect(await byline.evaluate((el) => getComputedStyle(el).flexWrap)).toBe("nowrap");
          await names.evaluate((el) => {
            el.textContent = "Avery";
          });
        }
        await expect.poll(async () => (await style()).mask).toBe("none");
        await names.evaluate((el) => {
          el.textContent += ", Avery, Deniz, Morgan, Quinn".repeat(16);
        });
        await expect.poll(async () => (await style()).mask).toContain("linear-gradient");
        expect(await style()).toMatchObject({ clipped: true, overflow: "clip", whiteSpace: "nowrap" });
      } finally {
        await page.close();
      }
    },
    30_000,
  );
}

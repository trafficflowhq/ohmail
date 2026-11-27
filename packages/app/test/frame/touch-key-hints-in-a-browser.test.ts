/**
 * A KEY NOBODY CAN PRESS IS NOT DRAWN (the switch's point 65, by RULING-JOIN J-1: today's shell loaded the rule with its key
 * registry). The frame stands its own registry, so the frame's own bundle carries the coarse-pointer sheet: on a phone or
 * a tablet the keycap on a control, a hint that is only keys and the palette's key column are not drawn; with a mouse
 * they are. The frame's entry is bundled as a product page bundles it, and its sheets laid out in Chromium.
 */
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, REPO } from "../support/browser-page.js";

type Browser = Awaited<ReturnType<typeof chromium.launch>>;
let browser: Browser | null = null;
let sheets = "";
beforeAll(async () => {
  /* The frame's own sheets, as a bundler collects them from its entry: the packages it names stay outside. */
  const out = await build({
    absWorkingDir: REPO,
    entryPoints: ["packages/app/src/frame/Frame.tsx"],
    bundle: true,
    write: false,
    outdir: "out",
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    logLevel: "silent",
    external: ["react", "react-dom", "react/*", "@ohmail/*"],
  });
  sheets = out.outputFiles
    .filter((f) => f.path.endsWith(".css"))
    .map((f) => f.text)
    .join("\n");
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

const PAGE = `<button>Write <kbd>c</kbd></button><div class="fr-foot"><span class="esc"><kbd>esc</kbd></span></div>`;

async function shown(touch: boolean): Promise<{ cap: string; esc: string }> {
  const context = await browser!.newContext({
    hasTouch: touch,
    isMobile: touch,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html><head><style>${sheets}</style></head><body>${PAGE}</body></html>`,
  );
  const seen = await page.evaluate(() => ({
    cap: getComputedStyle(document.querySelector("button kbd")!).display,
    esc: getComputedStyle(document.querySelector(".fr-foot .esc")!).display,
  }));
  await context.close();
  return seen;
}

describe("the frame's key hints on a device with no keys", () => {
  it("on a touch screen a control's keycap and a hint that is only keys are not drawn", async () => {
    expect(await shown(true)).toEqual({ cap: "none", esc: "none" });
  });

  it("with a mouse they are", async () => {
    const seen = await shown(false);
    expect(seen.cap).not.toBe("none");
    expect(seen.esc).not.toBe("none");
  });
});

it("keeps a keyboard tooltip narrower than the viewport at large text size", async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.setContent(
      `<!doctype html><html style="zoom:1.5;--ui-zoom:1.5"><head><style>${sheets}</style></head>
      <body><span class="fr-shortcut-chip fr-shortcut-tooltip">An available keyboard shortcut</span></body></html>`,
    );
    const maxWidth = await page
      .locator(".fr-shortcut-tooltip")
      .evaluate((tooltip) => Number.parseFloat(getComputedStyle(tooltip).maxWidth));
    expect(maxWidth).toBe(236);
  } finally {
    await page.close();
  }
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "@playwright/test";

/**
 * THE FONT A GEOMETRY ARM WAS MEASURED IN.
 *
 * Paper's UI face is `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`
 * (`packages/tokens/src/faces.css`). On Linux that is Inter where Inter is installed and whatever
 * `sans-serif` resolves to where it is not, and a handful of arms sit within a pixel or two of a
 * threshold that only Inter's advance widths meet. Those arms ask for the font by name: where this
 * machine renders paper's text in another face they are skipped, saying which face it was, and
 * everywhere else they measure. CI installs Inter (`fonts-inter`), so they measure there.
 */
export const MEASURED_FONT = "Inter";

/** The family Chromium renders paper's UI text with on this machine, read through the DevTools protocol. */
export async function renderedUiFont(browser: Browser): Promise<string> {
  const faces = readFileSync(resolve(process.cwd(), "packages/tokens/src/faces.css"), "utf8");
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><head><style>${faces}</style></head>
      <body style="font-family:var(--font-ui)"><span id="probe">Sync now · sender@example.com 12:34</span></body></html>`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#probe" });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.slice().sort((a, b) => b.glyphCount - a.glyphCount)[0]?.familyName ?? "";
  } finally {
    await page.close();
  }
}

/** Skip the calling arm, by name and with the reason, unless paper's text renders in {@link MEASURED_FONT}. */
export function skipUnlessMeasuredFont(font: string, ctx: { skip: () => void; task: { name: string } }): void {
  if (font === MEASURED_FONT) return;
  console.info(`SKIPPED "${ctx.task.name}": measured in ${MEASURED_FONT}, and this machine renders paper's text in ${font || "an unknown face"}`);
  ctx.skip();
}

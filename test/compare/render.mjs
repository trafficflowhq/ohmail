/**
 * One way to render a state and take its picture and its scene, for the reference and the product alike.
 *
 * Everything that could make two machines draw the same page differently is pinned here and named in
 * `tolerance.json`: the browser's flags, the motion setting, the scale, the wait, the clock a script reads. A caller hands in how to
 * open the state (`open`) and what to draw it in (`variant`); nothing here has a default for either.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readScene } from "./scene.mjs";

/** @type {import("./render.d.mts").Tolerance} */
export const TOLERANCE = JSON.parse(readFileSync(fileURLToPath(new URL("./tolerance.json", import.meta.url)), "utf8"));


/**
 * Runs in the page before any of its own code: no animation and no transition takes time. A move that
 * is over the moment it starts cannot be caught half way, and cannot leave a stale frame behind. Asking
 * the browser to finish running animations at the moment of the picture does both, on a loaded machine.
 */
function holdStill() {
  const css = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}";
  const add = () => {
    const root = document.documentElement;
    if (!root || root.querySelector(":scope > style[data-compare-still]")) return;
    const style = document.createElement("style");
    style.setAttribute("data-compare-still", "");
    style.textContent = css;
    root.append(style);
  };
  add();
  new MutationObserver(add).observe(document, { childList: true });
}

/**
 * Runs in each document before its own code: once the head is read and its stylesheets are in, loads
 * every font face they declare, then says so. Until then the page's scripts are held back (`shoot`), so
 * code that measures text when it starts measures it in the page's own fonts, every time. Left to the
 * network, a font is sometimes there at that moment and sometimes not, and the layout differs.
 */
function fontsFirst() {
  const started = performance.now();
  const tick = () => {
    const waited = performance.now() - started;
    const links = [...document.querySelectorAll('link[rel~="stylesheet"]')];
    if (waited < 3000 && ((!document.body && waited < 300) || links.some((l) => !l.sheet))) { setTimeout(tick, 4); return; }
    Promise.all([...document.fonts].map((f) => f.load().catch(() => null))).then(() => window.__compareFontsIn(location.href));
  };
  tick();
}

/**
 * Runs in each document before its own code: a clock read twice in one run of script reads the same. How
 * long a piece of script took is the machine's speed and nothing of the page; a page that prints it (a
 * search that says "found in 11 ms") would draw differently on every run. From one task to the next the
 * clock runs on as it does, so timers and frames keep their time.
 */
function oneClockATurn() {
  const real = performance.now.bind(performance);
  /** @type {number | null} */
  let held = null;
  performance.now = () => {
    if (held === null) { held = real(); queueMicrotask(() => { held = null; }); }
    return held;
  };
}

/** How long a page's scripts wait for its fonts before the state is given up as lost. */
const FONTS_MS = 10_000;

/** A file of the page did not arrive; drawing the state again may succeed. */
export class RequestLost extends Error {}

/** @param {import("@playwright/test").BrowserType} chromium */
export function launch(chromium) {
  return chromium.launch({ args: TOLERANCE.chromiumArgs });
}

/** @param {import("./scene.d.mts").Variant} variant */
function assertVariant(variant) {
  for (const k of ["width", "height", "scale"]) {
    if (!Number.isFinite(variant?.[k]) || variant[k] <= 0) throw new Error(`render: the variant names no ${k}; a picture is never taken at a default size`);
  }
  if (variant.scheme !== "light" && variant.scheme !== "dark") throw new Error("render: the variant names no scheme");
}

/**
 * Opens a fresh window in `variant`, lets `open` draw the state, waits until the page stands still, and
 * returns the picture and the scene read with it. Still means: looked at twice, `settle.quietMs` apart,
 * the scene and every pixel are the same. A state often arrives a moment after its page loaded (a sheet
 * that opens on a timer, a selection that glides into place); a picture taken at the first quiet frame
 * shows the moment before, and a different one on the next run.
 *
 * @param {import("@playwright/test").Browser} browser
 * @param {import("./scene.d.mts").Variant} variant
 * @param {(page: import("@playwright/test").Page) => Promise<void>} open
 * @param {{ prepare?: (context: import("@playwright/test").BrowserContext) => Promise<unknown>, mayFail?: (url: string) => boolean }} [hooks]
 * @returns {Promise<{ png: Buffer, scene: import("./scene.d.mts").Scene }>}
 */
export async function shoot(browser, variant, open, hooks = {}) {
  assertVariant(variant);
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.scale,
    colorScheme: variant.scheme,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  try {
    if (hooks.prepare) await hooks.prepare(context);
    await context.addInitScript(holdStill);
    await context.addInitScript(oneClockATurn);
    /** @type {Map<string, { arrived: Promise<void>, say: () => void }>} */
    const fonts = new Map();
    const fontsOf = (/** @type {string} */ href) => {
      let f = fonts.get(href);
      if (!f) { let say = () => {}; const arrived = new Promise((done) => { say = () => done(undefined); }); fonts.set(href, f = { arrived, say }); }
      return f;
    };
    /** @type {string[]} */
    const late = [];
    await context.exposeBinding("__compareFontsIn", (_source, href) => { fontsOf(String(href)).say(); });
    await context.addInitScript(fontsFirst);
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.resourceType() !== "script") return route.fallback();
      const href = request.frame().url();
      let timer;
      const timedOut = await Promise.race([fontsOf(href).arrived.then(() => false), new Promise((done) => { timer = setTimeout(() => done(true), FONTS_MS); })]);
      clearTimeout(timer);
      if (timedOut) late.push(`${new URL(request.url()).pathname} (its page's fonts did not arrive)`);
      return route.fallback();
    });
    const page = await context.newPage();
    /* A page that lost one of its files still draws something. That is no picture of the state. */
    /** @type {string[]} */
    const lost = [];
    page.on("requestfailed", (r) => { if (!hooks.mayFail || !hooks.mayFail(r.url())) lost.push(`${new URL(r.url()).pathname} (${r.failure()?.errorText ?? "failed"})`); });
    const whole = () => { const gone = [...lost, ...late]; if (gone.length) throw new RequestLost(`render: the page lost ${gone.length} of its files: ${gone.slice(0, 3).join(", ")}`); };
    await open(page);
    whole();
    /* A page written into an open document (setContent) starts over; it is held still from here. */
    await page.evaluate(holdStill);
    const look = async () => {
      await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null))))));
      const scene = JSON.stringify(await page.evaluate(readScene, variant));
      return { scene, png: await page.screenshot({ animations: "allow", caret: "hide", scale: "device" }) };
    };
    const deadline = Date.now() + TOLERANCE.settle.withinMs;
    let before = await look();
    for (;;) {
      await page.waitForTimeout(TOLERANCE.settle.quietMs);
      const after = await look();
      whole();
      if (after.scene === before.scene && after.png.equals(before.png)) return { png: after.png, scene: JSON.parse(after.scene) };
      if (Date.now() > deadline) throw new Error("render: the page did not stand still");
      before = after;
    }
  } finally {
    await context.close();
  }
}

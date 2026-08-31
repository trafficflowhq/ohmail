/**
 * THE LANDING'S SCREENSHOT PIPELINE — automated captures of the live demo, per face.
 *
 * OHMARCHY-PLAN.md §5: the landing's imagery is per-face (and the demo per-theme), and
 * N themes × 2 faces × 2 schemes will never survive hand-shooting — so the captures are
 * MADE by this script, from the same `/demo` route the landing embeds, and regenerating
 * the whole set is one command. The paper-face originals (`pile-*.webp`, `mail-*.webp`)
 * predate the pipeline and are deliberately NOT overwritten by default — the shipped
 * paper landing keeps its exact pixels — but `--faces paper` re-shoots them when a
 * redesign wants the whole set from one source.
 *
 * Usage (from the repository root):
 *   pnpm -F @ohmail/webapp build && (pnpm -F @ohmail/webapp start &)
 *   node apps/webapp/scripts/landing-shots.mjs [baseUrl]     # default http://localhost:3000
 *   node apps/webapp/scripts/landing-shots.mjs --faces paper # also re-shoot the paper set
 *
 * What it shoots (into apps/webapp/public/landing/):
 *   hero-{paper,ohmarchy}[-dark].webp   the whole app at 1440×900×2 — the hero split's
 *                                       four layers (the SAME screen, both faces)
 *   pile-{ohbox,reads,receipts}-oh[-dark].webp  380×560 list-pane crops, ohmarchy face
 *                                       (the paper triptych keeps its original files)
 *   mail-light-oh.webp / mail-dark-oh.webp      reading-pane crops for the dark-mode
 *                                       diptych, ohmarchy face
 *
 * Mechanics worth naming:
 *   · The face/scheme are forced through the app's own storage contract (`ohmail.theme`,
 *     `ohmail.face` — OHMARCHY-CONTRACT.md) seeded before any script runs, so every
 *     capture goes through the real boot stamp, not a style override.
 *   · WebP encoding happens INSIDE the browser (canvas.toDataURL) — no native image
 *     dependency enters the repo for this.
 *   · Every capture asserts its target selector first; a demo whose anatomy moved fails
 *     loudly rather than shipping a crop of the wrong region.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const OUT = here("../public/landing");

const args = process.argv.slice(2);
const baseUrl = args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000";
const alsoPaperStills = args.includes("--faces") && args[args.indexOf("--faces") + 1] === "paper";

/** viewport of the hero captures — 16:10, the demo frame's own aspect */
const HERO = { width: 1440, height: 900 };
/** the triptych's crop, in CSS px (shipped files are 2× = 760×1120) */
const PILE = { width: 380, height: 560 };
/** the diptych's crops, in CSS px, matching the original captures' declared boxes */
const MAIL_LIGHT = { width: 572, height: 466 };
const MAIL_DARK = { width: 688, height: 560 };

const WEBP_QUALITY = 0.9;

/** PNG bytes → WebP bytes, encoded by the page's own canvas. */
async function toWebp(page, pngBuffer) {
  const b64 = pngBuffer.toString("base64");
  const dataUrl = await page.evaluate(
    async ([b64png, q]) => {
      // no fetch(), deliberately: the demo page's CSP refuses connect-src, and a Blob
      // decoded from bytes reaches createImageBitmap without any URL load at all
      const bytes = Uint8Array.from(atob(b64png), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      return canvas.toDataURL("image/webp", q);
    },
    [b64, WEBP_QUALITY],
  );
  if (!dataUrl.startsWith("data:image/webp")) {
    throw new Error("the browser refused webp encoding — capture aborted, nothing written");
  }
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function save(page, pngBuffer, file) {
  const webp = await toWebp(page, pngBuffer);
  writeFileSync(`${OUT}/${file}`, webp);
  console.log(`  ${file}  ${(webp.length / 1024).toFixed(0)} KB`);
}

/** A context whose storage already answers the boot scripts: explicit scheme, explicit
 *  face pin — detection never decides a capture. */
async function openDemo(browser, { face, scheme }) {
  const context = await browser.newContext({
    viewport: HERO,
    deviceScaleFactor: 2,
    reducedMotion: "reduce", // captures want the settled state, not a frame of travel
  });
  await context.addInitScript(
    ([f, s]) => {
      try {
        window.localStorage.setItem("ohmail.theme", s);
        window.localStorage.setItem("ohmail.face", f);
      } catch {
        /* a blocked jar would fall to detection — unacceptable for a capture, and the
           assertion on data-face below is what catches it */
      }
    },
    [face, scheme],
  );
  const page = await context.newPage();
  await page.goto(`${baseUrl}/demo`, { waitUntil: "networkidle" });
  // the shell is up when the rail and the split view's two columns exist
  await page.waitForSelector('.rail [data-rail-id="ohbox"]', { timeout: 30000 });
  await page.waitForSelector(".stage .view .list-col", { timeout: 30000 });
  await page.waitForSelector(".stage .view .read-col", { timeout: 30000 });
  // the capture must depict the face it claims to
  const stamped = await page.evaluate(() => document.documentElement.dataset.face ?? "");
  const wantFace = face === "ohmarchy" ? "ohmarchy" : "";
  if (stamped !== wantFace) {
    throw new Error(`face stamp mismatch: wanted "${wantFace}", document says "${stamped}"`);
  }
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
  if (theme !== scheme) {
    throw new Error(`scheme stamp mismatch: wanted "${scheme}", document says "${theme}"`);
  }
  await page.waitForTimeout(1200); // fonts, avatars, the last layout settle
  return { context, page };
}

/** clip helper: a region measured off a live element, in CSS px */
async function clipOf(page, selector, size) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`cannot measure ${selector}`);
  return { x: Math.ceil(box.x), y: Math.ceil(box.y), width: size.width, height: size.height };
}

/** open the FIRST message so the capture shows the app at work — rail, list, and a read
 *  message with its rationale/tracker chips (the same state the demo annotations point at) */
async function openFirstMessage(page) {
  await page
    .locator(".list-col .scroller li, .list-col .scroller [role='option'], .list-col .scroller article")
    .first()
    .click();
  await page.waitForSelector('.chip[data-chip="rationale"]', { timeout: 15000 });
  await page.waitForTimeout(700);
}

async function shootHero(browser, face, scheme, file) {
  const { context, page } = await openDemo(browser, { face, scheme });
  // the "invented mail" banner belongs to the demo PAGE; the hero split presents the app
  // itself, exactly as the established stills do — dismiss it before the full-window shot
  await page
    .getByRole("button", { name: /dismiss/i })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
  await page.waitForTimeout(400);
  await openFirstMessage(page);
  const png = await page.screenshot({ type: "png" });
  await save(page, png, file);
  await context.close();
}

async function shootPiles(browser, face, scheme, suffix) {
  const { context, page } = await openDemo(browser, { face, scheme });
  for (const pile of ["ohbox", "reads", "receipts"]) {
    await page.click(`.rail [data-rail-id="${pile}"]`);
    await page.waitForTimeout(900); // the list re-renders; reveal animations are reduced
    const clip = await clipOf(page, ".stage .view .list-col", PILE);
    const png = await page.screenshot({ type: "png", clip });
    await save(page, png, `pile-${pile}${suffix}.webp`);
  }
  await context.close();
}

async function shootMail(browser, face, scheme, size, file) {
  const { context, page } = await openDemo(browser, { face, scheme });
  await openFirstMessage(page);
  const clip = await clipOf(page, ".stage .view .read-col", size);
  const png = await page.screenshot({ type: "png", clip });
  await save(page, png, file);
  await context.close();
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  console.log(`shooting from ${baseUrl} …`);

  // the hero split's four layers — the same screen, both faces, both schemes
  await shootHero(browser, "paper", "light", "hero-paper.webp");
  await shootHero(browser, "paper", "dark", "hero-paper-dark.webp");
  await shootHero(browser, "ohmarchy", "light", "hero-ohmarchy.webp");
  await shootHero(browser, "ohmarchy", "dark", "hero-ohmarchy-dark.webp");

  // the ohmarchy face's screenshot set for the Views triptych and the dark-mode diptych
  await shootPiles(browser, "ohmarchy", "light", "-oh");
  await shootPiles(browser, "ohmarchy", "dark", "-oh-dark");
  await shootMail(browser, "ohmarchy", "light", MAIL_LIGHT, "mail-light-oh.webp");
  await shootMail(browser, "ohmarchy", "dark", MAIL_DARK, "mail-dark-oh.webp");

  // the paper originals, only on explicit request (they predate the pipeline)
  if (alsoPaperStills) {
    await shootPiles(browser, "paper", "light", "");
    await shootPiles(browser, "paper", "dark", "-dark");
    await shootMail(browser, "paper", "light", MAIL_LIGHT, "mail-light.webp");
    await shootMail(browser, "paper", "dark", MAIL_DARK, "mail-dark.webp");
  }
} finally {
  await browser.close();
}
console.log("done.");

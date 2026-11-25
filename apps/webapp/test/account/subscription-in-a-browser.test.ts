import { join } from "node:path";
import { chromium, type Browser, type Locator } from "@playwright/test";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { NEAR, OFFER, open } from "./storage-fixtures";
import en from "../../messages/en.json";
import de from "../../messages/de.json";
import subscriptionEn from "../../../../packages/app/messages/account-subscription.en.json";
import subscriptionDe from "../../../../packages/app/messages/account-subscription.de.json";
import aiEn from "../../../../packages/app/messages/settings-ai.en.json";
import aiDe from "../../../../packages/app/messages/settings-ai.de.json";

let browser: Browser;
let js: string;
let css: string;
beforeAll(async () => {
  const bundle = await build({
    entryPoints: [join(__dirname, "subscription-browser/entry.tsx")],
    bundle: true, format: "iife", jsx: "automatic", write: false, outdir: "out",
    alias: { "next-intl": join(__dirname, "../editor-feel/intl-shim.mjs") },
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
    banner: { js: "window.process = window.process || { env: {} }" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_API_BASE": '"/api"',
    },
    logLevel: "silent",
  });
  js = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => browser?.close());

const origin = "https://mail.browser.test";
const access = {
  ...open({
    ...NEAR,
    offer: {
      ...OFFER,
      current: null,
      setupBoostEligible: true,
      plans: OFFER.plans.map((plan, index) => ({ ...plan, setupSuggestions: (index + 1) * 137 })),
    },
  }),
  lifecycle: { state: "trialing", closedReason: null, trialEndsAt: new Date(Date.UTC(2026, 7, 17, 23, 30)).toISOString() },
  aiCredits: { remaining: 2_885, total: 4_000, setup: { remaining: 16_000, expiresAt: null } },
};

const words = {
  de: {
    ...de.settings, ...subscriptionDe.accountSubscription, ...aiDe.settingsAi,
    day: "18.08.2026", cadence: "/Monat", suggestions: "274 einmalige Vorschläge aus dem Verlauf",
    mailboxCount: "2 von 2", storageUsed: "3,2 GB von 4 GB", credits: "Noch 2.885 von 4.000", screening: "Noch 16.000",
  },
  en: {
    ...en.settings, ...subscriptionEn.accountSubscription, ...aiEn.settingsAi,
    day: "Aug 18, 2026", cadence: "/month", suggestions: "274 one-time history suggestions",
    mailboxCount: "2 of 2", storageUsed: "3.2 GB of 4 GB", credits: "2,885 of 4,000 left", screening: "16,000 left",
  },
};

async function expectWholeText(row: Locator, text: string) {
  const value = row.getByText(text, { exact: true });
  await value.waitFor();
  expect(await value.evaluate((node) => node.scrollWidth - node.clientWidth), text).toBeLessThanOrEqual(1);
}

const screens = [390, 1440].flatMap((width) =>
  (["de", "en"] as const).flatMap((lang) =>
    (["light", "dark"] as const).map((colorScheme) => ({ width, lang, colorScheme })),
  ),
);

it.each(screens)("fits Subscription in a $colorScheme $lang window at $width pixels", async ({ width, colorScheme, lang }) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390, colorScheme, timezoneId: "Europe/Zurich" });
  const t = words[lang];
  page.setDefaultTimeout(4_000);
  try {
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      switch (url.pathname) {
        case "/page.js": return route.fulfill({ contentType: "application/javascript", body: js });
        case "/page.css": return route.fulfill({ contentType: "text/css", body: css });
        case "/api/account/access": return route.fulfill({ json: access });
        default: return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/page.css"><body class="app-body oh-root"><div id="app"></div><script src="/page.js"></script>',
        });
      }
    });
    await page.goto(`${origin}/?lang=${lang}&theme=${colorScheme}`);
    await page.getByText(t.day, { exact: true }).waitFor();
    await page.waitForFunction((scheme) => document.documentElement.dataset.theme === scheme, colorScheme);
    const plus = page.getByRole("radio", { name: /^Plus/ });
    await plus.getByText(t.cadence, { exact: false }).waitFor();
    await plus.getByText(t.suggestions, { exact: false }).waitFor();
    expect(await plus.evaluate((row) => row.scrollWidth)).toBeLessThanOrEqual((await plus.boundingBox())!.width + 1);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const mailboxes = page.getByRole("group", { name: t.mailboxes, exact: true });
    await mailboxes.getByRole("button", { name: t.addMailbox, exact: true }).waitFor();
    await expectWholeText(mailboxes, t.mailboxCount);
    const storage = page.getByRole("group", { name: t.storage, exact: true }).filter({ hasText: t.storageUsed });
    await storage.getByRole("button", { name: t.openStorage, exact: true }).waitFor();
    await expectWholeText(storage, t.storageUsed);
    const addon = page.getByRole("group", { name: t.storage, exact: true }).filter({ hasText: t.storageAddStorage });
    await expectWholeText(addon, "10 GB");
    await expectWholeText(page.getByRole("group", { name: t.budget, exact: true }), t.credits);
    await expectWholeText(page.getByRole("group", { name: t.setupCredits, exact: true }), t.screening);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  } finally {
    await page.close();
  }
});

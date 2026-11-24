import type { Page } from "@playwright/test";
import { rangePage } from "./build-range.mjs";

/** The range views' states page at a registered key: the key is the page's own address. */
let html: Promise<string> | null = null;

export async function openRangePage(page: Page, key: string): Promise<void> {
  html ??= rangePage();
  const body = await html;
  await page.route("http://range.test/**", (r) => r.fulfill({ contentType: "text/html", body }));
  await page.goto(`http://range.test/?${key}`);
}

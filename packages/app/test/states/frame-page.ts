import type { Page } from "@playwright/test";
import { statesPage } from "./build-states.mjs";

/**
 * THE FRAME'S STATES PAGE, for the subjects that draw it: the frame over the fake host, bundled with its sheets and
 * read under today's views' sheets as the product page loads them (`build-states.mjs`). The page reads its state
 * from its own address in the reference's words, so a subject opens it at a key.
 */
let html: Promise<string> | null = null;

export async function openFramePage(page: Page, query: string): Promise<void> {
  html ??= statesPage();
  const body = await html;
  /* The document is served from a stand-in address on loopback's terms, so `location.search` carries the key. */
  await page.route("http://frame.test/**", (r) => r.fulfill({ contentType: "text/html", body }));
  await page.goto(`http://frame.test/?${query}`);
}

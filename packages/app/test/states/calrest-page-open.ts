import type { Page } from "@playwright/test";
import { statesPage } from "./build-states.mjs";

/**
 * THE CALENDAR'S REST, ITS STATES PAGE, for the subjects that draw it: `calrest-page.tsx` bundled as the frame's
 * states page is (`build-states.mjs`). The page reads its state from its own address in the reference's words.
 */
let html: Promise<string> | null = null;

export async function openCalRestPage(page: Page, key: string): Promise<void> {
  html ??= statesPage("packages/app/test/states/calrest-page.tsx");
  const body = await html;
  await page.route("http://calrest.test/**", (r) => r.fulfill({ contentType: "text/html", body }));
  await page.goto(`http://calrest.test/?${key}`);
}

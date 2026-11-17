import type { Page } from "@playwright/test";
import { drawnAt, stepsOf, type Lang } from "./phonedoor-states.js";

/**
 * THE PHONE'S WAYS IN'S STATES PAGE, for the subjects that open it in a browser: one state by address, served from a
 * stand-in address on loopback's terms so that `location.search` carries the key, and brought to its state by a
 * person's steps: a blank by its label, a press by its name. The page is bundled at the first open, so that a case
 * that only lists the subjects reaches no bundler.
 */
let html: Promise<string> | null = null;

export async function openPhoneDoorPage(page: Page, query: string): Promise<void> {
  html ??= import("./build-phonedoor.mjs").then(({ phoneDoorPage }) => phoneDoorPage());
  const body = await html;
  await page.route("http://phonedoor.test/**", (r) => r.fulfill({ contentType: "text/html", body }));
  await page.goto(`http://phonedoor.test/?${query}`);
  const words = new URLSearchParams(query);
  const drawn = drawnAt(words);
  if (drawn === null) throw new Error(`the ways in's page draws no state at ${query}`);
  const lang: Lang = words.get("lang") === "de" ? "de" : "en";
  for (const step of stepsOf(drawn, lang)) {
    if ("into" in step) await page.getByLabel(step.into, { exact: true }).fill(step.type);
    else await page.getByRole("button", { name: step.press, exact: true }).click();
  }
}

/**
 * A screen's subjects of the ways in: each registered key of the screen the page draws, opened at its own address.
 * The screen's other keys are other tasks': the first run's own steps, the phone's postures.
 */
export function phoneDoorSubjects(
  screen: "phonedoor" | "onboarding",
  registered: readonly { readonly key: string; readonly screen: string }[],
): { key: string; open(page: Page): Promise<void> }[] {
  return registered
    .filter((row) => row.screen === screen && drawnAt(new URLSearchParams(row.key)) !== null)
    .map((row) => ({ key: row.key, open: (page: Page) => openPhoneDoorPage(page, row.key) }));
}

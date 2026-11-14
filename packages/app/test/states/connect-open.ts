import type { Page } from "@playwright/test";
import { CONNECT_KEYS, drawnAt, stepsOf, type Lang } from "./connect-states.js";

/**
 * THE ONE CONNECT FORM'S STATES PAGE, for the subjects that open it in a browser: one state by address, served from a
 * stand-in address on loopback's terms so that `location.search` carries the key, and brought to its state by a
 * person's steps: a field by its label, a press by its name, a line by its switch's name. The page is bundled at the
 * first open, so that a case that only lists the subjects reaches no bundler.
 */
let html: Promise<string> | null = null;

export async function openConnectPage(page: Page, query: string): Promise<void> {
  html ??= import("./build-connect.mjs").then(({ connectPage }) => connectPage());
  const body = await html;
  await page.route("http://connect.test/**", (r) => r.fulfill({ contentType: "text/html", body }));
  await page.goto(`http://connect.test/?${query}`);
  const words = new URLSearchParams(query);
  const drawn = drawnAt(words);
  if (drawn === null) throw new Error(`the connect page draws no state at ${query}`);
  const lang: Lang = words.get("lang") === "de" ? "de" : "en";
  for (const step of stepsOf(drawn, lang)) {
    if ("into" in step) await page.getByLabel(step.into, { exact: true }).fill(step.type);
    else if ("leave" in step) await page.getByLabel(step.leave, { exact: true }).blur();
    else if ("press" in step) await page.getByRole("button", { name: step.press, exact: true }).click();
    else await page.getByRole("switch", { name: step.tick, exact: true }).click();
  }
}

/**
 * The screen `onboarding`'s subjects of the one connect form: each registered key the page draws, opened at its own
 * address. The screen's other keys are other tasks': the doors' steps, the first run's stage, the phone's postures.
 */
export function connectSubjects(
  registered: readonly { readonly key: string; readonly screen: string }[],
): { key: string; open(page: Page): Promise<void> }[] {
  const drawn = new Set(CONNECT_KEYS);
  return registered
    .filter((row) => row.screen === "onboarding" && drawn.has(row.key))
    .map((row) => ({ key: row.key, open: (page: Page) => openConnectPage(page, row.key) }));
}

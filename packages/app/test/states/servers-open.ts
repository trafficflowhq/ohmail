import type { Page } from "@playwright/test";
import { drawnAt, stepsOf, type Lang } from "./servers-states.js";

/**
 * THE PHONE'S LIST OF SERVERS' STATES PAGE, for the subjects that open it in a browser: one state by address, served
 * from a stand-in address on loopback's terms so that `location.search` carries the key, and brought to its state by a
 * person's press. The page is bundled at the first open, so that a case that only lists the subjects reaches no
 * bundler.
 */
let html: Promise<string> | null = null;

export async function openServersPage(page: Page, query: string): Promise<void> {
  html ??= import("./build-phonedoor.mjs").then(({ phoneDoorPage }) =>
    phoneDoorPage("packages/app/test/states/servers-page.tsx"),
  );
  const body = await html;
  await page.route("http://servers.test/**", (r) => r.fulfill({ contentType: "text/html", body }));
  await page.goto(`http://servers.test/?${query}`);
  const words = new URLSearchParams(query);
  const drawn = drawnAt(words);
  if (drawn === null) throw new Error(`the list's page draws no state at ${query}`);
  const lang: Lang = words.get("lang") === "de" ? "de" : "en";
  for (const step of stepsOf(drawn, lang))
    await page.getByRole("button", { name: step.press, exact: true }).click();
}

/** The screen's subjects: each registered key of `servers` the page draws, opened at its own address. */
export function serversSubjects(
  registered: readonly { readonly key: string; readonly screen: string }[],
): { key: string; open(page: Page): Promise<void> }[] {
  return registered
    .filter((row) => row.screen === "servers" && drawnAt(new URLSearchParams(row.key)) !== null)
    .map((row) => ({ key: row.key, open: (page: Page) => openServersPage(page, row.key) }));
}

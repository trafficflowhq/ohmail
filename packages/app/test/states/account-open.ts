import type { Page } from "@playwright/test";
import { ACCOUNT_KEYS, factorSteps, say, type FactorStep, type Lang } from "./account-states.js";
import { accountPage } from "./build-account.mjs";

/**
 * THE ACCOUNT GROUP'S STATES PAGE, for the subjects and the cases that open it in a browser: one state by address,
 * served from a stand-in address on loopback's terms so that `location.search` carries the key, and the factor's
 * dialog brought to the state the address names by a person's own presses.
 */
let html: Promise<string> | null = null;

export async function openAccountPage(page: Page, query: string): Promise<void> {
  html ??= accountPage();
  const body = await html;
  await page.route("http://account.test/**", (r) => r.fulfill({ contentType: "text/html", body }));
  await page.goto(`http://account.test/?${query}`);
  const words = new URLSearchParams(query);
  await walk(page, factorSteps(words), words.get("lang") === "de" ? "de" : "en");
}

/** The steps in the dialog, in the page's language: a button by the name it starts with, a blank by its label. */
async function walk(page: Page, steps: readonly FactorStep[], lang: Lang): Promise<void> {
  const dialog = page.getByRole("dialog");
  for (const step of steps) {
    if ("press" in step) await dialog.getByRole("button", { name: say(lang, "stepUp", step.press) }).click();
    else await dialog.getByLabel(say(lang, "stepUp", step.into), { exact: true }).fill(step.type);
  }
}

/**
 * The Settings screen's subjects of the account group: each registered key whose state the page draws, opened at its
 * own address. The screen's other sections are their own tasks', and so are the account group's keys of another
 * task (the desktop's own pane under `door=local`, the phone's under `store=1` on a phone).
 */
export function accountSubjects(
  registered: readonly { readonly key: string; readonly screen: string }[],
): { key: string; open(page: Page): Promise<void> }[] {
  const drawn = new Set(ACCOUNT_KEYS);
  return registered
    .filter((row) => row.screen === "settings" && drawn.has(row.key))
    .map((row) => ({ key: row.key, open: (page: Page) => openAccountPage(page, row.key) }));
}

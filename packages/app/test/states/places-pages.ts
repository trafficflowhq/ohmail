import type { Page } from "@playwright/test";
import { comparedKeys } from "./places-states.mjs";

/**
 * THE PLACES' STATES PAGE, for a comparison or a browser test that draws it (`places-page.tsx`, bundled by the
 * reader's page builder with the place's own sheets): each state is the reference's own address, read by the page as
 * it stands, plus `lang`. Built once a run; served from a stand-in address. A state that is a person's press (a tag's
 * Rename asked from the list's menu) is pressed here.
 */
export const PLACES_ORIGIN = "http://places.states.invalid";
let built: Promise<string> | null = null;

type Build = { readerStatesPage: (entry?: string) => Promise<string> };

/** The page as one document. */
export function placesStatesPage(): Promise<string> {
  built ??= import("./reader-states.mjs").then((m: Build) =>
    m.readerStatesPage("packages/app/test/states/places-page.tsx"),
  );
  return built;
}

/** Open the page at `query` (a registry key, with `&lang=de` for German). */
export async function openPlacesPage(page: Page, query: string): Promise<void> {
  const body = await placesStatesPage();
  await page.route(`${PLACES_ORIGIN}/**`, (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body }),
  );
  await page.goto(`${PLACES_ORIGIN}/?${query}`);
  if (/(^|&)show=rename(&|$)/.test(query)) {
    const de = /(^|&)lang=de(&|$)/.test(query);
    await page
      .getByRole("button", { name: de ? "Liste" : "List", exact: true })
      .first()
      .click();
    await page.getByRole("menuitem", { name: de ? "Umbenennen" : "Rename" }).click();
  }
}

/** A screen's subjects: each key the comparison draws for it, opened on the page at that key. */
export function placesSubjects(screen: string): { key: string; open: (page: Page) => Promise<void> }[] {
  return comparedKeys(screen).map((key) => ({ key, open: (page: Page) => openPlacesPage(page, key) }));
}

import type { Page } from "@playwright/test";

/**
 * THE READER'S TWO PAGES, for a comparison that draws them: the reader's states page (`reader-page.tsx`: the reader
 * with the body's own renderer over the reading screen's letters, in the real frame over the fake host) and the
 * body's ask page for a marked link (`linkask-page.ts`). Each reads its state from its own address in the
 * reference's words, so a comparison opens it at a key. Built once a run; served from a stand-in address.
 */
let reading: Promise<string> | null = null;
let ask: Promise<string> | null = null;

type Build = { readerStatesPage: (entry?: string) => Promise<string> };
const build = (entry?: string): Promise<string> =>
  import("./reader-states.mjs").then((m: Build) => m.readerStatesPage(entry));

/** Open the reader's states page at `query`; a state that needs a press (Load it now) is pressed here. */
export async function openReaderPage(page: Page, query: string): Promise<void> {
  reading ??= build();
  const body = await reading;
  await page.route("http://reader.states.invalid/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body }),
  );
  await page.goto(`http://reader.states.invalid/?${query}`);
  /* An emptied letter's live states follow the person's press on Load it now. */
  if (
    query.includes("open=lt-emptied") &&
    /state=(loading|loaded|gone|large|busy|unreachable|failed)/.test(query)
  )
    await page.getByRole("button", { name: "Load it now" }).click();
  /* The note of what was kept out of the letter, as the person opened it from its chip. */
  if (/(^|&)show=note(&|$)/.test(query)) {
    const chip = page.getByRole("button", { name: /blocked$/ }).first();
    if (await chip.count()) await chip.click();
  }
  /* The quoted history open, as the person opened it. */
  if (/(^|&)state=history(&|$)/.test(query)) await page.getByRole("button", { name: "Show history" }).click();
}

/** Open the body's ask page for a marked link, as the browser opens it, at `query`. */
export async function openAskPage(page: Page, query: string): Promise<void> {
  ask ??= build("packages/app/test/states/linkask-page.ts");
  const body = await ask;
  await page.route("http://linkask.states.invalid/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body }),
  );
  await page.goto(`http://linkask.states.invalid/?${query}`);
}

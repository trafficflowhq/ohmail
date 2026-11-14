import type { Locator, Page } from "@playwright/test";

/**
 * THE READER'S PAGES, for a comparison that draws them: the reader's states page (`reader-page.tsx`: the reader
 * with the body's own renderer over the reading screen's letters, in the real frame over the fake host), the body's
 * ask page for a marked link (`linkask-page.ts`), and the Ohbox's states page (`ohbox-page.tsx`: the reader beside
 * the Ohbox's list, over the reference's nine conversations). Each reads its state from its own address in the
 * reference's words, so a comparison opens it at a key; what a key names as a person's press, the opener presses.
 * Built once a run; served from a stand-in address.
 */
let reading: Promise<string> | null = null;
let ask: Promise<string> | null = null;
let ohbox: Promise<string> | null = null;

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

/** The verbs a key opens from the reader's panel: on the panel where it stands there, else behind More. */
const PANEL_SHOWS: Readonly<Record<string, readonly string[]>> = {
  more: [],
  move: ["Move"],
  tag: ["Tag"],
  resurface: ["Resurface"],
  pickday: ["Resurface", "Pick a date"],
};

/**
 * Open the Ohbox's states page at `query`, then make the presses the key names in the reading column, as a person
 * makes them: `at=N` presses the conversation's Nth square (the column stands at that letter), `hist=N` opens the
 * Nth letter's history, and `show=` opens the open letter's card, its menu or its details, or the panel's More and
 * the verb behind it. A press whose control the reader does not draw is left unmade: the state then draws without
 * it, and the comparison says so.
 */
export async function openOhboxReaderPage(page: Page, query: string): Promise<void> {
  ohbox ??= import("./ohbox-states.mjs").then((m: { ohboxStatesPage: () => Promise<string> }) =>
    m.ohboxStatesPage(),
  );
  const body = await ohbox;
  await page.route("http://ohbox.states.invalid/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body }),
  );
  await page.goto(`http://ohbox.states.invalid/?${query}`);
  const q = new URLSearchParams(query);
  const reading = page.getByRole("region", { name: "Reading" });
  const letters = reading.getByRole("article");
  await letters
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
  const press = async (control: Locator): Promise<boolean> => {
    if ((await control.count()) === 0) return false;
    /* Drawn but not to be pressed (under another layer, out of the window): the press is left unmade. */
    return control
      .first()
      .click({ timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
  };
  const at = Number(q.get("at") ?? 0);
  if (at > 0) {
    /* A square is a slot of the conversation's squares, numbered from 0; a press on it lands on that letter. */
    const square = reading.getByRole("group").locator(`[data-square="${at - 1}"]`);
    if (await square.count()) await square.first().dispatchEvent("click");
  }
  const hist = Number(q.get("hist") ?? 0);
  if (hist > 0) await press(letters.nth(hist - 1).getByRole("button", { name: "Show history" }));
  const show = q.get("show");
  /* The open letter is the conversation's newest: the column's last letter. */
  const opened = letters.last();
  if (show === "card") await press(opened.getByRole("button").first());
  if (show === "msgmenu") await press(opened.getByRole("button", { name: "Message", exact: true }));
  if (show === "details") await press(opened.getByRole("button", { name: "details", exact: true }));
  const verbs = show === null ? undefined : PANEL_SHOWS[show];
  if (verbs !== undefined) {
    const panel = page.getByRole("toolbar", { name: "Actions" });
    const [first, ...then] = verbs;
    const direct = first === undefined ? null : panel.getByRole("button", { name: first, exact: true });
    if (direct === null || !(await press(direct))) {
      await press(panel.getByRole("button", { name: "More", exact: true }));
      if (first !== undefined) await press(page.getByRole("menuitem", { name: first, exact: true }));
    }
    for (const next of then) await press(page.getByRole("menuitem", { name: next, exact: true }));
  }
}

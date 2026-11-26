import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { measurePress, measureScroll, summarize } from "./gesture-probes.mjs";

const OHBOX_ROWS = '.ob-scroll .oh-row[role="option"][data-id]';
const NEWS_CONTENT =
  '[role="listbox"][aria-label="News"] [role="option"], [data-stream-phone-list] [data-stream-item]';
const SEARCH_BOX = 'input[aria-label="Search"]';
const SEARCH_RESULTS = 'section.fr-list [role="listitem"][data-hit]';
const CALENDAR = 'section.cal-body[aria-label="Calendar"]';
const SETTINGS = 'nav[aria-label="Settings sections"] .oh-row[role="button"]';
const SELECTION = '[role="toolbar"][aria-label="Selection"]';
const COMPOSER = '[role="region"][aria-label="New message"]';
const SEND_NOTICE = ".oh-notice-title, .oh-report-said";
const SYNTHETIC_RECIPIENT = ["recipient", "fixture.invalid"].join("@");

const shown = (selector) => [[{ selector }]];
const visible = (page, selector) => page.locator(`:is(${selector}):visible`).first();

class MissingEffect extends Error {}

function createDriver(
  page,
  { timeoutMs = 12_000, searchTerm = "Harbor", recipient = SYNTHETIC_RECIPIENT, directSetup = false } = {},
) {
  if (typeof recipient !== "string" || !/^[^@\s]+@[^@\s]+\.(invalid|test)$/i.test(recipient)) {
    throw new Error("The benchmark requires a synthetic recipient under .invalid or .test.");
  }
  const runId = randomUUID().slice(0, 8);
  let sendCount = 0;
  let lastPicked = "";
  const wait = { timeout: timeoutMs };
  let usesTouch;
  const click = async (target) => {
    usesTouch ??= await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    return usesTouch ? target.tap(wait) : target.click(wait);
  };
  const setup = async (target) => {
    if (!directSetup) return click(target);
    await target.waitFor(wait);
    await target.evaluate((element) => element.click());
  };
  const press = async (target, effect) => {
    if (directSetup) await target.click({ ...wait, trial: true });
    return measurePress(target, () => click(target), effect, timeoutMs);
  };
  const scroller = visible(page, ".ob-scroll");
  const nav = (name) =>
    page
      .getByRole("button", { name })
      .and(page.locator(":is(nav button, .oh-switcher button):not([inert] *):visible"))
      .first();

  async function navigation(name) {
    const button = nav(name);
    const more = visible(page, "nav button[data-drawer-toggle]:not([inert] *)");
    await button.or(more).first().waitFor(wait);
    if (await button.isVisible()) return button;
    // Calendar and Settings are in the phone's More drawer. The timed input is the destination click.
    await click(more);
    await button.waitFor(wait);
    return button;
  }

  async function ensureMail() {
    if (await visible(page, CALENDAR).isVisible()) {
      await click(await navigation(/^Mail$/));
      await page.waitForSelector(CALENDAR, { state: "hidden", ...wait });
    }
  }

  async function ensureOhbox() {
    if (await visible(page, OHBOX_ROWS).isVisible()) return;
    const reader = page.getByRole("region", { name: "Open message" });
    const back = reader.getByRole("button", { name: /^(Back|Ohbox)$/ }).first();
    if ((await back.isVisible()) && !(await nav(/^Ohbox\b/).isVisible())) await click(back);
    await ensureMail();
    if (!(await visible(page, OHBOX_ROWS).isVisible())) await click(await navigation(/^Ohbox\b/));
    await visible(page, OHBOX_ROWS).waitFor(wait);
  }

  async function pickRow(unread) {
    await ensureOhbox();
    // Use a different letter for each action. Read may still be moving the
    // previous letter between groups while its visible effect is already clear.
    const other = lastPicked ? `:not([data-id="${lastPicked}"])` : "";
    const candidates = page.locator(`${OHBOX_ROWS}${unread ? "[data-unread]" : ""}${other}:visible`);
    await candidates.first().waitFor(wait);
    const row = candidates.first();
    const id = await row.evaluate((el) => CSS.escape(el.getAttribute("data-id")));
    lastPicked = id;
    const selector = `${OHBOX_ROWS}[data-id="${id}"]`;
    const exactRow = visible(page, selector);
    const select = exactRow.locator("..").getByRole("button", { name: "Select the message", exact: true });
    await (unread ? click(select) : setup(select));
    const toolbar = visible(page, SELECTION);
    await toolbar.waitFor(wait);
    return { selector, toolbar };
  }

  async function selectionVerb(toolbar, name) {
    const button = toolbar.getByRole("button", { name, exact: true });
    if (await button.isVisible()) return button;
    await setup(toolbar.getByRole("button", { name: "More", exact: true }));
    return page.getByRole("menu", { name: "More", exact: true }).getByRole("menuitem", { name, exact: true });
  }

  async function markRead() {
    const { selector, toolbar } = await pickRow(true);
    return press(await selectionVerb(toolbar, "Read"), [
      [{ selector: `${selector}:not([data-unread])` }],
      // A read message can leave the visible New group when it files under Earlier.
      [
        { selector, hidden: true },
        { selector: ".oh-report-said", includes: "· Read" },
      ],
    ]);
  }

  async function move() {
    const { selector, toolbar } = await pickRow(false);
    await setup(await selectionVerb(toolbar, "Move"));
    const dialog = page.getByRole("dialog", { name: "Move", exact: true });
    return press(dialog.getByRole("menuitem", { name: "News", exact: true }), [
      [
        { selector, hidden: true },
        { selector: SELECTION, hidden: true },
      ],
    ]);
  }

  async function send() {
    await ensureOhbox();
    await click(await navigation(/^Write$/));
    const editor = page.getByRole("region", { name: "New message", exact: true });
    const subject = `Synthetic performance letter ${runId} ${++sendCount}`;
    // Address suggestions turn the same field into a combobox on a configured mailbox.
    const to = editor.locator('input[aria-label="To"]');
    await to.fill(recipient, wait);
    await to.press("Enter", wait);
    await editor.getByRole("textbox", { name: "Subject", exact: true }).fill(subject, wait);
    const body = editor.getByRole("textbox", { name: "Message", exact: true });
    await click(body);
    await page.keyboard.insertText(
      "This sample letter measures the visible confirmation on a local synthetic mailbox.",
    );
    const sendButton = editor.getByRole("button", { name: "Send", exact: true });
    return press(sendButton, [
      [
        { selector: SEND_NOTICE, prefix: "Sent to ", includes: subject },
        { selector: COMPOSER, hidden: true },
      ],
    ]);
  }

  async function news() {
    await ensureOhbox();
    return press(await navigation(/^News\b/), shown(NEWS_CONTENT));
  }

  async function ohbox() {
    await ensureMail();
    if (await visible(page, OHBOX_ROWS).isVisible())
      throw new MissingEffect("The Ohbox was already visible.");
    return press(await navigation(/^Ohbox\b/), shown(OHBOX_ROWS));
  }

  async function search() {
    await ensureOhbox();
    return press(await navigation(/^Search$/), shown(SEARCH_BOX));
  }

  async function searchResults() {
    const field = visible(page, SEARCH_BOX);
    await field.waitFor(wait);
    if ((await field.inputValue(wait)) !== "") {
      await field.fill("", wait);
      await visible(page, SEARCH_RESULTS).waitFor({ state: "hidden", ...wait });
    }
    await field.focus(wait);
    return measurePress(
      field,
      () => page.keyboard.insertText(searchTerm),
      shown(SEARCH_RESULTS),
      timeoutMs,
      "input",
    );
  }

  async function calendar() {
    if (await visible(page, CALENDAR).isVisible()) await ensureMail();
    return press(await navigation(/^Calendar$/), shown(CALENDAR));
  }

  async function settings() {
    await ensureMail();
    if (await visible(page, SETTINGS).isVisible()) await ensureOhbox();
    return press(await navigation(/^Settings(?:\b|$)/), shown(SETTINGS));
  }

  async function scroll(screens, direction = 1) {
    await ensureOhbox();
    return measureScroll(page, scroller, { screens, direction, timeoutMs });
  }

  async function resetScroll() {
    await scroller.evaluate(
      (node) => {
        node.scrollTo({ top: 0, behavior: "instant" });
        return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      },
      undefined,
      wait,
    );
  }

  return {
    markRead,
    move,
    send,
    news,
    ohbox,
    search,
    searchResults,
    calendar,
    settings,
    scroll,
    resetScroll,
  };
}

function actionList(driver) {
  return [
    ["mark-read", driver.markRead],
    ["move", driver.move],
    ["send", driver.send],
    ["switch-news", driver.news],
    ["switch-ohbox", driver.ohbox],
    ["switch-search", driver.search],
    ["search-results", driver.searchResults],
    ["switch-calendar", driver.calendar],
    ["switch-settings", driver.settings],
  ];
}

async function attempt(action) {
  try {
    return await action();
  } catch (error) {
    // Browser errors may contain typed content and API URLs. Keep reports to the action and its outcome.
    return {
      ms: null,
      why:
        error instanceof MissingEffect
          ? error.message
          : "The gesture's setup did not reach its visible control.",
    };
  }
}

/** Fast pass on a caller-owned production page already signed in with synthetic data. */
export async function runGestures(page, { repetitions = 1, only, onBefore, onResult, ...options } = {}) {
  const driver = createDriver(page, options);
  const actions = {};
  const scrolling = [];
  for (let rep = 1; rep <= repetitions; rep += 1) {
    if (only === undefined) {
      await onBefore?.("scroll-ten-screens");
      const scroll = { rep, ...(await attempt(() => driver.scroll(10))) };
      scrolling.push(scroll);
      await onResult?.("scroll-ten-screens", scroll);
      await attempt(driver.resetScroll);
    }
    for (const [name, action] of actionList(driver)) {
      if (only && !only.includes(name)) continue;
      await onBefore?.(name);
      const sample = { rep, ...(await attempt(action)) };
      (actions[name] ??= []).push(sample);
      await onResult?.(name, sample);
    }
  }
  const summary = Object.fromEntries(
    Object.entries(actions).map(([name, samples]) => [name, summarize(samples)]),
  );
  return { actions, scrolling, summary };
}

/** Measured interaction loop with brief reading pauses. The caller owns memory and idle sampling. */
export async function activeUse(page, { activeMs = 600_000, onResult, clock, ...options } = {}) {
  const driver = createDriver(page, options);
  const activities = [
    ["scroll-down", () => driver.scroll(2)],
    ["scroll-up", () => driver.scroll(2, -1)],
    ...actionList(driver),
  ];
  const results = {};
  const failures = {};
  const now = clock?.now ?? (() => performance.now());
  const wait = clock?.wait ?? ((ms) => page.waitForTimeout(ms));
  await clock?.ready();
  const started = now();
  const deadline = started + activeMs;
  let sequence = 0;
  let interrupted = 0;
  for (;;) {
    const epoch = await clock?.ready();
    if (now() >= deadline) break;
    const [name, action] = activities[sequence % activities.length];
    sequence += 1;
    const sample = await attempt(action);
    if ((await clock?.ready()) !== epoch) {
      interrupted++;
      await onResult?.(name, { phase: "active", sequence, interrupted: true });
    } else {
      const completed = Number.isFinite(sample.ms) && sample.reached !== false;
      (results[name] ??= []).push({ ms: completed ? sample.ms : null });
      if (!completed) failures[name] ??= sample.why;
      await onResult?.(name, { phase: "active", sequence, ...sample });
    }
    const pauseMs = Math.min(1_500, deadline - now());
    if (pauseMs > 0) await wait(pauseMs);
  }
  const result = {
    requestedMs: activeMs,
    durationMs: now() - started,
    attempted: sequence,
    interrupted,
    completed: Object.values(results)
      .flat()
      .filter(({ ms }) => ms !== null).length,
    actions: Object.fromEntries(Object.entries(results).map(([name, samples]) => [name, summarize(samples)])),
    firstFailure: failures,
  };
  await onResult?.("active-use", result);
  return result;
}

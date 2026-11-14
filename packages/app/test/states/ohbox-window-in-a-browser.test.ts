/**
 * THE OHBOX'S LIST WINDOW, IN A REAL BROWSER. The window measures every node that carries `data-index` in its
 * scroller; a part drawn inside a row that carried one too would be measured as a row of its own, and the list
 * would never come to rest. jsdom has no layout, so only Chromium sees it. Read on the Ohbox's states page: the
 * registered default state, and the same list with some hundred more rows, conversations among them.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const ORIGIN = "http://ohbox.states.invalid";
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let html = "";

beforeAll(async () => {
  const states = (await import("./ohbox-states.mjs")) as { ohboxStatesPage: () => Promise<string> };
  html = await states.ohboxStatesPage();
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

async function atRest(query: string) {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(`${ORIGIN}/?${query}`);
  await page.waitForSelector("[role=option][data-id]", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);
  const read = await page.evaluate(async () => {
    const scroller = document.querySelector(".ob-scroll");
    if (!scroller) return { rows: 0, squares: 0, mutations: -1 };
    let mutations = 0;
    const watch = new MutationObserver((list) => {
      mutations += list.length;
    });
    watch.observe(scroller, { subtree: true, childList: true, attributes: true });
    await new Promise((r) => setTimeout(r, 1_000));
    watch.disconnect();
    return {
      rows: scroller.querySelectorAll("[role=option][data-id]").length,
      squares: scroller.querySelectorAll(".oh-readsquares").length,
      mutations,
    };
  });
  await page.close();
  return { ...read, errors };
}

describe("the Ohbox's list window in a real browser", () => {
  it("the registered default state draws its rows and comes to rest", async () => {
    const read = await atRest("open=none&screen=ohbox");
    expect(read.errors).toEqual([]);
    expect(read.rows).toBeGreaterThan(5);
    expect(read.squares, "no conversation drew its squares").toBeGreaterThan(0);
    expect(read.mutations, "the list kept changing at rest").toBe(0);
  }, 60_000);

  it("four hundred more rows, every fifth a conversation: drawn, and at rest", async () => {
    const read = await atRest("open=none&screen=ohbox&many=400");
    expect(read.errors).toEqual([]);
    expect(read.rows).toBeGreaterThan(5);
    expect(read.rows, "the window drew every row").toBeLessThan(200);
    expect(read.mutations, "the list kept changing at rest").toBe(0);
  }, 60_000);
});

describe("a long conversation's row in a real browser", () => {
  it("stands a run of its squares inside the row: the time drawn, the squares in the row, most of the sender kept", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?open=none&screen=ohbox&long=40`);
    await page.waitForSelector('[role=option][data-id="long-newest"]', { timeout: 15_000 });
    await page.waitForTimeout(500);
    const read = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('[role=option][data-id="long-newest"]')!;
      const box = row.getBoundingClientRect();
      const squares = row.querySelector<HTMLElement>('[role="group"]')!.getBoundingClientRect();
      const when = row.querySelector("time");
      const whenBox = when?.getBoundingClientRect() ?? null;
      const who = row.querySelector<HTMLElement>("b");
      return {
        rowRight: box.right,
        squaresRight: squares.right,
        whenShown: whenBox !== null && whenBox.width > 0 && whenBox.right <= box.right + 0.5,
        /* A long name may end in an ellipsis in a narrow column; the squares never take it down to a few letters. */
        whoKept: who === null ? 0 : who.clientWidth / Math.max(1, who.scrollWidth),
        hidden: row.querySelector('[role="group"]')?.textContent ?? "",
      };
    });
    await page.close();
    expect(read.squaresRight, "the squares run out of the row").toBeLessThanOrEqual(read.rowRight + 0.5);
    expect(read.whenShown, "the time is not drawn").toBe(true);
    expect(read.whoKept, "the squares took the sender's room").toBeGreaterThan(0.6);
    expect(read.hidden, "the run does not say how many it hides").toMatch(/\+\d+/);
  }, 60_000);
});

describe("the Ohbox's states page draws both columns", () => {
  async function columns(query: string) {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?${query}`);
    await page.waitForSelector("[role=option][data-id]", { timeout: 15_000 });
    await page.waitForTimeout(500);
    const reading = page.getByRole("region", { name: "Reading" });
    const read = {
      letter: await reading.getByRole("region", { name: "Open message" }).getByRole("article").count(),
      text: (await reading.textContent()) ?? "",
      errors,
    };
    await page.close();
    return read;
  }

  it("an open letter stands in the reading column, drawn by the reader the host hands", async () => {
    const read = await columns("hold=1&open=ben-kiln&screen=ohbox");
    expect(read.errors).toEqual([]);
    expect(read.letter, "no letter in the reading column").toBeGreaterThan(0);
    expect(read.text).toContain("The new element arrived early and the kiln heats evenly again");
  }, 60_000);

  it("with nothing open the reading column says the list's blank", async () => {
    const read = await columns("open=none&screen=ohbox");
    expect(read.errors).toEqual([]);
    expect(read.letter).toBe(0);
    expect(read.text, "the reading column is empty").toMatch(/unread/i);
  }, 60_000);
});

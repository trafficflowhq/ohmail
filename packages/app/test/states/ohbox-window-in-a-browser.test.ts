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

it("checks for new mail from phone Ohbox actions while a Restore draft notice stands", async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?open=none&device=phone&recovery`);
    await page.getByRole("button", { name: "Restore draft" }).waitFor();
    await page.getByRole("button", { name: "Ohbox actions" }).tap();
    const pull = page.getByRole("menuitem", { name: "Pull new mail" });
    await pull.tap({ position: { x: 45, y: 20 }, timeout: 2000 });
    expect(await page.locator("body").getAttribute("data-mail-check")).toBe("started");
    expect(await page.getByRole("button", { name: "Restore draft" }).isVisible()).toBe(true);
  } finally {
    await page.close();
  }
}, 15_000);

it.each([
  { device: "desktop", viewport: { width: 1440, height: 1000 }, hasTouch: false },
  { device: "phone", viewport: { width: 390, height: 844 }, hasTouch: true },
])(
  "keeps a second Mark all read press off the list or dock on $device",
  async ({ device, viewport, hasTouch }) => {
    const page = await browser.newPage({ viewport, hasTouch });
    try {
      await page.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
      );
      await page.goto(`${ORIGIN}/?open=none&device=${device}`);
      await page.getByRole("button", { name: "Ohbox actions" }).click();
      const markAll = page.getByRole("menuitem", { name: "Mark all read" });
      await markAll.waitFor();
      const row = (await markAll.boundingBox())!;
      const x = row.x + row.width / 2;
      const y = row.y + row.height / 2;

      await page.evaluate(() => {
        document.addEventListener("click", (event) => {
          if (!(event.target as Element).closest('[role="menu"]'))
            document.body.dataset.pressedBehindMenu = "yes";
        });
      });
      const press = () => (hasTouch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
      await press();
      await markAll.waitFor({ state: "hidden" });
      await page.waitForTimeout(120);
      await press();

      expect(await page.locator("body").getAttribute("data-pressed-behind-menu")).toBeNull();

      await press();
      expect(await page.locator("body").getAttribute("data-pressed-behind-menu")).toBe("yes");
    } finally {
      await page.close();
    }
  },
  15_000,
);

it.each([
  { device: "desktop", viewport: { width: 1440, height: 1000 }, hasTouch: false },
  { device: "phone", viewport: { width: 390, height: 844 }, hasTouch: true },
])(
  "keeps the next Trash action reachable with Undo in $device Ohbox",
  async ({ device, viewport, hasTouch }) => {
    const page = await browser!.newPage({ viewport, hasTouch, reducedMotion: "reduce" });
    try {
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?open=none&show=pick&device=${device}&undo`);
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await undo.waitFor();
      const more = page
        .getByRole("toolbar", { name: "Selection" })
        .getByRole("button", { name: "More", exact: true });
      const press = (control: typeof more) =>
        hasTouch ? control.tap({ timeout: 2000 }) : control.click({ timeout: 2000 });
      await press(more);
      const nextAction = page.getByRole("menuitem", { name: "Delete", exact: true });
      await nextAction.waitFor({ timeout: 2000 });
      if (!hasTouch) {
        expect(await page.locator("body").getAttribute("data-undone")).toBeNull();
        return;
      }
      await press(nextAction);
      await press(page.getByRole("menuitem", { name: "Move", exact: true }));
      expect(await page.locator("body").getAttribute("data-bulk-action")).toBe("delete");
      expect(await page.locator("body").getAttribute("data-undone")).toBeNull();
      expect(await undo.isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  },
  15_000,
);

it("accepts a reminder date while the previous reminder offers Undo on a phone", async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await page.clock.setFixedTime(new Date(2026, 10, 28, 12));
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?open=ben-kiln&device=phone&undo`);
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    await undo.waitFor();
    await page.getByRole("toolbar").getByRole("button", { name: "More", exact: true }).tap({ timeout: 3000 });
    await page.getByRole("menuitem", { name: "Resurface", exact: true }).tap({ timeout: 2000 });
    await page.getByRole("menuitem", { name: "Pick a date", exact: true }).tap({ timeout: 2000 });
    const picker = page.getByRole("menu", { name: "Pick a date" });
    await picker.getByRole("button", { name: "Next month" }).tap({ timeout: 2000 });
    await picker.getByRole("button").filter({ hasText: /^15$/ }).tap({ timeout: 2000 });
    await picker.waitFor({ state: "hidden", timeout: 2000 });
    expect(await page.locator("body").getAttribute("data-undone")).toBeNull();
  } finally {
    await page.close();
  }
}, 15_000);

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

it("keeps an older date on one line beside a conversation's squares", async () => {
  const page = await browser!.newPage({ viewport: { width: 719, height: 781 }, hasTouch: true });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?open=none&screen=ohbox&device=fold&long=40&dated=1`);
    const row = page.getByRole("option", { name: /The studio roof, again/ });
    const date = row.getByText("15 Sept", { exact: false }).or(row.getByText("15 Sep", { exact: true }));
    await date.waitFor();
    const box = (await row.boundingBox())!;
    const stamp = await date.evaluate((el) => {
      const text = el.ownerDocument.createRange();
      text.selectNodeContents(el);
      const rects = Array.from(text.getClientRects()).filter((r) => r.width > 0);
      return {
        left: rects[0]!.left,
        right: rects.at(-1)!.right,
        lines: new Set(rects.map((r) => r.top)).size,
      };
    });
    expect(stamp.lines).toBe(1);
    expect(stamp.left).toBeGreaterThanOrEqual(box.x);
    expect(stamp.right).toBeLessThanOrEqual(box.x + box.width);
  } finally {
    await page.close();
  }
}, 60_000);

it("keeps desktop sender and date sizing at the default and minimum list widths", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?screen=ohbox&open=none&long=40&dated=1`);
    const row = page.getByRole("option", { name: /The studio roof, again/ });
    await row.waitFor();
    for (const width of [400, 320]) {
      await page.evaluate((px) => {
        document.documentElement.style.setProperty("--split-user", `${px}px 1fr`);
      }, width);
      const sizing = await row.evaluate((el) => {
        const who = getComputedStyle(el.querySelector("b")!);
        const stamp = getComputedStyle(el.querySelector("time")!);
        return {
          senderRoom: parseFloat(who.minWidth) / parseFloat(who.fontSize),
          stampRoom: stamp.minInlineSize,
        };
      });
      expect(sizing.senderRoom).toBeCloseTo(3);
      expect(sizing.stampRoom).toBe("auto");
    }
  } finally {
    await page.close();
  }
}, 60_000);

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

it.each([
  [600, "paper", "a conversation"],
  [700, "paper", "a conversation"],
  [700, "ohmarchy", "a conversation"],
  [1024, "paper", "a conversation"],
  [1024, "ohmarchy", "a conversation"],
  [1600, "paper", "a conversation"],
  [1600, "ohmarchy", "a conversation"],
  [1024, "paper", "a single letter"],
  [1600, "ohmarchy", "a single letter"],
] as const)(
  "keeps the design insets at %i px in %s with %s open",
  async (width, face, scenario) => {
    const page = await browser!.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === ORIGIN
          ? route.fulfill({ contentType: "text/html", body: html })
          : route.abort(),
      );
      const thread = scenario === "a conversation";
      const open = thread ? "ben-kiln" : "petra-talk";
      const fold = width < 840;
      const device = fold ? "fold" : "desktop";
      await page.goto(`${ORIGIN}/?screen=ohbox&device=${device}&face=${face}&open=${open}&hold=1`);
      const list = page.getByRole("region", { name: "Messages", exact: true });
      const reader = page.getByRole("region", { name: "Open message", exact: true });
      const squares = reader.getByRole("group", { name: /^\d+ messages,/ });
      const letter = reader.getByRole("article").first();
      await letter.waitFor({ state: "attached" });
      if (thread) await squares.waitFor();
      await page.evaluate(() => document.fonts.ready);
      expect(await squares.count()).toBe(thread ? 1 : 0);

      const tokens = await reader.evaluate((pane) => {
        const styles = getComputedStyle(pane);
        const px = (name: string) => parseFloat(styles.getPropertyValue(name));
        return {
          edge: px("--edge"),
          gap: px("--gap"),
          gutter: px("--sq-gutter"),
          measure: px("--readw"),
          ring: px("--ringw"),
          inset: px("--sheet-pad"),
        };
      });
      const listBox = (await list.boundingBox())!;
      const readerBox = (await reader.boundingBox())!;
      const letterBox = (await letter.boundingBox())!;
      const side = Math.max(0, (readerBox.width - tokens.measure) / 2 - tokens.ring);

      const listRight = listBox.x + listBox.width;
      expect(readerBox.x - listRight).toBeCloseTo(tokens.gap - tokens.ring);
      expect(letterBox.x - listRight).toBeCloseTo(tokens.gap + side + (thread && !fold ? tokens.gutter : 0));
      expect(width - (letterBox.x + letterBox.width)).toBeCloseTo(tokens.edge + side);
      if (thread && fold) {
        const heading = reader.getByRole("heading", { level: 2 }).first();
        const head = heading.locator("..");
        const headSquares = head.getByRole("group", { name: /^\d+ messages,/ });
        const capsule = (await headSquares.boundingBox())!;
        const bounds = await head.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return [
            box.left + parseFloat(style.paddingInlineStart),
            box.right - parseFloat(style.paddingInlineEnd),
          ];
        });
        expect(capsule.x).toBeGreaterThanOrEqual(bounds[0]!);
        expect(capsule.x + capsule.width).toBeCloseTo(bounds[1]!);
        const currentSquare = headSquares
          .getByRole("button")
          .and(headSquares.locator('[aria-current="true"]'));
        await currentSquare.click({ trial: true });
      }
      if (thread && !fold) {
        const squaresBox = (await squares.boundingBox())!;
        expect(squaresBox.width).toBeCloseTo(tokens.gutter - tokens.gap);
        expect(squaresBox.x - listRight).toBeCloseTo(tokens.gap + side);
        expect(letterBox.x - (squaresBox.x + squaresBox.width)).toBeCloseTo(tokens.gap);
        expect(squaresBox.y - listBox.y, "the squares start at the same top inset as the list").toBeCloseTo(
          0,
        );
      }
      const padding = await letter.evaluate((node) => {
        const style = getComputedStyle(node);
        return [parseFloat(style.paddingInlineStart), parseFloat(style.paddingInlineEnd)];
      });
      expect(padding).toEqual([tokens.inset, tokens.inset]);
    } finally {
      await page.close();
    }
  },
  30_000,
);

describe("the way back to the top of the Ohbox on a phone", () => {
  type Box = { left: number; top: number; right: number; bottom: number };
  const meets = (a: Box, b: Box) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  async function scrolledFar(query: string, width: number, height: number) {
    const page = await browser!.newPage({
      viewport: { width, height },
      hasTouch: true,
      reducedMotion: "reduce",
    });
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?screen=ohbox&device=phone&many=400&${query}`);
    await page.waitForSelector(".ob-scroll [role=option][data-id]", { state: "attached", timeout: 15_000 });
    await page.evaluate(async () => {
      const list = document.querySelector<HTMLElement>(".ob-scroll")!;
      list.scrollTop = 2_000;
      list.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 500));
    });
    return page;
  }

  it.each([
    [412, 915],
    [360, 800],
  ])(
    "stands clear of the dock's buttons at %i by %i, above them as in News",
    async (width, height) => {
      const page = await scrolledFar("open=none", width, height);
      try {
        const read = await page.evaluate(() => {
          const box = (el: Element) => {
            const { left, top, right, bottom } = el.getBoundingClientRect();
            return { left, top, right, bottom };
          };
          const jump = document.querySelector(".ob-list > .oh-jumpback[data-on]");
          const dock = document.querySelector(".fr-dockbox");
          return {
            jump: jump ? box(jump) : null,
            dock: dock ? box(dock) : null,
            buttons: dock ? [...dock.querySelectorAll("button, a")].map(box) : [],
          };
        });
        expect(read.jump, "the way back does not stand once the list is far from its top").not.toBeNull();
        expect(read.dock, "the dock does not stand").not.toBeNull();
        for (const button of read.buttons)
          expect(meets(read.jump!, button), "it lies over a dock button").toBe(false);
        expect(read.jump!.bottom, "it does not stand above the dock").toBeLessThanOrEqual(read.dock!.top);
      } finally {
        await page.close();
      }
    },
    60_000,
  );

  it("does not stand over a conversation opened over the list", async () => {
    const page = await scrolledFar("open=ben-kiln", 412, 915);
    try {
      await page.waitForSelector(".fr-list[inert]", { state: "attached", timeout: 15_000 });
      const read = await page.evaluate(() => {
        const jump = document.querySelector<HTMLElement>(".ob-list > .oh-jumpback")!;
        return {
          far: jump.hasAttribute("data-on"),
          seen: jump.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
        };
      });
      expect(read.far, "the list behind is not far from its top").toBe(true);
      expect(read.seen, "the list's way back stands over the conversation").toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);
});

it("a conversation's row carries its sender's address after the name, as a single letter's row does", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?open=none&screen=ohbox`);
    await page.waitForSelector("[role=option][data-id] .oh-readsquares", { timeout: 15_000 });
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[role=option][data-id]")].map((row) => {
        const address = row.querySelector<HTMLElement>(".oh-row-address");
        return {
          /* A conversation of one voice: a name, not "Giulia, Ben". */
          squares:
            row.querySelector(".oh-readsquares") !== null &&
            !row.querySelector(".oh-row-who")!.textContent!.includes(","),
          address:
            address !== null &&
            address.checkVisibility({ visibilityProperty: true }) &&
            address.clientWidth > 0,
        };
      }),
    );
    const conversations = rows.filter((r) => r.squares);
    expect(conversations.length, "no conversation's row of one voice").toBeGreaterThan(0);
    expect(
      conversations.every((r) => r.address),
      "a conversation's row shows no address",
    ).toBe(true);
  } finally {
    await page.close();
  }
}, 60_000);

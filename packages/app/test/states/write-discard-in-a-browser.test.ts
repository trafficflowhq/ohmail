import { afterAll, beforeAll, expect, it } from "vitest";
import de from "../../messages/write.de.json" with { type: "json" };
import en from "../../messages/write.en.json" with { type: "json" };
import { chromium } from "../support/browser-page.js";
import { replyControlsPage } from "./reply-controls-page.js";
import { writeStatesPage } from "./write-states.mjs";

const ORIGIN = "http://write.states.invalid";
const WIDTH = 320;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let html = "";

beforeAll(async () => {
  html = await writeStatesPage();
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

it.each([
  ["en", en],
  ["de", de],
] as const)(
  "keeps Discard reachable below its explanation in narrow Write (%s)",
  async (lang, words) => {
    const page = await browser!.newPage({ viewport: { width: WIDTH, height: 800 }, hasTouch: true });
    try {
      await page.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
      );
      await page.goto(`${ORIGIN}/?state=draft&device=phone&discard=sent-elsewhere&lang=${lang}`);
      await page.locator('html[data-ready="1"]').waitFor();

      const letter = page.getByRole("region", { name: words.write.letter, exact: true });
      const sentence = words.compose.cancelWhatSentElsewhereTyped;
      const explanation = letter.getByText(sentence, { exact: true });
      const toolbar = letter.getByRole("toolbar", { name: words.write.verbs, exact: true });
      const discard = toolbar.getByRole("button", {
        name: `${words.write.discard}. ${sentence}`,
        exact: true,
      });

      expect(await explanation.isVisible(), "the discard explanation").toBe(true);
      expect(await discard.isVisible(), "the named Discard button").toBe(true);
      const note = (await explanation.boundingBox())!;
      const actions = (await toolbar.boundingBox())!;
      expect(note.x).toBeGreaterThanOrEqual(0);
      expect(note.x + note.width).toBeLessThanOrEqual(WIDTH);
      expect(note.y + note.height).toBeLessThanOrEqual(actions.y);
      await discard.click({ trial: true });
    } finally {
      await page.close();
    }
  },
  30_000,
);

it("shows the failed send with the studio's verdict and way back", async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?state=draft&device=phone&send=failed`);
    await page.locator('html[data-ready="1"]').waitFor();
    const verdict = page.getByText("Not sent.", { exact: true });
    expect(await verdict.count()).toBe(1);
    expect(await verdict.isVisible()).toBe(true);
    expect(await verdict.evaluate((el) => el.tagName)).toBe("B");
    expect(
      await page
        .getByRole("status")
        .filter({ hasText: "Not sent. Sending did not work, but your draft is kept, so try again." })
        .count(),
    ).toBe(1);
  } finally {
    await page.close();
  }
}, 30_000);

it("explains an unreachable mail server with the studio's retry wording", async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await page.goto(`${ORIGIN}/?state=draft&device=phone&send=unreachable`);
    await page.locator('html[data-ready="1"]').waitFor();
    expect(
      await page
        .getByRole("status")
        .filter({ hasText: "It's kept in Drafts, so send it again once your mail server answers." })
        .count(),
    ).toBe(1);
  } finally {
    await page.close();
  }
}, 30_000);

for (const { width, height, zoom, face, modes } of [
  { width: 1440, height: 900, modes: ["reply", "reply-all", "forward", "new"] },
  { width: 390, height: 844, modes: ["reply", "reply-all", "forward", "new"] },
  { width: 390, height: 500, modes: ["forward", "new"] },
  ...["paper", "ohmarchy"].map((face) => ({ width: 1440, height: 700, zoom: "1.5", face, modes: ["reply"] })),
].map((config) => ({ zoom: "1", face: "paper", ...config }))) {
  for (const mode of modes) {
    it(`keeps the writing tools and caret visible in a long ${mode} at ${width}x${height} on ${face}`, async () => {
      const phone = width === 390;
      const page = await browser!.newPage({ viewport: { width, height }, hasTouch: phone });
      try {
        await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
        const params = new URLSearchParams({
          state: "draft",
          device: phone ? "phone" : "desktop",
          zoom,
          face,
        });
        if (mode !== "new") params.set("inline", mode);
        if (mode === "reply") params.set("overlimit", "1");
        await page.goto(`${ORIGIN}/?${params}`);
        await page.locator('html[data-ready="1"]').waitFor();
        const editor = page.locator(".oh-lettertext[contenteditable=true]");
        const marks = page.getByRole("toolbar", { name: "Formatting", exact: true });
        if (!(await marks.count())) await page.getByRole("button", { name: "Show formatting" }).click();
        await editor.click();
        await editor.press("End");
        const lines = Array.from(
          { length: 80 },
          (_, i) => `Workshop note ${i + 1}. The afternoon session has room for another table.`,
        );
        await editor.evaluate((el, text) => {
          const data = new DataTransfer();
          data.setData("text/plain", text);
          el.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
          );
        }, lines.join("\n"));
        expect(await editor.textContent()).toContain(lines.at(-1));
        const foot = page.getByRole("toolbar", { name: "Formatting and files" });
        const send = page.getByRole("button", { name: "Send", exact: true });
        const check = async (visibleHeight = height) => {
          // Let the reader align the growing sheet and the editor settle after the draft button wraps.
          await page.evaluate(
            () =>
              new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
          );
          const top = (await marks.boundingBox())!;
          const bottom = (await foot.boundingBox())!;
          const action = (await send.boundingBox())!;
          expect(top.y).toBeGreaterThanOrEqual(0);
          expect(bottom.y + bottom.height).toBeLessThanOrEqual(action.y);
          expect(action.y + action.height).toBeLessThanOrEqual(visibleHeight);
          const caret = await editor.evaluate(() => {
            const range = getSelection()!.getRangeAt(0).cloneRange();
            // WebKit can collapse just after a text node, where a zero-width range has no box.
            if (!range.getClientRects().length && range.startContainer.nodeType === Node.ELEMENT_NODE) {
              const previous = range.startContainer.childNodes[range.startOffset - 1];
              if (previous?.nodeType === Node.TEXT_NODE && previous.textContent?.length) {
                range.setStart(previous, previous.textContent.length - 1);
              }
            }
            const rect = range.getBoundingClientRect();
            return { y: rect.y, bottom: rect.bottom, height: rect.height };
          });
          const port = (await page.locator(".oh-composer-scroll").boundingBox())!;
          expect(caret.y).toBeGreaterThanOrEqual(port.y - 1);
          expect(caret.bottom).toBeLessThanOrEqual(port.y + port.height + 1);
          expect(
            await foot.locator("button").evaluateAll((buttons) =>
              buttons.every((button) => {
                const r = button.getBoundingClientRect();
                return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
              }),
            ),
          ).toBe(true);
          expect(caret.height).toBeGreaterThan(0);
          expect(caret.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
          expect(caret.bottom).toBeLessThanOrEqual(bottom.y + 1);
        };
        await check();
        const toolbarTop = (await marks.boundingBox())!.y;
        await editor.press("Enter");
        await page.keyboard.type("See you there.");
        await check();
        expect((await marks.boundingBox())!.y).toBeCloseTo(toolbarTop, 0);
        const body = page.locator(".oh-composer-scroll");
        expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        expect(await body.getByRole("textbox", { name: en.write.signature.label }).count()).toBe(1);
        if (mode !== "new") {
          expect(await body.getByRole("button", { name: en.write.history.show }).count()).toBe(1);
        }
        if (phone && height === 844) {
          for (const room of [400, 260, 190]) {
            await page.evaluate((h) => {
              Object.defineProperty(visualViewport!, "height", { configurable: true, get: () => h });
              visualViewport!.dispatchEvent(new Event("resize"));
            }, room);
            await check(room);
          }
        }
        if (mode === "reply" && height === 900) {
          // The resting Send still accepts a person's press and explains the refusal.
          const action = (await send.boundingBox())!;
          await page.mouse.click(action.x + action.width / 2, action.y + action.height / 2);
          const refusal = page.getByText(/Too long to send/);
          const bounds = (await refusal.boundingBox())!;
          const controls = (await foot.boundingBox())!;
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(controls.y + 1);
          expect(
            await refusal.evaluate((el) => {
              const r = el.getBoundingClientRect();
              return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            }),
          ).toBe(true);
        }
      } finally {
        await page.close();
      }
    }, 30_000);
  }
}

it.each([344, 390, 884])(
  "keeps Send and the editor above a keyboard at width %i",
  async (width) => {
    const page = await browser!.newPage({ viewport: { width, height: 844 }, hasTouch: true });
    try {
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?state=draft&device=${width <= 390 ? "phone" : "fold"}`);
      const letter = page.getByRole("region", { name: en.write.letter, exact: true });
      const editor = letter.getByRole("textbox", { name: en.write.text, exact: true });
      const send = letter.getByRole("button", { name: en.write.send, exact: true });
      await editor.focus();
      await page.evaluate(() => {
        const viewport = window.visualViewport!;
        Object.defineProperty(viewport, "height", { configurable: true, get: () => 400 });
        viewport.dispatchEvent(new Event("resize"));
      });
      await page.waitForFunction(() => {
        const pane = document.querySelector("[data-writing-keyboard]");
        return pane && pane.getBoundingClientRect().bottom <= 401;
      });
      await editor.press("End");
      await editor.press("Space");
      const action = (await send.boundingBox())!;
      const text = (await editor.boundingBox())!;
      expect(action.y).toBeGreaterThanOrEqual(0);
      expect(action.y + action.height).toBeLessThanOrEqual(400);
      expect(action.y).toBeGreaterThan(text.y);
      await expect
        .poll(() =>
          editor.evaluate((el) => {
            const range = getSelection()?.getRangeAt(0).cloneRange();
            range?.collapse(false);
            const caret = range?.getBoundingClientRect();
            const scroll = el.closest("[data-reading-scroll]")!.getBoundingClientRect();
            return Boolean(
              caret && caret.height > 0 && caret.top >= scroll.top - 1 && caret.bottom <= scroll.bottom + 1,
            );
          }),
        )
        .toBe(true);
      await expect.poll(() => letter.getByText("From", { exact: true }).isVisible()).toBe(true);
      expect(text.y).toBeLessThan(400);
      expect(await page.evaluate(() => scrollY)).toBe(0);
    } finally {
      await page.close();
    }
  },
  30_000,
);

it("edits, previews and saves signature links and formatting for a new letter", async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?signature=1&device=phone`);
    const editor = page.locator(".oh-lettertext[contenteditable=true]");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    const url = "https://example.org/workshop";
    const revised = "https://example.org/calendar";
    const address = page.getByRole("textbox", { name: en.write.link.field });
    const apply = page.getByRole("button", { name: en.write.link.apply });
    const link = page.getByRole("button", { name: en.write.marks.link, exact: true });
    await link.click();
    await address.fill(url);
    await apply.click();
    expect(await editor.locator("a").getAttribute("href", { timeout: 1500 })).toBe(url);
    expect(await editor.locator("a").evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain(
      "underline",
    );
    await page.keyboard.press("ControlOrMeta+k");
    expect(await address.inputValue()).toBe(url);
    await address.fill(revised);
    await apply.click();
    expect(await editor.locator("a").getAttribute("href")).toBe(revised);
    await link.click();
    await page.getByRole("button", { name: en.write.link.remove }).click();
    expect(await editor.locator("a").count()).toBe(0);

    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await editor.evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, revised);
    expect(await editor.locator("a").getAttribute("href", { timeout: 1500 })).toBe(revised);
    await page.keyboard.press("Enter");
    await page.keyboard.type(url + " ");
    const index = "https://example.org/index";
    await link.click();
    await address.fill(index);
    await apply.click();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.press("ControlOrMeta+i");
    await page.keyboard.type("Workshop");
    await page.getByRole("button", { name: en.write.marks.bullets }).click();

    const preview = page.locator(".oh-composer-signed .oh-lettertext");
    const markup = (el: Element) =>
      Array.from(el.querySelectorAll("a,strong,em,ul,li,br"))
        .filter((node) => !node.classList.contains("ProseMirror-trailingBreak"))
        .map((node) => [node.tagName, node.getAttribute("href")]);
    const expected = await editor.evaluate(markup);
    for (const tag of ["STRONG", "EM", "UL", "LI", "BR"]) expect(expected).toContainEqual([tag, null]);
    expect(expected).toContainEqual(["A", url]);
    expect(expected).toContainEqual(["A", revised]);
    expect(expected).toContainEqual(["A", index]);
    expect(await preview.evaluate(markup)).toEqual(expected);
    for (const surface of [editor, preview]) {
      expect(
        await surface
          .locator("strong")
          .first()
          .evaluate((el) => Number(getComputedStyle(el).fontWeight)),
      ).toBeGreaterThan(500);
      expect(
        await surface
          .locator("em")
          .first()
          .evaluate((el) => getComputedStyle(el).fontStyle),
      ).toBe("italic");
      expect(
        await surface
          .locator("ul")
          .first()
          .evaluate((el) => getComputedStyle(el).listStyleType),
      ).toBe("disc");
    }
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.reload();
    expect(await editor.evaluate(markup)).toEqual(expected);
    await page.goto(`${ORIGIN}/?state=draft&device=phone`);
    expect(await page.locator(".oh-composer-signed .oh-lettertext").evaluate(markup)).toEqual(expected);
  } finally {
    await page.close();
  }
}, 30_000);

it("edits the link before the caret where two links meet, through the keyboard and the toolbar", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?signature=1&device=desktop`);
    const editor = page.locator(".oh-lettertext[contenteditable=true]");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    const first = "https://example.org/first";
    const second = "https://example.org/second";
    const changed = "https://example.org/changed";
    await editor.evaluate((el, markup) => {
      const data = new DataTransfer();
      data.setData("text/html", markup);
      data.setData("text/plain", "OneTwo");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, `<a href="${first}">One</a><a href="${second}">Two</a>`);
    const hrefs = () =>
      editor.locator("a").evaluateAll((all) => all.map((a) => [a.textContent, a.getAttribute("href")]));
    await expect.poll(hrefs).toEqual([
      ["One", first],
      ["Two", second],
    ]);
    for (let i = 0; i < "Two".length; i += 1) await page.keyboard.press("ArrowLeft");

    const address = page.getByRole("textbox", { name: en.write.link.field });
    await page.keyboard.press("ControlOrMeta+k");
    expect(await address.inputValue(), "the dialog names the link before the caret").toBe(first);
    await address.fill(changed);
    await page.getByRole("button", { name: en.write.link.apply }).click();
    expect(await hrefs(), "Apply changes the link the dialog named").toEqual([
      ["One", changed],
      ["Two", second],
    ]);

    await page.getByRole("button", { name: en.write.marks.link, exact: true }).click();
    expect(await address.inputValue(), "the toolbar opens the same link").toBe(changed);
    await page.getByRole("button", { name: en.write.link.remove }).click();
    expect(await hrefs(), "Remove takes off the link the dialog named").toEqual([["Two", second]]);
    expect(await editor.textContent()).toContain("OneTwo");
  } finally {
    await page.close();
  }
}, 30_000);

it.each([390, 1440])(
  "keeps the signature toolbar above a long signature at %ipx",
  async (width) => {
    const phone = width === 390;
    const height = phone ? 844 : 900;
    const page = await browser!.newPage({ viewport: { width, height }, hasTouch: phone });
    try {
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${ORIGIN}/?signature=1&device=${phone ? "phone" : "desktop"}`);
      const editor = page.locator(".oh-lettertext[contenteditable=true]");
      await editor.click();
      await editor.press("End");
      await editor.evaluate((el) => {
        const data = new DataTransfer();
        data.setData(
          "text/plain",
          Array.from({ length: 80 }, (_, i) => `Workshop session ${i + 1}`).join("\n"),
        );
        el.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      });
      const scroll = page.locator(".oh-composer-scroll");
      expect((await scroll.boundingBox())!.height).toBeGreaterThan(height * 0.55);
      for (const room of phone ? [height, 350] : [height]) {
        if (room < height) {
          await page.evaluate((h) => {
            Object.defineProperty(visualViewport!, "height", { configurable: true, get: () => h });
            visualViewport!.dispatchEvent(new Event("resize"));
          }, room);
        }
        await expect
          .poll(() =>
            editor.evaluate((el, h) => {
              const port = el.closest(".oh-composer-scroll")!;
              const body = port.getBoundingClientRect();
              const bar = el
                .closest(".oh-composer-editor")!
                .querySelector('[role="toolbar"]')!
                .getBoundingClientRect();
              const caret = getSelection()!.getRangeAt(0).getBoundingClientRect();
              return (
                port.scrollTop > 0 &&
                bar.top >= 0 &&
                bar.bottom <= body.top + 1 &&
                body.bottom <= h + 1 &&
                caret.height > 0 &&
                caret.top >= body.top - 1 &&
                caret.bottom <= body.bottom + 1
              );
            }, room),
          )
          .toBe(true);
      }
    } finally {
      await page.close();
    }
  },
  30_000,
);

it("keeps a typing line, the refusal and the reply's controls above a keyboard with formatting open", async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?state=draft&device=phone&inline=reply&overlimit=1`);
    await page.locator('html[data-ready="1"]').waitFor();
    const editor = page.locator(".oh-lettertext[contenteditable=true]");
    if (!(await page.getByRole("toolbar", { name: "Formatting", exact: true }).count())) {
      await page.getByRole("button", { name: "Show formatting" }).click();
    }
    await editor.click();
    await editor.press("End");
    const lines = Array.from({ length: 80 }, (_, i) => `Workshop note ${i + 1}. Room for another table.`);
    await editor.evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, lines.join("\n"));
    const foot = page.getByRole("toolbar", { name: "Formatting and files" });
    const send = page.getByRole("button", { name: "Send", exact: true });
    const resize = async (h: number) => {
      await page.evaluate((room) => {
        Object.defineProperty(visualViewport!, "height", { configurable: true, get: () => room });
        visualViewport!.dispatchEvent(new Event("resize"));
      }, h);
      await page.evaluate(
        () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
      );
    };
    /* The whole caret line is drawn and takes a finger: the point beside its middle is the editor's. */
    const typingLine = () =>
      editor.evaluate((el) => {
        const range = getSelection()!.getRangeAt(0).cloneRange();
        range.collapse(false);
        // WebKit can collapse just after a text node, where a zero-width range has no box.
        if (!range.getClientRects().length && range.startContainer.nodeType === Node.ELEMENT_NODE) {
          const previous = range.startContainer.childNodes[range.startOffset - 1];
          if (previous?.nodeType === Node.TEXT_NODE && previous.textContent?.length) {
            range.setStart(previous, previous.textContent.length - 1);
          }
        }
        const caret = range.getBoundingClientRect();
        const box = el.closest(".oh-composer-editor")!.getBoundingClientRect();
        const scroll = el.closest(".oh-composer-scroll")!.getBoundingClientRect();
        const hit = document.elementFromPoint(
          Math.max(caret.left - 2, box.left + 2),
          caret.top + caret.height / 2,
        );
        return (
          caret.height > 0 &&
          caret.top >= Math.max(box.top, scroll.top) - 1 &&
          caret.bottom <= Math.min(box.bottom, scroll.bottom) + 1 &&
          el.contains(hit)
        );
      });
    const reachable = (locator: typeof foot) =>
      locator.evaluateAll((all) =>
        all.every((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.height > 0 && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
          );
        }),
      );

    await resize(105);
    await expect.poll(typingLine, { timeout: 1800 }).toBe(true);
    expect(await reachable(send)).toBe(true);

    await resize(844);
    const action = (await send.boundingBox())!;
    await page.mouse.click(action.x + action.width / 2, action.y + action.height / 2);
    const refusal = page.getByText(/Too long to send/);
    await refusal.waitFor();
    for (const room of [260, 190]) {
      await resize(room);
      await expect.poll(typingLine, { timeout: 1800 }).toBe(true);
      expect(await reachable(foot.locator("button")), `the reply's controls at ${room}`).toBe(true);
      expect(await reachable(refusal), `the refusal at ${room}`).toBe(true);
      expect(await reachable(send), `Send at ${room}`).toBe(true);
    }
  } finally {
    await page.close();
  }
}, 30_000);

it("keeps the Send target and typing line visible in a 105 px keyboard viewport", async () => {
  const page = await browser!.newPage({ viewport: { width: 344, height: 780 }, hasTouch: true });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`${ORIGIN}/?state=draft&device=phone`);
    const editor = page.getByRole("textbox", { name: en.write.text, exact: true });
    const send = page.getByRole("button", { name: en.write.send, exact: true });
    await editor.focus();
    const resize = (height: number) =>
      page.evaluate((h) => {
        Object.defineProperty(visualViewport!, "height", { configurable: true, get: () => h });
        visualViewport!.dispatchEvent(new Event("resize"));
      }, height);
    await editor.press("End");
    await resize(105);
    const visible = () =>
      editor.evaluate((el) => {
        const scroller = el.closest("[data-reading-scroll]")!.getBoundingClientRect();
        const range = getSelection()?.getRangeAt(0).cloneRange();
        range?.collapse(false);
        const caret = range?.getBoundingClientRect();
        return Boolean(
          caret && caret.height > 0 && caret.top >= scroller.top - 1 && caret.bottom <= scroller.bottom + 1,
        );
      });
    const sendBottom = async () => {
      const box = (await send.boundingBox())!;
      return box.y + box.height;
    };
    await expect.poll(sendBottom, { timeout: 1800 }).toBeLessThanOrEqual(105);
    await expect.poll(visible, { timeout: 1800 }).toBe(true);
    await page.keyboard.insertText(" still here");
    await expect.poll(visible, { timeout: 1800 }).toBe(true);
    expect(await sendBottom()).toBeLessThanOrEqual(105);
    const draft = await editor.textContent();
    expect(draft).toContain("still here");
    await resize(780);
    await page.waitForFunction(() => !document.querySelector("[data-writing-keyboard]"));
    await expect.poll(() => editor.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await editor.textContent()).toBe(draft);
    expect(await page.evaluate(() => scrollY)).toBe(0);
  } finally {
    await page.close();
  }
}, 30_000);

it.each([390, 1440])(
  "keeps reply tools above the Send panel at %i px",
  async (width) => {
    const phone = width === 390;
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: phone });
    try {
      await page.setContent(await replyControlsPage(phone));
      const tools = page.getByRole("toolbar", { name: "Reply tools" });
      const actions = page.getByRole("toolbar", { name: "Letter actions" });
      // The scrollport clips the composer before the pill at every scroll position.
      const scroll = page.locator("[data-reading-scroll]");
      const [port, pill] = await Promise.all([scroll.boundingBox(), actions.boundingBox()]);
      expect(port!.y + port!.height).toBeLessThanOrEqual(pill!.y);
      for (const control of [
        tools.getByRole("button", { name: "Show formatting", exact: true }),
        tools.getByRole("button", { name: "Draft again", exact: true }),
        actions.getByRole("button", { name: "Send", exact: true }),
      ]) {
        if (phone) await control.tap({ trial: true, timeout: 3000 });
        else await control.click({ trial: true, timeout: 3000 });
      }
    } finally {
      await page.close();
    }
  },
  30_000,
);

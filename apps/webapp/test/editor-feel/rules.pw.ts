/**
 * THE RULE TABLE UNDER A REAL KEYBOARD, on chromium and webkit. Every `EDITOR_RULES` id (see
 * `packages/app/src/write/editor/marks.ts`) is in a test name here; the jsdom suite pins the same rows at
 * the mechanism and its census refuses a row missing from either file. Keys are Playwright's
 * `page.keyboard` — the browser's own editing host inserts the character and ProseMirror reads
 * the DOM change, which is the path a person's keystroke takes and jsdom cannot.
 */
import { expect, test, type Page } from "@playwright/test";
import { MOD, caretAt, marksAt, openHarness, posOf, read, setDoc, settled as caughtUp } from "./writing-rig";

const A = '<a target="_blank" rel="noopener noreferrer nofollow" href="https://x.example/p">';
const MARKS: Record<string, [string, string, string]> = {
  bold: ["<strong>", "</strong>", "Bold"],
  italic: ["<em>", "</em>", "Italic"],
  strike: ["<s>", "</s>", "Strikethrough"],
  code: ["<code>", "</code>", "Inline code"],
};

/** The document's selection caught up with the DOM's (see `rig.ts`), then a read. */
async function settled(page: Page) {
  await caughtUp(page);
  return read(page);
}

async function html(page: Page): Promise<string> {
  return (await settled(page)).html;
}

test.describe("links end where you stop typing them", () => {
  test("[link-end-letter] letters and punctuation typed at the end of a link extend it", async ({ page }) => {
    await openHarness(page);
    await setDoc(page, `<p>ab ${A}cd</a> ef</p>`);
    await caretAt(page, await posOf(page, "cd"));
    await page.keyboard.type("x.");
    expect(await html(page)).toBe(`<p>ab ${A}cdx.</a> ef</p>`);
  });

  test("[link-end-space] the reported glue: a space after a link is plain, and so is everything after it", async ({ page }) => {
    await openHarness(page);
    await setDoc(page, `<p>see ${A}cd</a></p>`);
    await caretAt(page, await posOf(page, "cd"));
    await page.keyboard.type("x and more");
    expect(await html(page)).toBe(`<p>see ${A}cdx</a> and more</p>`);
  });

  test("[link-end-space] the reported flow — select a word, Ctrl+K, an address, Enter, then a space — leaves the link", async ({ page }) => {
    await openHarness(page);
    await page.keyboard.type("read this");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
    await caughtUp(page);
    await page.keyboard.press(`${MOD}+k`);
    const field = page.getByRole("dialog", { name: "Link" }).getByRole("textbox", { name: "Address" });
    await expect(field).toBeFocused();
    await field.fill("https://x.example/p");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Link" })).toHaveCount(0);
    // The selection is the linked word; End puts the caret after it, as a person would.
    await page.keyboard.press("End");
    await page.keyboard.type(" now");
    expect(await html(page)).toBe(`<p>read ${A}this</a> now</p>`);
  });

  test("[link-end-space] a line break at the end of a link starts the next line plain", async ({ page }) => {
    await openHarness(page);
    await setDoc(page, `<p>ab ${A}cd</a></p>`);
    await caretAt(page, await posOf(page, "cd"));
    await page.keyboard.press("Enter");
    await page.keyboard.type("z");
    expect(await html(page)).toBe(`<p>ab ${A}cd</a><br>z</p>`);
  });

  test("[link-start] typing before a link never joins it, mid-line or when the link opens the line", async ({ page }) => {
    await openHarness(page);
    await setDoc(page, `<p>ab ${A}cd</a> ef</p>`);
    await caretAt(page, await posOf(page, "cd", "start"));
    await page.keyboard.type("x");
    expect(await html(page)).toBe(`<p>ab x${A}cd</a> ef</p>`);
    await setDoc(page, `<p>${A}cd</a> ef</p>`, 1);
    await page.keyboard.type("x");
    expect(await html(page)).toBe(`<p>x${A}cd</a> ef</p>`);
  });

  test("[link-reenter] Backspace back to the link's last character re-enters it", async ({ page }) => {
    await openHarness(page);
    await setDoc(page, `<p>ab ${A}cd</a></p>`);
    await caretAt(page, await posOf(page, "cd"));
    await page.keyboard.type(" ");
    expect(await html(page)).toBe(`<p>ab ${A}cd</a> </p>`);
    await page.keyboard.press("Backspace");
    await page.keyboard.type("y");
    expect(await html(page)).toBe(`<p>ab ${A}cdy</a></p>`);
  });

  test("[link-self-href] a pasted address, once linked, keeps its address equal to its text as it is typed onto", async ({ page }) => {
    await openHarness(page);
    await page.keyboard.type("see ");
    await page.getByRole("textbox", { name: "Reply", exact: true }).evaluate((box) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "https://x.example/p");
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.keyboard.type(" ");
    expect(await html(page)).toBe('<p>see <a target="_blank" rel="noopener noreferrer nofollow" href="https://x.example/p">https://x.example/p</a> </p>');
    await page.keyboard.press("Backspace");
    await page.keyboard.type("q ");
    expect(await html(page)).toBe('<p>see <a target="_blank" rel="noopener noreferrer nofollow" href="https://x.example/pq">https://x.example/pq</a> </p>');
  });

  test("[autolink-punct] an address typed before a full stop or comma is linked without the punctuation", async ({ page }) => {
    await openHarness(page);
    await page.keyboard.type("see https://example.com. now");
    expect(await html(page)).toBe('<p>see <a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com">https://example.com</a>. now</p>');
    await setDoc(page, "<p></p>", 1);
    await page.keyboard.type("at www.example.com, then");
    expect(await html(page)).toBe('<p>at <a target="_blank" rel="noopener noreferrer nofollow" href="http://www.example.com">www.example.com</a>, then</p>');
    await setDoc(page, "<p></p>", 1);
    await page.keyboard.type("hello. there");
    expect(await html(page)).toBe("<p>hello. there</p>");
  });
});

test.describe("formats stay while you type, and end where Slack ends them", () => {
  for (const [mark, [o, c]] of Object.entries(MARKS)) {
    test(`[mark-end-sticky] ${mark} continues at its end; [mark-start] typing before it mid-line stays plain`, async ({ page }) => {
      await openHarness(page);
      await setDoc(page, `<p>ab ${o}cd${c} ef</p>`);
      await caretAt(page, await posOf(page, "cd"));
      await page.keyboard.type("x");
      expect(await html(page)).toBe(`<p>ab ${o}cdx${c} ef</p>`);
      await setDoc(page, `<p>ab ${o}cd${c} ef</p>`);
      await caretAt(page, await posOf(page, "cd", "start"));
      await page.keyboard.type("x");
      expect(await html(page)).toBe(`<p>ab x${o}cd${c} ef</p>`);
    });
  }

  test("[code-end-space] a space at the end of inline code leaves the code; bold keeps its space", async ({ page }) => {
    await openHarness(page);
    await setDoc(page, "<p>ab <code>cd</code></p>");
    await caretAt(page, await posOf(page, "cd"));
    await page.keyboard.type(" y");
    expect(await html(page)).toBe("<p>ab <code>cd</code> y</p>");
    await setDoc(page, "<p>ab <strong>cd</strong></p>");
    await caretAt(page, await posOf(page, "cd"));
    await page.keyboard.type(" y");
    expect(await html(page)).toBe("<p>ab <strong>cd y</strong></p>");
  });

  test("[enter-keeps] a line break keeps bold, italic and strikethrough; code and links end with the line", async ({ page }) => {
    await openHarness(page);
    for (const [mark, [o, c]] of Object.entries(MARKS)) {
      await setDoc(page, `<p>ab ${o}cd${c}</p>`);
      await caretAt(page, await posOf(page, "cd"));
      await page.keyboard.press("Enter");
      await page.keyboard.type("z");
      const kept = mark !== "code";
      expect(await html(page)).toBe(`<p>ab ${o}cd${c}<br>${kept ? `${o}z${c}` : "z"}</p>`);
    }
    await setDoc(page, "<ul><li><p><code>cd</code></p></li></ul>");
    await caretAt(page, await posOf(page, "cd"));
    await page.keyboard.press("Enter");
    await page.keyboard.type("z");
    expect(await html(page)).toBe("<ul><li><p><code>cd</code></p></li><li><p>z</p></li></ul><p></p>");
  });

  test("[toggle-sticky] Ctrl+B with nothing selected carries until toggled off; a caret move drops an untyped toggle", async ({ page }) => {
    await openHarness(page);
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.type("ab");
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.type("c");
    expect(await html(page)).toBe("<p><strong>ab</strong>c</p>");
    await page.keyboard.press(`${MOD}+i`);
    expect((await settled(page)).stored).toEqual(["italic"]);
    // The caret moves one left, between the bold "ab" and the plain "c": the untyped italic is
    // gone, and what the letter carries is the bold it now stands at the end of.
    await page.keyboard.press("ArrowLeft");
    await caughtUp(page);
    await page.keyboard.type("x");
    expect(await html(page)).toBe("<p><strong>abx</strong>c</p>");
  });

  test("[list-empty-enter] Enter on an empty middle item takes it out of the list", async ({ page }) => {
    await openHarness(page);
    await setDoc(page, "<ul><li><p>one</p></li><li><p></p></li><li><p>three</p></li></ul>");
    await caretAt(page, (await posOf(page, "one")) + 4);
    await page.keyboard.press("Enter");
    expect(await html(page)).toBe("<ul><li><p>one</p></li></ul><p></p><ul><li><p>three</p></li></ul><p></p>");
  });
});

test.describe("the toolbar says what the next letter carries", () => {
  test("[toolbar-next] each mark button lights exactly when the next letter would carry it", async ({ page }) => {
    await openHarness(page);
    for (const [, [o, c, label]] of Object.entries(MARKS)) {
      await setDoc(page, `<p>ab ${o}cd${c} ef</p>`);
      await caretAt(page, await posOf(page, "cd"));
      await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
      await caretAt(page, await posOf(page, "cd", "start"));
      await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "false");
    }
    // After a typed space at the end of code the button reads what the next letter carries: nothing.
    await setDoc(page, "<p>ab <code>cd</code></p>");
    await caretAt(page, await posOf(page, "cd"));
    await page.keyboard.type(" ");
    await expect(page.getByRole("button", { name: "Inline code", exact: true })).toHaveAttribute("aria-pressed", "false");
  });

  test("[link-not-toggle] the link button claims no pressed state; it opens the dialog, which edits the link the caret ends", async ({ page }) => {
    await openHarness(page);
    await setDoc(page, `<p>ab ${A}cd</a></p>`);
    await caretAt(page, await posOf(page, "cd"));
    const link = page.getByRole("button", { name: "Link", exact: true });
    await expect(link).not.toHaveAttribute("aria-pressed");
    await expect(link).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press(`${MOD}+k`);
    await expect(link).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("dialog", { name: "Link" }).getByRole("textbox", { name: "Address" })).toHaveValue("https://x.example/p");
    await page.keyboard.press("Escape");
    await expect(link).toHaveAttribute("aria-expanded", "false");
  });

  test("[one-caret] arrow keys move one caret, the surface keeps focus through a toolbar click, and no arrow writes", async ({ page }) => {
    await openHarness(page);
    await page.keyboard.type("line one");
    await page.keyboard.press("Enter");
    await page.keyboard.type("line two");
    await page.keyboard.press("ArrowUp");
    await caughtUp(page);
    let s = await settled(page);
    expect([s.rangeCount, s.collapsed, s.activeIsSurface, s.editables, s.gapcursors]).toEqual([1, true, true, 1, 0]);
    await page.keyboard.press("ArrowDown");
    await caughtUp(page);
    s = await settled(page);
    expect([s.rangeCount, s.collapsed, s.activeIsSurface, s.editables, s.gapcursors]).toEqual([1, true, true, 1, 0]);
    // A toolbar press is a real mouse click; the editor stays the focus owner THROUGHOUT — read as
    // "no blur left the surface during the press", because the command's own focus() would bring
    // focus back a frame later and hide a focus that had left.
    await page.evaluate(() => {
      (window as unknown as { __blurs: number }).__blurs = 0;
      window.__rte.editor!.view.dom.addEventListener("blur", () => { (window as unknown as { __blurs: number }).__blurs += 1; });
    });
    await page.getByRole("button", { name: "Bold", exact: true }).click();
    s = await settled(page);
    expect(s.activeIsSurface).toBe(true);
    expect(s.rangeCount).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { __blurs: number }).__blurs)).toBe(0);
    // No arrow key writes a character, at the end of code or of a link.
    for (const doc of ["<p>ab <code>cd</code></p>", `<p>ab ${A}cd</a></p>`]) {
      await setDoc(page, doc);
      await caretAt(page, await posOf(page, "cd"));
      await page.keyboard.press("ArrowRight");
      await caughtUp(page);
      await page.keyboard.press("ArrowLeft");
      await caughtUp(page);
      await page.keyboard.press("ArrowRight");
      expect(await html(page)).toBe(doc);
    }
  });
});

test("what leaves the editor is pinned: every construct serialises as before this change", async ({ page }) => {
  await openHarness(page);
  const doc =
    "<p>a <strong>b</strong> <em>c</em> <s>d</s> <code>e</code> " +
    '<a target="_blank" rel="noopener noreferrer nofollow" href="https://x.example/">f</a><br>g</p>' +
    "<ul><li><p>h</p></li></ul><ol><li><p>i</p></li></ol><blockquote><p>j</p></blockquote><pre><code>k</code></pre>";
  await setDoc(page, doc);
  // The trailing `<p></p>` is StarterKit's `TrailingNode`, shipped before this change.
  expect(await html(page)).toBe(`${doc}<p></p>`);
  expect(await marksAt(page, await posOf(page, "f", "start"))).toEqual(["link"]);
});

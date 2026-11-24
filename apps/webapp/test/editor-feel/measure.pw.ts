/**
 * MEASUREMENT, not judgement: what each mark does at its END, its START and INSIDE when a real key
 * types a letter, a space, Enter. Writes one JSON line per cell to build/editor-feel/measure-<browser>.jsonl
 * and prints the table. The rules spec (`rules.pw.ts`) is where the same cells become assertions.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "@playwright/test";
import { caretAt, openHarness, posOf, read, setDoc } from "./writing-rig";

const OUT = resolve(__dirname, "../../../../build/editor-feel");
const MARKS: Record<string, string> = {
  bold: "<strong>cd</strong>",
  italic: "<em>cd</em>",
  strike: "<s>cd</s>",
  code: "<code>cd</code>",
  link: '<a href="https://x.example/p">cd</a>',
};
const rows: Record<string, unknown>[] = [];
const row = (r: Record<string, unknown>) => { rows.push(r); };

test.describe.configure({ mode: "serial" });

test("marks at END / START / INSIDE, typed by a real keyboard", async ({ page, browserName }) => {
  await openHarness(page);
  for (const [mark, frag] of Object.entries(MARKS)) {
    // END: a letter, then a space, then a letter.
    await setDoc(page, `<p>ab ${frag} ef</p>`);
    await caretAt(page, await posOf(page, "cd", "end"));
    const atEnd = await read(page);
    await page.keyboard.type("x");
    const afterX = await read(page);
    await page.keyboard.type(" ");
    const afterSpace = await read(page);
    await page.keyboard.type("y");
    const afterY = await read(page);
    row({ mark, site: "end", toolbar: atEnd.pressed, next: atEnd.next, x: afterX.before, space: afterSpace.before, y: afterY.before, html: afterY.html });

    // START, mid-paragraph (plain text before the mark).
    await setDoc(page, `<p>ab ${frag} ef</p>`);
    await caretAt(page, await posOf(page, "cd", "start"));
    const atStart = await read(page);
    await page.keyboard.type("x");
    row({ mark, site: "start-mid", toolbar: atStart.pressed, next: atStart.next, x: (await read(page)).before, html: (await read(page)).html });

    // START, at the paragraph's first position (the mark opens the paragraph).
    await setDoc(page, `<p>${frag} ef</p>`);
    await caretAt(page, await posOf(page, "cd", "start"));
    const atP0 = await read(page);
    await page.keyboard.type("x");
    row({ mark, site: "start-p0", toolbar: atP0.pressed, next: atP0.next, x: (await read(page)).before, html: (await read(page)).html });

    // INSIDE.
    await setDoc(page, `<p>ab ${frag} ef</p>`);
    await caretAt(page, (await posOf(page, "cd", "start")) + 1);
    await page.keyboard.type("x");
    row({ mark, site: "inside", x: (await read(page)).before, html: (await read(page)).html });

    // Enter at the END, then a letter (Enter is a hard break here).
    await setDoc(page, `<p>ab ${frag}</p>`);
    await caretAt(page, await posOf(page, "cd", "end"));
    await page.keyboard.press("Enter");
    const afterEnter = await read(page);
    await page.keyboard.type("z");
    row({ mark, site: "enter-end", nextAfterEnter: afterEnter.next, toolbarAfterEnter: afterEnter.pressed, z: (await read(page)).before, html: (await read(page)).html });

    // Toggle pressed with nothing selected, then Enter, then a letter.
    await setDoc(page, `<p>ab </p>`);
    await caretAt(page, 4);
    const label = { bold: "Bold", italic: "Italic", strike: "Strikethrough", code: "Code", link: null }[mark];
    if (label) {
      await page.getByRole("button", { name: label, exact: true }).click();
      const toggled = await read(page);
      await page.keyboard.press("Enter");
      const afterEnter2 = await read(page);
      await page.keyboard.type("z");
      row({ mark, site: "toggle-enter", stored: toggled.stored, nextAfterEnter: afterEnter2.next, z: (await read(page)).before, html: (await read(page)).html });
    }
  }

  // The reported glue: a link, letters typed at its end, a space, more letters.
  await setDoc(page, `<p>see <a href="https://x.example/p">cd</a></p>`);
  await caretAt(page, await posOf(page, "cd", "end"));
  await page.keyboard.type("x and more");
  row({ site: "link-glue", html: (await read(page)).html });

  // Autolink with trailing punctuation then a space.
  await setDoc(page, `<p></p>`, 1);
  await page.keyboard.type("see https://example.com. now");
  row({ site: "autolink-punct", html: (await read(page)).html });

  // ArrowRight at the END of the block inside a link / code (Tiptap's `exitable`).
  for (const mark of ["link", "code"]) {
    await setDoc(page, `<p>ab ${MARKS[mark]}</p>`);
    await caretAt(page, await posOf(page, "cd", "end"));
    await page.keyboard.press("ArrowRight");
    row({ mark, site: "arrowright-blockend", html: (await read(page)).html, next: (await read(page)).next });
  }

  // Enter on an EMPTY list item in the MIDDLE of a list.
  await setDoc(page, `<ul><li><p>one</p></li><li><p></p></li><li><p>three</p></li></ul>`);
  await caretAt(page, (await posOf(page, "one", "end")) + 4);
  const mid = await read(page);
  await page.keyboard.press("Enter");
  row({ site: "enter-empty-middle-item", parentBefore: mid.parent, html: (await read(page)).html });

  // Selection/focus facts after arrow keys across a paragraph boundary.
  await setDoc(page, `<p>one</p><p>two</p>`, 2);
  await page.keyboard.press("ArrowDown");
  const dn = await read(page);
  row({ site: "arrowdown-paragraphs", rangeCount: dn.rangeCount, collapsed: dn.collapsed, activeIsSurface: dn.activeIsSurface, editables: dn.editables, gapcursors: dn.gapcursors, pos: dn.pos });

  mkdirSync(OUT, { recursive: true });
  const file = resolve(OUT, `measure-${browserName}.jsonl`);
  writeFileSync(file, "");
  for (const r of rows) appendFileSync(file, JSON.stringify(r) + "\n");
  console.log(`MEASURE ${browserName} rows=${rows.length} → ${file}`);
});

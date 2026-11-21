import { expect, test } from "@playwright/test";
import { openHarness, read } from "./writing-rig";

test("the harness mounts the real editor and a real keystroke reaches the document", async ({ page }) => {
  await openHarness(page);
  await page.keyboard.type("hello");
  const s = await read(page);
  expect(s.html).toBe("<p>hello</p>");
  expect(s.activeIsSurface).toBe(true);
  expect(s.editables).toBe(1);
  expect(await page.getByRole("status", { name: "Editor value" }).textContent()).toContain('"text":"hello"');
  expect(Object.keys(s.pressed).sort()).toEqual(
    ["Bold", "Bulleted list", "Code", "Italic", "Link", "Numbered list", "Quote", "Strikethrough", "Underline"],
  );
});

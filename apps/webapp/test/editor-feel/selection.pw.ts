import { expect, test } from "@playwright/test";
import { caretAt, openHarness, posOf, read, setDoc, settled } from "./writing-rig";

test("Enter starts a new line after leaving a formatted selection", async ({ page }) => {
  await openHarness(page);
  await page.keyboard.type("Bring a spare notebook.");
  await page.keyboard.press("ArrowLeft");
  for (const _ of "notebook") await page.keyboard.press("Shift+ArrowLeft");
  await settled(page);
  await page.getByRole("button", { name: "Strikethrough", exact: true }).click();
  await page.getByRole("button", { name: "Underline", exact: true }).click();
  const body = page.getByRole("textbox", { name: "Reply", exact: true });
  await expect(body.locator("s u, u s")).toHaveText("notebook");
  await expect(body).toBeFocused();

  // Move to the end of the line and press Enter before the queued selectionchange runs.
  await body.evaluate((surface) => {
    const lastText = surface.querySelector("p")!.lastChild!;
    document.getSelection()!.collapse(lastText, lastText.textContent!.length);
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
  });
  await page.keyboard.type("See you later.");

  await expect(body).toHaveText("Bring a spare notebook.See you later.");
  await expect(body.locator("s u, u s")).toHaveText("notebook");
  await settled(page);
  expect((await read(page)).html).toContain(".<br>See you later.</p>");
});

test("Enter still replaces a word that remains selected", async ({ page }) => {
  await openHarness(page);
  await setDoc(page, "<p>Bring a spare <s>notebook</s>.</p>");
  await caretAt(page, await posOf(page, "notebook"));
  for (const _ of "notebook") await page.keyboard.press("Shift+ArrowLeft");
  await settled(page);
  await page.keyboard.press("Enter");
  await settled(page);
  expect((await read(page)).html).toBe("<p>Bring a spare <br>.</p>");
});

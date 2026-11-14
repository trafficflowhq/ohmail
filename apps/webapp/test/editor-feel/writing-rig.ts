import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type Page } from "@playwright/test";
import type { CaretState } from "./rig";

export { MOD, caretAt, marksAt, posOf, setDoc, settled } from "./rig";

let harness: string | undefined;

/** A worker builds its own page once. An external measurement can hand in a prebuilt directory. */
export async function openHarness(page: Page, options: { height?: number } = {}): Promise<void> {
  if (!harness) {
    const external = process.env.EDITOR_FEEL_OUT;
    const out = external
      ? resolve(__dirname, "../../../..", external)
      : resolve(test.info().project.outputDir, `writing-${test.info().workerIndex}`);
    if (!external) execFileSync(process.execPath, [resolve(__dirname, "build-writing-harness.mjs"), "--out", out]);
    harness = resolve(out, "writing.html");
  }
  const url = pathToFileURL(harness);
  if (options.height !== undefined) url.searchParams.set("height", String(options.height));
  await page.goto(url.href);
  await page.getByRole("toolbar", { name: "Formatting", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Reply", exact: true }).click();
}

export async function read(page: Page): Promise<CaretState> {
  return page.evaluate(() => {
    const ed = window.__rte.editor!;
    const { state } = ed;
    const $from = state.selection.$from;
    const names = (ms: readonly { type: { name: string } }[]) => ms.map((m) => m.type.name).sort();
    const next = names(state.storedMarks ?? $from.marks());
    const before = $from.nodeBefore ? names($from.nodeBefore.marks) : null;
    const after = $from.nodeAfter ? names($from.nodeAfter.marks) : null;
    const pressed: Record<string, string | null> = {};
    for (const b of document.querySelectorAll<HTMLButtonElement>('[role="toolbar"][aria-label="Formatting"] button')) {
      pressed[b.getAttribute("aria-label") ?? "?"] = b.getAttribute("aria-pressed");
    }
    const sel = document.getSelection();
    return {
      html: ed.getHTML(),
      next,
      before,
      after,
      stored: state.storedMarks ? names(state.storedMarks) : null,
      pressed,
      rangeCount: sel ? sel.rangeCount : -1,
      collapsed: sel ? sel.isCollapsed : false,
      activeIsSurface: document.activeElement === ed.view.dom,
      editables: document.querySelectorAll('[contenteditable="true"]').length,
      gapcursors: document.querySelectorAll(".ProseMirror-gapcursor").length,
      pos: $from.pos,
      parent: $from.parent.type.name,
    };
  });
}

import type { Locator, Page } from "@playwright/test";

/**
 * What a person does to a control. The journey says the act; how a surface performs it is here.
 * A keyboard act presses the key the control itself announces (`aria-keyshortcuts`), so no key of
 * the product is written a second time.
 */
export interface Act {
  id: string;
  web: (target: Locator, page: Page, value?: string) => Promise<void>;
}

/** `aria-keyshortcuts` names its first chord as the keyboard API wants it ("Shift+F", "r"). */
async function announcedKey(target: Locator): Promise<string> {
  const keys = (await target.getAttribute("aria-keyshortcuts"))?.trim() ?? "";
  if (keys === "") throw new Error("this control announces no keyboard shortcut");
  return keys.split(/\s+/)[0]!;
}

export const ACTS = {
  press: { id: "press", web: (target) => target.click() },
  /**
   * Fill a box, once, and see that it holds what was typed. Words a box drops are a fault, never typed again, and never
   * printed. The person is in the box before the first letter, as a person is: the box left (a recipient line that
   * takes its words as it is left) has answered first, not in the same instant as the first letter typed here.
   */
  type: {
    id: "type",
    web: async (target, _page, value = "") => {
      await target.focus();
      await target.fill(value);
      const holds = await target.inputValue();
      // The count, never the words: what a journey types can be a password, and the message goes into a public log.
      if (holds !== value) throw new Error(`the box did not keep what was typed: it holds ${holds.length} of the ${value.length} characters`);
    },
  },
  /** Letter by letter, for an editor that reacts to each key. */
  write: { id: "write", web: (target, _page, value = "") => target.pressSequentially(value) },
  shortcut: {
    id: "shortcut",
    web: async (target, page) => page.keyboard.press(await announcedKey(target)),
  },
  /** A key the person presses with the control in focus; the key is the journey's, never the product's. */
  keyIn: {
    id: "keyIn",
    web: async (target, _page, value = "") => target.press(value),
  },
  /** Roll the wheel over the control, by `value` pixels. */
  wheel: {
    id: "wheel",
    web: async (target, page, value = "600") => {
      await target.hover();
      await page.mouse.wheel(0, Number(value));
    },
  },
} as const satisfies Record<string, Act>;

export type ActId = keyof typeof ACTS;

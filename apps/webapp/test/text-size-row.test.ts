/** @vitest-environment jsdom */
/**
 * SETTINGS → TEXT SIZE, THE ROW's PRESS: it stores the size first, then applies it through the host's door.
 * Moved word for word from `text-size.test.ts` (whose other cases read only the kept `text-size.ts`): the row is
 * today's `TextSizeRow`, which waits for the General pane's mount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEXT_SIZE_KEY, installTextSizeApplier } from "../app/shell/text-size";
import { setTextSize } from "../app/shell/TextSizeRow";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  installTextSizeApplier(null);
});
afterEach(() => {
  installTextSizeApplier(null);
  vi.restoreAllMocks();
});

describe("the host's door", () => {
  it("the row's press stores the size, then applies it through the door", () => {
    const order: string[] = [];
    installTextSizeApplier((n) => order.push(`apply ${n} stored=${localStorage.getItem(TEXT_SIZE_KEY)}`));
    setTextSize(125);
    expect(localStorage.getItem(TEXT_SIZE_KEY)).toBe("125");
    expect(order).toEqual(["apply 125 stored=125"]);
  });
});

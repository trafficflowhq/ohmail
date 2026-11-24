/** @vitest-environment jsdom */
/**
 * THE REPLY's TEXT TAKES THE KEYS WITHOUT SCROLLING THE READING COLUMN (the switch's point 66, PART B): the column
 * counts a scroll under a resting pointer as the person's reading, so the editor taking the keys at its mount, or
 * when a part of the reply hands them back (`EditorHandle.focus`), must not scroll the letters above it.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { EditorHandle } from "../../src/write/ports.js";
import { plainEditor } from "../../src/write/plain/index.js";

let focus: MockInstance<(options?: FocusOptions) => void>;
beforeEach(() => {
  focus = vi.spyOn(HTMLElement.prototype, "focus");
});
afterEach(() => {
  focus.mockRestore();
  cleanup();
});

describe("the plain editor's focus", () => {
  it("at its mount and through its handle asks the browser not to scroll", () => {
    const Editor = plainEditor;
    let handle: EditorHandle | null = null;
    render(
      <Editor
        value={{ text: "", html: "" }}
        onChange={() => undefined}
        label="Reply body"
        placeholder=""
        editable
        focusAtMount
        onSendKey={() => undefined}
        onLeaveKey={() => undefined}
        onHandle={(h) => {
          handle = h;
        }}
      />,
    );
    expect(handle).not.toBeNull();
    (handle as EditorHandle | null)?.focus({ preventScroll: true });
    expect(focus.mock.calls.length, "the editor took no keys").toBe(2);
    expect(focus.mock.calls.map(([options]) => options?.preventScroll)).toEqual([true, true]);
  });
});

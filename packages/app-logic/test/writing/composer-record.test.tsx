/** @vitest-environment jsdom */
import { cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerContext, useComposer } from "../../src/writing/composer-record.js";
import type { ShellCompose } from "../../src/writing/shell-compose.js";

/**
 * THE ONE COMPOSER'S RECORD, read where its one mount stands above: the send machine, the drafts' doors, the line a
 * notice says. Without its provider the reader throws its own sentence: no part beside the composer sends, saves or
 * says a send's state over a machine of its own.
 */

afterEach(cleanup);

describe("the reader of the one composer's record", () => {
  it("throws its own sentence where no composer stands above", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useComposer())).toThrow(
      "useComposer: no composer stands above (ComposerContext)",
    );
    quiet.mockRestore();
  });

  it("answers the very record its provider hands", () => {
    const record = { mailSend: {} } as unknown as ShellCompose;
    const under = ({ children }: { children: ReactNode }) =>
      createElement(ComposerContext.Provider, { value: record }, children);
    expect(renderHook(() => useComposer(), { wrapper: under }).result.current).toBe(record);
  });
});

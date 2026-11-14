/** @vitest-environment jsdom */
import { cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OhboxReplyDone } from "../../src/ohbox/index.js";
import { ReplyDoneContext, useReplyDone } from "../../src/writing/reply-done.js";

/**
 * THE REPLY THAT LAST SETTLED, read where the one composer stands above: never a guess where none does. Without its
 * provider the reader throws its own sentence; under one it answers what that provider hands, a settled reply or none.
 */

afterEach(cleanup);

const under = (value: OhboxReplyDone | null) =>
  function Provides({ children }: { children: ReactNode }) {
    return createElement(ReplyDoneContext.Provider, { value }, children);
  };

describe("the reader of the reply that last settled", () => {
  it("throws its own sentence where nothing stands above", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useReplyDone())).toThrow(
      "useReplyDone: no composer stands above (ReplyDoneContext)",
    );
    quiet.mockRestore();
  });

  it("answers what its provider hands: the reply that settled, or none yet", () => {
    const done: OhboxReplyDone = { messageId: "m1", at: "2026-11-17T16:00:00.000Z" };
    expect(renderHook(() => useReplyDone(), { wrapper: under(done) }).result.current).toBe(done);
    expect(renderHook(() => useReplyDone(), { wrapper: under(null) }).result.current).toBeNull();
  });
});

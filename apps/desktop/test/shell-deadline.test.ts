import { describe, expect, it, vi } from "vitest";

import { SHELL_DEADLINE_MS, withDeadline } from "../src/shell-deadline.js";

/**
 * THE DEFAULT IS THE BOUND. A call that names no deadline is bounded by one minute; a call that
 * names 0, a negative, `NaN` or `undefined` is refused by name and never sent, so no caller can
 * reach "no deadline" by accident.
 */
describe("the shell deadline", () => {
  it("a call that names no deadline is bounded by the one minute", async () => {
    vi.useFakeTimers();
    try {
      const verdict = withDeadline("the app", () => new Promise(() => {}))
        .then(() => "answered", (err: Error) => err.name);
      await vi.advanceTimersByTimeAsync(SHELL_DEADLINE_MS - 1);
      expect(await Promise.race([verdict, Promise.resolve("still pending")])).toBe("still pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(await verdict).toBe("BridgeDeadlineError");
    } finally {
      vi.useRealTimers();
    }
  });

  for (const ms of [0, -1, Number.NaN, undefined]) {
    it(`a deadline of ${String(ms)} is refused by name and nothing is sent`, async () => {
      let sent = 0;
      const verdict = await withDeadline("the app", async () => { sent += 1; }, { ms })
        .then(() => "answered", (err: Error) => err.name);
      expect(verdict).toBe("DeadlineMissingError");
      expect(sent).toBe(0);
    });
  }
});

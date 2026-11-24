/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { modelOf, mountPlace } from "./screener-world.js";

afterEach(cleanup);

it("offers undecided mail only when the model names it and waits for the press", () => {
  const asked = { flushes: 0 };
  mountPlace(modelOf(asked, { unscreened: null }));
  expect(screen.queryByRole("button", { name: /^Screen \d/ })).toBeNull();
  cleanup();

  const move = vi.fn();
  mountPlace(
    modelOf(asked, {
      unscreened: { total: 12, atLeast: true, groups: [], screening: false, screen: move },
    }),
  );
  expect(screen.getByText(/At least 12 messages from senders you have not decided about/)).toBeTruthy();
  expect(move).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /^Screen 12/ }));
  expect(move).toHaveBeenCalledTimes(1);
});

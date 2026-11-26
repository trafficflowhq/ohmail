/** @vitest-environment jsdom */
import { lazyView } from "@ohmail/app/frame";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(cleanup);

it("retries a refused preload and draws the loaded view on the first render", async () => {
  const load = vi.fn()
    .mockRejectedValueOnce(new Error("Loading chunk failed"))
    .mockResolvedValue({ default: () => <p>Loaded</p> });
  const loading = vi.fn();
  const View = lazyView(load, { loading });
  await expect(View.preload()).rejects.toThrow("Loading chunk failed");
  await View.preload();
  render(<View />);
  expect(screen.getByText("Loaded")).not.toBeNull();
  expect(loading).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(2);
});

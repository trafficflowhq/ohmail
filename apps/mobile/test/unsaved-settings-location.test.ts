/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { nothingMounted, phoneFrameSupplies } from "../web/src/frame-supplies";

afterEach(() => window.history.replaceState(null, "", "/"));

it("keeps native on the edited section until the person discards", async () => {
  const at = "#/settings/away";
  window.history.replaceState(null, "", at);
  const kept = vi.fn();
  const { address } = phoneFrameSupplies(nothingMounted(), at, kept);
  let resume: (() => void) | undefined;
  const release = address.holdLeave((leave) => { resume = leave; }, at);
  try {
    window.location.hash = "#/history";
    expect(address.read()).toBe(at);
    await new Promise(r => setTimeout(r, 20));
    expect(window.location.hash).toBe(at);
    expect(kept).not.toHaveBeenCalled();
    expect(resume).toBeTypeOf("function");
    resume!();
    await new Promise(r => setTimeout(r, 20));
    expect(kept.mock.calls).toEqual([["#/history"]]);
  } finally { release(); }
});

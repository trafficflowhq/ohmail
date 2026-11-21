/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { OhmailEngine } from "@ohmail/client-engine";
import { POLL_MS, startSyncScheduler } from "@ohmail/app-logic/session/sync-scheduler";
import { FixturesAdapter } from "@ohmail/testing/adapter";

it("waits for the browser to reconnect before polling, then syncs promptly", async () => {
  vi.useFakeTimers();
  let connected = false;
  const network = vi.spyOn(navigator, "onLine", "get").mockImplementation(() => connected);
  const adapter = new FixturesAdapter();
  const sync = vi.spyOn(adapter, "sync");
  const stop = startSyncScheduler(new OhmailEngine({ adapter }), { visibility: null });
  try {
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(sync).not.toHaveBeenCalled();
    connected = true;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    network.mockRestore();
    vi.useRealTimers();
  }
});

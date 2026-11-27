import { expect, it, vi } from "vitest";
import { HttpAdapter, OhmailEngine } from "@ohmail/client-engine";
import { createSyncGate } from "../../src/session/sync-scheduler.js";

it("reads a selected original through the live browser's account gate", async () => {
  const bytes = new Uint8Array([0, 128, 255]);
  const fetch = vi.fn(
    async () =>
      new Response(bytes, {
        headers: { "Content-Type": "application/octet-stream" },
      }),
  );
  const adapter = new HttpAdapter({ baseUrl: "http://wire.test", fetch, getCookie: () => null });
  const engine = new OhmailEngine({ adapter: createSyncGate(null).guard(adapter) });
  const source = await engine.fetchForwardSource("letter", 100);
  expect(new Uint8Array(await source.arrayBuffer())).toEqual(bytes);
  expect(fetch).toHaveBeenCalledTimes(1);
});

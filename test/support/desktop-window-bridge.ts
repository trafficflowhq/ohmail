/// <reference path="../../apps/desktop/src/build-flags.d.ts" />
import { vi } from "vitest";
import { createLocalEngine } from "../../apps/desktop/src/bridge-fetch.js";

/** Connect the real desktop window engine to a test handler through the native request frame. */
export function desktopWindowThrough(scope: string, handle: (url: string, method: string) => Promise<Response>) {
  vi.stubGlobal("__TAURI_INTERNALS__", {
    invoke: async (command: string, request: { url: string; method: string }) => {
      if (command !== "engine_request") throw new Error(`unexpected command: ${command}`);
      const response = await handle(request.url, request.method);
      const meta = new TextEncoder().encode(JSON.stringify({ status: response.status, h: [...response.headers] }));
      const body = new Uint8Array(await response.arrayBuffer());
      const frame = new Uint8Array(4 + meta.length + body.length);
      new DataView(frame.buffer).setUint32(0, meta.length);
      frame.set(meta, 4);
      frame.set(body, 4 + meta.length);
      return frame;
    },
  });
  return createLocalEngine(scope);
}

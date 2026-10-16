import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_MAX_FETCH_BYTES, SEND_STAGED_OBJECT_MAX_BYTES } from "@trafficflow/services/mail";
import { COMPOSE_ATTACH_MAX_TOTAL_BYTES, COMPOSE_ATTACH_STAGED_SURFACE_BYTES } from "@ohmail/client-engine";

/**
 * WHAT OHMAIL SENDS, OHMAIL OPENS. The single-download ceiling (`ATTACHMENT_MAX_FETCH_BYTES`) sat
 * at 32 MiB while the desktop and the hosted browser sent 40 MiB, so a file somebody sent could not
 * be opened when it came back. Every send ceiling of every door is held at or under the open
 * ceiling, and the desktop shell's own write cap equal to it. The constants that live in source a
 * root test does not import (the Rust shell, the window, the hosts) are read from their files.
 */

const REPO = join(import.meta.dirname, "..");

/** `NAME = <n> * 1024 * 1024` in one file, as bytes. */
function mibConstant(file: string, name: string): number {
  const text = readFileSync(join(REPO, file), "utf8");
  const m = new RegExp(`\\b${name}\\b[^=\\n]*=\\s*(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024\\s*;`).exec(text);
  if (!m) throw new Error(`${name} is not a "<n> * 1024 * 1024" constant in ${file}`);
  return Number(m[1]) * 1024 * 1024;
}

const SEND_CEILINGS: ReadonlyArray<readonly [string, number]> = [
  ["services SEND_STAGED_OBJECT_MAX_BYTES", SEND_STAGED_OBJECT_MAX_BYTES],
  ["client-engine COMPOSE_ATTACH_STAGED_SURFACE_BYTES", COMPOSE_ATTACH_STAGED_SURFACE_BYTES],
  ["client-engine COMPOSE_ATTACH_MAX_TOTAL_BYTES", COMPOSE_ATTACH_MAX_TOTAL_BYTES],
  ["desktop DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES",
    mibConstant("apps/desktop/src/desktop-send-surface.ts", "DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES")],
  ["desktop HOST_CLIENT_SEND_MAX_TOTAL_BYTES",
    mibConstant("apps/desktop/src/host-client/HostGate.tsx", "HOST_CLIENT_SEND_MAX_TOTAL_BYTES")],
  ["sidecar HOST_SEND_MAX_TOTAL_BYTES", mibConstant("apps/sidecar/src/host-listener.ts", "HOST_SEND_MAX_TOTAL_BYTES")],
  ["phone host HOST_SEND_MAX_TOTAL_BYTES", mibConstant("apps/sidecar/src/phone/host-listener.ts", "HOST_SEND_MAX_TOTAL_BYTES")],
  ["self-host SELF_HOST_SEND_MAX_TOTAL_BYTES", mibConstant("apps/server/src/config.ts", "SELF_HOST_SEND_MAX_TOTAL_BYTES")],
];

describe("the open ceiling is pinned to the send ceilings", () => {
  it.each(SEND_CEILINGS)("%s is at or under the single-download ceiling", (_name, sendMax) => {
    expect(sendMax).toBeLessThanOrEqual(ATTACHMENT_MAX_FETCH_BYTES);
  });

  it("the open ceiling is the largest send ceiling, not an unrelated larger number", () => {
    expect(ATTACHMENT_MAX_FETCH_BYTES).toBe(Math.max(...SEND_CEILINGS.map(([, n]) => n)));
  });

  it("the desktop shell writes exactly what the service fetches", () => {
    expect(mibConstant("apps/desktop/src-tauri/src/engine.rs", "ATTACHMENT_MAX_BYTES")).toBe(ATTACHMENT_MAX_FETCH_BYTES);
  });
});

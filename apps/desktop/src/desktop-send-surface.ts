/**
 * WHAT ONE SEND FROM THIS WINDOW CAN CARRY, per door. Every send's attachments cross the bridge
 * as base64 inside the queued change the window records (`window-outbox.ts`, 63 MiB per write,
 * under the shell's 64 MiB frame) before anything leaves this computer, so 40 MiB of files is
 * this window's ceiling on every door, whatever the mail server would take — the same number the
 * hosted browser stages to. The hosted door stages its bytes to storage (`stagesAttachments`);
 * a self-hosted server takes its own 32 MiB inline; only the paired door declares nothing and
 * keeps the strict inline constant.
 */
import { COMPOSE_ATTACH_STAGED_SURFACE_BYTES } from "@ohmail/client-engine";
import type { EngineStatus } from "./bridge-fetch.js";
import { flavorOf } from "./doors.js";

/** Raw attachment bytes one send from this window carries — base64 plus the message fit one write. */
export const DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES = 40 * 1024 * 1024;

/** What every self-hosted server takes inline in one send (its `SELF_HOST_SEND_MAX_TOTAL_BYTES`). */
export const DESKTOP_SELFHOST_SEND_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** The hosted door, and only it, stages attachment bytes to the account's storage. */
export function stagesAttachments(status: EngineStatus | null): boolean {
  return flavorOf(status) === "managed";
}

/**
 * The compose surface this door declares: a number, or `undefined` for a door that keeps the
 * strict inline constant. Never `null`: no door of this window is uncapped.
 */
export function desktopSendSurface(status: EngineStatus | null): number | undefined {
  if (status?.mode === "local") return DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES;
  if (stagesAttachments(status)) {
    return Math.min(DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES, COMPOSE_ATTACH_STAGED_SURFACE_BYTES);
  }
  if (flavorOf(status) === "selfhost") {
    return Math.min(DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES, DESKTOP_SELFHOST_SEND_MAX_TOTAL_BYTES);
  }
  return undefined;
}

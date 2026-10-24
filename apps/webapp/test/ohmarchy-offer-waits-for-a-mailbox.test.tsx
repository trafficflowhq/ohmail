/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import type { MailboxFacts } from "../app/shell/mail-state";

// The first mount pays the shell's cold import.
vi.setConfig({ testTimeout: 30_000 });

/**
 * THE THEME OFFER WAITS FOR A MAILBOX, on every door. An account with nothing connected has one thing
 * to do, and a banner about the look of mail it cannot receive stood above it.
 */

const realPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");

async function offer(facts: MailboxFacts[]): Promise<Element | null> {
  const c = await mountShell(facts);
  await tick(100);
  return c.querySelector(".ohx-notice");
}

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  // The offer is for a Linux desktop browser.
  Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "Linux x86_64" });
});
afterEach(async () => {
  await teardownShellEnv();
  if (realPlatform) Object.defineProperty(Navigator.prototype, "platform", realPlatform);
});

describe("the ohmarchy offer", () => {
  it("is not shown while no mailbox is connected", async () => {
    expect(await offer([])).toBeNull();
  });

  it("is shown once one is", async () => {
    expect(await offer([mailbox()])).not.toBeNull();
  });
});

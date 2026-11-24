/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { json } from "./account/account-harness";
import { closeMailPage, MAILBOX, mountMailPage, prepareMailPage } from "./fixtures/mounted-mail-page";

async function offer(connected: boolean): Promise<HTMLElement | null> {
  await prepareMailPage({
    "GET /api/mailboxes": () => json({ items: connected ? [MAILBOX] : [] }),
  });
  const page = await mountMailPage();
  return page.queryByRole("button", { name: en.ohmarchy.offerAction });
}

beforeEach(() => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Linux x86_64");
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux x86_64)");
});

afterEach(() => {
  closeMailPage();
  vi.restoreAllMocks();
});

describe("the ohmarchy offer", () => {
  it("is not shown while no mailbox is connected", async () => {
    expect(await offer(false)).toBeNull();
  }, 30_000);

  it("is shown once one is", async () => {
    expect(await offer(true)).not.toBeNull();
  }, 30_000);
});

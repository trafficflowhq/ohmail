/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import messages from "../messages/en.json";
import { storeMessage } from "./_store-fixture";
import {
  ISO, act, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, page, teardownShellEnv, tick,
  liveAccountFetch,
} from "./fixtures/live-walk-shell";

beforeEach(installShellEnv);
afterEach(teardownShellEnv);

describe("the separator is never printed without a value on both sides", () => {
  it("a search hit for an undated message says where it is and stops", async () => {
    const hit = storeMessage(0, null, { subject: "Kingfisher invoice", accountId: "acct_live_1" });
    const sync = page(1);
    answerSyncWith(() => sync.clone());
    const fetch = globalThis.fetch;
    globalThis.fetch = liveAccountFetch((input, init) => {
      const url = new URL(String(input), "https://harness.invalid");
      if (url.pathname.endsWith("/search")) {
        const items = url.searchParams.get("q") === "kingfisher" ? [hit] : [];
        return Promise.resolve(Response.json({ items, total: items.length, totalExact: true, ms: 4 }));
      }
      return fetch(input, init);
    });
    const host = await mountShell([mailbox({ id: "mb_1", lastSyncAt: ISO })]);
    await goTo("search");
    const box = within(host).getByRole("textbox", { name: messages.search.aria });
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(box, "kingfisher");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick(1_000);
    const row = within(host).getAllByRole("listitem").find((item) => item.getAttribute("data-hit") === hit.id);
    expect(row, "the undated hit rendered").toBeDefined();
    expect(within(row!).getByRole("button", { name: /Kingfisher invoice/i })).toBeTruthy();
    const where = within(row!).getByText(/^Ohbox(?: ·.*)?$/);
    expect(where.textContent).not.toBe("Ohbox · ");
    expect(where.textContent).toBe("Ohbox");
  });
});

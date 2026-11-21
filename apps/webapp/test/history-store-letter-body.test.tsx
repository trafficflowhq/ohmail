/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { readingColumn } from "./ohbox/_finders.js";
import { storeMessage } from "./_store-fixture.js";
import {
  ISO, act, answerStoreWith, answerSyncWith, goTo, installShellEnv, liveAccountResponse, mailbox, mountShell, page,
  teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

beforeEach(() => {
  installShellEnv();
  const sync = page(1);
  answerSyncWith(() => sync.clone());
});
afterEach(teardownShellEnv);

it("THE FIRST MESSAGE: a row only the store holds opens, and its body is read and rendered", async () => {
  const first = storeMessage(0, "2011-06-01T08:00:00.000Z", {
    id: "first-ever",
    accountId: "acct_live_1",
    subject: "the very first message",
  });
  answerStoreWith([first], { "first-ever": "Hello from two thousand eleven — the whole text of it." });
  const fetchMail = globalThis.fetch;
  const lookups: string[] = [];
  globalThis.fetch = (input, init) => {
    if ((init?.method ?? "GET") === "GET" && /\/messages\/first-ever(?:\?|$)/.test(String(input))) {
      lookups.push(first.id);
      return Promise.resolve(liveAccountResponse(Response.json(first)));
    }
    return fetchMail(input, init);
  };
  const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
  await tick(0);
  await goTo("history");
  await tick(0);
  // The last slot of the timeline is the account's first message, which the mirror never held.
  const rail = within(c).queryByRole("navigation", { name: "Month" });
  const oldest = rail && within(rail).queryAllByRole("button").at(-1);
  if (oldest) await act(async () => { oldest.click(); await Promise.resolve(); });
  await tick(0);
  const row = c.querySelector('[role="option"][data-id="first-ever"]') as HTMLElement | null;
  expect(row, "the first message is not in History").toBeTruthy();
  await act(async () => { row!.click(); await Promise.resolve(); });
  await tick(0);
  await tick(0);
  const col = readingColumn(c)?.textContent ?? "";
  expect(col).toContain("the very first message");
  expect(lookups).toEqual(["first-ever"]);
  expect(col).toContain("Hello from two thousand eleven");
});

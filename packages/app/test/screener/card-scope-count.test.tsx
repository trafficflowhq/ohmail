/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { modelOf, mountPlace, sender } from "./screener-world.js";

afterEach(cleanup);

it("the sender card names the mail in each scope before a choice", () => {
  const representative = sender("first", "First sender");
  const asked = { flushes: 0, decided: [] };
  mountPlace(
    modelOf(asked, {
      waiting: [representative],
      waitingCount: 2,
      domainWaitingCount: () => 2,
      reachOf: () => ({
        others: [{ address: "second" + "@" + "first.example", count: 3 }],
        inboxIds: [],
      }),
    }),
  );
  fireEvent.keyDown(document.body, { key: "s" });
  const card = within(screen.getByRole("dialog", { name: "Change this sender's screening" }));
  expect(card.getByRole("radio", { name: /this sender.*1 message/i })).toBeTruthy();
  expect(card.getByRole("radio", { name: /first\.example.*4 messages.*2 senders/i })).toBeTruthy();
  expect(asked.decided).toEqual([]);
});

it("the sender card leaves the wider count out while more senders remain to load", () => {
  const representative = sender("first", "First sender");
  mountPlace(
    modelOf(
      { flushes: 0 },
      {
        waiting: [representative],
        waitingCount: 200,
        domainWaitingCount: () => null,
      },
    ),
  );
  fireEvent.keyDown(document.body, { key: "s" });
  const card = within(screen.getByRole("dialog", { name: "Change this sender's screening" }));
  const domain = card.getByRole("radio", { name: /first\.example/i });
  expect(domain.textContent).not.toContain("messages");
  expect(domain.textContent).not.toContain("senders");
});

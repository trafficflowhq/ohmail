/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ISO, act, goTo, installShellEnv, teardownShellEnv, tick } from "../fixtures/live-walk-shell.js";
import { click, mountThread, msg, settle } from "../fixtures/thread-read-shell.js";
import { letterShown } from "../ohbox/_finders.js";

beforeEach(installShellEnv);
afterEach(teardownShellEnv);

it("pressing the row's open control opens exactly that message", async () => {
  const anna = { name: "Anna Berg", address: "anna@acme.test" };
  const bank = { name: null, address: "noreply@bank.test" };
  const rows = [
    msg("a", 30, { threadId: "thread-a", subject: "Invoice a", from: anna }),
    msg("b", 0, { threadId: "thread-b", subject: "Invoice b", from: bank }),
  ];
  const rules = [anna, bank].map(({ address }, i) => {
    const id = `rule-${i}`;
    return {
      type: "rule", op: "create", id, seq: 100 + i, updatedAt: ISO,
      entity: { id, kind: "sender", match: address, destination: "INBOX", priority: 0, enabled: true,
        provenance: "seeded-from-sent", stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO },
    };
  });
  await mountThread([...rows, ...rules]);
  const fetchMail = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    /\/search\?/.test(String(input))
      ? Promise.resolve(Response.json({ items: rows.map((row) => row.entity), total: 2, totalExact: true, ms: 4 }))
      : fetchMail(input, init);

  await goTo("search");
  const box = screen.getByRole<HTMLInputElement>("textbox", { name: "Search" });
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(box, "invoice");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tick(1_000);
  await settle();

  const hits = screen.getAllByRole("listitem").filter((item) => item.hasAttribute("data-hit"));
  expect(hits.map((hit) => hit.dataset.hit).sort()).toEqual(["a", "b"]);
  const row = hits.find((item) => item.dataset.hit === "b")!;
  const circle = within(row).getByRole("button", { pressed: false, name: "Select the message" });
  const controls = within(row).getAllByRole("button").filter((button) => button !== circle);
  expect(controls).toHaveLength(1);
  const position = window.history.length;
  await click(controls[0], "the second hit's open control");

  expect(window.location.hash).toBe("#/search/m/b?q=invoice");
  expect(window.history.length).toBe(position + 1);
  expect(letterShown(document, "b")).not.toBeNull();
  expect(letterShown(document, "a")).toBeNull();
});

/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { fakeMail } from "../../../packages/app/test/reader/support/mail.js";
import { issue } from "../../../packages/app/test/streams/registered-world.js";
import { mountCheckedStream } from "./stream-check-frame.js";

const WORK = { id: "mb-1", address: "work@example.invalid", displayName: "Work" };
const HOME = { id: "mb-2", address: "home@example.invalid", displayName: null };
const ROSTER = [WORK, HOME];

async function show(
  roster: typeof ROSTER | null,
  mailboxId = WORK.id,
  locale: "en" | "de" = "en",
) {
  const { engine } = fakeMail([issue("weekly", 12, {
    mailboxId,
    to: [{ name: null, address: "list@example.invalid" }],
  })]);
  await mountCheckedStream(engine, "#/reads", locale, roster ? async () => roster : undefined);
  return {
    row: within(screen.getByRole("option", { name: /Issue 12/ })),
    card: within(screen.getByRole("region", { name: locale === "de" ? "News-Strom" : "News stream" })),
  };
}

it.each([
  [WORK.id, "en", WORK.displayName, "Delivered to"],
  [HOME.id, "en", HOME.address, "Delivered to"],
  [WORK.id, "de", WORK.displayName, "Zugestellt an"],
] as const)("names the receiving mailbox on the row and card (%s, %s)", async (id, locale, label, phrase) => {
  const { row, card } = await show(ROSTER, id, locale);
  const title = `${phrase} ${label}`;
  expect(row.getByTitle(title).textContent).toBe(label);
  expect(card.getByTitle(title).textContent).toBe(label);
  expect(screen.getByRole("option", { name: /Issue 12/ }).getAttribute("aria-description")).toBe(title);
  expect(card.queryByText("list@example.invalid")).toBeNull();
});

it.each([
  ["one mailbox", [WORK], WORK.id],
  ["no mailbox reader", null, WORK.id],
  ["an empty roster", [], WORK.id],
  ["an unknown mailbox", ROSTER, "missing"],
] as const)("omits the delivery badge with %s", async (_name, roster, id) => {
  const { row, card } = await show(roster ? [...roster] : null, id);
  expect(row.queryByTitle(/^Delivered to/)).toBeNull();
  expect(card.queryByTitle(/^Delivered to/)).toBeNull();
  expect(screen.getByRole("option", { name: /Issue 12/ }).getAttribute("aria-description")).toBeNull();
});

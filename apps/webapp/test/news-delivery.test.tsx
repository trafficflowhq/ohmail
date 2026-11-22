/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { fakeMail } from "../../../packages/app/test/reader/support/mail.js";
import { issue } from "../../../packages/app/test/streams/registered-world.js";
import { mountCheckedStream } from "./stream-check-frame.js";
import en from "../../../packages/app/messages/news.en.json";
import de from "../../../packages/app/messages/news.de.json";
import readerEn from "../../../packages/app/messages/reader.en.json";
import readerDe from "../../../packages/app/messages/reader.de.json";

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
] as const)("names the receiving mailbox in the card head and omits it from the row (%s, %s)", async (id, locale, label, phrase) => {
  const { row, card } = await show(ROSTER, id, locale);
  const title = `${phrase} ${label}`;
  // Studio keeps mailbox attribution in the message head and clears the list row of badges.
  expect(row.queryByTitle(title)).toBeNull();
  expect(card.getByTitle(title).textContent).toBe(label);
  const hint = (locale === "de" ? de : en).news.item.keyboardOpen;
  const unread = (locale === "de" ? readerDe : readerEn).message.rowUnread;
  expect(screen.getByRole("option", { name: /Issue 12/ }).getAttribute("aria-description"))
    .toBe(`${hint}. ${unread}`);
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
  expect(screen.getByRole("option", { name: /Issue 12/ }).getAttribute("aria-description"))
    .toBe(`${en.news.item.keyboardOpen}. ${readerEn.message.rowUnread}`);
});

/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { MailGround, mailPlaces } from "../../src/mail/index.js";
import { readerEntry } from "../../src/reader/entry.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import newsEn from "../../messages/news.en.json" with { type: "json" };
import { bodyDouble, fakeMail, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { issue, mountStreamFrame } from "./registered-world.js";

afterEach(cleanup);

it("opens and dismisses a sender's contact card without opening or reading the letter", () => {
  const letter = issue("first", 12, { body: undefined });
  const { address, mail } = mountStreamFrame({ at: "#/reads", letters: [letter] });
  const region = screen.getByRole("region", { name: "News stream" });
  const sender = within(region).getByRole("button", { name: /^The Weekly/ });
  fireEvent.mouseDown(sender);
  fireEvent.click(sender);
  const contact = screen.getByRole("dialog", { name: "Options for The Weekly" });
  fireEvent.mouseDown(contact);
  fireEvent.click(contact);
  expect(screen.getByRole("dialog", { name: "Options for The Weekly" })).toBe(contact);
  fireEvent.pointerDown(contact.parentElement!.querySelector("[data-veil]")!);
  expect(screen.queryByRole("dialog", { name: "Options for The Weekly" })).toBeNull();
  expect(address.read()).toBe("#/reads");
  expect(mail.bodyAsks).toEqual([]);
  expect(mail.mutations).toEqual([]);
});

it("copies the sender's stored address from a folded card and leaves the letter closed", () => {
  const letter = issue("first", 12, { body: undefined });
  const mail = fakeMail([letter]);
  const copy = vi.fn(async () => true);
  const reader = readerEntry({
    body: bodyDouble().body,
    files: "none",
    pictures: "none",
    look: "none",
    sentCopy: "none",
    reply: "none",
    invitation: "none",
    copy,
  });
  const address = fakeAddress("#/reads");
  const { host } = fakeHost({
    engine: mail.engine,
    service: "self",
    scope: "acct-1",
    places: mailPlaces(),
    above: MailGround,
    reader,
    window: fakeWindow("desktop"),
    address,
  });
  render(
    <TextProvider locale="en" messages={{ ...WORDS.en, ...newsEn } as Messages} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );
  const region = screen.getByRole("region", { name: "News stream" });
  const sender = within(region).getByRole("button", { name: /^The Weekly/ });
  fireEvent.mouseDown(sender);
  fireEvent.click(sender);
  const contact = within(screen.getByRole("dialog", { name: "Options for The Weekly" }));
  const copyButton = contact.getByRole("button", { name: "Copy address" });
  fireEvent.mouseDown(copyButton);
  fireEvent.click(copyButton);
  expect(copy).toHaveBeenCalledTimes(1);
  expect(copy).toHaveBeenCalledWith(letter.from.address);
  expect(screen.queryByRole("dialog", { name: "Options for The Weekly" })).toBeNull();
  expect(address.read()).toBe("#/reads");
  expect(mail.bodyAsks).toEqual([]);
  expect(mail.mutations).toEqual([]);
});

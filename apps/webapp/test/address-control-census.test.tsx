/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import messages from "../messages/en.json";
import { act, goTo, installShellEnv, liveAccountResponse, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { LENA, click, mountThread, msg, settle } from "./fixtures/thread-read-shell.js";

const SUBJECT = "Invoice for the reading lamp";
const RECIPIENT = { name: "Anna Berg", address: "anna@example.invalid" };
const addressRoute = (address: string) => `#/address/${encodeURIComponent(address)}`;

async function mountAt(hash: string, fields: Record<string, unknown> = {}, webContactScreening = false): Promise<void> {
  window.location.hash = hash;
  await mountThread([msg("a", 0, { subject: SUBJECT, ...fields })], { webContactScreening });
}

async function openContact(
  source: HTMLElement,
  buttonName: string,
  contact: { name: string; address: string },
): Promise<void> {
  expect(within(source).queryByRole("link", { name: contact.address })).toBeNull();
  const control = within(source).getByRole("button", { name: buttonName });
  const at = window.location.hash;
  await click(control, contact.name);
  expect(window.location.hash).toBe(at);

  const card = screen.getByRole("dialog", {
    name: messages.message.contactAria.replace("{who}", contact.name),
  });
  expect(card.textContent).toContain(contact.address);
  await click(
    within(card).getByRole("menuitem", { name: messages.message.addressOpen }),
    messages.message.addressOpen,
  );
  expect(window.location.hash).toBe(`${addressRoute(contact.address)}/m/a`);
}

const openReader = () => screen.getByRole("region", { name: messages.reader.pane });

beforeEach(installShellEnv);
afterEach(teardownShellEnv);

async function mountSearch(items: ReturnType<typeof msg>["entity"][]): Promise<void> {
  await mountAt("#/ohbox");
  const hostFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    /\/search\?/.test(String(input))
      ? Promise.resolve(liveAccountResponse(Response.json({ items, total: items.length, totalExact: true, ms: 4 })))
      : hostFetch(input, init);
  await goTo("search");
  const box = screen.getByRole<HTMLInputElement>("textbox", { name: messages.search.aria });
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { set.call(box, "invoice"); box.dispatchEvent(new Event("input", { bubbles: true })); });
  await tick(1_000);
  await settle();
}

describe("each surface's address, classified by the hit test it is actually under", () => {
  it("list row — the address is the sender handle; the way in is the popover's row", async () => {
    await mountAt("#/ohbox", {}, true);
    const row = screen.getByRole("option", { name: new RegExp(SUBJECT) });
    expect(within(row).queryByRole("link", { name: LENA.address })).toBeNull();

    await click(row, SUBJECT);
    const sender = within(row).queryByRole("button", { name: messages.screening.openFor.replace("{sender}", LENA.name) });
    expect(sender, "the Ohbox row's address opens the sender sheet").toBeTruthy();
    await click(sender, LENA.name);
    const sheet = screen.getByRole("dialog", { name: messages.screening.aria.replace("{sender}", LENA.address) });
    const link = within(sheet).getByRole("link", { name: messages.screening.addressOpen });
    expect(link.getAttribute("href")).toBe(addressRoute(LENA.address));
  }, 30_000);

  it("stream card — the address is the sender handle; the way in is the popover's row", async () => {
    await mountAt("#/reads", { folder: "ohmail/News" });
    const stream = screen.getByRole("region", { name: messages.news.stream.label });
    await click(within(stream).getByRole("button", { name: messages.news.item.expand }), SUBJECT);
    await openContact(stream, `${LENA.name} ${LENA.address}`, LENA);
  }, 30_000);

  it("search result row — the hit test answers null; the address itself is the link", async () => {
    await mountSearch([msg("a", 0, { subject: SUBJECT }).entity]);

    const row = screen.getAllByRole("listitem").find((item) => item.textContent?.includes(SUBJECT));
    expect(row, "the matching result appears").toBeTruthy();
    const link = within(row!).queryByRole("link", { name: LENA.address });
    expect(link, "the address itself is a link").toBeTruthy();
    expect(link!.tagName).toBe("A");
    expect(link!.getAttribute("href")).toBe(addressRoute(LENA.address));
  }, 30_000);

  it("reader To/Cc chip — the hit test answers null; the chip's own popover carries the verb", async () => {
    await mountAt("#/ohbox/m/a", { to: [RECIPIENT] });
    await openContact(openReader(), RECIPIENT.name, RECIPIENT);
  }, 30_000);

  it("reader From block — the hit test answers null; its own press opens the screening popover", async () => {
    await mountAt("#/ohbox/m/a");
    await openContact(openReader(), `${LENA.name} ${LENA.address}`, LENA);
  }, 30_000);
});

describe("the search result row — the address is printed, and it is the control", () => {
  const namedSubject = "Invoice for a lamp";
  const unnamedSubject = "Invoice for a table";
  const unnamed = "accounts@example.test";
  const results = () => mountSearch([
    msg("named", 0, { subject: namedSubject, from: RECIPIENT }).entity,
    msg("nameless", 1, { subject: unnamedSubject, from: { name: null, address: unnamed } }).entity,
  ]);

  it("prints the name on line one and the address on line two, linked to the address view", async () => {
    await results();
    const result = within(screen.getByRole("button", { name: new RegExp(namedSubject) }));
    const name = result.getByText(RECIPIENT.name);
    const link = result.getByRole("link", { name: RECIPIENT.address });
    expect(link.parentElement).toBe(name.parentElement);
    expect(link.getAttribute("href")).toBe(addressRoute(RECIPIENT.address));
    await click(link, RECIPIENT.address);
    expect(window.location.hash).toBe(addressRoute(RECIPIENT.address));
  });

  it("with no name, the address takes line one — and is still the link", async () => {
    await results();
    const hit = screen.getByRole("button", { name: new RegExp(unnamedSubject) });
    const result = within(hit);
    expect(result.getAllByText(unnamed, { exact: true })).toHaveLength(1);
    const link = result.getByRole("link", { name: unnamed });
    expect(hit.querySelector(".oh-row-who")?.contains(link)).toBe(true);
    expect(link.getAttribute("href")).toBe(addressRoute(unnamed));
  });

  it("pressing the address navigates to `#/address/<addr>` and does NOT open the message", async () => {
    await results();
    const result = within(screen.getByRole("button", { name: new RegExp(namedSubject) }));
    const link = result.getByRole("link", { name: RECIPIENT.address });
    expect(link.getAttribute("href")).toBe(addressRoute(RECIPIENT.address));
    await click(link, RECIPIENT.address);
    expect(window.location.hash).toBe(addressRoute(RECIPIENT.address));
    expect(screen.queryByRole("heading", { name: namedSubject })).toBeNull();
  });
});

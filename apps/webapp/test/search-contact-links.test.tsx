/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeMessage } from "./_store-fixture.js";
import {
  ISO, act, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, page, teardownShellEnv, tick,
  liveAccountFetch,
} from "./fixtures/live-walk-shell.js";

const named = "named@example.invalid";
const unnamed = "unnamed@example.invalid";
const rows = [
  storeMessage(0, ISO, {
    id: "named-sender", accountId: "acct_live_1", subject: "Invoice number one",
    from: { name: "Anna Berg", address: named },
  }),
  storeMessage(1, ISO, {
    id: "unnamed-sender", accountId: "acct_live_1", subject: "Invoice number two",
    from: { name: null, address: unnamed },
  }),
];

beforeEach(installShellEnv);
afterEach(teardownShellEnv);

async function results() {
  const sync = page(1);
  answerSyncWith(() => sync.clone());
  const original = globalThis.fetch;
  globalThis.fetch = liveAccountFetch((input, init) => {
    const url = new URL(String(input), "https://harness.invalid");
    if (url.pathname.endsWith("/search")) {
      const items = url.searchParams.get("q") === "invoice" ? rows : [];
      return Promise.resolve(Response.json({ items, total: items.length, totalExact: true, ms: 4 }, { headers: { "X-Ohmail-Account": "acct_live_1" } }));
    }
    return original(input, init);
  });
  const host = await mountShell([mailbox({ lastSyncAt: ISO })]);
  await goTo("search");
  const box = within(host).getByRole<HTMLInputElement>("textbox", { name: "Search" });
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(box, "invoice");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tick(1_000);
  return (id: string) => within(host).getAllByRole("listitem").find((item) => item.dataset.hit === id)!;
}

const card = (who: string) => within(document.body).getByRole("dialog", { name: `Options for ${who}` });
const press = (button: HTMLElement) => act(async () => { button.click(); });

const destination = (address: string) => `#/address/${encodeURIComponent(address)}`;

describe("the search result row links the contact separately", () => {
  it("links the printed address independently of the sender name", async () => {
    const hit = await results();
    const result = hit("named-sender");
    expect(within(result).getByText("Anna Berg")).toBeTruthy();
    const address = within(result).getByRole<HTMLAnchorElement>("link", { name: named });
    expect(result.querySelector(".oh-row-who")?.contains(address)).toBe(false);
    expect(address.getAttribute("href")).toBe(destination(named));
    expect(address.tabIndex).toBe(0);
    await press(within(result).getByRole("button", { name: "Options for Anna Berg" }));
    expect(card("Anna Berg").textContent).toContain(named);
    expect(window.location.hash).toBe("#/search");
  });

  it("with no name, the address takes line one and is still the link", async () => {
    const hit = await results();
    const result = hit("unnamed-sender");
    expect(within(result).getAllByText(unnamed, { exact: true })).toHaveLength(1);
    const link = within(result).getByRole<HTMLAnchorElement>("link", { name: unnamed });
    expect(result.querySelector(".oh-row-who")?.contains(link)).toBe(true);
    expect(link.getAttribute("href")).toBe(destination(unnamed));
    await press(link);
    expect(card(unnamed).textContent).toContain(unnamed);
  });

  it("pressing the address opens the contact without opening the Search hit", async () => {
    const hit = await results();
    const link = within(hit("named-sender")).getByRole<HTMLAnchorElement>("link", { name: named });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => { link.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect(window.location.hash).toBe("#/search");
    const browse = within(card("Anna Berg")).getByRole("menuitem", { name: "Everything from and to this address" });
    await press(browse);
    await tick(50);
    expect(window.location.hash).toBe(destination(named));
  });
  it("leaves modified and non-primary presses to the native address link", async () => {
    const hit = await results();
    const link = within(hit("named-sender")).getByRole<HTMLAnchorElement>("link", { name: named });
    const events: MouseEvent[] = [
      ...[{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }].map(
        (modifier) => new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier }),
      ),
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }),
      new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
    ];
    for (const event of events) {
      await act(async () => { link.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(within(document.body).queryByRole("dialog", { name: "Options for Anna Berg" })).toBeNull();
    expect(window.location.hash).not.toContain("/m/");
  });
});

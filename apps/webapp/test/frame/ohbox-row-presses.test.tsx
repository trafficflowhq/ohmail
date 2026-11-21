/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it, vi } from "vitest";
import messages from "../../messages/en.json";
import { openRow } from "../ohbox/_finders.js";
import {
  ACCOUNT, ISO, act, installScreeningWeb, mountScreeningWeb, syncScreeningWeb, teardownScreeningWeb, tick,
} from "../fixtures/screening-web.js";

const ada = ["ada", "sender.example"].join("@");
const bea = ["bea", "sender.example"].join("@");
const mailbox = "mb_1";
const letter = {
  accountId: ACCOUNT, mailboxId: mailbox, folder: "INBOX", threadId: null,
  to: [], cc: [], unread: true, placeDecided: true, updatedAt: ISO,
} satisfies Partial<EngineMessage>;
const letters: (Partial<EngineMessage> & { id: string })[] = [
  { ...letter, id: "recent", from: { name: "Ada", address: ada }, subject: "A note from Ada", date: ISO },
  { ...letter, id: "earlier", from: { name: "Bea", address: bea }, subject: "An earlier note", date: "2026-09-03T12:40:00.000Z" },
  { ...letter, id: "oldest", from: { name: "Ada", address: ada }, subject: "The oldest note", date: "2026-09-02T12:40:00.000Z" },
];

async function mount(
  width: number,
  check: (shell: HTMLElement, sheetName: string) => Promise<void>,
  { messagesInBox = letters, hash = "#/ohbox" } = {},
) {
  installScreeningWeb(hash, (path, query) => {
    if (path === "/api/mailboxes") {
      return Response.json({ items: [{
        id: mailbox, address: ["reader", "mailbox.example"].join("@"),
        status: "connected", organizerRole: "organizer", organizerChecked: true,
        createdAt: ISO, lastSyncAt: ISO, organizeConsentedAt: ISO,
      }] });
    }
    if (path === "/api/sync") {
      if (query.get("types") === "rule") return syncScreeningWeb([], 1);
      return syncScreeningWeb(messagesInBox.map((message, index) => ({
        type: "message", op: "create", id: message.id, seq: index + 2, updatedAt: ISO, entity: message,
      })), messagesInBox.length + 1);
    }
    return undefined;
  });
  vi.stubGlobal("innerWidth", width);
  try {
    const shell = await mountScreeningWeb();
    await tick(4000);
    await check(shell, messages.screening.aria.replace("{sender}", ada));
  } finally {
    await teardownScreeningWeb();
  }
}

async function dispatch(target: EventTarget, event: Event) {
  const before = window.location.hash;
  await act(async () => { target.dispatchEvent(event); });
  if (window.location.hash !== before) {
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
  }
}

const click = (target: HTMLElement, modifiers: MouseEventInit = {}) =>
  dispatch(target, new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers }));
const key = (key: string, modifiers: KeyboardEventInit = {}) =>
  dispatch(document, new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));

describe.each([1440, 390])("Ohbox row controls at %i pixels wide", (width) => {
  const noCard = () => expect(within(document.body).queryByRole("dialog", { name: /^Screening for / })).toBeNull();

  it("picks from the circles, extends across intervening rows, and toggles a picked row", async () => {
    await mount(width, async (shell) => {
      const [first, middle, last] = within(shell).getAllByRole("option");
      const circle = (row: HTMLElement) => within(row).getByRole("button", {
        name: messages.ohbox.keyPick,
      });
      const count = (size: number) => within(shell).getByRole("button", { name: new RegExp(`^${size} selected`) });
      const selected = () => within(shell).getAllByRole("option", { selected: true });

      await click(circle(first!));
      noCard();
      expect(count(1)).toBeTruthy();
      expect(selected()).toEqual([first]);
      expect(openRow(shell)).toBeNull();

      await click(circle(last!), { shiftKey: true });
      expect(count(3)).toBeTruthy();
      expect(selected()).toEqual([first, middle, last]);

      await click(circle(middle!));
      expect(count(2)).toBeTruthy();
      expect(selected()).toEqual([first, last]);
      noCard();
      expect(openRow(shell)).toBeNull();
    });
  }, 30_000);

  it("still lets the keyboard pick the cursor row and extend its range", async () => {
    await mount(width, async (shell) => {
      await key("j");
      await key("x");
      expect(within(shell).getByRole("button", { name: /^1 selected/ })).toBeTruthy();
      await key("J", { shiftKey: true });
      expect(within(shell).getByRole("button", { name: /^2 selected/ })).toBeTruthy();
    });
  }, 30_000);

  it.each(["name", "address"] as const)("opens the contact card from the %s", async (by) => {
    await mount(width, async (shell, sheetName) => {
      const row = within(shell).getByRole("option", { name: /Ada: A note from Ada/ });
      const address = ada;
      await click(within(row).getByText(by === "name" ? "Ada" : address, { exact: true }));
      expect(within(document.body).getByRole("dialog", { name: sheetName })).toBeTruthy();
      expect(openRow(shell)).toBeNull();
      expect(within(shell).queryByRole("button", { name: /^1 selected/ })).toBeNull();
    });
  }, 30_000);

  it("opens the letter from the subject", async () => {
    await mount(width, async (shell) => {
      const row = within(shell).getByRole("option", { name: /Bea: An earlier note/ });
      await click(within(row).getByText("An earlier note", { exact: true }));
      expect(openRow(shell)).toBe(row);
      noCard();
      expect(within(shell).queryByRole("button", { name: /^1 selected/ })).toBeNull();
    });
  }, 30_000);
});

describe("the senders printed on a grouped Ohbox row", () => {
  const dialog = (address: string) => messages.screening.aria.replace("{sender}", address);
  const button = (name: string) => messages.screening.openFor.replace("{sender}", name);
  const grouped = (earlierUnread: boolean) => [
    { ...letters[0]!, threadId: "conversation", from: { name: "Ada Vale", address: ada }, subject: "Project notes" },
    { ...letters[1]!, threadId: "conversation", from: { name: "Bea Moss", address: bea }, subject: "Project notes", unread: earlierUnread },
  ];

  it.each([["Ada", "Ada Vale", ada], ["Bea", "Bea Moss", bea]])(
    "opens the contact for %s from that name alone",
    async (printed, name, address) => {
      await mount(1440, async (shell) => {
        const row = within(shell).getByRole("option", { name: /Ada Vale.*Bea Moss|Bea Moss.*Ada Vale/ });
        const names = within(row);
        const control = names.getByRole("button", { name: button(name) });
        expect(control.textContent).toBe(printed);
        await click(control);
        expect(within(document.body).getByRole("dialog", { name: dialog(address) })).toBeTruthy();
        expect(openRow(shell)).toBeNull();
      }, { messagesInBox: grouped(true) });
    },
    30_000,
  );

  it("opens the only unread sender's contact while another sender's letter is open", async () => {
    await mount(1440, async (shell) => {
      const row = within(shell).getByRole("option", { name: /^Ada Vale: Project notes/ });
      expect(window.location.hash).toBe("#/ohbox/m/earlier");
      expect(openRow(shell)).toBe(row);
      await click(within(row).getByText("Ada Vale", { exact: true }));
      expect(within(document.body).getByRole("dialog", { name: dialog(ada) })).toBeTruthy();
      expect(within(document.body).queryByRole("dialog", { name: dialog(bea) })).toBeNull();
      expect(window.location.hash).toBe("#/ohbox/m/earlier");
    }, { messagesInBox: grouped(false), hash: "#/ohbox/m/earlier" });
  }, 30_000);
});

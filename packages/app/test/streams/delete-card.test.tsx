/** @vitest-environment jsdom */
import { consentVia } from "@ohmail/app-logic/consent";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "./registered-world.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  HTMLElement.prototype.scrollTo ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const places = [
  ["reads", issue],
  ["receipts", receipt],
] as const;

it.each(places)("two deliberate d presses on a %s card file only that letter", async (place, make) => {
  const { mail } = mountStreamFrame({
    at: `#/${place}/m/selected`,
    letters: [make("selected", 10), make("beside", 9)],
  });
  fireEvent.keyDown(document.body, { key: "d" });
  const menu = screen.getByRole("menu", { name: "More" });
  const choice = within(menu).getByRole("menuitem", { name: "Delete" });
  for (const init of [
    { repeat: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
  ]) {
    fireEvent.keyDown(choice, { key: "d", ...init });
  }
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  expect(mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([]);
  fireEvent.keyDown(choice, { key: "d" });
  expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
  expect(document.querySelector('.pl-list [data-id="beside"]')).toBeTruthy();
  expect(document.querySelector('.pl-list [data-id="selected"]')).toBeNull();
  expect(mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([]);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([
    { kind: "message_delete", messageId: "selected" },
  ]);
});

it.each(places)("a %s card reaches Trash only after confirming its own Move", (place, make) => {
  mountStreamFrame({ at: `#/${place}/m/selected`, letters: [make("selected", 10), make("beside", 9)] });
  fireEvent.click(screen.getByRole("toolbar", { name: "Actions" }).querySelector("[data-more]")!);
  const menu = screen.getByRole("menu", { name: "More" });
  const choice = within(menu).getByRole("menuitem", { name: "Delete" });
  fireEvent.keyDown(choice, { key: "d" });
  expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  fireEvent.click(choice);
  const confirmation = screen.getByRole("dialog", { name: /Move to Trash/ });
  expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  fireEvent.click(within(confirmation).getByRole("button", { name: /Cancel/ }));
  expect(document.querySelector('.pl-list [data-id="selected"]')).toBeTruthy();
  fireEvent.click(screen.getByRole("toolbar", { name: "Actions" }).querySelector("[data-more]")!);
  fireEvent.click(
    within(screen.getByRole("menu", { name: "More" })).getByRole("menuitem", { name: "Delete" }),
  );
  fireEvent.click(
    within(screen.getByRole("dialog", { name: /Move to Trash/ })).getByRole("button", { name: /Move/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
  expect(document.querySelector('.pl-list [data-id="selected"]')).toBeTruthy();
});

it("remembers Move to Trash for the account across reload and on another device", async () => {
  const accounts = new Map<string, number>();
  const writes = vi.fn();
  const mountAccount = async (scope: string, phone = false) => {
    const consent = consentVia(async (path, init) => {
      if (path === "/consent/settings") {
        const body = JSON.parse(String(init?.body));
        writes(body);
        if (body.acknowledgeScreener === "moveToTrash") accounts.set(scope, 64);
      }
      return Response.json({ dormancyDays: 60, screenerAcknowledgements: accounts.get(scope) ?? 0 });
    });
    let view!: ReturnType<typeof mountStreamFrame>;
    await act(async () => {
      view = mountStreamFrame({
        at: "#/receipts/m/selected",
        scope,
        phone,
        consent,
        letters: [receipt("selected", 10), receipt("beside", 9)],
      });
    });
    return view;
  };
  const remove = () => {
    fireEvent.click(screen.getByRole("toolbar", { name: "Actions" }).querySelector("[data-more]")!);
    fireEvent.click(
      within(screen.getByRole("menu", { name: "More" })).getByRole("menuitem", { name: "Delete" }),
    );
  };
  const question = () => screen.getByRole("dialog", { name: "Move to Trash" });
  const undo = () => screen.getByRole("button", { name: /Undo/ });
  const immediate = (through: string) => {
    expect(screen.queryByRole("dialog", { name: "Move to Trash" }), through).toBeNull();
    expect(screen.queryByRole("button", { name: /Undo/ }), through).toBeTruthy();
  };

  const first = await mountAccount("account-one");
  remove();
  fireEvent.click(within(question()).getByRole("button", { name: "Cancel" }));
  expect(writes).not.toHaveBeenCalled();
  remove();
  await act(async () => {
    fireEvent.click(within(question()).getByRole("button", { name: "Move" }));
  });
  fireEvent.click(undo());
  remove();
  immediate("the next toolbar press");
  fireEvent.click(undo());
  fireEvent.contextMenu(document.querySelector('.pl-list [data-id="beside"]')!);
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete" }));
  immediate("the row menu");
  expect(writes).toHaveBeenCalledTimes(1);
  expect(writes).toHaveBeenCalledWith({ acknowledgeScreener: "moveToTrash" });
  first.page.unmount();

  const reload = await mountAccount("account-one");
  fireEvent.keyDown(document.body, { key: "d" });
  immediate("the delete shortcut after reload");
  reload.page.unmount();

  localStorage.clear();
  const otherDevice = await mountAccount("account-one", true);
  remove();
  immediate("the phone-width toolbar on another device");
  otherDevice.page.unmount();

  const otherAccount = await mountAccount("account-two");
  remove();
  expect(question()).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  otherAccount.page.unmount();
});

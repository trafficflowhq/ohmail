/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { pileOrganizer } from "@ohmail/app-logic/lists/pile-note";
import type { UnscreenedPileWire } from "@ohmail/wire";
import { Frame } from "../../src/frame/Frame.js";
import { MailGround, mailPlaces } from "../../src/mail/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import news from "../../messages/news.en.json" with { type: "json" };
import receipts from "../../messages/receipts.en.json" with { type: "json" };
import screener from "../../messages/screener.en.json" with { type: "json" };
import { fakeMail, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";

const words = { ...WORDS.en, ...news, ...receipts, ...screener } as Messages;
function account(scope: string, count: number, result: Promise<number>) {
  const { engine } = fakeMail([]);
  const address = fakeAddress("#/reads");
  const ask = vi.fn(async (_pile: UnscreenedPileWire) => ({ total: count, atLeast: false }));
  const press = vi.fn(() => result);
  Object.assign(engine, { pileUnscreened: ask, screenPileUnscreened: press });
  const { host } = fakeHost({
    engine,
    scope,
    service: "self",
    places: mailPlaces(),
    above: MailGround,
    address,
    window: fakeWindow("desktop"),
  });
  return {
    ask,
    press,
    address,
    frame: (
      <TextProvider locale="en" messages={words} timeZone="UTC">
        <Frame host={host} />
      </TextProvider>
    ),
  };
}

afterEach(cleanup);

it("the prior account's pending screening answer cannot change the current account's note or report", async () => {
  let finish!: (count: number) => void;
  const first = account(
    "account-one",
    7,
    new Promise<number>((done) => {
      finish = done;
    }),
  );
  const next = account("account-two", 2, Promise.resolve(2));
  const page = render(first.frame);
  fireEvent.click(await screen.findByRole("button", { name: "Screen 7" }));
  expect(first.press.mock.calls).toEqual([["news"]]);
  page.rerender(next.frame);
  expect(await screen.findByRole("button", { name: "Screen 2" })).toBeTruthy();
  const report = () => document.querySelector('.fr-report [role="status"]')?.textContent ?? null;
  const priorReport = report();
  await act(async () => {
    finish(7);
  });
  expect(report()).toBe(priorReport);
  expect(screen.getByRole("note").textContent).toBe(
    "2 letters in News come from senders you haven't screened yet Screen sends them to the Screener, where you decide once per sender. Nothing is deleted.Screen 2Not now",
  );
  expect(first.ask.mock.calls).toEqual([["news"]]);
  expect(next.ask.mock.calls).toEqual([["news"]]);
  expect(next.press.mock.calls).toEqual([]);
});

it("Not now keeps the note hidden for this account and pile until its count grows", async () => {
  const current = account("account-not-now", 7, Promise.resolve(0));
  const page = render(current.frame);
  fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("note")).toBeNull();
  expect(current.press).not.toHaveBeenCalled();

  await act(async () => current.address.visit("#/receipts"));
  expect(await screen.findByRole("button", { name: "Screen 7" })).toBeTruthy();

  const other = account("account-not-now-other", 7, Promise.resolve(0));
  page.rerender(other.frame);
  expect(await screen.findByRole("button", { name: "Screen 7" })).toBeTruthy();
  const returned = account("account-not-now", 6, Promise.resolve(0));
  page.rerender(returned.frame);
  await act(async () => {});
  expect(returned.ask).toHaveBeenCalledWith("news");
  expect(screen.queryByRole("note")).toBeNull();

  await act(async () => returned.address.visit("#/receipts"));
  expect(await screen.findByRole("button", { name: "Screen 6" })).toBeTruthy();
  returned.ask.mockResolvedValue({ total: 8, atLeast: false });
  await act(async () => returned.address.visit("#/reads"));
  expect(await screen.findByRole("button", { name: "Screen 8" })).toBeTruthy();
});

it("shows the note when the count grows after dropping below the dismissed count", async () => {
  const current = account("account-count-drop", 40, Promise.resolve(0));
  render(current.frame);
  expect(await screen.findByRole("button", { name: "Screen 40" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));

  await act(async () => current.address.visit("#/ohbox"));
  current.ask.mockResolvedValue({ total: 10, atLeast: false });
  await act(async () => current.address.visit("#/reads"));
  expect(screen.queryByRole("note")).toBeNull();

  await act(async () => current.address.visit("#/ohbox"));
  current.ask.mockResolvedValue({ total: 25, atLeast: false });
  await act(async () => current.address.visit("#/reads"));
  expect(await screen.findByRole("button", { name: "Screen 25" })).toBeTruthy();
});

it("an earlier count cannot restore the screening button after the press has emptied its pile", async () => {
  let finish!: (count: number) => void;
  let answerEarlier!: (answer: { total: number; atLeast: boolean }) => void;
  const current = account(
    "account-one",
    7,
    new Promise<number>((done) => {
      finish = done;
    }),
  );
  const stale = new Promise<{ total: number; atLeast: boolean }>((done) => {
    answerEarlier = done;
  });
  const initial = { total: 7, atLeast: false };
  const empty = { total: 0, atLeast: false };
  const news = [Promise.resolve(initial), stale, Promise.resolve(empty)];
  current.ask.mockImplementation((pile) => (pile === "news" ? news.shift()! : Promise.resolve(empty)));
  render(current.frame);
  fireEvent.click(await screen.findByRole("button", { name: "Screen 7" }));
  await act(async () => current.address.visit("#/receipts"));
  await act(async () => current.address.visit("#/reads"));
  expect(screen.getByRole("button", { name: "Screen 7" }).getAttribute("aria-busy")).toBe("true");
  await act(async () => {
    finish(7);
  });
  expect(screen.queryByRole("note")).toBeNull();
  await act(async () => {
    answerEarlier(initial);
  });
  expect(screen.queryByRole("note")).toBeNull();
  expect(current.ask.mock.calls).toEqual([["news"], ["receipts"], ["news"], ["news"]]);
  expect(current.press.mock.calls).toEqual([["news"]]);
});

it("a successful screening cannot be pressed again while the updated count is still being read", async () => {
  let recount!: (answer: { total: number; atLeast: boolean }) => void;
  const current = account("account-one", 7, Promise.resolve(7));
  current.ask.mockResolvedValueOnce({ total: 7, atLeast: false }).mockImplementationOnce(
    () =>
      new Promise((done) => {
        recount = done;
      }),
  );
  render(current.frame);
  const button = await screen.findByRole("button", { name: "Screen 7" });
  await act(async () => {
    fireEvent.click(button);
  });
  expect(current.ask.mock.calls).toEqual([["news"], ["news"]]);
  const staleButton = screen.queryByRole("button", { name: "Screen 7" });
  if (staleButton) fireEvent.click(staleButton);
  await act(async () => {
    recount({ total: 0, atLeast: false });
  });
  expect(current.press.mock.calls).toEqual([["news"]]);
  expect(screen.queryByRole("note")).toBeNull();
});

it("returning to a pile waits for its new count before offering a screening press", async () => {
  let answerReturn!: (answer: { total: number; atLeast: boolean }) => void;
  const current = account("account-one", 7, Promise.resolve(2));
  current.ask
    .mockResolvedValueOnce({ total: 7, atLeast: false })
    .mockResolvedValueOnce({ total: 0, atLeast: false })
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          answerReturn = done;
        }),
    )
    .mockResolvedValue({ total: 0, atLeast: false });
  render(current.frame);
  expect(await screen.findByRole("button", { name: "Screen 7" })).toBeTruthy();
  await act(async () => current.address.visit("#/receipts"));
  await act(async () => current.address.visit("#/reads"));
  const stale = screen.queryByRole("button", { name: "Screen 7" });
  if (stale) fireEvent.click(stale);
  expect(current.press.mock.calls).toEqual([]);
  await act(async () => {
    answerReturn({ total: 2, atLeast: false });
  });
  fireEvent.click(screen.getByRole("button", { name: "Screen 2" }));
  expect(current.press.mock.calls).toEqual([["news"]]);
});

it("names the organizer eligible to screen the pile when another mailbox is held elsewhere", () => {
  const here = {
    status: "active",
    organizerRole: "organizer",
    organizerState: "held",
    organizedBy: { kind: "local", name: "Home desktop", since: null },
  } as const;
  const away = {
    ...here,
    organizerRole: "reader",
    organizedBy: { kind: "local", name: "Other laptop", since: null },
  } as const;
  expect(pileOrganizer([away, here], false)).toBe("Home desktop");
  expect(pileOrganizer([away, here], true)).toBe("Home desktop");
  expect(pileOrganizer([here, { ...away, organizerRole: "organizer" }], true)).toBeNull();
});

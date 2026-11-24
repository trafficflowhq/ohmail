/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import messages from "../messages/en.json";
import { storeMessage } from "./_store-fixture";
import {
  ISO, act, answerSyncWith, installShellEnv, mailbox, mountShell, page, teardownShellEnv, tick,
  liveAccountFetch,
} from "./fixtures/live-walk-shell";

/**
 *  ESCAPE CLOSES WHAT IS OPEN, IN SEARCH AND OVER THE NAV DRAWER.
 *
 * The app's own `?` sheet reads "esc — Close what is open", and two surfaces contradicted it:
 *
 *   · SEARCH was a keyboard trap. The box autofocuses, every letter types, and Escape did
 *     nothing — no blur, no clear, no exit. A keyboard user had no route out. And re-entering
 *     kept the old query with the caret at its end, so the next question was APPENDED to the
 *     last one.
 *   · The 390px NAV DRAWER stayed open and swallowed every press until its backdrop was
 *     tapped — Escape closed all seven overlays around it and left exactly this one standing.
 *
 * Every case runs the real shell on the fixture world and presses the real key.
 */
const width = window.innerWidth;
beforeEach(installShellEnv);
afterEach(async () => {
  await teardownShellEnv();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
});

async function shell(): Promise<HTMLElement> {
  const sync = page(1);
  answerSyncWith(() => sync.clone());
  const hit = storeMessage(0, ISO, { accountId: "acct_live_1", subject: "Glaze delivery" });
  const fetch = globalThis.fetch;
  globalThis.fetch = liveAccountFetch((input, init) => {
    const url = new URL(String(input), "https://harness.invalid");
    if (url.pathname.endsWith("/search")) {
      const items = url.searchParams.get("q") === "glaze" ? [hit] : [];
      return Promise.resolve(Response.json({ items, total: items.length, totalExact: true, ms: 4 }));
    }
    return fetch(input, init);
  });
  const host = await mountShell([mailbox({ id: "mb_1", lastSyncAt: ISO })]);
  await tick(0);
  return host;
}

const key = async (key: string): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await tick(50);
};

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const searchInput = (el: HTMLElement): HTMLInputElement =>
  within(el).getByRole<HTMLInputElement>("textbox", { name: messages.search.aria });
const keySheet = () => screen.queryByRole("dialog", { name: messages.shortcuts.title });
const news = (el: HTMLElement) => within(el).getByRole("heading", { name: "News" });
const ohbox = (el: HTMLElement) => within(el).getByRole("heading", { name: "Ohbox" });

describe(" Escape in Search: clear, then leave", () => {
  it("first press clears the query, second returns to the view `/` was pressed in", async () => {
    const container = await shell();
    // Enter Search from Reads — the way back out must be Reads, not a hard-coded Ohbox.
    // Wait on the VIEW, not the raw hash: jsdom delivers `hashchange` a task later, and two
    // navigations inside one task cancel out before React ever sees the first.
    const rail = within(container).getByRole("navigation", { name: "Places" });
    await act(async () => { within(rail).getByRole("button", { name: "News" }).click(); });
    await tick(100);
    expect(news(container)).toBeTruthy();
    await key("/");
    await type(searchInput(container), "glaze");
    await tick(1_000);
    expect(within(container).getByRole("button", { name: /Glaze delivery/i })).toBeTruthy();

    await key("Escape");
    expect(searchInput(container).value, "Escape did not clear the query").toBe("");
    expect(window.location.hash, "one Escape must not also leave").toBe("#/search");

    await key("Escape");
    expect(news(container)).toBeTruthy();
    expect(window.location.hash).toBe("#/reads");
  }, 20000);

  it("on an empty box a single Escape leaves", async () => {
    const container = await shell();
    await key("/");
    await key("Escape");
    expect(ohbox(container)).toBeTruthy();
    expect(window.location.hash).toBe("#/ohbox");
  }, 20000);

  it("an overlay still outranks the view: Escape closes the ? sheet, the query survives", async () => {
    const container = await shell();
    await key("/");
    await type(searchInput(container), "glaze");

    searchInput(container).blur();
    await key("?");
    expect(keySheet()).toBeTruthy();

    await key("Escape");
    expect(keySheet(), "Escape did not close the sheet").toBeNull();
    expect(searchInput(container).value, "Escape spent itself on the query instead").toBe("glaze");
  }, 20000);

  it("re-entering keeps the old query SELECTED, so typing replaces instead of appending", async () => {
    const container = await shell();
    await key("/");
    await type(searchInput(container), "glaze");

    const rail = within(container).getByRole("navigation", { name: "Places" });
    await act(async () => { within(rail).getByRole("button", { name: /^Ohbox/ }).click(); });
    await tick(50);
    expect(ohbox(container)).toBeTruthy();
    await key("/");

    const input = searchInput(container);
    expect(input.value).toBe("glaze"); // the answer survives the round trip…
    expect(
      [input.selectionStart, input.selectionEnd],
      "…but must come back selected, or the next question is appended to the last",
    ).toEqual([0, "glaze".length]);
  }, 20000);
});

/*
 * THE NAV DRAWER IN THE FRAME. Under 840 px the whole rail is More's sheet over the app: the case above's probe re-read
 * (the dock's More opens it, the sheet's scrim is its backdrop, a window's width is its innerWidth, and Escape is
 * pressed where the keys are, as a browser does).
 */
describe(" Escape closes the nav drawer, in the frame", () => {
  it("open the drawer from the topbar, press Escape, the drawer and backdrop are gone", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const container = await shell();
    const openNav = within(container).getByRole("button", { name: "More" });
    await act(async () => { openNav.click(); });
    await tick(50);
    expect(document.querySelector("[data-scrim]")).not.toBeNull();
    await key("Escape");
    expect(document.querySelector("[data-scrim]")).toBeNull();
  }, 20000);
});

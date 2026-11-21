/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, getByRole, getByText, queryByRole, queryByText, within } from "@testing-library/react";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import {
  act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  sessionFull, teardownConfirmEnv, tick,
} from "./fixtures/cloud-confirm-shell";
import { bindApiOwner, type AwayResponderSaveWire, type AwayResponderWire } from "../app/api-client";
import messages from "../messages/en.json";

/**
 * THE AWAY SWITCH SAYS WHAT IS SAVED.
 *
 * Pressing the switch drew "On. Replies to new mail, …" while nothing was stored, Save sat below
 * the fold, and leaving the pane dropped the change without a word: somebody who flipped it on
 * before a holiday was told replies would go out and none did. Measured through the signed-in Settings pane and browser navigation:
 *  · the status line states the SAVED row; an unsaved change has its own sentence and its own Save;
 *  · leaving with one asks — through the rail's verb, a settings pane switch, and Back/a link —
 *    and Discard leaves without a write, Keep editing stays with the edit;
 *  · controls: a save still writes the message unchanged, and switching off says off once saved.
 */

let host: HTMLElement;
let puts: Array<Omit<AwayResponderWire, "updatedAt">>;

const A = messages.away;

async function mount(row: Partial<AwayResponderSaveWire> = {}, url = "/mailbox#/settings/away", state: unknown = null): Promise<void> {
  const stored: AwayResponderSaveWire = {
    enabled: false, body: "Back Monday", startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: "t0",
    ...row,
  };
  puts = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), location.origin).pathname;
    if (url.includes("settings=devices") && path === "/api/hello") {
      return Response.json({ product: "ohmail", flavor: "managed", needsSetup: false, features: { pairing: true } });
    }
    if (path !== "/api/away-responder") {
      return fetch(input, init);
    }
    if (init?.method === "PUT") {
      const next = JSON.parse(String(init.body)) as Omit<AwayResponderWire, "updatedAt">;
      puts.push(next);
      Object.assign(stored, next, { updatedAt: "t1" });
    }
    return Response.json(stored);
  };
  window.history.replaceState(state, "", url);
  host = await mountCloudShell();
  await tick(2500);
}

const awaySwitch = () => getByRole(host, "switch", { name: A.title });
const pane = () => getByRole(host, "region", { name: A.title });
const menu = () => within(getByRole(host, "navigation", { name: messages.settings.navAria }));
const button = (name: string) => getByRole(pane(), "button", { name });
const save = () => {
  const unsaved = getByText(pane(), (text) => text === A.unsavedStillOff || text === A.unsavedStillOn);
  const announcement = unsaved.closest<HTMLElement>("[aria-live]");
  if (!announcement) throw new Error("the unsaved announcement is missing");
  return within(announcement).getByRole("button", { name: A.save });
};
const press = async (el: Element) => {
  await act(() => { fireEvent.click(el); });
  await tick(100);
};
const flip = () => press(awaySwitch());
const text = () => host.textContent ?? "";
const question = () => queryByText(host, (text) => text.endsWith(A.leaveAsk));
const onSettings = () =>
  queryByRole(host, "navigation", { name: messages.settings.navAria }) !== null ||
  queryByRole(host, "region", { name: messages.settings.title }) !== null;
const goOhbox = () => press(getByRole(within(host).getByRole("navigation", { name: "Places" }), "button", { name: /^Ohbox/ }));

beforeEach(() => {
  resetSessionTruthForTests();
  resetStorageOwnerForTest();
  localStorage.clear();
  installConfirmEnv();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  rememberOwner();
});
afterEach(async () => {
  await teardownConfirmEnv();
  bindApiOwner(null);
  resetSessionTruthForTests();
  resetStorageOwnerForTest();
  window.history.replaceState(null, "", "/");
});

describe("the status line states the saved responder", () => {
  it("switching on draws the unsaved sentence and its Save, never 'On.'", async () => {
    await mount();
    expect(text()).toContain(A.off);
    await flip();
    expect(text(), "the line read the draft").not.toContain(A.on);
    expect(text()).toContain(A.off);
    expect(text()).toContain(A.unsavedStillOff);
    /* The Save beside the sentence, in the block under the switch. */
    expect(save().textContent).toContain(A.save);
    expect(puts).toHaveLength(0);
  });

  it("the end-date note follows the saved row too: no 'On until' over a responder still off", async () => {
    await mount({ endsAt: "2036-09-14T23:59:59.000Z" });
    /* At rest: a saved OFF row that keeps a stored end date reads Off, and nothing else. */
    expect(text()).toContain(A.off);
    expect(text()).not.toContain("On until");
    await flip();
    expect(text()).not.toContain("On until");
    await press(save());
    expect(text()).toContain("On until ");
  });

  it("CONTROL: the Save beside it writes the row, the message unchanged, and the line says On", async () => {
    await mount();
    await flip();
    await press(save());
    expect(puts).toHaveLength(1);
    expect(puts[0]!.enabled).toBe(true);
    expect(puts[0]!.body).toBe("Back Monday");
    expect(text()).toContain(A.on);
    expect(text()).not.toContain(A.unsavedStillOff);
    expect(text()).toContain(A.saved);
    /* Nothing unsaved, nothing to ask: leaving goes. */
    await goOhbox();
    expect(onSettings()).toBe(false);
  });

  it("CONTROL: switching off says off once saved, and 'stays on' until then", async () => {
    await mount({ enabled: true });
    expect(text()).toContain(A.on);
    await flip();
    expect(text()).toContain(A.on);
    expect(text()).toContain(A.unsavedStillOn);
    await press(save());
    expect(puts.at(-1)!.enabled).toBe(false);
    expect(text()).toContain(A.off);
    expect(text()).not.toContain(A.on);
  });
});

describe("leaving with an unsaved change asks", () => {
  it("the rail's verb is held: asked, Keep editing stays with the edit, Discard leaves unsaved", async () => {
    await mount();
    await flip();
    const depth = window.history.length;
    await goOhbox();
    expect(onSettings(), "the pane was left without a question").toBe(true);
    /* Asked BEFORE the hash is written: no history entry for a leave that did not happen. */
    expect(window.history.length).toBe(depth);
    expect(window.location.hash).toBe("#/settings/away");
    expect(question()?.textContent).toContain(A.leaveAsk);
    await press(button(A.leaveKeep));
    expect(question()).toBeNull();
    expect(onSettings()).toBe(true);
    expect(awaySwitch().getAttribute("aria-checked") ?? String((awaySwitch() as HTMLInputElement).checked)).toBe("true");

    await goOhbox();
    await press(button(A.leaveDiscard));
    expect(onSettings()).toBe(false);
    expect(window.location.hash).toBe("#/ohbox");
    expect(puts).toHaveLength(0);
  });

  it("a Back press or a link is held too, and the address goes back to the pane", async () => {
    await mount();
    await flip();
    await act(async () => { window.location.hash = "#/screener"; });
    await tick(100);
    expect(onSettings()).toBe(true);
    expect(window.location.hash).toBe("#/settings/away");
    expect(question()).not.toBeNull();
    await press(button(A.leaveDiscard));
    expect(window.location.hash).toBe("#/screener");
    expect(onSettings()).toBe(false);
    expect(puts).toHaveLength(0);
  });

  it("another settings pane is a leave as well", async () => {
    await mount();
    await flip();
    const entry = menu().getByRole("button", { name: messages.settings.screener });
    const depth = window.history.length;
    await press(entry!);
    expect(window.location.hash).toBe("#/settings/away");
    expect(window.history.length).toBe(depth);
    expect(question()).not.toBeNull();
  });

  it("closing the tab asks the browser's question while unsaved, and not after a save", async () => {
    await mount();
    const unload = (): boolean => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await flip();
    expect(unload()).toBe(true);
    await press(save());
    expect(unload()).toBe(false);
  });

  it("CONTROL: a message typed and deleted over an empty one is no change", async () => {
    await mount({ body: null });
    const field = getByRole(host, "textbox", { name: A.bodyLabel });
    const type = async (v: string): Promise<void> => {
      await act(() => { fireEvent.change(field, { target: { value: v } }); });
      await tick(100);
    };
    await type("x");
    expect(text()).toContain(A.unsavedStillOff);
    await type("");
    expect(text()).not.toContain(A.unsavedStillOff);
    await goOhbox();
    expect(onSettings()).toBe(false);
  });

  it("opens a saved Away link in place and still guards unsaved edits", async () => {
    const depth = window.history.length;
    await mount({}, "/mailbox?settings=away&source=bookmark#/settings");
    expect(window.location.hash).toBe("#/settings/away");
    expect(window.location.search).toBe("?source=bookmark");
    expect(window.history.length).toBe(depth);
    await flip();
    await press(menu().getByRole("button", { name: A.title }));
    expect(question()).toBeNull();
    expect(text()).toContain(A.unsavedStillOff);
    await press(menu().getByRole("button", { name: messages.settings.screener }));
    expect(question()).not.toBeNull();
  });

  it("CONTROL: a pile ticked and unticked over an old spelling or an inert Screener pile is no change", async () => {
    await mount({ piles: ["INBOX", "ohmail/Reads", "ohmail/Screener"] as never });
    await press(button(A.pileReceipts));
    expect(text()).toContain(A.unsavedStillOff);
    await press(button(A.pileReceipts));
    expect(text()).not.toContain(A.unsavedStillOff);
    await goOhbox();
    expect(onSettings()).toBe(false);
  });

  it("CONTROL: an edit put back by hand is no change — nothing asks", async () => {
    await mount();
    await flip();
    await flip();
    expect(text()).not.toContain(A.unsavedStillOff);
    await goOhbox();
    expect(onSettings()).toBe(false);
  });
});

it("opens the desktop Devices link in place while preserving the query and history state", async () => {
  const depth = window.history.length;
  const state = { source: "desktop settings" };
  await mount({}, "/mailbox?settings=devices&source=desktop#/settings", state);
  expect(window.location.hash).toBe("#/settings/devices");
  expect(window.location.search).toBe("?source=desktop");
  expect(window.history.state).toEqual(state);
  expect(window.history.length).toBe(depth);
  expect(menu().getByRole("button", { name: messages.settings.devices }).getAttribute("aria-current")).toBe("page");
});

/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMessage, UnsubscribeHeaderState } from "@ohmail/wire";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import messages from "../messages/en.json";
import { act, installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import { openScreenerSender } from "./fixtures/live-screener-unsubscribe";
import { screenerReport, screenerRow } from "./fixtures/live-screener";

const removedExplanation = "Where a sender offers one-click unsubscribe, Spam and Screen out here also ask to unsubscribe you.";

const ONE_CLICK = "news@list.example";
const NO_OFFER = "person@plain.example";
const copy = messages.screener;
const confirmedLabel = copy.place.unsub.screened;

type Held = {
  id: string;
  from: string;
  posture: UnsubscribeHeaderState | "unread";
  verdict?: EngineMessage["authVerdict"];
};

async function cleanMount(): Promise<void> {
  await teardownShellEnv();
  vi.unstubAllGlobals();
}
beforeEach(() => localStorage.clear());
afterEach(cleanMount);

async function mount({ held, width, autoUnsubscribe, providerConfirms, consentRow }: {
  held: readonly [Held, ...Held[]];
  width: 1280 | 390;
  autoUnsubscribe?: boolean;
  providerConfirms?: boolean;
  consentRow?: Parameters<typeof openScreenerSender>[0]["consentRow"];
}) {
  installShellEnv();
  vi.stubGlobal("innerWidth", width);
  const letter = ({ id, posture, verdict }: Held) => ({ id, posture: posture === "unread" ? null : posture, verdict });
  const opened = await openScreenerSender({
    address: held[0].from,
    letters: [letter(held[0]), ...held.slice(1).map(letter)],
    autoUnsubscribe,
    providerConfirms,
    consentRow,
  });
  expect(opened.shell.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe(width === 390 ? "1" : "2");
  return opened;
}

const cardLine = (shell: HTMLElement): string | null => {
  const sheet = shell.querySelector('[data-kind="reading"]');
  if (!sheet) throw new Error("the sender sheet is not open");
  return within(sheet as HTMLElement).queryByText(copy.unsubOffered, { exact: true })?.textContent ?? null;
};
const screenOut = (shell: HTMLElement): HTMLElement =>
  within(within(shell).getByRole("toolbar", { name: copy.place.panel }))
    .getByRole("button", { name: /^(Screen out)( \+ unsubscribe)?$/ });
const click = (button: HTMLElement): Promise<void> =>
  act(async () => { button.click(); });

async function confirmScreenOut(shell: HTMLElement, label = confirmedLabel): Promise<void> {
  await click(screenOut(shell));
  const ask = within(document.body).getByRole("dialog", { name: confirmedLabel });
  expect(ask.textContent).toContain(copy.place.unsub.service);
  await click(within(ask).getByRole("button", { name: label }));
}

// Keep the case names referenced by the older-tests checklist. The confirmed-press ruling
// limits unsubscribe to waiting mail and keeps the Undo window for filing-only decisions.
describe.each([1280, 390] as const)("the Screener card at %i says the unsubscribe before the press", (width) => {
  it("a sender whose held letter offers one-click: the card says it as a fact", async () => {
    const mounted = await mount({ held: [{ id: "a1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width });
    expect(cardLine(mounted.shell)).toBe(copy.unsubOffered);
    expect(mounted.shell.textContent).not.toContain("also send");
    await click(screenOut(mounted.shell));
    const ask = within(document.body).getByRole("dialog", { name: confirmedLabel });
    expect(within(ask).getByRole("button", { name: confirmedLabel })).toBeTruthy();
    expect(mounted.decisions).toEqual([]);
  });

  it("a one-click letter its provider did not confirm: the condition, never the fact — the pass sends only for a confirmed sender", async () => {
    const mounted = await mount({ held: [{ id: "a2", from: ONE_CLICK, posture: "one_click", verdict: "unavailable" }], width });
    expect(cardLine(mounted.shell)).toBe(copy.unsubOffered);
    expect(mounted.shell.textContent).not.toContain("also send");
    await click(screenOut(mounted.shell));
    const ask = within(document.body).getByRole("dialog", { name: confirmedLabel });
    expect(within(ask).getByRole("button", { name: messages.screening.unsubCommitMaybe })).toBeTruthy();
    expect(mounted.decisions).toEqual([]);
  });

  it("every held letter read and none offering it: the condition still stands — later mail and past mail may offer one", async () => {
    const mounted = await mount({ held: [{ id: "b1", from: NO_OFFER, posture: "no_header" }, { id: "b2", from: NO_OFFER, posture: "not_one_click" }], width });
    expect(cardLine(mounted.shell)).toBe(copy.unsubOffered);
    expect(mounted.shell.textContent).not.toContain("also send");
    await click(screenOut(mounted.shell));
    const ask = within(document.body).getByRole("dialog", { name: confirmedLabel });
    expect(within(ask).getByRole("button", { name: messages.screening.unsubCommitMaybe })).toBeTruthy();
    expect(mounted.decisions).toEqual([]);
  });

  it("a held letter still unread: the card says it as a condition, never as a promise", async () => {
    const mounted = await mount({ held: [{ id: "c1", from: NO_OFFER, posture: "no_header" }, { id: "c2", from: NO_OFFER, posture: "unread" }], width });
    expect(cardLine(mounted.shell)).toBe(copy.unsubOffered);
    expect(mounted.shell.textContent).not.toContain("also send");
    await click(screenOut(mounted.shell));
    const ask = within(document.body).getByRole("dialog", { name: confirmedLabel });
    expect(within(ask).getByRole("button", { name: messages.screening.unsubCommitMaybe })).toBeTruthy();
    expect(mounted.decisions).toEqual([]);
  });

  it("the account's switch off: nothing is said, whatever the sender offers", async () => {
    const mounted = await mount({ held: [{ id: "d1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width, autoUnsubscribe: false });
    expect(cardLine(mounted.shell)).toBeNull();
    expect(screenOut(mounted.shell)).toBeTruthy();
  });

});

describe("the press, and how far its Undo reaches", () => {
  it("Undo inside the window stops the decision and the request: nothing reaches the wire", async () => {
    const { shell, decisions } = await mount({
      held: [{ id: "e1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width: 1280, autoUnsubscribe: false,
    });
    await click(screenOut(shell));
    expect(screenerReport()).not.toContain("unsubscribe");
    const undo = within(document.body).getByRole("button", { name: "Undo" });
    expect(decisions).toEqual([]);
    await click(undo);
    await tick(COMMIT_MS + 1);
    expect(decisions).toEqual([]);
    expect(screenerRow(shell, "e1")).toBeTruthy();
  });

  it("left alone, the window closes and the screen-out is sent once — the request the server then makes", async () => {
    const { shell, decisions } = await mount({ held: [{ id: "f1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width: 1280 });
    await confirmScreenOut(shell);
    expect(within(document.body).queryByRole("button", { name: "Undo" })).toBeNull();
    const confirmed = [{
      id: "f1", body: { decision: "no", dest: "ohmail/Screened", scope: "sender", applyRetro: false, unsubscribeIds: ["f1"] },
    }];
    expect(decisions).toEqual(confirmed);
    await tick(COMMIT_MS + 1);
    expect(decisions).toEqual(confirmed);
  });

  it("on the same account, the next screen-out sends only for the newly selected sender without another confirmation", async () => {
    const consentRow = { screenerAcknowledgements: 0 };
    const first = await mount({
      held: [{ id: "f2", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width: 1280, consentRow,
    });
    await confirmScreenOut(first.shell);
    expect(first.decisions.map(({ id }) => id)).toEqual(["f2"]);
    await cleanMount();

    const second = await mount({
      held: [{ id: "f3", from: "news@another-list.example", posture: "one_click", verdict: "pass" }],
      width: 1280, consentRow,
    });
    await tick(COMMIT_MS + 1);
    expect(second.decisions).toEqual([]);
    await click(screenOut(second.shell));
    expect(within(document.body).queryByRole("dialog")).toBeNull();
    expect(within(document.body).queryByRole("button", { name: "Undo" })).toBeNull();
    const confirmed = [{
      id: "f3", body: { decision: "no", dest: "ohmail/Screened", scope: "sender", applyRetro: false, unsubscribeIds: ["f3"] },
    }];
    expect(second.decisions).toEqual(confirmed);
    await tick(COMMIT_MS + 1);
    expect(second.decisions).toEqual(confirmed);
  });

  it("a sender whose held letter offers none: the toast still names the request as the sender-level condition", async () => {
    const { shell, decisions } = await mount({ held: [{ id: "g1", from: NO_OFFER, posture: "no_header" }], width: 390 });
    await confirmScreenOut(shell, messages.screening.unsubCommitMaybe);
    expect(screenerReport()).toContain("Screened out");
    expect(screenerReport()).not.toContain("unsubscribe");
    expect(decisions).toEqual([]);
  });
});

describe("an account whose mailboxes' providers ohmail cannot read says no unsubscribe before or after the press", () => {
  it("nothing on the card, the bulk strip or the toast, over a one-click letter", async () => {
    const { shell } = await mount({
      held: [{ id: "m1", from: ONE_CLICK, posture: "one_click", verdict: "unavailable" }],
      width: 1280, providerConfirms: false,
    });
    expect(cardLine(shell)).toBeNull();
    const tools = within(shell).getByRole("group", { name: copy.bulkAria });
    expect(tools.textContent).not.toContain(removedExplanation);
    await click(screenOut(shell));
    expect(within(document.body).queryByRole("dialog", { name: confirmedLabel })).toBeNull();
    expect(screenerReport()).toContain("Screened out");
    expect(screenerReport()).not.toContain("unsubscrib");
  });

  it("the control: a Gmail mailbox's confirmed one-click letter is said as a fact", async () => {
    const { shell, decisions } = await mount({
      held: [{ id: "m2", from: ONE_CLICK, posture: "one_click", verdict: "pass" }],
      width: 1280, providerConfirms: true,
    });
    expect(cardLine(shell)).toBe(copy.unsubOffered);
    const panel = within(within(shell).getByRole("toolbar", { name: copy.place.panel }));
    await click(panel.getByRole("button", { name: "Spam" }));
    expect(decisions).toEqual([]);
    const ask = within(document.body).getByRole("dialog", { name: copy.place.unsub.spam });
    await click(within(ask).getByRole("button", { name: copy.place.unsub.spam }));
    expect(decisions).toEqual([{
      id: "m2", body: {
        decision: "no", dest: "ohmail/Quarantine", scope: "confirmed_sender", applyRetro: false,
        confirmedIds: ["m2"], unsubscribeIds: ["m2"],
      },
    }]);
  });
});

describe("the row's menu, its Accept and the bulk strip say it before the press too", () => {
  it("the bulk strip says it for any waiting sender, and not with the switch off", async () => {
    const on = await mount({ held: [{ id: "j1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }], width: 1280 });
    const tools = (shell: HTMLElement) => within(shell).getByRole("group", { name: copy.bulkAria });
    expect(within(tools(on.shell)).queryByText(removedExplanation, { exact: true })).toBeNull();
    expect(on.decisions).toEqual([]);
    await cleanMount();

    const off = await mount({
      held: [{ id: "k1", from: NO_OFFER, posture: "no_header" }],
      width: 1280, autoUnsubscribe: false,
    });
    await click(within(tools(off.shell)).getByRole("button", { name: copy.place.listMenu }));
    const menu = within(document.body).getByRole("menu", { name: copy.place.listMenu });
    expect(within(menu).getByRole("menuitem", { name: copy.markAllSpam })).toBeTruthy();
    expect(within(tools(off.shell)).queryByText(removedExplanation, { exact: true })).toBeNull();
    expect(off.decisions).toEqual([]);
  });
});

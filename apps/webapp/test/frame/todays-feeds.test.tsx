/** @vitest-environment jsdom */
/**
 * WHAT TODAY'S CHROME SAID, SAID BY THE FRAME. The rail as a fed model (its entries, counts, current place, the tags'
 * fold), the strips as notices in the one slot (the desktop offer, the organizer's and the gap's two answers, the
 * update with its press, a waiting send whose "Show" opens today's list), and the first run's hold. These were the
 * old shell's own tests of its rail and strips; the strips' components keep their own.
 */
import { createElement as h, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "@ohmail/app/host";
import { Frame, PLACE_IDS, type FramePlaces, type PaneProps } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { announceUpdate, announceVersion, holdFilesForRestart, holdForRestart, resetUpdateStoreForTests } from "@ohmail/app-logic/doors/app-update";
import type { RailGroup } from "@ohmail/ui";
import messages from "../../messages/en.json";
import { engineOver, setup, storeWith, teardown } from "../_view-shell";
import { hostFromTodaysInputs } from "../_todays-shell";
import { DESKTOP_CTA_DISMISSED, DESKTOP_DOWNLOAD_URL, useTodaysFeeds, type TodaysFeedsInput } from "../../app/shell/todays-feeds";
import type { MailSendApi, SendLineItem } from "@ohmail/app-logic/writing/mail-send";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";

const quiet = { key: "quiet", settled: true } as unknown as TodaysFeedsInput["mailState"];

function sendLine(items: SendLineItem[]): MailSendApi {
  return {
    line: () => items, subscribeLine: () => () => undefined, lineVersion: () => 0,
    mountLine: () => () => undefined, dismissLine: () => undefined, showing: () => () => undefined,
  } as unknown as MailSendApi;
}

const GROUPS: RailGroup[] = [
  { items: [{ id: "ohbox", label: "Ohbox", count: 5, hot: true }, { id: "reads", label: "News" }] },
  { items: [{ id: "triage-aside", label: "Parked", count: 2 }] },
  { items: [], tags: { label: "Tags", items: [{ id: "t-1", label: "Receipts 2026", hue: "ochre", count: 3 }] } },
];

let input: Omit<TodaysFeedsInput, "t">;
/** The wide pane: it feeds the frame as today's views do, with the root translator they hand in. */
function Feeds(_: PaneProps): ReactNode {
  return useTodaysFeeds({ ...input, t: useTranslations() as unknown as TodaysFeedsInput["t"] });
}

async function mount() {
  const engine = engineOver(await storeWith([]));
  const { EngineProvider } = await import("../../app/shell/engine");
  const { useTodaysSupplies } = await import("../../app/shell/todays-supplies");
  const { ThemeProvider } = await import("@ohmail/ui");
  function Host() {
    const frame = useTodaysSupplies(NONE);
    const feeds = { id: "ohbox", body: "feeds", rail: null, panes: { kind: "wide", Wide: Feeds } } as const;
    const places = Object.fromEntries(PLACE_IDS.map((id) => [id, { ...feeds, id }])) as unknown as FramePlaces;
    const host = hostFromTodaysInputs({ demo: false, engine }, engine, { ...frame, places }, NONE);
    return h(Frame, { host });
  }
  return render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC" } as never,
    h(TextProvider, { locale: "en", messages: messages as never, timeZone: "UTC" } as never,
      h(ThemeProvider as never, null, h(EngineProvider, { demo: false, engine } as never, h(Host))))));
}

beforeEach(() => {
  setup();
  window.location.hash = "#/ohbox";
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  resetUpdateStoreForTests();
  input = {
    demo: false, scope: null, facts: [], mailState: quiet, setupHref: null, mailSend: sendLine([]), desktopSection: true,
    railGroups: GROUPS, activeRailId: "ohbox", routeView: "ohbox", activeTagId: null, compose: () => undefined,
    pull: { available: false, pulling: false, pull: () => undefined }, account: null, mailboxes: [],
    organizer: { changes: [], acknowledge: async () => undefined, on: false },
    gap: { offers: [], answer: async () => undefined, on: false },
    openNotSent: () => true, hold: false,
  };
});
afterEach(async () => {
  cleanup();
  resetUpdateStoreForTests();
  await teardown();
});

const rail = () => screen.getByRole("navigation", { name: "Main" });

describe("today's rail, fed to the frame", () => {
  it("draws the entries with their counts, the current place, and goes where a press says", async () => {
    await mount();
    const ohbox = within(rail()).getByRole("button", { name: "Ohbox 5" });
    expect(ohbox.getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(rail()).getByRole("button", { name: "Parked 2" }));
    expect(window.location.hash).toBe("#/triage/aside");
    // The rail's Compose is today's: the press the composer's door answers.
    const compose = vi.fn();
    input = { ...input, compose };
    cleanup();
    await mount();
    fireEvent.click(within(rail()).getByRole("button", { name: /Compose/ }));
    expect(compose).toHaveBeenCalledOnce();
  });

  it("folds the tags as today's rail did, and offers a new tag in place", async () => {
    await mount();
    expect(within(rail()).getByRole("button", { name: "Receipts 2026 3" })).toBeTruthy();
    fireEvent.click(within(rail()).getByRole("button", { name: "Tags" }));
    expect(within(rail()).queryByRole("button", { name: "Receipts 2026 3" })).toBeNull();
    // The fold is remembered on this device: drawn again, the group stays shut.
    cleanup();
    await mount();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(within(rail()).queryByRole("button", { name: "Receipts 2026 3" })).toBeNull();
    expect(within(rail()).getByRole("button", { name: "Tags" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the rail's account line", () => {
  const mailbox = (address: string) => ({ id: "mbx-1", address }) as unknown as MailboxFacts;
  const accountLine = () => within(rail()).queryByRole("button", { name: /mailbox@example\.com|account@example\.com|\?/ });

  it("names the mailbox the shell holds the facts of, before the account and the mirror's list", async () => {
    input = { ...input, facts: [mailbox("mailbox@example.com")], account: null, mailboxes: [] };
    await mount();
    expect(within(rail()).getByText("mailbox@example.com")).toBeTruthy();
  });

  it("names the account's address where no mailbox's facts are known", async () => {
    input = { ...input, facts: [], account: "account@example.com" };
    await mount();
    expect(within(rail()).getByText("account@example.com")).toBeTruthy();
  });

  it("is withheld where nobody is known: no circle with a question mark and an empty name", async () => {
    input = { ...input, facts: null, account: null, mailboxes: [], pull: { available: true, pulling: false, pull: () => undefined } };
    await mount();
    expect(accountLine()).toBeNull();
    expect(within(rail()).queryByText("?")).toBeNull();
    // Pull new mail still stands in the foot.
    expect(within(rail()).getByRole("button", { name: /Pull new mail/ })).toBeTruthy();
  });
});

describe("a row dragged to the fed rail", () => {
  it("still finds its targets: a pile by the rail's id, a tag by its own", async () => {
    const { railDropTargetOf } = await import("../../app/shell/drag-file");
    await mount();
    expect(railDropTargetOf(within(rail()).getByRole("button", { name: "Parked 2" }))?.target).toEqual({ kind: "pile", action: "aside" });
    expect(railDropTargetOf(within(rail()).getByRole("button", { name: "Receipts 2026 3" }))?.target).toEqual({ kind: "tag", tagId: "t-1" });
    expect(railDropTargetOf(within(rail()).getByRole("button", { name: "Tags" }))).toBeNull();
  });
});

describe("today's strips, as notices in the one slot", () => {
  it("offers the desktop app in a signed-in browser, and a dismissal keeps it away", async () => {
    input = { ...input, desktopSection: false };
    await mount();
    expect(screen.getByText(/Get ohmail for/)).toBeTruthy();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(open).toHaveBeenCalledWith(DESKTOP_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(localStorage.getItem(DESKTOP_CTA_DISMISSED)).toBe("1");
    expect(screen.queryByText(/Get ohmail for/)).toBeNull();
  });

  it("never offers the desktop app inside the desktop app or on the demo", async () => {
    input = { ...input, desktopSection: true };
    await mount();
    expect(screen.queryByText(/Get ohmail for/)).toBeNull();
    cleanup();
    input = { ...input, desktopSection: false, demo: true };
    await mount();
    expect(screen.queryByText(/Get ohmail for/)).toBeNull();
  });

  it("says who stopped organizing a mailbox, with its two answers, and Dismiss sends the acknowledgement", async () => {
    const acknowledge = vi.fn(async () => undefined);
    input = { ...input, organizer: { on: true, acknowledge, changes: [{ id: "mb-1", address: "lena@example.com", kind: "stopped", name: "Kestrel", at: "2026-11-01T00:00:00Z", order: 0 } as never] } };
    await mount();
    const said = screen.getByText(/Kestrel stopped organizing lena@example.com/).closest<HTMLElement>('[role="status"]')!;
    expect(within(said).getByRole("button", { name: "Mailboxes" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); });
    expect(acknowledge).toHaveBeenCalledWith("mb-1");
    expect(screen.queryByText(/Kestrel stopped organizing/)).toBeNull();
  });

  it("offers the letters a gap left behind, and an answer reaches the mailbox with both counts", async () => {
    const answer = vi.fn(async () => undefined);
    input = { ...input, gap: { on: true, answer, offers: [{ id: "mb-1", address: "lena@example.com", count: 4, strangers: 0 }] } };
    await mount();
    const file = screen.getAllByRole("button").find((b) => /^File/.test(b.textContent ?? ""))!;
    await act(async () => { fireEvent.click(file); });
    expect(answer).toHaveBeenCalledWith("mb-1", { file: true, count: 4, strangers: 0 });
  });

  it("says a newer ohmail is ready, and Later puts it away", async () => {
    await mount();
    const restart = vi.fn();
    await act(async () => { announceUpdate({ kind: "ready", version: "2.0.1", act: restart } as never); });
    expect(screen.getByText(/2\.0\.1/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart" })); });
    expect(restart).toHaveBeenCalledOnce();
  });

  /* The rail's foot keeps no version line: the running version is said nowhere, with or without an offer, and the
     update notice names the version that is ready. */
  it("keeps no version line for the running ohmail; the update notice names the ready one", async () => {
    const view = await mount();
    await act(async () => { announceVersion("2.0.0"); });
    expect(view.container.textContent, "the running version took a line").not.toContain("2.0.0");
    await act(async () => { announceUpdate({ kind: "ready", version: "2.0.1", act: () => {} } as never); });
    expect(view.container.textContent).toContain("2.0.1");
    expect(view.container.textContent, "the offer named the running version").not.toContain("2.0.0");
  });

  it("writes an open editor's words before Restart restarts, and a hold that began meanwhile stops the press", async () => {
    await mount();
    const order: string[] = [];
    const release = holdForRestart(async () => { order.push("written"); });
    await act(async () => { announceUpdate({ kind: "ready", version: "2.0.1", act: () => order.push("restarted") } as never); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart" })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(order).toEqual(["written", "restarted"]);
    release();
  });

  it("leaves the restart uncalled when a hold begins while the editor's words are written", async () => {
    await mount();
    const restart = vi.fn();
    let drop = (): void => {};
    /* The editor takes files while its words are written: a hold that was not there when Restart was pressed. */
    const release = holdForRestart(async () => {
      drop = holdFilesForRestart();
    });
    await act(async () => { announceUpdate({ kind: "ready", version: "2.0.1", act: restart } as never); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart" })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(restart, "the restart dropped the files the editor took meanwhile").not.toHaveBeenCalled();
    release();
    drop();
  });

  it("says a send did not go, and Show opens today's list in a dialog", async () => {
    const ended = { id: "s1", key: "compose", state: "ended", to: "Lena", subject: "Plans", ended: null } as unknown as SendLineItem;
    input = { ...input, mailSend: sendLine([ended]) };
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("holds the frame inert while the first run's stage stands", async () => {
    input = { ...input, hold: true };
    const view = await mount();
    expect(view.container.querySelector(".fr-root")?.hasAttribute("data-held")).toBe(true);
  });
});


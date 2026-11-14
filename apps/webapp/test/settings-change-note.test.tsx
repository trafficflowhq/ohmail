/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import type { AwayTransport } from "../app/shell/AwayResponderRow";
import type { AwayResponderSaveWire, AwayResponderWire } from "../app/api-client";
import type { TravelledChangeWire } from "../app/shell/travelled-change";

/**
 * THE AWAY ROW, THE DORMANCY DIAL AND THE SIGNATURE EDITORS SAY WHERE A READER'S CHANGE WENT —
 * the Screening pane's sentence on the three other settings that travel, through the real
 * components: the refusal a read carries, the dial's "sent" at the press, and each mailbox's own
 * line. And the hosted transport carries a signature's formatting: it dropped it, so a formatted
 * save in the browser was sent as "clear the signature".
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

const S = messages.settings.screening;
const ASKED = messages.away.asked;
const REFUSED: TravelledChangeWire = { state: "refused", holder: "work-laptop", refusal: "unreadable" };
const REFUSED_TEXT = S.refusedUnreadable.replace("{name}", "work-laptop");

let host: HTMLDivElement;
let root: Root | null = null;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
async function mount(node: React.ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: node }) }),
    }));
  });
  await flush();
}
const text = (): string => host.textContent ?? "";
/* Imported after the API base is set: the client reads it when its module loads. */
const Away = async () => (await import("../app/shell/AwayResponderRow")).AwayResponderRow as
  React.FunctionComponent<{ transport: AwayTransport }>;
const Dormancy = async () => (await import("../app/shell/DormancyRow")).DormancyRow;

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  vi.useRealTimers();
});

const ROW: AwayResponderWire = {
  enabled: false, body: "Back Monday.", startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: "2026-09-26T08:00:00.000Z",
};

describe("the away row on a reader", () => {
  it("says a refusal the read carries when the pane opens", async () => {
    const transport: AwayTransport = { state: async () => ({ ...ROW, change: REFUSED }), save: async () => ROW };
    await mount(h(await Away(), { transport }));
    expect(text(), "the refusal reached no surface").toContain(REFUSED_TEXT);
  });

  it("CONTROL: an applied change the read carries says nothing on open", async () => {
    const transport: AwayTransport = {
      state: async () => ({ ...ROW, change: { state: "applied", holder: null, refusal: null } }), save: async () => ROW,
    };
    await mount(h(await Away(), { transport }));
    expect(text()).not.toContain(S.applied);
    expect(text()).not.toContain("Not applied");
  });

  it("ends its wait on the refusal instead of standing on 'asked'", async () => {
    let answer: AwayResponderWire = ROW;
    const transport: AwayTransport = {
      state: async () => answer,
      save: async (): Promise<AwayResponderSaveWire> => ({ ...ROW, pending: true }),
    };
    await mount(h(await Away(), { transport }));
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === messages.away.save)!;
    await act(async () => { save.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(text()).toContain(ASKED);
    answer = { ...ROW, change: REFUSED };
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await flush();
    expect(text()).toContain(REFUSED_TEXT);
    expect(text()).not.toContain(ASKED);
  });
});

describe("the dormancy dial on a reader", () => {
  it("says the change was sent, and says a refusal", async () => {
    const setDormancyDays = async () => 90;
    await mount(h(await Dormancy(), { days: 90, scope: "window", change: { state: "asked", holder: null, refusal: null }, setDormancyDays }));
    expect(text(), "the dial snapped back with nothing said").toContain(ASKED);
    if (root) await act(async () => { root!.unmount(); });
    host.remove();
    await mount(h(await Dormancy(), { days: 90, scope: "window", change: REFUSED, setDormancyDays }));
    expect(text()).toContain(REFUSED_TEXT);
  });

  it("an applied change says nothing over the dial's own row", async () => {
    await mount(h(await Dormancy(), {
      days: 90, scope: "window", change: { state: "applied", holder: null, refusal: null }, setDormancyDays: async () => 90,
    }));
    expect(text()).not.toContain(S.applied);
    expect(text()).not.toContain(ASKED);
  });
});

describe("the signature editors on a reader", () => {
  it("each mailbox says its own change", async () => {
    const { SignaturesRow } = await import("../app/shell/SignaturesRow");
    await mount(h(SignaturesRow, {
      mailboxes: [
        { id: "m-1", address: "one@example.test", organizerRole: "reader" },
        { id: "m-2", address: "two@example.test", organizerRole: "organizer" },
      ],
      signatures: {}, signaturesHtml: {}, signatureSources: {},
      changes: { "m-1": REFUSED },
      setMailboxSignature: async () => ({}),
    }));
    const blocks = [...host.querySelectorAll<HTMLElement>(".sig-settings")];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.textContent, "the refusal reached no surface").toContain(REFUSED_TEXT);
    expect(blocks[1]!.textContent).not.toContain("Not applied");
  });
});

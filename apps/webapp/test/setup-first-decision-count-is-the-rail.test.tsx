/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import german from "../messages/de.json";
import { NOW, S, act, consentTransport, engineOver, msg, setup, storeWith, teardown, waitFor } from "./_view-shell";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";

/**
 * THE FIRST DECISION COUNTS WHAT THE RAIL COUNTS — the whole shell over a memory
 * mirror. Setup's first-decision step said "One sender is waiting" whatever waited, because its
 * sentence was a fixed one; the rail behind it read Screener 3. The step now takes the rail's own
 * count (`ScreenerState.waitingCount`) through the shell, so the two cannot disagree.
 */

const h = React.createElement;
const t = messages.onboarding;

const ORGANIZED: MailboxFacts = {
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer", organizedBy: null, organizerState: null,
  organizeConsentedAt: "2026-09-16T08:30:00.000Z", initialImportCompletedAt: "2026-09-16T08:40:00.000Z",
} as MailboxFacts;

const host = (): FirstRunHost => ({
  door: "selfhost", ai: "off",
  probe: async () => ({ host: "h", user: "u", folders: 1 }),
  connect: async () => ({ id: "mb1" }),
  organize: async () => "stored",
  complete: async () => { /* stamped */ },
  probeReason: () => null,
  probeMessage: () => null,
});

/** `n` senders who wrote and were never decided, each with two letters held in the Screener. */
function waiting(n: number): EngineMessage[] {
  const rows: EngineMessage[] = [];
  for (let i = 0; i < n; i++) {
    for (const k of [0, 1]) {
      rows.push(msg(`w${i}-${k}`, {
        from: { address: `sender${i}@rig.invalid`, name: `Rig Sender ${i}` },
        folder: "ohmail/Screener", unread: true, date: `2026-09-16T08:0${k}:00.000Z`,
      } as Partial<EngineMessage>));
    }
  }
  return rows;
}

async function launch(n: number, locale: "en" | "de" = "en"): Promise<HTMLElement> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const s = await storeWith(waiting(n));
  const engine = engineOver(s);
  S.store = s; S.engine = engine;
  window.location.hash = "#/first-run";
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  S.roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: locale === "de" ? german : messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { children: h(ToastHost, {
        children: h(AppShell as never, {
          demo: false, engine, consentTransport, mailboxFacts: async () => [ORGANIZED], firstRun: host(),
        } as never),
      }) }),
    }));
  });
  return container;
}

const stageHeading = () => screen.queryByRole("heading", { name: (text) => text.includes(t.decideGoes.split("{name}")[1]!.split("<place>")[0]!.trim()), level: 1 });
const stageLead = (lead: RegExp) => {
  const dialog = within(screen.getByRole("dialog", { name: messages.frame.landmark.stage }));
  expect(dialog.getByRole("heading", { name: (text) => text.includes(t.decideGoes.split("{name}")[1]!.split("<place>")[0]!.trim()), level: 1 })).toBeTruthy();
  return dialog.getByText(lead);
};
/** The rail keeps the counted entry under the stage. */
const railScreener = (count: number, label = messages.screener.title) =>
  screen.queryByRole("button", { name: `${label} ${count}`, hidden: true });

beforeEach(() => { setup(); });
afterEach(teardown);

describe("the first decision says the Screener's count, the one the rail reads", () => {
  it("three senders wait: the step and the rail both say three", async () => {
    await launch(3);
    await waitFor(() => stageHeading() !== null, "the first-decision step");
    await waitFor(() => railScreener(3) !== null, "the rail to count 3");
    expect(railScreener(3)?.getAttribute("title")).toBe("3 first-time senders waiting");
    expect(stageLead(/^3 left$/)).toBeTruthy();
  });

  it("control: one sender waits, and the step keeps the singular", async () => {
    await launch(1);
    await waitFor(() => stageHeading() !== null, "the first-decision step");
    await waitFor(() => railScreener(1) !== null, "the rail to count 1");
    expect(railScreener(1)?.getAttribute("title")).toBe("1 first-time sender waiting");
    expect(stageLead(/^1 left$/)).toBeTruthy();
  });
});

it.each([
  [1, "1 neuer Absender wartet"],
  [3, "3 neue Absender warten"],
])("shows the German waiting title for %i senders", async (count, title) => {
  await launch(count, "de");
  await waitFor(() => railScreener(count, german.screener.title) !== null, `the German rail to count ${count}`);
  expect(railScreener(count, german.screener.title)?.getAttribute("title")).toBe(title);
});

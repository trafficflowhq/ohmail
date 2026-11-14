/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { NOW, S, act, consentTransport, engineOver, msg, setup, storeWith, teardown, waitFor } from "./_view-shell";
import type { EngineMessage } from "@ohmail/client-engine";
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

async function launch(n: number): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
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
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { children: h(ToastHost, {
        children: h(AppShell as never, {
          demo: false, engine, consentTransport, mailboxFacts: async () => [ORGANIZED], firstRun: host(),
        } as never),
      }) }),
    }));
  });
  return container;
}

const stageHeading = (): string => (document.querySelector(".ob-stage h1")?.textContent ?? "").trim();
const stageLead = (): string => (document.querySelector(".ob-stage .ob-card .sub")?.textContent ?? "").trim();
/** The rail's Screener entry says its count in its title (`rail.screenerTitle`). */
const railScreener = (): string | null => {
  const hit = [...document.querySelectorAll<HTMLElement>("[title]")]
    .map((el) => el.getAttribute("title") ?? "")
    .find((title) => /^\d+ waiting$/.test(title));
  return hit ?? null;
};

beforeEach(() => { setup(); });
afterEach(teardown);

describe("the first decision says the Screener's count, the one the rail reads", () => {
  it("three senders wait: the step and the rail both say three", async () => {
    await launch(3);
    await waitFor(() => stageHeading() === t.decideTitle, "the first-decision step");
    await waitFor(() => railScreener() === "3 waiting", `the rail to count 3 (read ${railScreener()})`);
    expect(stageLead(), "the step and the rail disagree").toMatch(/^3 senders are waiting\. /);
  });

  it("control: one sender waits, and the step keeps the singular", async () => {
    await launch(1);
    await waitFor(() => stageHeading() === t.decideTitle, "the first-decision step");
    await waitFor(() => railScreener() === "1 waiting", `the rail to count 1 (read ${railScreener()})`);
    expect(stageLead()).toMatch(/^One sender is waiting\. /);
  });
});

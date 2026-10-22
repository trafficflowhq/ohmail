/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { NOW, S, act, click, consentTransport, engineOver, setup, storeWith, teardown, waitFor } from "./_view-shell";
import type { MailboxFacts } from "../app/shell/mail-state";

/**
 * THE WHOLE SHELL PUTS THE GAP OFFER UNDER THE PILES (GAP-OFFER-OFF-SCREEN-UNDER-FOLDERS).
 *
 * The rail's notice slot stood at the foot, after the folder list, and under folders it was below
 * the window's edge. It now follows the group that holds Resurface and comes before Tags; the
 * narrow-width copy still stands before the topbar. `rail-notice-on-screen.test.tsx` measures it.
 */

const h = React.createElement;

const ROW: MailboxFacts = {
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer", organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
} as MailboxFacts;

let gap = 2;
const answers: Array<{ id: string; answer: { file: boolean; count: number; strangers: number } }> = [];

async function launch(): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const s = await storeWith([]);
  const engine = engineOver(s);
  S.store = s; S.engine = engine;
  window.location.hash = "#/ohbox";
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  S.roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { children: h(ToastHost, {
        children: h(AppShell as never, {
          demo: false, engine, consentTransport,
          mailboxFacts: async () => [{ ...ROW, gapLetters: gap > 0 ? gap : null }],
          gapLettersTransport: async (id: string, answer: { file: boolean; count: number; strangers: number }) => {
            answers.push({ id, answer });
            gap = 0;
            return {};
          },
        } as never),
      }) }),
    }));
  });
  return container;
}

beforeEach(() => { setup(); gap = 2; answers.length = 0; });
afterEach(async () => { await teardown(); });

describe("the gap offer in the whole shell", () => {
  it("the rail's slot follows the piles and comes before Tags; the shell copy stands before the topbar", async () => {
    const c = await launch();
    await waitFor(() => c.querySelector('nav.rail .rail-notice-slot [data-state="gap"]') !== null, "the rail's gap offer");
    const slot = c.querySelector("nav.rail .rail-notice-slot")!;
    const piles = c.querySelector('nav.rail [data-rail-id="triage-resurface"]')!.closest(".rgroup")!;
    expect(slot.previousElementSibling, "the slot does not follow the group holding Resurface").toBe(piles);
    const next = slot.nextElementSibling!;
    expect(next.classList.contains("rgroup"), `the slot is followed by .${next.className}`).toBe(true);
    expect(next.querySelector(":scope > .rgroup.rsub .rlabel-toggle"), "the slot is not followed by the Tags group").not.toBeNull();
    const copy = c.querySelector('.notice-shell[data-state="gap"]')!;
    const topbar = c.querySelector(".topbar")!;
    expect(copy, "no narrow-width copy").not.toBeNull();
    expect(copy.compareDocumentPosition(topbar) & Node.DOCUMENT_POSITION_FOLLOWING, "the shell copy is not before the topbar").toBeTruthy();
  });

  it("File sends {file:true,count:2,strangers:0} once, and the offer leaving does not remount the Tags group", async () => {
    const c = await launch();
    await waitFor(() => c.querySelector('nav.rail [data-state="gap"]') !== null, "the rail's gap offer");
    const tags = c.querySelector("nav.rail .rgroup.rsub")!.parentElement!;
    const file = c.querySelector<HTMLButtonElement>('nav.rail [data-state="gap"] .rn-verbs button')!;
    expect(file.textContent).toMatch(/File/);
    await click(file, "File");
    await waitFor(() => c.querySelector('nav.rail [data-state="gap"]') === null, "the offer to leave");
    expect(answers).toEqual([{ id: "mb1", answer: { file: true, count: 2, strangers: 0 } }]);
    expect(c.querySelector("nav.rail .rgroup.rsub")!.parentElement, "the Tags group was remounted").toBe(tags);
    expect(tags.isConnected).toBe(true);
  });
});

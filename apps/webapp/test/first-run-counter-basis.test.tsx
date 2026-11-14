/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import { DESKTOP_WINDOW } from "@ohmail/app-logic/session/store-windows";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";

/**
 * ═══ THE FIRST-RUN COUNTERS SAY WHICH POPULATION THEY ARE ABOUT ════════════════════════════
 *
 * "Screened so far" is the mirror's row count minus what History lists — two projections over one
 * windowed reader — beside "Still to read", which is about the IMPORT. Three numbers, two
 * questions, under a heading saying "First pull", and nothing saying which is which. The pair is
 * worth showing; what it may not do is read as the mailbox. The sentence is read off the RENDERED
 * screen, not the catalogue, at the window's own numbers (the pair sums to
 * `DESKTOP_WINDOW.minRows` while the import has taken in three times that).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** What the window holds, and what the import has actually pulled past it. */
const HELD = DESKTOP_WINDOW.minRows;
const HISTORY = 1_200;
const PULLED = 3 * HELD + 17;

/** Consented, connected, and the import stamp UNWRITTEN — `deriveOnboardingStep` row 7, "pull". */
const midImport: OnboardingFacts = {
  door: "cloud",
  mailbox: {
    organizerRole: "organizer",
    organizedBy: null,
    organizerState: null,
    organizeConsentedAt: "2026-09-16T10:00:00.000Z",
    initialImportCompletedAt: null,
  },
  account: { onboardingCompletedAt: null },
  ai: "off",
  queuedSenders: 0,
};

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

async function mountPull(): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);

  const host: FirstRunHost = {
    door: "cloud",
    ai: "off",
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    organize: async () => "stored",
    complete: async () => {},
    setAiEnabled: async () => {},
    probeReason: () => null,
    probeMessage: () => null,
  };

  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, {
        children: h(FirstRun, {
          host,
          facts: midImport,
          onRefresh: () => {},
          onLeave: () => {},
          // The pair is the WINDOW's; `pulled` is the import's, and it is past the window.
          pull: { screened: HELD - HISTORY, history: HISTORY, pulled: PULLED },
          serverMessageCount: PULLED + 40_000,
          decide: null,
          mailboxId: "mb-1",
        }),
      }),
    }));
  });
  return el;
}

const textOf = (el: HTMLElement): string => (el.textContent ?? "").replace(/\s+/g, " ");

describe("the first-run counters name their basis", () => {
  it("is on the pull screen, beside the counters it qualifies", async () => {
    const el = await mountPull();
    // The screen under test, or the rest of this file is about nothing.
    expect(textOf(el)).toContain(messages.onboarding.pullTitle);

    const basis = el.querySelector(".ob-basis");
    expect(basis, "the pull screen renders no basis line").not.toBeNull();
    expect(textOf(basis as HTMLElement)).toBe(messages.onboarding.counterBasis);
  });

  it("the sentence is the one the numbers need — device, not mailbox", async () => {
    const el = await mountPull();
    const said = textOf(el);
    // A needle on the RENDERED text, never on a source comment: this is the claim a person meets.
    expect(said).toContain("on this device");
    expect(said).toContain("not the whole mailbox");
  });

  it("the way out promises only what the status bar shows: the messages read, never these counters", async () => {
    const el = await mountPull();
    const said = textOf(el);
    // The strip counts the import's messages (`importingCount`, `importingOf`); Screened and History stay here.
    expect(said).not.toContain("carries these counters");
    expect(said).toContain("the status bar shows how many messages it has read");
  });

  it("the fixture is the shape the row is about — the pair is bounded, the import is not", async () => {
    // Without this the two cases above would pass over a small mailbox where the window holds
    // everything and the sentence qualifies nothing.
    expect((HELD - HISTORY) + HISTORY).toBe(HELD);
    expect(PULLED).toBeGreaterThan(HELD);

    const el = await mountPull();
    const said = textOf(el);
    // All three numbers are on screen together, which is the condition that makes the pair
    // readable as the mailbox.
    expect(said).toContain((HELD - HISTORY).toLocaleString("en-US"));
    expect(said).toContain(HISTORY.toLocaleString("en-US"));
    expect(said).toContain(messages.onboarding.remaining);
  });
});

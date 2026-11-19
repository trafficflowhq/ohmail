/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import type { FirstRunPull, FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { O, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * "What ohmail did" stated the device's projection as what ohmail did.
 *
 * A self-hosted install over a large mailbox with a 365-day window: setup's last step read
 * two counts, "N messages screened" and "M listed under History", summing to the
 * browser window's ceiling — and not what the server had screened or lists under History.
 * The pull screen says its counters count this device; this step said nothing. No server count of
 * either exists on this base, so the step says the same thing, unless the store has said the device
 * holds the whole mailbox, when the pair is the mailbox's.
 *
 * RE-POINTED (the switch's older tests, sorted once): the summary is the new frame's first-run stage
 * (`_first-run-stage.tsx`); the mailbox is the ground's row (the server's count on it), the window's
 * pair and whether the store holds the whole mailbox the ground's `about().pull`; the words the stage's catalogue;
 * the basis line is the note that says the catalogue's basis sentence. Every expectation is as it stood.
 */

const messages = { onboarding: O };

/** Consented, imported, nobody waiting — `deriveOnboardingStep` row 9, "summary". */
const done = (): FirstRunRow => ({
  id: id("mb-1"),
  address: "me@example.invalid",
  organizerRole: "organizer",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: "2026-09-27T01:53:12.000Z",
  initialImportCompletedAt: "2026-09-27T02:20:00.000Z",
  serverMessageCount: 74_004,
}) as FirstRunRow;

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

async function mountSummary(whole: boolean | undefined): Promise<HTMLElement> {
  const st = await mountStage({
    rows: [done()],
    door: "cloud",
    // The window's pair: it sums to the ceiling while the mailbox holds seven times that.
    about: { pull: { screened: 6_012, history: 3_988, pulled: 74_004, whole } as FirstRunPull },
    verbs: {
      ai: "off",
      organize: async () => "stored",
      complete: async () => {},
      setAiEnabled: async () => {},
    },
  });
  return st.el;
}

/** The line that states the counts' basis: the note that says it, or null. */
const basis = (el: HTMLElement): Element | null =>
  [...el.querySelectorAll("*")].find((n) => n.children.length === 0 && n.textContent === messages.onboarding.counterBasis) ?? null;

const textOf = (el: HTMLElement): string => (el.textContent ?? "").replace(/\s+/g, " ");

describe("the summary's counts name their basis", () => {
  it("over a store past the window, the step says it counts this device", async () => {
    const el = await mountSummary(false);
    expect(textOf(el), "the screen under test").toContain(messages.onboarding.doneTitle);
    expect(textOf(el)).toContain("6,012" + " messages screened");
    // MUTATION: render the basis line unconditionally-off — the device's pair reads as the mailbox's.
    expect(basis(el)?.textContent, "the summary states a window projection as what ohmail did")
      .toBe(messages.onboarding.counterBasis);
  });

  it("a host that states nothing about the store reads as this device, never as the mailbox", async () => {
    const el = await mountSummary(undefined);
    expect(basis(el)?.textContent).toBe(messages.onboarding.counterBasis);
  });

  it("when the store has said the device holds everything, the pair is the mailbox's and says no basis", async () => {
    const el = await mountSummary(true);
    expect(textOf(el)).toContain("6,012" + " messages screened");
    expect(basis(el)).toBeNull();
  });
});

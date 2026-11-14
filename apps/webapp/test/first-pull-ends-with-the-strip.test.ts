import { describe, expect, it } from "vitest";
import { deriveOnboardingStep, importOverOf, type OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";
import { firstRunStep } from "../app/shell/FirstRun";
import { importOver, seedGrowth, type MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * THE SETUP STAGE'S PULL ENDS WHEN THE STRIP'S IMPORT DOES. On
 * the desktop's own door a mailbox the worker never stamps: the strip ended its import on the
 * device holding the account's total or on the 24 h floor bound, and the stage ended on the stamp
 * alone, so the pull screen stayed up with the strip quiet. ONE predicate (`importOver`) now, read
 * by the strip, the stage's derivation, the cursor release and the AI step's `keep`.
 */

const NOW = Date.parse("2026-09-29T01:00:00.000Z");
const DAY = 86_400_000;
const drained = { bootstrapping: false, failures: 0 };
const mailbox = (over: Partial<MailboxFacts>): MailboxFacts => ({
  id: "mbx-1", address: "me@example.test", status: "connected", createdAt: new Date(NOW - 60_000).toISOString(),
  initialImportCompletedAt: null, ...over,
} as unknown as MailboxFacts);

const facts = (importOverNow: boolean | undefined): OnboardingFacts => ({
  door: "local", account: {}, ai: "on", queuedSenders: 0,
  mailbox: {
    organizeConsentedAt: new Date(NOW - 2 * DAY).toISOString(), initialImportCompletedAt: null,
    ...(importOverNow === undefined ? {} : { importOver: importOverNow }),
  },
});

describe("importOver — the strip's end, for every surface", () => {
  it("the floor released past its bound, drained and still: over", () => {
    const m = mailbox({ createdAt: new Date(NOW - 2 * DAY).toISOString() });
    expect(importOver(m, seedGrowth(500), drained, 500, [m], NOW)).toBe(true);
  });

  it("the device holding the account's total: over, whatever the stamp says", () => {
    const m = mailbox({ messageCount: 500, hostedMessageCount: 500 } as Partial<MailboxFacts>);
    expect(importOver(m, seedGrowth(500), drained, 500, [m], NOW)).toBe(true);
  });

  it("CONTROL: a young mailbox with its stamp unwritten and the account's total not reached is importing", () => {
    const m = mailbox({ hostedMessageCount: 5_000 } as Partial<MailboxFacts>);
    expect(importOver(m, seedGrowth(500), drained, 500, [m], NOW)).toBe(false);
  });

  it("CONTROL: a stamped mailbox is over, and an older server's absent stamp is not an import", () => {
    expect(importOver(mailbox({ initialImportCompletedAt: new Date(NOW).toISOString() }), seedGrowth(0), drained, 0, null, NOW)).toBe(true);
    const older = mailbox({}) as unknown as Record<string, unknown>;
    delete older.initialImportCompletedAt;
    expect(importOver(older as unknown as MailboxFacts, seedGrowth(0), drained, 0, null, NOW)).toBe(true);
  });
});

describe("the stage reads it", () => {
  it("the derivation does not resume on the pull once the reading says the import is over", () => {
    expect(deriveOnboardingStep(facts(true)), "the pull screen outlived the strip's import").not.toBe("pull");
    expect(deriveOnboardingStep(facts(false))).toBe("pull");
  });

  it("a cursor held on the pull is released on the same reading", () => {
    expect(firstRunStep(facts(true), "pull"), "the cursor kept the pull screen up").not.toBe("pull");
    expect(firstRunStep(facts(false), "pull")).toBe("pull");
  });

  it("CONTROL: a caller that cannot say leaves the stamp rule standing", () => {
    expect(importOverOf({ initialImportCompletedAt: null })).toBe(false);
    expect(importOverOf({})).toBe(true);
    expect(deriveOnboardingStep(facts(undefined))).toBe("pull");
  });
});

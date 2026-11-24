import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveOnboardingStep, type OnboardingAi, type OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";

/**
 * ═══ THE AI QUESTION IS ASKED — and on the hosted door it was not asked at all ══════════════
 *
 * ── WHAT THE GAP ROW SAID, AND WHAT IS ACTUALLY TRUE ────────────────────────────────────────
 *
 * The row said `accounts.ai_enabled` "rests false", so the door reported `unset` for both
 * "never asked" and "answered no", and the cost was one repeated question on a resumed run — a
 * LOW. **Both halves are wrong.** The column is `NOT NULL DEFAULT true` (migration 0019) and
 * `aiEnabledFor` falls back to `true` for a missing row, so `useCloudFirstRun`'s
 * `aiEnabled ? "on" : "unset"` reported `on` for a brand-new account.
 *
 * The first case below is that defect as a measurement rather than an argument: with `ai: "on"`
 * the derivation answers `pull`, so the AI screen — which is on the forward path — is never a
 * resume target and the window's write re-derives straight past it. The question was not asked
 * twice. It was never asked, on an account whose AI was already spending its credits.
 *
 * ── WHAT THE COLUMN BUYS ────────────────────────────────────────────────────────────────────
 *
 * `accounts.ai_answered_at` (migration 0084) is the fact the switch cannot carry. The posture
 * asks the STAMP first and lets it outrank the switch, so a resting `true` no longer reads as an
 * answer. `packages/db/test/ai-answered.pg.test.ts` drives the write and the read against real
 * Postgres; this file drives the derivation and pins the posture the client computes.
 *
 * Mutation-checked, each watched red and restored:
 *  · the posture reading the switch before the stamp → the never-asked case;
 *  · `aiAnswered` dropped from the GET's mapping      → the never-asked case;
 *  · the write's echo not applied                      → the answered-no case.
 */

const SRC = readFileSync(
  resolve(process.cwd(), "apps/webapp/app/(product)/mailbox/useCloudFirstRun.ts"), "utf8",
);

/** A hosted account that has consented and is importing — the state the AI step is reached in. */
const facts = (ai: OnboardingAi): OnboardingFacts => ({
  door: "cloud",
  mailbox: {
    organizerRole: "organizer", organizedBy: null, organizerState: null,
    organizeConsentedAt: "2026-09-02T09:00:00.000Z", initialImportCompletedAt: null,
  },
  account: { onboardingCompletedAt: null },
  ai,
  queuedSenders: 0,
});

describe("the derivation, and what each posture selects", () => {
  it("THE DEFECT: a resting `on` walks straight past the question", () => {
    // Not an argument — the measurement. This is what a fresh hosted account reported, and the
    // AI screen is on the forward path, so nothing else would have brought them back to it.
    expect(deriveOnboardingStep(facts("on"))).toBe("pull");
  });

  it("`unset` stops and asks, which is what the missing state is for", () => {
    expect(deriveOnboardingStep(facts("unset"))).toBe("ai");
  });

  it("`off` walks past — the fourth state, and the whole point of the column", () => {
    // "Answered no" and "never asked" select opposite screens. Without `off` the flow either
    // re-asks somebody who declined or skips somebody who was never asked; there is no third
    // behaviour available from one boolean.
    expect(deriveOnboardingStep(facts("off"))).toBe("pull");
  });
});

describe("the client's posture reads the stamp FIRST", () => {
  it("a null stamp is `unset` whatever the switch says", () => {
    // The correction, as the source states it: the switch's resting value is not an answer, so
    // it may only be consulted once somebody has answered.
    expect(SRC).toMatch(/aiEnabled === null \|\| aiAnswered === null/);
    expect(SRC).toMatch(/: !aiAnswered\s*\n\s*\? "unset"/);
    expect(SRC).toMatch(/: aiEnabled \? "on" : "off"/);
  });

  it("…and it can no longer produce `on` from an unanswered account", () => {
    // The shape that caused this: `aiEnabled ? "on" : "unset"` with nothing else consulted. A
    // regex rather than a behaviour because the posture is a const inside a hook, and the
    // behaviour it feeds is driven above.
    expect(SRC, "the old two-state posture is back")
      .not.toMatch(/const ai: OnboardingAi = aiEnabled === null \? "unset" : aiEnabled \? "on" : "unset"/);
  });

  it("reads the stamp off the GET, so no second round trip is needed", () => {
    expect(SRC).toContain("setAiAnswered(r.aiAnswered === true);");
  });

  it("but the WRITE does not depend on the echo — a successful PATCH is itself the answer", () => {
    /* THIS PIN USED TO ASSERT THE OPPOSITE, and the max review was right about it: reading the
       echo strictly meant a PRE-0084 API — which succeeds and omits the field — stored `false`,
       so the flow re-derived `unset` and returned to the question it had just asked. The old
       client had no such loop, which makes it a regression rather than an inheritance. The
       assertion is corrected to the behaviour, not relaxed; `ai-answered-race.test.tsx` DRIVES
       both directions, including the 0084 control. */
    expect(SRC).toContain("setAiAnswered(true);");
    expect(SRC, "the write reads the echo again")
      .not.toContain('setAiAnswered((r as { aiAnswered?: boolean }).aiAnswered === true);');
  });

  it("and a boot read that settles after a write applies NOTHING — user always wins", () => {
    // The second finding: `aiSettings.get()` is issued at mount and can settle after the PATCH,
    // carrying the account as it was before the answer. Marked BEFORE the request leaves, so a
    // read already in the air loses whatever it answers.
    expect(SRC).toContain("wrote.current = true;");
    expect(SRC).toContain("if (!live || wrote.current) return;");
  });

  it("AN API BEFORE 0084 OMITS THE FIELD, and that must land on ASKING", () => {
    // The version-skew direction, and it is the same safe direction the four-state union was
    // written for: an absent field reads as `false` ⇒ `unset` ⇒ the question is asked.
    expect(SRC).toContain("aiAnswered?: boolean");
    expect(SRC, "an absent field must not read as answered").not.toMatch(/aiAnswered\s*\?\?\s*true/);
  });
});

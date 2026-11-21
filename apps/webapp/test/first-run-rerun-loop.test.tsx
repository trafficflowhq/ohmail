/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { FirstRunOrganizeOutcome } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { O, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { RUNGS } from "../../../packages/app/src/mailboxes/first-run/words.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * ═══ "AGREE AND START ORGANIZING" MUST NOT RETURN TO THE SCREEN THAT ASKED ═══════════════════
 *
 * ── THE DEFECT, MEASURED ON A RELEASED BUILD ────────────────────────────────────────────────
 *
 * Somebody opened setup again from Settings on a mailbox that was already organized, walked to
 * "How far back", pressed "Agree and start organizing", and landed back on the consent statement.
 * Pressing it again did the same thing. For ever.
 *
 * The mechanism is two lines that are individually correct. `firstRunStep` answers `consent` for
 * a re-run whose cursor is null, because a re-run has to open SOMEWHERE and the derivation cannot
 * help — a finished account derives to "nothing to do", which is the right answer for a boot and
 * useless here. And `run` clears the cursor after every write, because "re-derive after every
 * write" is the rule the whole stage is built on. Put together, on `#/first-run/again` every
 * write walks back to the opening screen, and there is no state in which it stops.
 *
 * ── AND THE SAME LOOP ON A FIRST RUN, THROUGH A DIFFERENT DOOR ──────────────────────────────
 *
 * A first run re-derives instead, which is only a way out if the facts have MOVED. They are read
 * over the wire (hosted) or out of the local mirror (standalone) and neither is guaranteed to
 * have caught up by the render after the press — and row 4 of the derivation is `if (!consented)
 * return "consent"`. So a lagging read puts a person who has just agreed back in front of the
 * question, with the button they pressed still on it. The last case here holds the facts
 * completely still, which is the worst case that read can have.
 *
 * ── WHY THIS IS A RENDER AND NOT A TABLE TEST ───────────────────────────────────────────────
 *
 * `first-run-stage.test.ts` drives `firstRunStep` directly and every row of it was, and still is,
 * green: the table is right. What was wrong is the ARGUMENT the component passes it after a
 * write, which only exists while the component is running. A table test cannot see this, and did
 * not.
 *
 * Watched red before the fix, each restored:
 *  · the cursor cleared on a re-run          → cases 1, 2 and 3 (all land on the consent heading);
 *  · `organize` answering void               → case 4 (a mailbox that is gone advances anyway);
 *  · the write's own result not applied       → case 5 (the lagging read re-derives to consent).
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`_first-run-stage.tsx`), a re-run at `#/first-run/again` naming its mailbox; the facts are the
 * ground's (the mailbox its row, the stored window its `screening`, the account its `account`), and the write's
 * re-read is the ground's refresh, which reads the rows again (or, held still, reads nothing new); a rung is the
 * window's radio by its name (`words.ts` RUNGS); the words the stage's catalogue. Every expectation is as it stood.
 */

const t = O;

const CONNECTED = {
  organizerRole: "organizer" as const,
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: null as string | null,
  initialImportCompletedAt: null as string | null,
};

/** The account a re-run is about: set up months ago, finished, still organizing. */
const finished = (): OnboardingFacts => ({
  door: "cloud",
  mailbox: {
    ...CONNECTED,
    organizeConsentedAt: "2026-03-01T10:00:00.000Z",
    initialImportCompletedAt: "2026-03-01T11:00:00.000Z",
  },
  account: { onboardingCompletedAt: "2026-03-01T11:30:00.000Z" },
  ai: "off",
  queuedSenders: 0,
});

/** A first run that has connected a mailbox and not yet agreed to anything. */
const fresh = (): OnboardingFacts => ({
  door: "cloud",
  mailbox: { ...CONNECTED },
  account: { onboardingCompletedAt: null },
  ai: "unset",
  queuedSenders: 0,
});

interface Harness {
  el: HTMLElement;
  organized: Array<{ dormancyDays?: number; scope?: "window" | "all_time" }>;
  /** Every heading the stage has shown, in order — the whole point of these cases. */
  heading: () => string;
  press: (label: string) => Promise<void>;
  pick: (label: string) => Promise<void>;
  text: () => string;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

async function mount(o: {
  facts: OnboardingFacts;
  rerun?: boolean;
  outcome?: FirstRunOrganizeOutcome;
  /** `false` holds the facts completely still — the worst case a lagging read can be. */
  refresh?: boolean;
}): Promise<Harness> {
  const organized: Harness["organized"] = [];
  let facts = o.facts;
  const rowOf = (): FirstRunRow => ({ id: id("mb-1"), address: "me@example.invalid", ...facts.mailbox! }) as FirstRunRow;

  const st = await mountStage({
    rows: [rowOf()],
    door: "cloud",
    ...(o.rerun ? { at: "#/first-run/again?mailbox=mb-1" } : {}),
    account: o.facts.account,
    screening: { dormancyDays: 365, scope: "window" as const },
    /* The write's re-read: the rows as the client can see them now. */
    ...(o.refresh === false ? {} : { live: () => [rowOf()] }),
    verbs: {
      ai: o.facts.ai,
      organize: async (_id, body) => {
        if (body.screening) organized.push(body.screening as Harness["organized"][number]);
        /* THE WRITE LANDED ON THE SERVER. Whether the CLIENT can see it is the other half of
           what these cases are about, and `refresh` is the dial for it. */
        if (o.refresh !== false && (o.outcome ?? "stored") === "stored") {
          facts = {
            ...facts,
            mailbox: { ...facts.mailbox!, organizeConsentedAt: "2026-09-02T09:00:00.000Z" },
          };
        }
        return o.outcome ?? "stored";
      },
      complete: async () => { /* leaves */ },
      setAiEnabled: async () => { /* answered */ },
    },
  });
  const el = st.el;

  const press = async (label: string) => {
    /* `startsWith`, not equality: the foot's buttons carry their keycap inside the label
       ("Continue" plus a ↵ glyph), which is exactly what a person sees and reads as one word. */
    const button = [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim().startsWith(label));
    if (!button) {
      throw new Error(`no button labelled ${JSON.stringify(label)}; saw: `
        + [...el.querySelectorAll("button")].map((b) => JSON.stringify(b.textContent)).join(", "));
    }
    /* ONE act, and the microtasks drained INSIDE it. */
    await act(async () => {
      button.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  };

  return {
    el, organized,
    heading: st.heading,
    press,
    pick: st.pick,
    text: () => el.textContent ?? "",
  };
}

describe("a re-run of setup, driven through the rendered stage", () => {
  it("opens on the consent statement — the behaviour the loop was hiding behind", async () => {
    const s = await mount({ facts: finished(), rerun: true });
    expect(s.heading()).toBe(t.consentTitle);
  });

  it("AGREE MOVES ON. It returned to the consent statement, every press, for ever", async () => {
    const s = await mount({ facts: finished(), rerun: true });
    await s.press(t.continue);
    expect(s.heading(), "the window screen").toBe(t.windowTitle);

    await s.press(t.agree);
    expect(s.heading(), "the press walked back to the screen it came from").not.toBe(t.consentTitle);
    expect(s.heading()).toBe(t.aiTitle);
  });

  it("…and the window it carried is the one that was chosen, not the default", async () => {
    const s = await mount({ facts: finished(), rerun: true });
    await s.press(t.continue);
    // "All time" — the answer somebody opens setup again to give.
    const rung = RUNGS.find((r) => r.value === "all")!;
    const all = t[rung.label.slice("onboarding.".length) as keyof typeof t] as string;
    expect([...s.el.querySelectorAll("[role=radio]")].some((r) => (r.textContent ?? "").trim().startsWith(all)),
      "the window screen offers no all-time rung").toBe(true);
    await s.pick(all);
    await s.press(t.agree);
    expect(s.organized).toEqual([{ scope: "all_time" }]);
  });

  it("and the AI answer ends the re-run rather than returning to consent", async () => {
    const s = await mount({ facts: finished(), rerun: true });
    await s.press(t.continue);
    await s.press(t.agree);
    expect(s.heading()).toBe(t.aiTitle);
    await s.press(t.continue);
    expect(s.heading(), "the second write looped as well").not.toBe(t.consentTitle);
    expect(s.heading()).toBe(t.doneTitle);
  });

  it("A PRESS THAT STORED NOTHING SAYS SO, and does not advance", async () => {
    // Every reply to this call is a 200, the ones that write nothing included. Advancing on one
    // is a control reporting that it acted when it did not.
    const s = await mount({ facts: finished(), rerun: true, outcome: "gone" });
    await s.press(t.continue);
    await s.press(t.agree);
    expect(s.heading(), "it walked on as though the window had been stored").toBe(t.windowTitle);
    expect(s.text()).toContain(t.windowGone);
  });
});

describe("a FIRST run whose read has not caught up yet", () => {
  it("does not return to the consent screen it just left", async () => {
    // The facts never move — the worst case a lagging `GET /mailboxes` or a cold mirror can be.
    // Without the write's own result applied locally, row 4 of the derivation (`if (!consented)
    // return "consent"`) puts the person back in front of the question they just answered, and
    // there is nothing in the loop to end it.
    const s = await mount({ facts: fresh(), refresh: false });
    expect(s.heading()).toBe(t.consentTitle);
    await s.press(t.continue);
    expect(s.heading()).toBe(t.windowTitle);

    await s.press(t.agree);
    expect(s.heading(), "the stale read sent the run back to the consent statement")
      .not.toBe(t.consentTitle);
    // Row 5: the AI question is the first thing left unanswered once consent is recorded.
    expect(s.heading()).toBe(t.aiTitle);
  });

  it("CONTROL: with the read caught up it lands on the same screen", async () => {
    // Which is what says the case above is about the LAG and not about the cursor.
    const s = await mount({ facts: fresh() });
    await s.press(t.continue);
    await s.press(t.agree);
    expect(s.heading()).toBe(t.aiTitle);
  });
});

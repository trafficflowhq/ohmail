/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { O, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * SETUP OFFERS AI ONLY WHERE A MODEL CAN ANSWER.
 *
 * A self-hosted server with no model (`/hello` features.ai = false) was offered "Yes — Runs on this
 * server with the operator's Anthropic key", the press switched AI on, and every Suggest then
 * answered 503. The self-host door now offers "Yes" only when the server says it has a model; with
 * none, the step says so and the answer it stores is "no". Cloud and the desktop are unchanged.
 *
 * RE-POINTED (the switch's older tests, sorted once): the re-run is the new frame's first-run stage at
 * `#/first-run/again` (`_first-run-stage.tsx`), the mailbox the ground's row, the stored window the
 * ground's `screening`, its words the stage's catalogue; a choice is the AI step's radio by its text. Every
 * expectation is as it stood.
 */

const t = O;

/** A re-run of setup on an organized mailbox whose account switch rests ON, the default. */
const row = (): FirstRunRow => ({
  id: id("mb-1"), address: "me@example.invalid",
  organizerRole: "organizer", organizedBy: null, organizerState: null,
  organizeConsentedAt: "2026-03-01T10:00:00.000Z", initialImportCompletedAt: "2026-03-01T11:00:00.000Z",
}) as FirstRunRow;

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

async function atTheAiStep(door: "cloud" | "selfhost", selfhostAi?: boolean) {
  const writes: boolean[] = [];
  const st = await mountStage({
    rows: [row()],
    at: "#/first-run/again?mailbox=mb-1",
    door,
    account: { onboardingCompletedAt: "2026-03-01T11:30:00.000Z" },
    screening: { dormancyDays: 365, scope: "window" as const },
    verbs: {
      ai: "on",
      organize: async () => "stored",
      complete: async () => { /* leaves */ },
      setAiEnabled: async (on: boolean) => { writes.push(on); },
      ...(selfhostAi === undefined ? {} : { selfhostAi }),
    },
  });
  const el = st.el;
  const press = async (label: string) => {
    const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
    expect(button, `no button labelled ${label}`).toBeTruthy();
    await act(async () => { button!.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
  };
  await press(t.continue);
  await press(t.agree);
  expect((el.querySelector("h1")?.textContent ?? "").trim()).toContain(t.aiSay.split("<on>")[0]!.trim());
  const slot = el.querySelector<HTMLButtonElement>('.oh-page-say [aria-haspopup="menu"]');
  const choices = async () => {
    if (slot && slot.getAttribute("aria-expanded") !== "true") await act(async () => { slot.click(); });
    return [...el.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  };
  const on = async () => {
    const item = (await choices()).find((row) => row.textContent === t.aiOn);
    expect(item).toBeDefined();
    await act(async () => { item!.click(); });
  };
  return { el, writes, press, slot, choices, on };
}

describe("the AI question in setup", () => {
  it("a self-hosted server with no model offers no Yes, says why, and stores no", async () => {
    const s = await atTheAiStep("selfhost", false);
    expect(s.slot).toBeNull();
    expect(s.el.textContent).toContain(t.aiRulesOnly);
    await s.press(t.continue);
    expect(s.writes).toEqual([false]);
  });

  it("a self-hosted server with no model information offers no on choice", async () => {
    const s = await atTheAiStep("selfhost");
    expect(s.slot).toBeNull();
    expect(s.el.textContent).toContain(t.aiRulesOnly);
  });

  it("a self-hosted server with a model offers AI without a Cloud label", async () => {
    const s = await atTheAiStep("selfhost", true);
    await s.on();
    expect(s.el.textContent).toContain(t.aiServerTag);
    expect(s.el.textContent).not.toContain(t.aiCloudTag);
    await s.press(t.continue);
    expect(s.writes).toEqual([true]);
  });

  it("Cloud offers AI and labels the service", async () => {
    const s = await atTheAiStep("cloud");
    await s.on();
    expect(s.el.textContent).toContain(t.aiCloudTag);
    expect(s.el.textContent).toContain(t.aiSends);
  });
});

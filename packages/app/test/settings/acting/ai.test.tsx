/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_START,
  AiPane,
  aiStates,
  aiStep,
  type AiModel,
  type AiState,
  useAiBudgetSummary,
} from "../../../src/settings/ai/index.js";
import { dayStamp } from "@ohmail/app-logic/text/format";
import { drawn, said } from "./words.js";

afterEach(cleanup);

const run = (...events: Parameters<typeof aiStep>[1][]): AiState => events.reduce(aiStep, AI_START);
const model = (state: AiState, toggle: (next: boolean) => void = () => {}): AiModel => ({ ...state, toggle });
/** The words as a person reads them, across the parts that draw them. */
const seen = (words: string) => (document.body.textContent ?? "").includes(words);
const isOff = (el: HTMLElement) => (el as HTMLButtonElement).disabled;
const theSwitch = () => screen.getByRole("switch", { name: said("en", "settings", "aiLabel") });

describe("the AI switch's rules, as the shipped pane holds them", () => {
  it("is unknown before the server answers, and a press then changes nothing", () => {
    expect(run().enabled).toBeNull();
    expect(run({ kind: "press", next: true })).toEqual(AI_START);
  });

  it("a failed read leaves the switch unknown, with the sentence", () => {
    expect(run({ kind: "unreadable", said: "unread" })).toEqual({
      enabled: null,
      problem: "unread",
      noModel: false,
    });
  });

  it("a press moves the switch at once, and the server's answer is what stays", () => {
    const pressed = run({ kind: "read", enabled: true }, { kind: "press", next: false });
    expect(pressed.enabled).toBe(false);
    expect(aiStep(pressed, { kind: "answered", enabled: true }).enabled).toBe(true);
  });

  it("a refusal puts the switch back where it stood before the press, and says why", () => {
    const refused = run(
      { kind: "read", enabled: true },
      { kind: "press", next: false },
      { kind: "refused", said: "no", back: true },
    );
    expect(refused).toEqual({ enabled: true, problem: "no", noModel: false });
  });

  it("a later press clears what the last refusal said", () => {
    const again = run(
      { kind: "read", enabled: true },
      { kind: "refused", said: "no", back: true },
      { kind: "press", next: false },
    );
    expect(again.problem).toBeNull();
  });
});

describe("the AI pane", () => {
  it("draws the switch before the server answers and lets nothing press it", () => {
    const toggle = vi.fn();
    drawn(<AiPane model={model(AI_START, toggle)} noModelSaid="" />);
    expect(isOff(theSwitch())).toBe(true);
    fireEvent.click(theSwitch());
    fireEvent.click(screen.getByRole("group", { name: said("en", "settings", "aiLabel") }));
    expect(toggle).not.toHaveBeenCalled();
  });

  it("says a failed read on the sheet, and the switch stays unpressable", () => {
    drawn(
      <AiPane
        model={model({ ...AI_START, problem: said("en", "settings", "aiUnreadable") })}
        noModelSaid=""
      />,
    );
    expect(seen(said("en", "settingsAi", "notRead"))).toBe(true);
    expect(screen.getByText(said("en", "settings", "aiUnreadable"), { exact: false })).toBeTruthy();
    expect(isOff(theSwitch())).toBe(true);
  });

  it("draws the server's position, and a press asks for the other one", () => {
    const toggle = vi.fn();
    drawn(<AiPane model={model({ ...AI_START, enabled: true }, toggle)} noModelSaid="" />);
    expect(theSwitch().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(theSwitch());
    expect(toggle.mock.calls).toEqual([[false]]);
  });

  it("says a refused write as not changed, with the server's sentence", () => {
    drawn(<AiPane model={model({ enabled: true, problem: "Refused.", noModel: false })} noModelSaid="" />);
    expect(seen(said("en", "settingsAi", "notChanged"))).toBe(true);
    expect(screen.getByText("Refused.", { exact: false })).toBeTruthy();
  });

  it("shows a notice only for a server with no model", () => {
    const noModel = "No AI model is set up on this server.";
    drawn(<AiPane model={model({ enabled: true, problem: null, noModel: true })} noModelSaid={noModel} />);
    expect(screen.getByText(noModel, { exact: false })).toBeTruthy();
    cleanup();
    drawn(<AiPane model={model({ enabled: true, problem: null, noModel: false })} noModelSaid={noModel} />);
    expect(screen.queryByText(noModel, { exact: false })).toBeNull();
  });

  it("reads German where the catalogue is German", () => {
    drawn(<AiPane model={model({ enabled: null, problem: "x", noModel: false })} noModelSaid="" />, "de");
    expect(isOff(screen.getByRole("switch", { name: said("de", "settings", "aiLabel") }))).toBe(true);
    expect(seen(said("de", "settingsAi", "notRead"))).toBe(true);
  });

  it("has a state for each rule, and the design's address on the switch at rest", () => {
    const states = aiStates({ unreadable: "u", refused: "r" });
    expect(states.on.address).toBe("screen=settings&sec=ai");
    expect(states.asking.model.enabled).toBeNull();
    expect(states.unreadable.model).toMatchObject({ enabled: null, problem: "u" });
  });
});

describe("the AI pane's budget, read the way Subscription reads it", () => {
  const until = "2027-02-01T12:00:00.000Z";
  const lineOf = (name: string) => screen.getByRole("group", { name });
  const on = model({ ...AI_START, enabled: true });

  it("says the month's credits never above the allowance, the rest as extra credits, and the setup credits apart", () => {
    drawn(
      <AiPane
        model={on}
        noModelSaid=""
        credits={{ remaining: 18_885, total: 4_000, setup: { remaining: 12_000, expiresAt: until } }}
      />,
    );
    expect(lineOf(said("en", "settingsAi", "budget")).textContent).toContain("4,000 of 4,000 this month");
    expect(lineOf(said("en", "settingsAi", "creditsExtra")).textContent).toContain("14,885 left");
    expect(lineOf("Screening credits").textContent).toContain("12,000 left");
    expect(
      seen(
        `Spent on Screener suggestions before your plan’s budget. Usable until ${dayStamp(until, "en", "Europe/Zurich")}.`,
      ),
    ).toBe(true);
    expect(seen("18,885")).toBe(false);
  });

  it("draws the meter right under the month's line: it measures the month, never the extra or the screening credits", () => {
    const { container } = drawn(
      <AiPane
        model={on}
        noModelSaid=""
        credits={{ remaining: 18_885, total: 4_000, setup: { remaining: 12_000, expiresAt: until } }}
      />,
    );
    const meter = container.querySelector("progress")!;
    expect(meter.value).toBe(4_000);
    expect(meter.max).toBe(4_000);
    const month = lineOf(said("en", "settingsAi", "budget"));
    const after = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(month, meter)).toBe(true);
    expect(after(meter, lineOf(said("en", "settingsAi", "creditsExtra")))).toBe(true);
    expect(after(meter, lineOf("Screening credits"))).toBe(true);
  });

  it("a new account reads its whole allowance with no extra line, on the phone too", () => {
    drawn(<AiPane phone model={on} noModelSaid="" credits={{ remaining: 4_000, total: 4_000 }} />);
    expect(lineOf(said("en", "settingsAi", "budget")).textContent).toContain("4,000 of 4,000 this month");
    expect(screen.queryByRole("group", { name: said("en", "settingsAi", "creditsExtra") })).toBeNull();
    expect(screen.queryByRole("group", { name: said("en", "settingsAi", "setupCredits") })).toBeNull();
  });

  it("a trial's pot is not a month's", () => {
    drawn(<AiPane model={on} noModelSaid="" credits={{ remaining: 400, total: 500, trial: true }} />);
    expect(lineOf(said("en", "settingsAi", "budget")).textContent).toContain("400 of 500 left");
    expect(seen("this month")).toBe(false);
  });

  it("says it in German", () => {
    drawn(
      <AiPane
        model={on}
        noModelSaid=""
        credits={{ remaining: 18_885, total: 4_000, setup: { remaining: 12_000, expiresAt: until } }}
      />,
      "de",
    );
    expect(seen("Noch 4.000 von 4.000 diesen Monat")).toBe(true);
    expect(lineOf(said("de", "settingsAi", "creditsExtra")).textContent).toContain("Noch 14.885");
    expect(lineOf("Screening-Credits").textContent).toContain("Noch 12.000");
    expect(
      seen(
        `Werden für Screener-Vorschläge vor dem Budget deines Tarifs verbraucht. Nutzbar bis ${dayStamp(until, "de", "Europe/Zurich")}.`,
      ),
    ).toBe(true);
    expect(seen("18.885")).toBe(false);
  });
});

describe("the AI entry in the Settings list", () => {
  function Row({ credits }: { credits: Parameters<typeof useAiBudgetSummary>[0] }) {
    const row = useAiBudgetSummary(credits);
    return <p>{row ? `${row.detail}${row.hot ? " (hot)" : ""}` : "none"}</p>;
  }

  it("says the month's credits capped at the allowance, as the panes do", () => {
    drawn(<Row credits={{ remaining: 18_885, total: 4_000 }} />);
    expect(seen("4,000 of 4,000 this month")).toBe(true);
    expect(seen("18,885")).toBe(false);
    cleanup();
    drawn(<Row credits={{ remaining: 0, total: 4_000 }} />);
    expect(seen("0 of 4,000 this month (hot)")).toBe(true);
    cleanup();
    drawn(<Row credits={null} />);
    expect(seen("none")).toBe(true);
  });

  it("says it in German", () => {
    drawn(<Row credits={{ remaining: 18_885, total: 4_000 }} />, "de");
    expect(seen("Noch 4.000 von 4.000 diesen Monat")).toBe(true);
  });
});

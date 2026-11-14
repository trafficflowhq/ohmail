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
} from "../../../src/settings/ai/index.js";
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

  it("says a server with no model beside what the switch covers, and only then", () => {
    const noModel = "No AI model is set up on this server.";
    drawn(<AiPane model={model({ enabled: true, problem: null, noModel: true })} noModelSaid={noModel} />);
    expect(screen.getByText(`${said("en", "settings", "aiSub")} ${noModel}`)).toBeTruthy();
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

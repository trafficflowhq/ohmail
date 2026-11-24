/** @vitest-environment jsdom */
/**
 * THE WAYS IN'S STATES PAGE, IN JSDOM: every state of the ways in's table is a state of the reference and is drawn at
 * its key, brought to itself by its steps, with no error and no code drawn raw; a refused state says one refusal and
 * no other state says one. The ruling's security case 3: where a state carries a typed pairing code or a password,
 * it draws them as dots and its markup holds neither. Each key stands in a named class of declared difference, or
 * in none, as its class says, until its picture is compared (the pictures are the comparison's run).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextProvider } from "../../src/text/index.js";
import { ONBOARDING_PHONE_STATES, PHONE_DOOR_STATES } from "../../src/phone-door/index.js";
import declared from "../../../../test/compare/declared.json" with { type: "json" };
import registry from "../../../../test/compare/registry.json" with { type: "json" };
import { deviceOf } from "../states/connect-states.js";
import {
  DECLARED_CLASSES,
  declaredClassOf,
  drawnAt,
  MARK,
  PHONE_DOOR_WORDS,
  PhoneDoorStateDrawn,
  stepsOf,
  type Drawn,
} from "../states/phonedoor-states.js";

const KEYS = (registry as { states: { key: string; screen: string }[] }).states
  .filter((row) => row.screen === "phonedoor" || row.screen === "onboarding")
  .map((row) => ({ key: row.key, drawn: drawnAt(new URLSearchParams(row.key)) }))
  .filter((row): row is { key: string; drawn: Drawn } => row.drawn !== null);

const settle = (): Promise<void> => act(async () => {});
/** A refusal's code as the phone's native side names one: never drawn as it is. */
const RAW_CODE = /\b(standalone|pair|base|unreachable)[A-Z]\w+/;

async function drawAt(drawn: Drawn): Promise<HTMLElement> {
  const { container } = render(
    <TextProvider locale="en" messages={PHONE_DOOR_WORDS.en as never} timeZone="UTC">
      <PhoneDoorStateDrawn
        drawn={drawn}
        lang="en"
        device={deviceOf(new URLSearchParams("device=phone"), document.documentElement)}
      />
    </TextProvider>,
  );
  await settle();
  for (const step of stepsOf(drawn, "en")) {
    if ("into" in step)
      fireEvent.change(screen.getByLabelText(step.into, { exact: true }), { target: { value: step.type } });
    else fireEvent.click(screen.getByRole("button", { name: (n) => n.replace(/\s*↵$/, "") === step.press }));
    await settle();
  }
  return container;
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  errors.mockRestore();
});

describe("the ways in's states, at the reference's keys", () => {
  it("are the table's states, each at a registered key", () => {
    const at = new Set(KEYS.map((row) => `${row.drawn.screen}:${row.drawn.id}`));
    for (const id of PHONE_DOOR_STATES) expect(at.has(`phonedoor:${id}`), id).toBe(true);
    for (const id of ONBOARDING_PHONE_STATES) expect(at.has(`onboarding:${id}`), id).toBe(true);
  });

  it("each draws, says one refusal where it is refused and none elsewhere, and draws no code", async () => {
    for (const { key, drawn } of KEYS) {
      const container = await drawAt(drawn);
      const refused = alerted(drawn);
      expect(container.textContent, key).not.toMatch(RAW_CODE);
      expect(container.textContent, key).not.toContain("no such state");
      expect(screen.queryAllByRole("alert").length, key).toBe(refused ? 1 : 0);
      expect(errors, key).not.toHaveBeenCalled();
      cleanup();
    }
  }, 60_000);

  it("draws a typed pairing code and a password as dots, and its markup holds neither", async () => {
    let typed = 0;
    for (const { key, drawn } of KEYS) {
      if (!stepsOf(drawn, "en").some((step) => "into" in step && step.type.includes(MARK))) continue;
      typed += 1;
      const container = await drawAt(drawn);
      const holding = [...container.querySelectorAll("input")].filter((el) => el.value.includes(MARK));
      expect(holding.length, key).toBe(1);
      expect(holding[0]!.type, key).toBe("password");
      expect(container.innerHTML, key).not.toContain(MARK);
      cleanup();
    }
    expect(typed).toBeGreaterThan(30);
  }, 60_000);

  it("stand in their named class of declared difference, or in none", () => {
    const rows = new Map((declared as { key: string; reason: string }[]).map((row) => [row.key, row.reason]));
    for (const { key, drawn } of KEYS) {
      const kind = declaredClassOf(drawn);
      expect(rows.get(key), key).toBe(kind === null ? undefined : DECLARED_CLASSES[kind]);
    }
  });
});

/** Whether a state says a refusal: its own, the form's, or the terms' where the build cannot organize. */
function alerted(drawn: Drawn): boolean {
  if (drawn.screen === "onboarding") return drawn.id === "refused";
  return ![
    "server",
    "checking",
    "reached",
    "reachedapi",
    "computer",
    "terms",
    "form",
    "formhost",
    "opening",
    "confirm",
    "confirmserver",
    "confirmcloud",
    "pairing",
    "hand",
    "mirror",
    "server&os=ios",
    "computer&os=ios",
    "terms&os=ios",
  ].includes(drawn.id);
}

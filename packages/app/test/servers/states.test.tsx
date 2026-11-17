/** @vitest-environment jsdom */
/**
 * THE LIST'S STATES PAGE, IN JSDOM: every state of the list's table is a state of the reference and is drawn at its
 * key, brought to itself by its press, with no error and no code drawn raw; a refused state says its refusal; a state of
 * Stop and remove stands with its dialog open and nothing removed. Each key stands in its named class of declared
 * difference until its picture is compared (the pictures are the comparison's run).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextProvider } from "../../src/text/index.js";
import { SERVERS_STATE_DATA, SERVERS_STATES, type ServersStateData } from "../../src/servers/index.js";
import declared from "../../../../test/compare/declared.json" with { type: "json" };
import registry from "../../../../test/compare/registry.json" with { type: "json" };
import phone from "../../messages/phone.en.json" with { type: "json" };
import { deviceOf } from "../states/connect-states.js";
import {
  DECLARED_CLASSES,
  declaredClassOf,
  drawnAt,
  SERVERS_WORDS,
  ServersStateDrawn,
  stepsOf,
  type Drawn,
} from "../states/servers-states.js";

const KEYS = (registry as { states: { key: string; screen: string }[] }).states
  .filter((row) => row.screen === "servers")
  .map((row) => ({ key: row.key, drawn: drawnAt(new URLSearchParams(row.key)) }))
  .filter((row): row is { key: string; drawn: Drawn } => row.drawn !== null);

const settle = (): Promise<void> => act(async () => {});
/** A refusal's code as the phone's native side names one: never drawn as it is. */
const RAW_CODE = /\b(admit|pair|forget|servers|account)[A-Z]\w+/;

async function drawAt(drawn: Drawn): Promise<HTMLElement> {
  const { container } = render(
    <TextProvider locale="en" messages={SERVERS_WORDS.en as never} timeZone="UTC">
      <ServersStateDrawn
        drawn={drawn}
        device={deviceOf(new URLSearchParams("device=phone"), document.documentElement)}
      />
    </TextProvider>,
  );
  await settle();
  for (const step of stepsOf(drawn, "en")) {
    fireEvent.click(screen.getByRole("button", { name: step.press }));
    await settle();
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

describe("the list's states, at the reference's keys", () => {
  it("are the table's states, each at a registered key", () => {
    const at = new Set(KEYS.map((row) => row.drawn.id));
    for (const id of SERVERS_STATES) expect(at.has(id), id).toBe(true);
    expect(KEYS.length).toBe(SERVERS_STATES.length + 6);
  });

  it("each draws, says its refusal or what a forget left, opens its dialog where it is one, and draws no code", async () => {
    const R: Record<string, string> = phone.phoneRefusal;
    for (const { key, drawn } of KEYS) {
      const data: ServersStateData = SERVERS_STATE_DATA[drawn.id];
      const container = await drawAt(drawn);
      expect(container.textContent, key).not.toMatch(RAW_CODE);
      expect(container.textContent, key).not.toContain("no such state");
      expect(screen.getByRole("heading", { name: phone.servers.title, level: 1 }), key).toBeTruthy();
      // A refusal and what a forget left are said in the catalogue's words (their first words, before any place).
      for (const said of [data.said, data.after])
        if (said !== undefined)
          expect(document.body.textContent, key).toContain(R[said.code]!.split(/[{(]/)[0]!.trim());
      expect(screen.queryAllByRole("dialog").length, key).toBe(data.ask === undefined ? 0 : 1);
      expect(errors, key).not.toHaveBeenCalled();
      cleanup();
    }
  }, 60_000);

  it("stand in their named class of declared difference", () => {
    const rows = new Map((declared as { key: string; reason: string }[]).map((row) => [row.key, row.reason]));
    for (const { key } of KEYS) expect(rows.get(key), key).toBe(DECLARED_CLASSES[declaredClassOf(key)]);
  });
});

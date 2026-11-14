/** @vitest-environment jsdom */
/**
 * THE ONE CONNECT FORM'S STATES PAGE, BEFORE ANY PICTURE: every key the comparison's subjects open is a registered
 * state of the screen `onboarding`, once; each state of a refused connect comes to its own sentence by the steps the
 * subjects walk, in English and in German; the join's step stands as the join seats it; and every key stands whole
 * in a named class of declared difference until its picture is compared. The pictures are the comparison's run.
 */
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Said } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { CONNECT_STATES, saidOfState } from "../../../app-logic/test/mailboxes/connect/refusal-states.js";
import { TextProvider, useTextLookup } from "../../src/text/index.js";
import declared from "../../../../test/compare/declared.json" with { type: "json" };
import registry from "../../../../test/compare/registry.json" with { type: "json" };
import { connectSubjects } from "./connect-open.js";
import {
  CONNECT_KEYS,
  CONNECT_WORDS,
  ConnectState,
  DECLARED_CLASSES,
  JOIN_STEP_KEY,
  declaredClassOf,
  deviceOf,
  drawnAt,
  keyOfRow,
  say,
  stepsOf,
  type Lang,
} from "./connect-states.js";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await act(async () => {});
};
const within = (lang: Lang, child: ReactNode) => (
  <TextProvider locale={lang} messages={CONNECT_WORDS[lang] as never} timeZone="Europe/Zurich">
    {child}
  </TextProvider>
);

/** The page at a key, its steps walked as the subjects walk them. */
async function page(key: string, lang: Lang = "en"): Promise<void> {
  const words = new URLSearchParams(key);
  const drawn = drawnAt(words);
  if (drawn === null) throw new Error(`the page draws no state at ${key}`);
  render(
    within(
      lang,
      <ConnectState drawn={drawn} lang={lang} device={deviceOf(words, document.documentElement)} />,
    ),
  );
  await settle();
  for (const step of stepsOf(drawn, lang)) {
    if ("into" in step) fireEvent.change(screen.getByLabelText(step.into), { target: { value: step.type } });
    else if ("leave" in step) fireEvent.focusOut(screen.getByLabelText(step.leave));
    else if ("press" in step) fireEvent.click(screen.getByRole("button", { name: step.press }));
    else fireEvent.click(screen.getByRole("switch", { name: step.tick }));
    await settle();
  }
}

/** A state's sentence as the form's reader says it, drawn alone. */
function sentence(said: Said, lang: Lang): string {
  function Says(): ReactNode {
    const text = useTextLookup();
    return "server" in said ? said.server : text(said.ns)(said.key, said.values);
  }
  const view = render(within(lang, <Says />));
  const words = view.container.textContent ?? "";
  view.unmount();
  return words;
}

describe("the page draws every key its subjects open", () => {
  const onboarding = new Set(
    (registry as { states: { key: string; screen: string }[] }).states
      .filter((state) => state.screen === "onboarding")
      .map((state) => state.key),
  );

  it("each a registered state of the onboarding screen, once: the join's step and every state of a refused connect", () => {
    expect(CONNECT_KEYS.filter((key) => !onboarding.has(key))).toEqual([]);
    expect(new Set(CONNECT_KEYS).size).toBe(CONNECT_KEYS.length);
    expect(CONNECT_KEYS).toHaveLength(1 + CONNECT_STATES.length);
    expect(
      connectSubjects((registry as { states: { key: string; screen: string }[] }).states)
        .map((s) => s.key)
        .sort(),
    ).toEqual([...CONNECT_KEYS].sort());
    for (const row of CONNECT_STATES)
      expect(drawnAt(new URLSearchParams(keyOfRow(row)))).toEqual({ kind: "row", row });
    expect(drawnAt(new URLSearchParams(`device=phone&${JOIN_STEP_KEY}`))).toEqual({ kind: "join" });
    expect(drawnAt(new URLSearchParams("screen=onboarding&step=login"))).toBeNull();
  });

  it("each whole in a named class of declared difference, until its picture is compared", () => {
    const rows = new Map(
      (declared as { key: string; reason: string; nodes?: unknown }[]).map((row) => [row.key, row]),
    );
    for (const key of CONNECT_KEYS) {
      const row = rows.get(key);
      expect(row, key).toBeDefined();
      expect(row!.nodes, key).toBeUndefined();
      expect(row!.reason, key).toBe(DECLARED_CLASSES[declaredClassOf(key)]);
    }
  });
});

describe("each state comes to itself by the steps the subjects walk", () => {
  it.each(["en", "de"] as const)("a refused connect says its own sentence, in %s", async (lang) => {
    for (const row of CONNECT_STATES) {
      const key = keyOfRow(row);
      await page(key, lang);
      const said = saidOfState(row);
      if (row.own === "serversFound") {
        expect(
          screen.getByRole("button", { name: say(lang, { ns: "providerPicker", key: "discoveredUse" }) }),
          key,
        ).toBeTruthy();
        expect(document.body.textContent, key).toContain("imap.lichtgrat.example");
      } else if (said === null) {
        const ticked = screen
          .getAllByRole("switch")
          .filter((line) => line.getAttribute("aria-checked") === "true");
        expect(ticked, key).toHaveLength(1);
      } else {
        const words = document.body.textContent ?? "";
        cleanup();
        expect(words, key).toContain(sentence(said, lang));
      }
      cleanup();
    }
  });

  it("the join's step stands as the join seats it: its heading, the address first, the tiles, nothing chosen", async () => {
    await page(JOIN_STEP_KEY);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      say("en", { ns: "join", key: "step_mailbox_title" }),
    );
    expect(screen.getByLabelText(say("en", { ns: "join", key: "mailboxAddress" }))).toBeTruthy();
    const tiles = screen.getByRole("group", { name: say("en", { ns: "providerPicker", key: "label" }) });
    expect(tiles.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

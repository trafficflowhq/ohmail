/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../src/host/contract.js";
import { TextProvider } from "../../src/text/index.js";
import {
  SubscribedPage,
  SUBSCRIBED_STATES,
  type SubscribedDoor,
  type SubscribedState,
} from "../../src/doors/subscribed/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };

/**
 * AFTER PAYING: the page goes on by itself where a session stands, and otherwise says one sentence and offers the way
 * to the app, the door's act. Its namespace is not in the document's first cut, so it waits wordless until it is there.
 */
type Words = Record<string, unknown>;
const W = en.subscribed;

function draw(state: SubscribedState, words: Words = en, locale: "en" | "de" = "en", pending = false) {
  const open = vi.fn();
  const door: SubscribedDoor = { state, open };
  const view = render(
    <TextProvider locale={locale} messages={words as never} timeZone="UTC" pending={pending}>
      <SubscribedPage door={door} />
    </TextProvider>,
  );
  return { view, open };
}

afterEach(cleanup);

describe("after paying", () => {
  it("continuing: says it is going on to ohmail, ending in the dot, busy, with nothing to press", () => {
    const { view } = draw({ at: "continuing" });
    expect(document.querySelector("main p")?.textContent).toBe("Continuing to ohmail");
    expect(view.container.querySelector("main p .oh-dot")).not.toBeNull();
    expect(view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("back: says the one true sentence, when ohmail opens again, and Open ohmail is the door's act", () => {
    const { open } = draw({ at: "back" });
    expect(document.querySelector("main p")?.textContent).toBe(W.title.replace(/\.$/, ""));
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.body.textContent).toContain(
      "ohmail opens your account again as soon as the payment is confirmed.",
    );
    expect(document.body.textContent).toContain(
      "If ohmail is an app on your home screen, close this window and switch to it.",
    );
    fireEvent.click(screen.getByRole("button", { name: W.open }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("claims nothing about the payment and names no payment processor", () => {
    for (const state of [{ at: "continuing" }, { at: "back" }] as const) {
      const { view } = draw(state);
      expect(view.container.textContent).not.toMatch(/stripe|paid|succeeded|receipt/i);
      cleanup();
    }
  });

  it("while its words are on their way, waits without a word and offers nothing", () => {
    const { subscribed: _held, ...cut } = en;
    const { view } = draw({ at: "back" }, cut, "en", true);
    expect(view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(view.container.textContent).toBe("");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("a build with no server: says so, and offers nothing", () => {
    render(
      <TextProvider locale="en" messages={en as never} timeZone="UTC">
        <SubscribedPage door={NONE} />
      </TextProvider>,
    );
    expect(document.body.textContent).toContain(en.gate.lede.replace(/\.$/, ""));
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("speaks German where the catalogue is German", () => {
    draw({ at: "back" }, de, "de");
    expect(screen.getByRole("button", { name: de.subscribed.open })).toBeTruthy();
    expect(document.body.textContent).toContain(de.subscribed.body);
  });

  it("names its states by the reference's address", () => {
    expect([...SUBSCRIBED_STATES]).toEqual(["continuing", "back"]);
  });
});

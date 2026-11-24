/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import phone from "../../messages/phone.en.json" with { type: "json" };
import { NewMailPane, type NewMailModel } from "../../src/phone-settings/new-mail/NewMailPane.js";
import { TextProvider } from "../../src/text/index.js";

const words = phone.phoneSettings.newMail;
const choices = [{ id: "fixture.wake", name: "Wake helper" }];

function show(model: Partial<NewMailModel> = {}) {
  const choose = vi.fn();
  const turnOff = vi.fn();
  render(
    <TextProvider locale="en" messages={phone as never} timeZone="UTC">
      <NewMailPane
        model={{
          os: "android",
          state: { k: "no_distributor" },
          choices,
          chosen: null,
          busy: false,
          choose,
          turnOff,
          ...model,
        }}
      />
    </TextProvider>,
  );
  return { choose, turnOff };
}

afterEach(cleanup);

it("offers the phone's installed distributor and its own turn-off action", () => {
  const { choose, turnOff } = show();
  const helper = screen.getByRole("radio", { name: "Wake helper" });
  const none = screen.getByRole("radio", { name: words.none });
  expect(none.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(helper);
  fireEvent.click(none);
  expect(choose.mock.calls).toEqual([[choices[0]!.id]]);
  expect(turnOff.mock.calls).toEqual([[]]);
});

it("has no distributor control where the phone has none or cannot use one", () => {
  show({ choices: [] });
  expect(screen.queryByRole("radiogroup")).toBeNull();
  cleanup();
  show({ os: "ios" });
  expect(screen.getByText(words.say.ios)).toBeTruthy();
  expect(screen.queryByRole("radiogroup")).toBeNull();
});

it("keeps distributor controls disabled while a change is pending", () => {
  const { choose, turnOff } = show({ busy: true });
  for (const choice of screen.getAllByRole("radio")) {
    expect(choice.matches(":disabled")).toBe(true);
    fireEvent.click(choice);
  }
  expect(choose).not.toHaveBeenCalled();
  expect(turnOff).not.toHaveBeenCalled();
});

it("shows the incomplete removal and withholds the claim that it removed the registration", () => {
  show({ state: { k: "off", reason: "row_remains" } });
  expect(screen.getByText(words.say.rowRemains)).toBeTruthy();
  expect(screen.getByRole("radio", { name: words.none })).toBeTruthy();
  expect(screen.queryByText(words.noneNote)).toBeNull();
});

it("says when the person switched new mail off and shows a failure without raw details", () => {
  show({ state: { k: "off", reason: "switched_off" } });
  expect(screen.getByText(words.say.switchedOff)).toBeTruthy();
  cleanup();
  show({ state: { k: "off", reason: "unexpected detail" } });
  expect(screen.getByText(words.say.failed)).toBeTruthy();
  expect(screen.queryByText("unexpected detail")).toBeNull();
});

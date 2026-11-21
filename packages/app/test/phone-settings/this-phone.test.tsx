/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import phone from "../../messages/phone.en.json" with { type: "json" };
import { ThisPhoneSheet, type ThisPhoneModel } from "../../src/phone-settings/this-phone/ThisPhoneSheet.js";
import { TextProvider } from "../../src/text/index.js";

const words = phone.phoneSettings.thisPhone;
const base = { scope: "test-phone", mailboxId: "mailbox", address: "Current mailbox" };

function sheet(model: ThisPhoneModel) {
  return (
    <TextProvider locale="en" messages={phone as never} timeZone="UTC">
      <ThisPhoneSheet model={model} />
    </TextProvider>
  );
}

function draw(model: ThisPhoneModel) {
  return render(sheet(model));
}

afterEach(cleanup);

it("names the answering server and offers no local change on a paired row", () => {
  draw({ ...base, tag: "reader", note: words.note.server });
  expect(screen.getByText(words.tag.reader)).toBeTruthy();
  expect(screen.getByText(words.note.server)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

it("explains the hand-back before asking the phone to stop", () => {
  const stop = vi.fn();
  draw({ ...base, tag: "organizing", stop });
  fireEvent.click(screen.getByRole("button", { name: words.stop }));
  const confirm = screen.getByRole("dialog", { name: words.stopAsk.title });
  expect(within(confirm).getByText(words.stopAsk.what)).toBeTruthy();
  fireEvent.click(within(confirm).getByRole("button", { name: words.stopAsk.cancel }));
  expect(stop).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: words.stop }));
  const reopened = screen.getByRole("dialog", { name: words.stopAsk.title });
  fireEvent.click(within(reopened).getByRole("button", { name: words.stopAsk.confirm }));
  expect(stop).toHaveBeenCalledTimes(1);
});

it("retires a stop question when the phone loses its original claim", () => {
  const firstStop = vi.fn();
  const laterStop = vi.fn();
  const view = draw({ ...base, tag: "organizing", stop: firstStop });
  fireEvent.click(screen.getByRole("button", { name: words.stop }));
  expect(screen.getByRole("dialog", { name: words.stopAsk.title })).toBeTruthy();

  view.rerender(sheet({ ...base, tag: "reader" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(sheet({ ...base, tag: "organizing", stop: laterStop }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(firstStop).not.toHaveBeenCalled();
  expect(laterStop).not.toHaveBeenCalled();
});

it("lets the handset choose when to explain background organizing", () => {
  const start = vi.fn();
  draw({ ...base, tag: "notOrganized", start, explainBackground: true });
  fireEvent.click(screen.getByRole("button", { name: words.start }));
  const explain = screen.getByRole("dialog", { name: words.background.title });
  expect(within(explain).getByText(words.background.why)).toBeTruthy();
  fireEvent.click(within(explain).getByRole("button", { name: words.background.continue }));
  expect(start).toHaveBeenCalledTimes(1);
  cleanup();
  draw({ ...base, tag: "notOrganized", start });
  fireEvent.click(screen.getByRole("button", { name: words.start }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(start).toHaveBeenCalledTimes(2);
});

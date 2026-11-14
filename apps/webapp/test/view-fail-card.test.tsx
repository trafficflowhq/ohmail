/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { fakeHost, NO_ENGINE } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import messages from "../messages/en.json";

const payload = "Subject: Anna's invoice — do not forward";
const words = messages.viewError;

function mount(place: "ohbox" | "history", error: unknown) {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "account",
    window: fakeWindow("desktop"),
    address: fakeAddress(`#/${place}`),
    places: {
      [place]: {
        id: place, body: place, rail: null,
        panes: { kind: "wide", Wide: () => { throw error; } },
      },
    },
  });
  render(
    <TextProvider locale="en" timeZone="UTC" messages={messages}>
      <Frame host={host} />
    </TextProvider>,
  );
  return within(screen.getByRole("alert"));
}

describe("the in-pane error card", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the build id and the view beside the sentence, and the reload stays", () => {
    const card = mount("ohbox", new TypeError(payload));
    expect(card.getByRole("heading", { name: words.paneTitle })).toBeTruthy();
    expect(card.getByText(words.body)).toBeTruthy();
    expect(card.getByRole("button", { name: words.action })).toBeTruthy();
    expect(card.getByText("TypeError · build dev · view ohbox", { selector: "code" })).toBeTruthy();
  });

  it("copies the error class, the build id and the view — and never the message", async () => {
    const writeText = vi.fn(async (_details: string) => undefined);
    vi.stubGlobal("navigator", { ...window.navigator, clipboard: { writeText } });

    const card = mount("ohbox", new TypeError(payload));
    fireEvent.click(card.getByRole("button", { name: words.copyDetails }));

    expect(writeText.mock.calls).toEqual([["TypeError · build dev · view ohbox"]]);
    expect(writeText.mock.calls[0][0]).not.toContain(payload);
    expect(await card.findByRole("button", { name: words.copied })).toBeTruthy();
  });

  it("a clipboard this context refuses is a no-op, never a second throw", () => {
    vi.stubGlobal("navigator", { ...window.navigator, clipboard: undefined });

    const card = mount("ohbox", new TypeError(payload));
    fireEvent.click(card.getByRole("button", { name: words.copyDetails }));

    expect(card.getByRole("button", { name: words.copyDetails })).toBeTruthy();
    expect(card.getByRole("heading", { name: words.paneTitle })).toBeTruthy();
  });

  it("a thrown string is named by type, its payload never rendered or copied", async () => {
    const writeText = vi.fn(async (_details: string) => undefined);
    vi.stubGlobal("navigator", { ...window.navigator, clipboard: { writeText } });

    const card = mount("history", payload);
    expect(card.queryByText(payload, { exact: false })).toBeNull();
    fireEvent.click(card.getByRole("button", { name: words.copyDetails }));
    expect(writeText.mock.calls).toEqual([["string · build dev · view history"]]);
    expect(await card.findByRole("button", { name: words.copied })).toBeTruthy();
  });
});

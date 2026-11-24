/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import frameEn from "../../messages/frame.en.json" with { type: "json" };

const payload = "Private letter subject";
const words = frameEn.viewError;
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function mount(thrown: unknown) {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "account",
    window: fakeWindow("desktop"),
    address: fakeAddress("#/history"),
    places: {
      history: {
        id: "history",
        body: "history",
        rail: null,
        panes: {
          kind: "wide",
          Wide: () => {
            throw thrown;
          },
        },
      },
    },
  });
  render(
    <TextProvider locale="en" timeZone="UTC" messages={{ ...FRAME_WORDS.en, viewError: words }}>
      <Frame
        host={{ ...host, device: { ...host.device, build: { ...host.device.build, commit: "abc123" } } }}
      />
    </TextProvider>,
  );
  return within(screen.getByRole("region", { name: words.title }));
}

it("reloads only the failed pane and keeps the same healthy reading column", () => {
  let broken = true;
  const address = fakeAddress("#/tag/work");
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "account",
    window: fakeWindow("desktop"),
    address,
    places: {
      tags: {
        id: "tags",
        body: "tags",
        rail: null,
        panes: {
          kind: "columns",
          holds: "always",
          List: () => {
            if (broken) throw new TypeError(payload);
            return <p>Recovered list</p>;
          },
          Reading: () => <p>Healthy reading column</p>,
        },
      },
    },
  });
  render(
    <TextProvider locale="en" timeZone="UTC" messages={{ ...FRAME_WORDS.en, viewError: words }}>
      <Frame host={host} />
    </TextProvider>,
  );
  const reading = screen.getByText("Healthy reading column");
  broken = false;
  const card = within(screen.getByRole("region", { name: words.title }));
  fireEvent.click(card.getByRole("button", { name: words.action }));

  expect(screen.getByText("Recovered list")).toBeTruthy();
  expect(screen.getByText("Healthy reading column")).toBe(reading);
  expect(address.read()).toBe("#/tag/work");
  expect(address.writes).toHaveLength(0);
});

function clipboardWith(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

it("offers a reload and copies the class, build and place from the failed pane", async () => {
  const write = vi.fn(async () => undefined);
  clipboardWith(write);
  const error = new TypeError(payload);
  error.name = payload;
  const card = mount(error);
  expect(card.getByRole("button", { name: words.action })).toBeTruthy();
  expect(card.getByText("TypeError · build abc123 · view history")).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: words.copyDetails }));
  expect(write.mock.calls).toEqual([["TypeError · build abc123 · view history"]]);
  expect(await card.findByRole("button", { name: words.copied })).toBeTruthy();
  expect(card.queryByText(payload, { exact: false })).toBeNull();
});

it("names a thrown string by type and stays usable when clipboard access is denied", async () => {
  const write = vi.fn(async () => {
    throw new Error("Denied");
  });
  clipboardWith(write);
  const card = mount(payload);
  const copy = card.getByRole("button", { name: words.copyDetails });
  fireEvent.click(copy);
  await waitFor(() => expect(write.mock.calls).toEqual([["string · build abc123 · view history"]]));
  expect(card.getByText(words.body)).toBeTruthy();
  expect(card.queryByText(payload, { exact: false })).toBeNull();
  expect(card.queryByRole("button", { name: words.copied })).toBeNull();
});

it("keeps its details visible when this window has no clipboard", () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const card = mount(new RangeError(payload));
  fireEvent.click(card.getByRole("button", { name: words.copyDetails }));
  expect(card.getByText("RangeError · build abc123 · view history")).toBeTruthy();
});

it("groups failure copy, selectable details and recovery actions inside the in-pane alert", () => {
  const card = mount(new Error(payload));
  const alert = within(card.getByRole("alert"));
  expect(alert.getByRole("heading", { name: "This view did not load" })).toBeTruthy();
  expect(alert.getByText(words.body)).toBeTruthy();
  expect(alert.getByText("Error · build abc123 · view history")).toBeTruthy();
  expect(alert.getByRole("button", { name: words.action })).toBeTruthy();
  expect(alert.getByRole("button", { name: words.copyDetails })).toBeTruthy();
  expect(alert.getByRole("button", { name: "Ohbox" })).toBeTruthy();
});

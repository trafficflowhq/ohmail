/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import type { PlaceEntry } from "../../src/frame/contract.js";
import type {
  BackSignal,
  FoldReading,
  HostContract,
  HostSignals,
  KeyboardReading,
  SafeInsets,
} from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, movable } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { wideWindow } from "../ohbox/setup.js";

/*
 * THE GLASS. A phone's host says where the system draws over its window's foot, how much the keyboard covers, where
 * the fold stands, and when the system's back is pressed. The frame writes the first three where its sheets read
 * them, takes back what it wrote, writes nothing for a host that says none, and answers back newest first.
 */

beforeEach(wideWindow);
afterEach(cleanup);

const root = () => document.documentElement;
const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List: () => <p>the list</p>, Reading: () => <p>a letter</p> },
};
const screener: PlaceEntry = { ...ohbox, id: "screener", body: "screener" };

/** A back the test presses: the newest handler first, as the platform asks them. */
function fakeBack(): BackSignal & { press(): boolean } {
  const handlers: Array<() => boolean> = [];
  return {
    subscribe(handle) {
      handlers.push(handle);
      return () => handlers.splice(handlers.indexOf(handle), 1);
    },
    press() {
      for (const handle of [...handlers].reverse()) if (handle()) return true;
      return false;
    },
  };
}

function mount(signals: Partial<HostSignals>, room: "phone" | "fold" = "phone", at = "#/ohbox") {
  const address = fakeAddress(at);
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: { ohbox, screener },
    window: fakeWindow(room),
    address,
  }).host;
  const host: HostContract = { ...made, signals: { ...made.signals, ...signals } };
  const view = render(
    <TextProvider locale="en" messages={{ ...FRAME_WORDS.en, ohbox: { title: "Ohbox" } }} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );
  return { view, address };
}

describe("the glass's foot", () => {
  it("writes the system's inset where the frame's sheets read it, and takes it back", () => {
    const insets = movable<SafeInsets>({ top: 0, right: 0, bottom: 34, left: 0 });
    const { view } = mount({ insets });
    expect(root().getAttribute("data-foot")).toBe("glass");
    expect(root().style.getPropertyValue("--sys-b")).toBe("34px");
    act(() => insets.set({ top: 0, right: 0, bottom: 0, left: 0 }));
    expect(root().style.getPropertyValue("--sys-b"), "gesture navigation, the hint off").toBe("0px");
    view.unmount();
    expect(root().hasAttribute("data-foot")).toBe(false);
    expect(root().style.getPropertyValue("--sys-b")).toBe("");
  });

  it("counts the inset 0 while the keyboard is up, and says how much it covers", () => {
    const insets = movable<SafeInsets>({ top: 0, right: 0, bottom: 34, left: 0 });
    const keyboard = movable<KeyboardReading>({ height: 0 });
    mount({ insets, keyboard });
    expect(root().style.getPropertyValue("--sys-b")).toBe("34px");
    act(() => keyboard.set({ height: 300 }));
    expect(root().style.getPropertyValue("--sys-b")).toBe("0px");
    expect(root().style.getPropertyValue("--kb")).toBe("300px");
  });

  it("writes nothing for a host that says none, and the dock stands where it stood", () => {
    mount({});
    expect(root().hasAttribute("data-foot")).toBe(false);
    expect(root().hasAttribute("data-fold")).toBe(false);
    expect(root().getAttribute("style") ?? "").toBe("");
  });

  it("writes a book's fold for the list to end at", () => {
    const posture = movable<FoldReading>({
      folds: [
        {
          bounds: { x: 355, y: 0, w: 10, h: 781 },
          state: "half",
          orientation: "vertical",
          occlusion: "none",
        },
      ],
      hasFold: true,
    });
    mount({ posture }, "fold");
    expect(root().getAttribute("data-fold")).toBe("book");
    expect(root().style.getPropertyValue("--fold-at")).toBe("360px");
    expect(root().style.getPropertyValue("--fold-band")).toBe("26px");
    expect(root().style.getPropertyValue("--fold-floor")).toBe("260px");
    act(() => posture.set({ folds: [], hasFold: true }));
    expect(root().hasAttribute("data-fold")).toBe(false);
  });
});

describe("the system's back", () => {
  it("dismisses the open Screener sender before letting the app leave", () => {
    const back = fakeBack();
    const { address } = mount({ back }, "phone", "#/screener?sender=open");
    const write = vi.spyOn(address, "write");
    let took = false;
    act(() => {
      took = back.press();
    });
    expect(took).toBe(true);
    expect(address.read()).toBe("#/screener");
    expect(write).toHaveBeenCalledWith("#/screener", "replace", "dismiss-preview");
    act(() => {
      took = back.press();
    });
    expect(took).toBe(false);
  });

  it("closes the open letter, and with nothing open lets the app leave", () => {
    const back = fakeBack();
    const { address } = mount({ back }, "phone", "#/ohbox/m/a1");
    let took = false;
    act(() => {
      took = back.press();
    });
    expect(took).toBe(true);
    expect(address.read()).toBe("#/ohbox");
    act(() => {
      took = back.press();
    });
    expect(took).toBe(false);
  });

  it("closes the whole rail over the app before the letter under it", () => {
    const back = fakeBack();
    const { address } = mount({ back }, "phone", "#/ohbox");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("dialog", { name: "More" })).not.toBeNull();
    let took = false;
    act(() => {
      took = back.press();
    });
    expect(took).toBe(true);
    expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
    expect(address.read()).toBe("#/ohbox");
  });
});

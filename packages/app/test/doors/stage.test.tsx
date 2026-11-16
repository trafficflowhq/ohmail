/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DoorStage, Said, useDoorPlan, type DoorDevice, type DoorRoot } from "../../src/doors/stage/index.js";
import { fakeWindow, movable } from "../support/fake-window.js";
import type { Appearance } from "../../src/frame/contract.js";

/**
 * THE DOORS' STAGE stands before the app: it lays out by the same plan as the frame, stamps the root attributes
 * the design's variants read, gives back what it found on unmount, and draws the same markup whatever the window.
 */
const root = document.documentElement;
const ATTRS = [
  "data-scheme",
  "data-device",
  "data-touch",
  "data-pose",
  "data-icons",
  "data-product",
  "data-rm",
  "data-face",
];
const stamped = (): Record<string, string | null> =>
  Object.fromEntries(ATTRS.map((a) => [a, root.getAttribute(a)]));

/** The document's element, as the web's device hands it in. */
const documentRoot: DoorRoot = {
  read: (name) => root.getAttribute(name),
  write: (name, value) => {
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  },
};

function deviceOf(
  room: Parameters<typeof fakeWindow>[0],
  look: Appearance = { face: "paper", scheme: "light" },
) {
  return { window: fakeWindow(room), appearance: movable(look), root: documentRoot };
}

function PlanSays() {
  const plan = useDoorPlan();
  return <p>{plan === null ? "no plan" : plan.device}</p>;
}

afterEach(() => {
  cleanup();
  for (const a of ATTRS) root.removeAttribute(a);
});

describe("the doors' stage", () => {
  it("stamps the device the window makes, and follows a resize and a change of look", () => {
    const device = deviceOf("phone");
    const view = render(
      <DoorStage device={() => device}>
        <PlanSays />
      </DoorStage>,
    );
    expect(stamped()).toMatchObject({
      "data-device": "phone",
      "data-touch": "1",
      "data-scheme": "light",
      "data-face": "paper",
      "data-product": "mail",
    });
    expect(view.getByText("phone")).toBeTruthy();
    act(() => device.window.resize(1440, 900, "fine"));
    expect(stamped()).toMatchObject({ "data-device": "desktop", "data-touch": "0" });
    expect(view.getByText("desktop")).toBeTruthy();
    act(() => device.appearance.set({ face: "paper", scheme: "dark" }));
    expect(root.getAttribute("data-scheme")).toBe("dark");
  });

  it("gives back what it found, and leaves a face the shell wrote alone", () => {
    root.setAttribute("data-face", "ohmarchy");
    root.setAttribute("data-scheme", "dark");
    const device = deviceOf("fold", { face: "ohmarchy", scheme: "light" });
    const view = render(
      <DoorStage device={() => device}>
        <p>page</p>
      </DoorStage>,
    );
    expect(stamped()).toMatchObject({
      "data-device": "fold",
      "data-scheme": "light",
      "data-face": "ohmarchy",
    });
    view.unmount();
    expect(stamped()).toMatchObject({
      "data-device": null,
      "data-scheme": "dark",
      "data-face": "ohmarchy",
      "data-touch": null,
    });
  });

  it("asks the shell for its device once, after its first markup (the web's server render is held by its route's test)", () => {
    let asked = 0;
    const device = deviceOf("desktop");
    const ask = (): DoorDevice => {
      asked += 1;
      return device;
    };
    const view = render(
      <DoorStage device={ask}>
        <PlanSays />
      </DoorStage>,
    );
    view.rerender(
      <DoorStage device={ask}>
        <PlanSays />
      </DoorStage>,
    );
    expect(asked).toBe(1);
  });
});

describe("a door's sentence ends in the dot", () => {
  const said = (text: string) => render(<Said text={text} />).container;

  it("turns a closing full stop into the dot, and gives a sentence that ends on a word one", () => {
    for (const text of ["You are signed out.", "Please sign in again"]) {
      const at = said(text);
      expect(at.textContent).toBe(text.replace(/\.$/, ""));
      expect(at.querySelectorAll("[aria-hidden=true]")).toHaveLength(1);
      cleanup();
    }
  });

  it("says a sentence that ends on another mark as it stands, with no dot", () => {
    const at = said("Checking your sign-in…");
    expect(at.textContent).toBe("Checking your sign-in…");
    expect(at.querySelectorAll("[aria-hidden=true]")).toHaveLength(0);
  });

  it("is a heading where it names the page", () => {
    const view = render(<Said text="Sign in" level={1} />);
    expect(view.getByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
  });
});

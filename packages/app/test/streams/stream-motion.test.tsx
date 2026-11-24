/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useStreamItem } from "../../src/stream/use-stream-item.js";
import { issue } from "./registered-world.js";

function Preview() {
  const [whole, setWhole] = useState(false);
  const { card, fold } = useStreamItem(
    issue("one", 10),
    whole,
    (_id, open) => setWhole(open),
    () => {},
  );
  return (
    <div ref={card}>
      <div className="oh-message-clip" data-shut={whole ? undefined : ""}>
        Text
      </div>
      <button onClick={fold}>Toggle</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("eases a preview when its full text arrives after it was opened", () => {
  let height = 100;
  let resized: ResizeObserverCallback | undefined;
  class Observer {
    constructor(callback: ResizeObserverCallback) {
      resized = callback;
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  const style = document.createElement("style");
  style.textContent =
    ".oh-message-clip { --d-in: 220ms; --e-move: linear; --stream-clip-motion-threshold: 2px; }";
  document.head.append(style);
  const original = Element.prototype.animate;
  const frames: Keyframe[][] = [];
  Element.prototype.animate = function (keyframes) {
    frames.push(keyframes as Keyframe[]);
    return { cancel() {}, addEventListener() {} } as unknown as Animation;
  };
  try {
    render(<Preview />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    height = 300;
    act(() => resized?.([], {} as ResizeObserver));
    expect(frames).toContainEqual([{ maxHeight: "100px" }, { maxHeight: "300px" }]);
  } finally {
    Element.prototype.animate = original;
    style.remove();
  }
});

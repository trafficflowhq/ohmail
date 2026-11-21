/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useMovingRows } from "../../src/place-list/use-moving-rows.js";

function List({ ids }: { ids: string[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  useMovingRows(scroller, ids.join(","));
  return (
    <div ref={scroller}>
      {ids.map((id) => (
        <div role="option" data-id={id} key={id}>
          {id}
        </div>
      ))}
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("moves a neighboring row to its new place after a removal and after Undo", () => {
  const style = document.createElement("style");
  style.textContent = '[role="option"] { --d-move: 260ms; --e-move: linear; }';
  document.head.append(style);
  const original = Element.prototype.animate;
  const frames: Keyframe[][] = [];
  Element.prototype.animate = function (keyframes) {
    frames.push(keyframes as Keyframe[]);
    return { cancel() {}, addEventListener() {} } as unknown as Animation;
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = Array.from(this.parentElement?.children ?? []).indexOf(this) * 50;
    return { top, bottom: top + 50, left: 0, right: 100, width: 100, height: 50, x: 0, y: top, toJSON() {} };
  });
  try {
    const list = render(<List ids={["one", "two", "three"]} />);
    list.rerender(<List ids={["one", "three"]} />);
    expect(frames).toContainEqual([{ transform: "translate(0px, 50px)" }, { transform: "none" }]);
    frames.length = 0;
    list.rerender(<List ids={["one", "two", "three"]} />);
    expect(frames).toContainEqual([{ transform: "translate(0px, -50px)" }, { transform: "none" }]);
  } finally {
    Element.prototype.animate = original;
    style.remove();
  }
});

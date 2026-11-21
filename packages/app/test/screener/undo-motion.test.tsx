/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { useRef, type CSSProperties } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useMovingRows } from "../../src/place-list/use-moving-rows.js";

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
afterEach(() => {
  cleanup();
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
});

const tokens = {
  "--d-in": "220ms",
  "--e-arrive": "cubic-bezier(.16,1,.3,1)",
  "--x-row": "translateY(-8px)",
  "--o-pop": "0",
} as CSSProperties;

function Queue({
  ids,
  scope = null,
  reduced = false,
}: {
  ids: readonly string[];
  scope?: string | null;
  reduced?: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  useMovingRows(list, JSON.stringify(ids), { ids, scope });
  return (
    <div ref={list} data-rm={reduced ? "1" : undefined}>
      {ids.map((id) => (
        <div key={id} role="option" aria-selected={false} data-id={id} style={tokens} />
      ))}
    </div>
  );
}

it("animates a restored sender after the queue was cleared, but skips first fill, filter changes and reduced motion", () => {
  const animate = vi.fn(() => ({ cancel() {}, addEventListener() {} }) as unknown as Animation);
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
  const { rerender } = render(<Queue ids={[]} />);
  rerender(<Queue ids={["sender"]} />);
  expect(animate).not.toHaveBeenCalled();
  rerender(<Queue ids={[]} />);
  rerender(<Queue ids={["sender"]} />);
  expect(animate).toHaveBeenCalledTimes(1);
  expect(animate).toHaveBeenCalledWith(
    [
      { transform: "translateY(-8px)", opacity: "0" },
      { transform: "none", opacity: "1" },
    ],
    { duration: 220, easing: "cubic-bezier(.16,1,.3,1)", fill: "none" },
  );
  animate.mockClear();
  rerender(<Queue ids={["another"]} scope="filter" />);
  expect(animate).not.toHaveBeenCalled();
  rerender(<Queue ids={[]} scope="filter" reduced />);
  rerender(<Queue ids={["another"]} scope="filter" reduced />);
  expect(animate).not.toHaveBeenCalled();
});

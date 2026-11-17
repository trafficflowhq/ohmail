import type { WayOutDoor } from "../../../src/account/way-out/model.js";

/**
 * A browser the test stands in for. It starts none unless handed an answer: each press takes the next answer in
 * turn, and a press with none left is one that started no browser. `opens` counts the presses that reached it.
 */
export function fakeWayOutDoor(
  answers: readonly boolean[] = [],
): WayOutDoor & { readonly opens: () => number } {
  const left = [...answers];
  let opens = 0;
  return {
    open: () => {
      opens += 1;
      return Promise.resolve(left.shift() ?? false);
    },
    opens: () => opens,
  };
}

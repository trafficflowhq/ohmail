/** @vitest-environment jsdom */
/**
 * AN UNFOLD KEEPS THE CARET IN THE REPLY. Android hands the composer's `Modal` a new
 * dialog window on an unfold (measured on the lane AVD: the dialog's window changed on every unfold
 * and never on a fold), and the field that held the caret lost it with the old window. The composer
 * gives it back when the dialog is shown again — never on the first show, and never to a field the
 * person had already let go.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { REDRAW_BLUR_MS, refocusOnShow, useFocusKeeper, type Focusable } from "../src/ui/keep-focus";
import { mount } from "./_rendered-dom";

describe("which show gives the caret back", () => {
  const field = { current: null as Focusable | null };
  it("a redraw of a field still held does; the first show never does", () => {
    expect(refocusOnShow(1, { field, blurredAt: null }, 0)).toBe(false);
    expect(refocusOnShow(2, { field, blurredAt: null }, 0)).toBe(true);
    expect(refocusOnShow(2, { field, blurredAt: 1000 }, 1000 + REDRAW_BLUR_MS), "the old window's blur").toBe(true);
  });
  it("a field let go before the redraw, or none at all, stays as it is", () => {
    expect(refocusOnShow(2, { field, blurredAt: 1000 }, 1000 + REDRAW_BLUR_MS + 1)).toBe(false);
    expect(refocusOnShow(3, null, 0)).toBe(false);
  });
});

describe("the keeper, rendered", () => {
  it("focus, the old window's blur, a redraw: the same field is focused again", () => {
    let t = 0;
    const focused: string[] = [];
    let api: ReturnType<typeof useFocusKeeper> | null = null;
    let bodyRef: { current: Focusable | null } | null = null;
    function Composer() {
      const keeper = useFocusKeeper(() => t);
      const body = useRef<Focusable | null>({ focus: () => focused.push("body") });
      api = keeper;
      bodyRef = body;
      return null;
    }
    const r = mount(<Composer />);
    const keeper = api!;
    keeper.onShow(); // the dialog's first show: autoFocus owns it
    keeper.bind(bodyRef!).onFocus();
    expect(focused).toEqual([]);
    t = 5000;
    keeper.bind(bodyRef!).onBlur(); // the unfold takes the old window
    t = 5300;
    keeper.onShow(); // the new window
    expect(focused).toEqual(["body"]);
    r.unmount();
  });
});

describe("the keyboard is asked for after the caret", () => {
  it("a redraw asks after it focuses; the first show and a field let go ask nothing", () => {
    let t = 0;
    const order: string[] = [];
    let api: ReturnType<typeof useFocusKeeper> | null = null;
    let bodyRef: { current: Focusable | null } | null = null;
    function Composer() {
      const keeper = useFocusKeeper(() => t, (f) => order.push(f === bodyRef?.current ? "keyboard:body" : "keyboard:?"));
      const body = useRef<Focusable | null>({ focus: () => order.push("focus:body") });
      api = keeper;
      bodyRef = body;
      return null;
    }
    const r = mount(<Composer />);
    const keeper = api!;
    keeper.onShow();
    keeper.bind(bodyRef!).onFocus();
    expect(order, "the first show is autoFocus's").toEqual([]);
    keeper.onShow();
    expect(order).toEqual(["focus:body", "keyboard:body"]);
    t = 9000;
    keeper.bind(bodyRef!).onBlur();
    t = 9000 + REDRAW_BLUR_MS + 1;
    keeper.onShow();
    expect(order, "let go before the redraw: no caret, no keyboard").toEqual(["focus:body", "keyboard:body"]);
    r.unmount();
  });
});

describe("the composer is wired to it", () => {
  const src = readFileSync(join(__dirname, "../src/ui/MessageActions.tsx"), "utf8");
  it("its Modal reports every show, and every field it writes in binds the keeper", () => {
    expect(src).toContain("onRequestClose={requestClose} onShow={focusKeeper.onShow}>");
    for (const f of ["toField", "bodyField"]) {
      expect(src).toContain(`ref={${f}}\n`);
      expect(src).toContain(`{...focusKeeper.bind(${f})}`);
    }
    expect(src).toContain("const subjectFocus = focusKeeper.bind(subjectField);");
    expect(src).toMatch(/ref=\{subjectField\}\s*\{\.\.\.subjectFocus\}\s*onFocus=\{\(\) => \{\s*subjectFocus\.onFocus\(\);/);
  });
});

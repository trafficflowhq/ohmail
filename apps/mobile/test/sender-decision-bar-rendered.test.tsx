/** @vitest-environment jsdom */
/**
 * THE DECISION BAR ON THE iPHONE SE (375 x 667), RENDERED. In the scrolling shape the bar drops
 * its side padding so the capsules' row can run to both edges; the hint lines under it must keep
 * their own inset, or they touch the glass. The row opens scrolled so the AI's suggested capsule
 * is whole on screen: no scroll indicator says that more of the row lies to the right.
 */
import { createElement, useEffect, useImperativeHandle, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const shim = vi.hoisted(() => ({
  window: { width: 375, height: 667 },
  layouts: {} as Record<string, { x: number; width: number }>,
  scrolls: [] as { x?: number; animated?: boolean }[],
}));

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  /* A view reports the layout the test gives its testID, once, as the device's first pass does. */
  const measured = (name: string) =>
    function Host(p: { testID?: string; style?: unknown; children?: ReactNode; onLayout?: (e: unknown) => void; ref?: unknown }) {
      const { onLayout, testID } = p;
      useImperativeHandle(p.ref as never, () => ({ scrollTo: (o: { x?: number; animated?: boolean }) => shim.scrolls.push(o) }));
      useEffect(() => {
        const box = (testID && shim.layouts[testID]) || { x: 0, width: 0 };
        onLayout?.({ nativeEvent: { layout: { x: box.x, y: 0, width: box.width, height: 44 } } });
      }, []);
      const s = Array.isArray(p.style) ? Object.assign({}, ...p.style.filter(Boolean)) : (p.style ?? {});
      return createElement("div", { "data-rn": name, "data-testid": testID, "data-style": JSON.stringify(s) }, p.children);
    };
  return {
    ...rnDom,
    View: measured("View"),
    ScrollView: measured("ScrollView"),
    useWindowDimensions: () => ({ ...shim.window, scale: 2, fontScale: 1 }),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    c: new Proxy({}, { get: () => "#000000" }),
    radius: new Proxy({}, { get: () => 8 }),
    lift: () => ({}),
    liftUp: () => ({}),
    ringed: false,
  }),
}));
vi.mock("../src/theme/lift", () => ({ ringOnLift: () => ({}) }));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const Txt = (p: { style?: unknown; testID?: string; children?: ReactNode }) => createElement(rnDom.Text, { style: p.style, testID: p.testID }, p.children);
  const Tap = (p: { style?: unknown; children?: ReactNode }) => createElement(rnDom.Pressable, { style: p.style }, p.children);
  const Nothing = () => null;
  return { Txt, Tap, Badge: Nothing, Button: Nothing, Panel: Nothing, Screen: Nothing, Scroller: Nothing };
});
vi.mock("../src/ui/Segmented", () => ({ Segmented: () => null }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({ heightClass: shim.window.height < 480 ? "compact" : "regular" }) }));
vi.mock("../src/ui/BodyPages", () => ({ BodyPages: () => null }));
vi.mock("../src/ui/body-note", () => ({ mailboxStatusOf: () => null, withheldNote: () => null }));
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null, PaneTop: () => null }));
vi.mock("../src/ui/MessageReader", () => ({ AttachmentTiles: () => null }));
vi.mock("../src/ui/EventCard", () => ({ EventCards: () => null }));
vi.mock("../src/ui/not-organizing", () => ({ noneOrganizedWhy: () => null }));
vi.mock("../src/state/relay", () => ({ relayMarkFor: () => null, senderSheetLine: () => null }));
vi.mock("../src/state/live", () => ({ decideLinesOf: () => ({}), domainScopeOffered: () => true }));
vi.mock("../src/state/world", () => ({ useBodies: () => ({}), useFilesStamp: () => 0, useWorld: () => ({}) }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));

import { mount, styleOf } from "./_rendered-dom";
import { DecisionBar } from "../src/ui/SenderDetail";
import type { Destination } from "../src/state/model";

const mounted: { unmount(): void }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
  shim.layouts = {};
  shim.scrolls = [];
});

function bar(window: { width: number; height: number }, suggested: Destination | null = null) {
  shim.window = window;
  const m = mount(
    createElement(DecisionBar, {
      scope: "domain",
      domainOffered: true,
      nobody: false,
      also: "Also files 3 other senders at example.org.",
      unsub: "Screen out also unsubscribes you from this list.",
      listClaim: "Screen out files these letters alone.",
      ruleLine: "Files every message from this sender.",
      suggested,
      onScope: () => undefined,
      onDecide: () => undefined,
    }),
  );
  mounted.push(m);
  return m.el;
}

const n = (v: unknown) => (typeof v === "number" ? v : 0);
/** A text line's distance from the bar's edge on one side: every padding and margin up to the bar. */
function inset(line: Element, root: Element, side: "Left" | "Right"): number {
  let sum = 0;
  for (let el: Element | null = line; el !== null && el !== root; el = el.parentElement) {
    const s = styleOf(el);
    sum += n(s[`padding${side}`] ?? s.paddingHorizontal ?? s.padding) + n(s[`margin${side}`] ?? s.marginHorizontal ?? s.margin);
  }
  return sum;
}
/** The bar's own text lines: not the capsules' labels, which ride the row. */
const lines = (el: Element) => [...el.querySelectorAll('[data-rn="Text"]')].filter((t) => t.closest('[data-testid^="decide-capsule-"]') === null);

describe("the hint lines under the decision bar keep a side inset", () => {
  it("at 375 x 667 (the scrolling row) every line stands at least 14 from both edges", () => {
    const el = bar({ width: 375, height: 667 });
    expect(el.querySelector('[data-rn="ScrollView"]'), "the scrolling shape").not.toBeNull();
    const found = lines(el);
    expect(found.map((t) => t.getAttribute("data-testid"))).toEqual(["decide-domain-also", "decide-unsub", "decide-list-claim"]);
    for (const t of found) {
      expect(inset(t, el, "Left"), t.getAttribute("data-testid") ?? "").toBeGreaterThanOrEqual(14);
      expect(inset(t, el, "Right"), t.getAttribute("data-testid") ?? "").toBeGreaterThanOrEqual(14);
    }
  });

  it("at 375 x 812 (the wrap) the lines keep the bar's own 14, not twice it", () => {
    const el = bar({ width: 375, height: 812 });
    expect(el.querySelector('[data-rn="ScrollView"]')).toBeNull();
    const found = lines(el);
    expect(found).toHaveLength(4);
    for (const t of found) {
      expect(inset(t, el, "Left")).toBe(14);
      expect(inset(t, el, "Right")).toBe(14);
    }
  });
});

describe("the scrolling row opens on the AI's suggestion", () => {
  it("a suggested capsule past the row's right edge is scrolled whole into view, once, without animation", () => {
    // Five capsules ~640 wide in a 375 row: Spam at 520..640 in the capsules' strip, 534..654 in the row.
    shim.layouts = { "decide-row": { x: 0, width: 375 }, "decide-capsule-spam": { x: 520, width: 120 } };
    bar({ width: 375, height: 667 }, "spam");
    expect(shim.scrolls).toEqual([{ x: 654 + 14 - 375, animated: false }]);
  });

  it("a suggested capsule already whole on screen leaves the row at its beginning", () => {
    shim.layouts = { "decide-row": { x: 0, width: 375 }, "decide-capsule-ohbox": { x: 0, width: 110 } };
    bar({ width: 375, height: 667 }, "ohbox");
    expect(shim.scrolls).toEqual([]);
  });

  it("without a suggestion the row starts at its beginning", () => {
    shim.layouts = { "decide-row": { x: 0, width: 375 }, "decide-capsule-spam": { x: 520, width: 120 } };
    bar({ width: 375, height: 667 }, null);
    expect(shim.scrolls).toEqual([]);
  });
});

/**
 * A RENDERER FOR THE PHONE'S LAYOUT TESTS: React DOM under jsdom, with React Native's few layout
 * primitives drawn as divs that keep their style. A posture change is a re-render, so a test reads
 * what a device cannot hide from it — whether a component MOUNTED again (its state is gone) and
 * whether a slot's node is the same node. Callers `vi.mock("react-native", () => rnDom)`.
 * React DOM is the webapp's copy of the one React this repository installs (19.2.3, one path).
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { act, createElement, useEffect, useRef, type ReactNode } from "react";

/* Resolved from the webapp's manifest, where React DOM is a dependency; the phone's has none. */
const require = createRequire(join(__dirname, "../../webapp/package.json"));
const client = require("react-dom/client") as {
  createRoot(el: Element): { render(node: ReactNode): void; unmount(): void };
};

type Props = { style?: unknown; children?: ReactNode; testID?: string; [k: string]: unknown };

const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style && typeof style === "object" ? (style as Record<string, unknown>) : {};

/* A test may hold the device's layout pass and run it later (`holdLayout`, `flushLayout`). */
const layout = { held: false, queue: [] as (() => void)[] };
export function holdLayout(): void { layout.held = true; }
export function flushLayout(): void {
  layout.held = false;
  const q = layout.queue.splice(0);
  act(() => { for (const fn of q) fn(); });
}

/* The style a slot was given, readable from the node: React DOM drops what CSS does not know. */
const host = (name: string) =>
  function Host({ style, children, testID, onLayout, onPress, accessibilityRole, accessibilityLabel, accessibilityState, accessibilityElementsHidden }: Props) {
    const s = flat(style);
    /* The device lays a view out after it is mounted; so does this, once. */
    const latest = useRef(onLayout);
    latest.current = onLayout;
    useEffect(() => {
      const fire = () => {
        const fn = latest.current;
        if (typeof fn === "function") fn({ nativeEvent: { layout: { x: 0, y: 0, width: 0, height: 0 } } });
      };
      if (layout.held) layout.queue.push(fire);
      else fire();
    }, []);
    /* What a screen reader is told, and the press, so a test can read and operate a control. */
    const state = accessibilityState as { expanded?: boolean } | undefined;
    return createElement("div", {
      "data-rn": name, "data-testid": testID, "data-style": JSON.stringify(s),
      "data-role": accessibilityRole, "data-label": accessibilityLabel,
      "data-expanded": state && "expanded" in state ? String(state.expanded) : undefined,
      "data-ax-hidden": accessibilityElementsHidden === true ? "" : undefined,
      onClick: typeof onPress === "function" ? () => (onPress as () => void)() : undefined,
    }, children);
  };

export const rnDom = {
  View: host("View"),
  ScrollView: host("ScrollView"),
  Pressable: host("Pressable"),
  Text: host("Text"),
  StyleSheet: { hairlineWidth: 1, absoluteFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }, create: <T,>(s: T) => s },
  Platform: { OS: "android", select: <T,>(o: { android?: T; default?: T }) => o.android ?? o.default },
};

export function styleOf(el: Element | null): Record<string, unknown> {
  return el === null ? {} : (JSON.parse(el.getAttribute("data-style") ?? "{}") as Record<string, unknown>);
}

export function mount(node: ReactNode): { el: HTMLElement; render(node: ReactNode): void; unmount(): void } {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = client.createRoot(el);
  act(() => root.render(node));
  return {
    el,
    render: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      el.remove();
    },
  };
}

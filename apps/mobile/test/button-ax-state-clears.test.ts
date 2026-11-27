/**
 * A control that was disabled once reads ENABLED to a screen reader after it enables. React Native
 * 0.86 on Android sets the native flag only when the state map HAS `disabled`
 * (`BaseViewManager.setViewState`), and JSI drops an undefined key, so a render that hands Pressable
 * no explicit `disabled: false` leaves the view disabled for good: TalkBack read a working Connect
 * as disabled. No RN renderer exists here (`fourth-door.test.ts` says why), so a render is the
 * component called with react-native, the theme and Tap's two hooks shimmed, and the assertion is
 * the state the Pressable element receives, render after render.
 */
import { describe, expect, it, vi } from "vitest";

const shims = vi.hoisted(() => {
  const colour = new Proxy({}, { get: () => "#000000" });
  const number = new Proxy({}, { get: () => 8 });
  const style = new Proxy({}, { get: () => ({}) });
  return { theme: { c: colour, radius: number, type: style, lift: () => null } };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return { ...real, useState: (v: unknown) => [v, () => {}], useCallback: (f: unknown) => f };
});
vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
  Pressable: "Pressable",
  RefreshControl: "RefreshControl",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  StyleSheet: { hairlineWidth: 1 },
  Platform: { OS: "android" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({}) }));
vi.mock("../src/ui/Icon", () => ({ Icon: "Icon" }));
vi.mock("../src/theme", () => ({ useTheme: () => shims.theme }));

import type { PressableProps } from "react-native";
import { Button, Tap } from "../src/ui/base";
import { GlassIconButton } from "../src/ui/glass/GlassIconButton";

type El = { type: unknown; props: Record<string, unknown> };

/** One render of a control: its element must be Tap, and Tap's element is what Pressable gets. */
function pressableOf(rendered: unknown): El {
  const el = rendered as El;
  expect(el.type, "the control is not built on Tap, the one Pressable").toBe(Tap);
  const out = Tap(el.props as PressableProps) as unknown as El;
  expect(out.type).toBe("Pressable");
  return out;
}

describe("a control's accessibility state clears when the control enables", () => {
  it("Button disabled, then enabled: the re-render hands Pressable disabled:false", () => {
    const onPress = () => {};
    const first = pressableOf(Button({ label: "Connect", onPress, disabled: true }));
    expect(first.props.accessibilityState).toStrictEqual({ disabled: true });
    expect(first.props.onPress).toBeUndefined();
    for (const disabled of [false, undefined]) {
      const next = pressableOf(Button({ label: "Connect", onPress, disabled }));
      expect(next.props.accessibilityState, `re-render with disabled=${String(disabled)}`)
        .toStrictEqual({ disabled: false });
      expect(next.props.onPress).toBe(onPress);
    }
  });

  it("GlassIconButton: a tab says selected true and false, a plain button still names its state", () => {
    const tab = (on: boolean) => pressableOf(GlassIconButton({ glyph: "x", label: "Inbox", role: "tab", on }));
    expect(tab(true).props.accessibilityState).toStrictEqual({ selected: true, disabled: false });
    expect(tab(false).props.accessibilityState).toStrictEqual({ selected: false, disabled: false });
    const plain = pressableOf(GlassIconButton({ glyph: "x", label: "More", on: true }));
    expect(plain.props.accessibilityState).toStrictEqual({ selected: false, disabled: false });
  });
});

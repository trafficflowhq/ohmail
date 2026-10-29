/** @vitest-environment jsdom */
/**
 * A SHEET ROW THAT IS ON SAYS SO, rendered. The Tag sheet listed a tag the message already carried as
 * a plain row: no mark a person saw, and a screen reader heard "Button rota", not checked. A tap
 * then removed the tag the person was trying to add. The mark stands beside the name, and the row
 * is a checkbox whose state is read out.
 */
import { createElement as h, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  KeyboardAvoidingView: () => null,
  Modal: () => null,
  useWindowDimensions: () => ({ width: 360, height: 780, scale: 3, fontScale: 1 }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("../src/theme", () => ({ useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }) }) }));
vi.mock("../src/ui/keyboard-lift", () => ({ useKeyboardLift: () => 0 }));
vi.mock("../src/ui/reader-cover", () => ({ useReaderCover: () => undefined }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => null, separatingVerticalHinge: () => null }));
vi.mock("../src/ui/scaffold/plan", () => ({ detailPaneRect: () => null, scaffoldPlan: () => null }));
vi.mock("../src/ui/sheet-bounds", () => ({ sheetPanelBounds: () => ({}), sheetRoom: () => ({}) }));
vi.mock("../src/ui/Icon", () => ({ Icon: (p: { name: string }) => h("i", { "data-icon": p.name }) }));
vi.mock("../src/ui/base", () => ({
  Tap: (p: { children?: ReactNode; accessibilityRole?: string; accessibilityState?: { checked?: boolean }; onPress?: () => void }) =>
    h("div", {
      "data-role": p.accessibilityRole,
      "data-checked": p.accessibilityState?.checked === undefined ? undefined : String(p.accessibilityState.checked),
      onClick: p.onPress,
    }, p.children),
  Txt: (p: { children?: ReactNode }) => h("span", { "data-txt": "" }, p.children),
}));

const { mount } = await import("./_rendered-dom");
const { SheetRow } = await import("../src/ui/Sheet");

/** The row's parts in order: the check is `✓`, another icon `[name]`, a name its text. */
const parts = (el: HTMLElement) => [...el.querySelectorAll("[data-icon], [data-txt]")].map((n) => {
  const icon = n.getAttribute("data-icon");
  return icon === null ? n.textContent : icon === "check" ? "✓" : `[${icon}]`;
});

describe("a row that can be on", () => {
  it("on: marked before its name, and read out as a checked checkbox", () => {
    const { el, unmount } = mount(h(SheetRow, { label: "rota", on: true, onPress: () => undefined }));
    expect(parts(el)).toEqual(["✓", "rota"]);
    const row = el.querySelector("[data-role]");
    expect([row?.getAttribute("data-role"), row?.getAttribute("data-checked")]).toEqual(["checkbox", "true"]);
    unmount();
  });

  it("off: the same place holds no mark, and the state is read out as not checked", () => {
    const { el, unmount } = mount(h(SheetRow, { label: "rota", on: false, onPress: () => undefined }));
    expect(parts(el)).toEqual(["rota"]);
    const row = el.querySelector("[data-role]");
    expect([row?.getAttribute("data-role"), row?.getAttribute("data-checked")]).toEqual(["checkbox", "false"]);
    unmount();
  });

  it("a row with its own icon keeps the icon first and the check after the name", () => {
    const { el, unmount } = mount(h(SheetRow, { label: "Reply later", icon: "clock" as never, on: true, onPress: () => undefined }));
    expect(parts(el)).toEqual(["[clock]", "Reply later", "✓"]);
    expect(el.querySelector("[data-role]")?.getAttribute("data-checked")).toBe("true");
    unmount();
  });

  it("CONTROL: a verb row stays a button with no state", () => {
    const { el, unmount } = mount(h(SheetRow, { label: "Archive", icon: "archive" as never, onPress: () => undefined }));
    const row = el.querySelector("[data-role]");
    expect([row?.getAttribute("data-role"), row?.getAttribute("data-checked")]).toEqual(["button", null]);
    unmount();
  });
});

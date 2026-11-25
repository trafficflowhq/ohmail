/** @vitest-environment jsdom */
import { act, createElement as h, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { mount, styleOf } from "./_rendered-dom";

const history = vi.hoisted(() => ({ jump: vi.fn(), scrollTo: vi.fn(), ready: true, years: 2, shifted: 0, undated: false }));
let list: React.ComponentProps<typeof import("../src/ui/MailList").MailList<number>>;
vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("../src/theme", () => ({
  useTheme: () => ({ mail: true, c: new Proxy({}, { get: () => "#334455" }), radius: { pill: 999 } }),
}));
vi.mock("../src/theme/mail", async (useOriginal) => ({
  ...await useOriginal<typeof import("../src/theme/mail")>(),
  MailAppearance: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../src/net/network-door", () => ({ useNetworkNow: () => "online" }));
vi.mock("../src/state/live", () => ({}));
vi.mock("../src/state/pull", () => ({ usePullToSync: () => undefined }));
vi.mock("../src/state/world", () => ({ useWorld: () => ({ boot: { settled: true } }) }));
vi.mock("../src/state/store-views", () => ({
  useStoreHistory: () => ({
    state: "ready", length: 5 * history.years + history.shifted, total: 5 * history.years + history.shifted,
    years: Array.from({ length: history.years }, (_, index) => ({
      year: history.undated && index === history.years - 1 ? null : String(2026 - index),
      start: index === 0 ? 0 : 5 * index + history.shifted,
    })),
    rowAt: () => null, shifted: history.shifted, want: () => undefined, jump: history.jump,
  }),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Screen: rnDom.View, Empty: () => null, Txt: rnDom.Text, Tap: rnDom.Pressable, ViewHead: () => null, Tail: () => null,
    useListInsets: () => ({ paddingBottom: 34 }),
  };
});
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null, PaneTop: () => null }));
vi.mock("../src/ui/list-detail", () => ({
  ListDetail: ({ list }: { list: ReactNode }) => list,
  useListDetail: () => ({ open: null, openRow: vi.fn(), close: vi.fn() }),
}));
vi.mock("../src/ui/MailList", () => ({ MailList: (props: typeof list) => {
  list = props;
  if (list.scrollTo && history.ready) list.scrollTo.current = history.scrollTo;
  return null;
} }));
vi.mock("../src/ui/Gated", () => ({ Gated: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/MessageReader", () => ({ MessageReader: () => null }));
vi.mock("../src/ui/MailRow", () => ({ MailRow: () => null }));
vi.mock("../src/ui/Skeleton", () => ({ SkeletonList: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));

import HistoryScreen from "../app/history";
import { Copy } from "../src/copy";

it("marks the visible year and moves the mark when a different year is pressed", () => {
  const view = mount(h(HistoryScreen));
  try {
    const year = (value: string) => view.el.querySelector<HTMLElement>(`[data-label="${value}"]`)!;
    expect(year("2026").getAttribute("data-selected")).toBe("true");
    expect(year("2025").getAttribute("data-selected")).toBe("false");
    act(() => year("2025").click());
    expect(history.jump).toHaveBeenCalledWith(5);
    expect(year("2025").getAttribute("data-selected")).toBe("true");
    expect(year("2026").getAttribute("data-selected")).toBe("false");
  } finally {
    view.unmount();
  }
});

it("waits for the list scroll handle before fetching a pressed year", () => {
  history.ready = false;
  history.jump.mockClear();
  const view = mount(h(HistoryScreen));
  try {
    const year = view.el.querySelector<HTMLElement>('[data-label="2025"]')!;
    act(() => year.click());
    expect(history.jump).not.toHaveBeenCalled();
    expect(year.getAttribute("data-selected")).toBe("false");
  } finally {
    view.unmount();
    history.ready = true;
  }
});

it("keeps the pressed year selected through a clamped scroll until the reader drags", () => {
  const view = mount(h(HistoryScreen));
  try {
    const newest = view.el.querySelector('[data-label="2026"]')!;
    const oldest = view.el.querySelector<HTMLElement>('[data-label="2025"]')!;
    const scroll = {
      nativeEvent: { contentOffset: { x: 0, y: 0 }, layoutMeasurement: { width: 390, height: 844 } },
    } as Parameters<NonNullable<typeof list.onScroll>>[0];
    act(() => oldest.click());
    act(() => list.onScroll?.(scroll));
    expect(oldest.getAttribute("data-selected")).toBe("true");
    act(() => {
      list.onScrollBeginDrag?.(scroll);
      list.onScroll?.(scroll);
    });
    expect(newest.getAttribute("data-selected")).toBe("true");
  } finally {
    view.unmount();
  }
});

it("lets the reader reach the oldest of ten years when the phone is turned sideways", () => {
  history.years = 10;
  const view = mount(h("div", { style: { width: 844, height: 390 } }, h(HistoryScreen)));
  try {
    const rail = view.el.querySelector('[data-role="menu"]')!;
    expect(styleOf(rail)).toMatchObject({ top: 8, bottom: 42 });
    const oldest = rail.querySelector<HTMLElement>('[data-rn="ScrollView"] [data-label="2017"]')!;
    history.scrollTo.mockClear();
    act(() => oldest.click());
    expect(history.scrollTo).toHaveBeenCalledTimes(1);
    expect(oldest.getAttribute("data-selected")).toBe("true");
  } finally {
    view.unmount();
    history.years = 2;
  }
});

it.each([false, true])("keeps the pressed group selected when newer mail arrives (undated: %s)", (undated) => {
  history.undated = undated;
  const view = mount(h(HistoryScreen));
  try {
    const label = undated ? Copy.historyUndated : "2025";
    const group = view.el.querySelector<HTMLElement>(`[data-label="${label}"]`)!;
    const scroll = {
      nativeEvent: { contentOffset: { x: 0, y: 80 }, layoutMeasurement: { width: 390, height: 844 } },
    } as Parameters<NonNullable<typeof list.onScroll>>[0];
    act(() => group.click());
    act(() => list.onScroll?.(scroll));
    expect(group.getAttribute("data-selected")).toBe("true");

    history.scrollTo.mockClear();
    history.shifted = 1;
    view.render(h(HistoryScreen));
    expect(history.scrollTo).toHaveBeenCalledTimes(1);
    act(() => list.onScroll?.(scroll));
    expect(group.getAttribute("data-selected")).toBe("true");
    act(() => list.onScrollBeginDrag?.(scroll));
    expect(view.el.querySelector('[data-label="2026"]')?.getAttribute("data-selected")).toBe("true");
  } finally {
    view.unmount();
    history.shifted = 0;
    history.undated = false;
  }
});

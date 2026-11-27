/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount, styleOf } from "./_rendered-dom";

const fixture = vi.hoisted(() => ({
  width: 360,
  pathname: "/history",
  scheme: "light" as "light" | "dark",
  push: vi.fn(),
  dismissTo: vi.fn(),
  pull: vi.fn(),
  setTheme: vi.fn(),
}));
vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  useWindowDimensions: () => ({ width: fixture.width, height: 800, fontScale: 1 }),
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-router", () => ({
  router: { push: fixture.push, dismissTo: fixture.dismissTo },
  usePathname: () => fixture.pathname,
  useLocalSearchParams: () => ({}),
}));
vi.mock("../src/state/world", () => ({
  useWorld: () => ({
    ohbox: { unread: 3 }, reads: { newCount: 5 }, receipts: { newCount: 2 },
    screener: { waiting: [{}] }, piles: [{ kind: "setAside", items: [] }],
    tags: [{ id: "project", name: "Project", hue: "moss" }], tagged: { count: () => 4 },
    folders: { enabled: false }, boot: { settled: true }, drafts: [{}], scheduled: [],
    trash: { available: true }, account: { name: "Example", email: "" },
    mailboxes: { known: true, rows: [{ displayName: "Example" }, {}] },
  }),
}));
vi.mock("../src/state/pull", () => ({ usePullToSync: () => ({ refreshing: false, onRefresh: fixture.pull }) }));
vi.mock("../src/state/store", () => ({ usePrefs: () => ({ setTheme: fixture.setTheme }) }));
vi.mock("../src/ui/MailCalendarSwitch", () => ({ MailCalendarSwitch: () => null }));
vi.mock("../src/ui/FoldersGroup", () => ({ FoldersGroup: () => null }));
vi.mock("../src/ui/keyboard-room", () => ({ KeyboardRoom: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/posture", async () => ({
  ...(await import("../src/ui/posture/derive")),
  usePosture: () => ({ fold: "none", hinge: null, split: "full", panes: 1, sizeClass: "compact", heightClass: "regular" }),
}));
vi.mock("../src/theme", async () => {
  const { space, radius, zLayer } = await import("../src/theme/tokens");
  const { type } = await import("../src/theme/type");
  return {
    useTheme: () => ({
      mail: true, scheme: fixture.scheme, c: { tag: { moss: { ink: "currentColor" } } },
      space, radius, zLayer, type, lift: () => ({}), ms: () => 0,
    }),
  };
});
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Button: (props: Record<string, unknown>) => rnDom.Pressable({ ...props, accessibilityLabel: props.label }),
    Rule: () => <hr />,
    Scroller: rnDom.ScrollView,
    Section: rnDom.Text,
    TagDot: rnDom.View,
    Tap: rnDom.Pressable,
    TapRow: rnDom.Pressable,
    Txt: rnDom.Text,
  };
});
vi.mock("../src/ui/Icon", () => ({ Icon: () => null, NavigationIcon: () => null }));
vi.mock("../src/ui/glass/GlassSidebar", () => ({
  GlassSidebar: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../src/ui/Sheet", () => ({ Sheet: () => null, SheetRow: () => null }));
vi.mock("expo-blur", () => ({ BlurView: () => null }));

const { MailPlaceDock } = await import("../src/ui/MailPlaceDock");
const { MailPlacesDrawer } = await import("../src/ui/MailPlacesDrawer");
const { setActiveLocale } = await import("../src/i18n/locale");

function control(root: Element, label: string) {
  return root.querySelector<HTMLElement>(`[data-label="${label}"]`);
}

describe("compact mail navigation", () => {
  it.each([360, 390, 412])("keeps the web tab order at %i points and marks History under More", (width) => {
    fixture.width = width;
    fixture.pathname = "/history";
    const r = mount(<MailPlaceDock><div>List</div></MailPlaceDock>);
    try {
      const tabs = [...r.el.querySelectorAll('[data-role="tab"]')];
      expect(tabs.map((tab) => tab.getAttribute("data-label"))).toEqual([
        "Ohbox, 3", "Screener, 1", "News, 5", ...(width === 412 ? ["Receipts, 2"] : []), "More",
      ]);
      expect(control(r.el, "More")?.getAttribute("data-selected")).toBe("true");
      act(() => control(r.el, "News, 5")?.click());
      expect(fixture.dismissTo).toHaveBeenLastCalledWith("/reads");
    } finally { r.unmount(); }
  });

  it("marks Search itself and keeps Search and Write usable beside the tabs", () => {
    fixture.pathname = "/search";
    const focus = vi.fn();
    const r = mount(<MailPlaceDock onSearch={focus}><div>Search field</div></MailPlaceDock>);
    try {
      expect(control(r.el, "More")?.getAttribute("data-selected")).toBe("false");
      expect(control(r.el, "Search")?.getAttribute("data-selected")).toBe("true");
      act(() => control(r.el, "Search")?.click());
      expect(focus).toHaveBeenCalledOnce();
      act(() => control(r.el, "Write")?.click());
      expect(fixture.push).toHaveBeenLastCalledWith("/compose");
    } finally { r.unmount(); }
  });

  it("opens the same drawer destinations with counts, a working pull, and the account footer", () => {
    const close = vi.fn();
    const r = mount(<MailPlacesDrawer open active="history" onClose={close} onPlace={vi.fn()} onCompose={vi.fn()} />);
    try {
      const rows = [...r.el.querySelectorAll('[data-role="link"]')];
      expect(rows.map((row) => row.getAttribute("data-label"))).toEqual([
        "Ohbox, 3", "News, 5", "Receipts, 2", "Screener, 1", "Answer Later", "Parked", "Resurface",
        "Project, 4", "History", "Search", "Drafts, 1", "Trash", "Settings",
      ]);
      expect(control(r.el, "Tags")?.getAttribute("data-expanded")).toBe("false");
      act(() => control(r.el, "Tags")?.click());
      expect(control(r.el, "Tags")?.getAttribute("data-expanded")).toBe("true");
      expect(control(r.el, "History")?.getAttribute("data-selected")).toBe("true");
      act(() => control(r.el, "Search")?.click());
      expect(fixture.push).toHaveBeenLastCalledWith("/search");
      expect(close).toHaveBeenCalledOnce();
      act(() => control(r.el, "Pull new mail")?.click());
      expect(fixture.pull).toHaveBeenCalledOnce();
      expect(r.el.textContent).toContain("2 mailboxes");
      act(() => control(r.el, "Example, 2 mailboxes")?.click());
      expect(fixture.push).toHaveBeenLastCalledWith({ pathname: "/settings", params: { pane: "mailboxes" } });
      act(() => control(r.el, "Dark")?.click());
      expect(fixture.setTheme).toHaveBeenLastCalledWith("dark");
    } finally { r.unmount(); }
  });

  it("uses the German drawer labels and offers Light from Dark", () => {
    fixture.scheme = "dark";
    setActiveLocale("de");
    const r = mount(<MailPlacesDrawer open active="history" onClose={vi.fn()} onPlace={vi.fn()} onCompose={vi.fn()} />);
    try {
      expect(control(r.el, "Historie")?.getAttribute("data-selected")).toBe("true");
      expect(control(r.el, "Neue Mails abrufen")).not.toBeNull();
      expect(r.el.textContent).toContain("2 Postfächer");
      act(() => control(r.el, "Hell")?.click());
      expect(fixture.setTheme).toHaveBeenLastCalledWith("light");
    } finally {
      r.unmount();
      fixture.scheme = "light";
      setActiveLocale("en");
    }
  });

  it("keeps Write tinted above the scrolling destinations and reachable footer", () => {
    const r = mount(<MailPlacesDrawer open active="index" onClose={vi.fn()} onPlace={vi.fn()} onCompose={vi.fn()} />);
    try {
      const places = r.el.querySelector('[data-rn="ScrollView"]');
      expect(places?.contains(control(r.el, "Settings"))).toBe(true);
      expect(places?.contains(control(r.el, "Pull new mail"))).toBe(true);
      expect(places?.contains(control(r.el, "Write"))).toBe(false);
      expect(styleOf(control(r.el, "Write")).backgroundColor).toBe("#F0EBE3");
    } finally { r.unmount(); }
  });
});

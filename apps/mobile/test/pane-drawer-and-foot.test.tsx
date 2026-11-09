/** @vitest-environment jsdom */
/**
 * THE iPAD'S LIST PANE, rendered: the drawer keeps Settings and the pairing door pinned at its foot,
 * outside the rows that scroll (on the mini in landscape they sat below the fold), and the list ends
 * in a fade above the Search and New mail pills instead of a flat cut, its last row clear of it.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePosture } from "../src/ui/posture/derive";
import { mount } from "./_rendered-dom";

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  Platform: { OS: "ios", select: <T,>(o: { ios?: T; default?: T }) => o.ios ?? o.default },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
}));
const live = vi.hoisted(() => ({ posture: null as unknown, win: { width: 0, height: 0 } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock("expo-router", () => ({
  router: { push: () => undefined, navigate: () => undefined, setParams: () => undefined },
  useLocalSearchParams: () => ({}),
  usePathname: () => "/",
  useIsFocused: () => true,
}));
vi.mock("../src/copy", () => ({
  Copy: new Proxy({}, { get: (_t, k) => (String(k).startsWith("ariaLabel") ? (label: string) => label : String(k)) }),
}));
vi.mock("../src/theme", async () => {
  const tokens = await import("../src/theme/tokens");
  return {
    useTheme: () => ({ c: { hairSoft: "#ccc", tint: "#eee", ink3: "#666", canvas: "#fff", tag: {} }, radius: { pill: 99 }, zLayer: { tabBar: 5 }, space: tokens.space }),
  };
});
vi.mock("../src/state/world", () => ({
  useWorld: () => ({
    account: { name: "", email: "" }, ohbox: { unread: 0 }, screener: { waiting: [] }, reads: { newCount: 0 }, receipts: { newCount: 0 },
    piles: [], tags: [], folders: { enabled: false }, boot: { settled: true }, drafts: [], scheduled: [], trash: { available: false },
  }),
}));
vi.mock("../src/engine/ui-marks", () => ({ beginMark: () => undefined }));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const actual = await vi.importActual<typeof import("../src/ui/base")>("../src/ui/base");
  type P = { children?: unknown; style?: unknown; accessibilityLabel?: string };
  return {
    useListInsets: actual.useListInsets,
    Screen: ({ children, style }: P) => rnDom.View({ style, children: children as never, testID: "screen" }),
    Empty: () => null, Section: () => null, TagDot: () => null, Txt: () => null,
    Rule: () => rnDom.View({ testID: "rule" }),
    Tap: ({ children, accessibilityLabel }: P) => rnDom.View({ accessibilityLabel, children: children as never }),
    TapRow: ({ accessibilityLabel }: P) => rnDom.View({ accessibilityLabel, testID: "row" }),
  };
});
vi.mock("../src/ui/FadeOut", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return { FadeOut: (p: { edge?: string; height?: number }) => rnDom.View({ testID: `fade-${p.edge ?? "bottom"}`, style: { height: p.height } }) };
});
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: unknown }) => children }));
vi.mock("../src/ui/glass", () => ({
  GlassRail: () => null,
  GlassSidebar: ({ open, children }: { open: boolean; children: unknown }) => (open ? <div data-testid="sidebar">{children as never}</div> : null),
}));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/FoldersGroup", () => ({ FoldersGroup: () => null }));
vi.mock("../src/ui/reader-rail", () => ({ useReaderRail: () => null }));
vi.mock("../src/ui/posture", async () => ({
  ...(await import("../src/ui/posture/derive")),
  usePosture: () => live.posture,
  useAppWindow: () => live.win,
  useStatusCluster: () => null,
}));

const { ListDetail } = await import("../src/ui/list-detail");
const { usePaneChrome } = await import("../src/ui/pane-chrome");
const { useListInsets } = await import("../src/ui/base");

/* The iPad mini in landscape: 1133 x 744, two panes, the bars. */
function setMini() {
  live.posture = derivePosture({ platform: "ios", width: 1133, height: 744, folds: null, hasFold: false, isPad: true });
  live.win = { width: 1133, height: 744 };
}

let open: { unmount(): void } | null = null;
afterEach(() => { open?.unmount(); open = null; });

describe("the drawer pins Settings and the pairing door at its foot", () => {
  it("both stand once, outside the scrolling rows; the places above them scroll", () => {
    setMini();
    let chrome: ReturnType<typeof usePaneChrome> = null;
    function Toggle() { chrome = usePaneChrome(); return null; }
    const r = mount(<ListDetail open={null} onClose={() => undefined} toRoute={(id) => `/message/${id}`}
      list={<Toggle />} renderDetail={() => null} />);
    open = r;
    act(() => chrome!.openDrawer());
    const drawer = r.el.querySelector('[data-testid="sidebar"]')!;
    const rows = drawer.querySelector('[data-rn="ScrollView"]')!;
    for (const label of ["settings", "serversRow"]) {
      const found = drawer.querySelectorAll(`[data-label="${label}"]`);
      expect(found.length, label).toBe(1);
      expect(rows.contains(found[0]!), `${label} scrolled away`).toBe(false);
    }
    expect(rows.querySelector('[data-label="history"]'), "the places still scroll").not.toBeNull();
    expect(rows.querySelector('[data-label="search"]')).not.toBeNull();
  });
});

describe("the list pane ends in a fade above its foot", () => {
  it("a fade at the list's bottom edge, before the Search pill; the last row rests above it", () => {
    setMini();
    let foot = -1;
    function List() { foot = useListInsets(true).paddingBottom; return <div data-testid="list" />; }
    const r = mount(<ListDetail open={null} onClose={() => undefined} toRoute={(id) => `/message/${id}`}
      list={<List />} renderDetail={() => null} />);
    open = r;
    const list = r.el.querySelector('[data-testid="list"]')!;
    const fade = r.el.querySelector('[data-testid="fade-bottom"]')!;
    expect(fade, "the list is cut flat").not.toBeNull();
    expect(fade.parentElement!.contains(list), "the fade sits over the list's own box").toBe(true);
    const search = r.el.querySelector('[data-label="search"]')!;
    expect(fade.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING, "the pill comes after it").toBeTruthy();
    expect(foot, "the last row clears the fade").toBeGreaterThanOrEqual(12);
  });
});

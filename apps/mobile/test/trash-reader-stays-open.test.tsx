/** @vitest-environment jsdom */
/**
 * THE LETTER OPEN IN TRASH STAYS OPEN, two panes. A letter is deleted from the Ohbox reader, Trash opens
 * over the tabs at once, another Trash row is chosen; then the delete commits (the Ohbox reader leaves its
 * own pane) and its letter lists late at the top of Trash. Neither may take the Trash reader. Rendered with
 * the real list-detail pair and Trash screen; the router stand-in keeps one param set per route, as
 * expo-router does: `router.setParams` writes the route in front, a screen's navigation writes its own.
 */
import { act, createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorldTrashRow } from "../src/state/live";

const nav = vi.hoisted(() => ({
  routes: {} as Record<string, { open?: string }>,
  front: "",
  stack: [] as string[],
  hearers: new Set<() => void>(),
}));
const tell = () => { for (const h of [...nav.hearers]) h(); };
vi.mock("expo-router", async () => {
  const { createContext: cc, useContext: uc, useSyncExternalStore: uses } = await import("react");
  const RouteKey = cc("");
  const useNav = () => uses((h) => { nav.hearers.add(h); return () => { nav.hearers.delete(h); }; }, () => nav.routes);
  const write = (key: string, p: { open?: string }) => { nav.routes = { ...nav.routes, [key]: { ...nav.routes[key], ...p } }; tell(); };
  return {
    RouteKey,
    router: {
      push: () => undefined,
      setParams: (p: { open?: string }) => write(nav.front, p),
      // A global back pops the screen in front, whichever screen calls it.
      back: () => { nav.stack = nav.stack.slice(0, -1); nav.front = nav.stack.at(-1) ?? ""; tell(); },
    },
    useLocalSearchParams: () => useNav()[uc(RouteKey)] ?? {},
    useNavigation: () => {
      const key = uc(RouteKey);
      return { setParams: (p: { open?: string }) => write(key, p), isFocused: () => key === nav.front };
    },
    useIsFocused: () => { useNav(); return uc(RouteKey) === nav.front; },
    usePathname: () => "/trash",
  };
});
vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) }));
vi.mock("../src/ui/base", () => {
  const box = (p: { children?: ReactNode }) => createElement("div", null, p.children);
  return {
    Screen: box, Scroller: box, TapRow: box, Tail: box, Panel: box, Rule: () => null, Tap: () => null,
    Button: (p: { label: string; onPress: () => void }) => createElement("button", { onClick: p.onPress }, p.label),
    Empty: (p: { title: string }) => createElement("span", { "data-empty": "" }, p.title),
    Txt: (p: { children?: ReactNode }) => createElement("span", null, p.children),
  };
});
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: { hairSoft: "#ccc", tint: "#eee", ink3: "#666", canvas: "#fff" }, radius: { pill: 99 }, zLayer: { tabBar: 5 } }),
}));
vi.mock("../src/engine/ui-marks", () => ({ beginMark: () => undefined }));
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null }));
vi.mock("../src/ui/Gated", () => ({ Gated: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/Skeleton", () => ({ SkeletonList: () => null }));
vi.mock("../src/ui/glass", () => ({ GlassRail: () => null, GlassSidebar: () => null }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/MoreNav", () => ({ MoreNav: () => null, Nav: () => null }));
vi.mock("../src/ui/reader-rail", () => ({ useReaderRail: () => null }));
vi.mock("../src/ui/MailRow", () => ({
  MailRow: (p: { m: { id: string }; onPress: () => void }) => createElement("button", { "data-row": p.m.id, onClick: p.onPress }),
}));
vi.mock("../src/ui/MailList", () => ({
  MailList: (p: { groups: { rows: WorldTrashRow[] }[]; renderRow: (r: WorldTrashRow) => ReactNode }) =>
    createElement("div", null, p.groups.flatMap((g) => g.rows).map((r) => createElement("div", { key: r.mail.id }, p.renderRow(r)))),
}));
/* The tester's posture: the 7.6in foldable open in landscape, two panes; a test may turn it into a phone. */
const win = { width: 897, height: 718, hasFold: true };
vi.mock("../src/ui/posture", async () => {
  const d = await import("../src/ui/posture/derive");
  const usePosture = () => d.derivePosture({ width: win.width, height: win.height, folds: [], platform: "android", hasFold: win.hasFold });
  return { ...d, usePosture, useAppWindow: () => win, useStatusCluster: () => null };
});
/* The pushed reader; its delete commit calls `onClose` (MessageActions' onDeleted). */
const reader = { commit: () => undefined as void };
vi.mock("../src/ui/MessageReader", () => ({
  MessageReader: (p: { id: string; onClose: () => void }) => { reader.commit = p.onClose; return createElement("i", { "data-message-reader": p.id }); },
}));

const row = (id: string): WorldTrashRow => ({
  mail: { id, place: "ohbox", from: { name: "Ann", address: "" }, subject: `subject ${id}`, time: "", body: "", snippet: "", unread: false, earlier: [] },
  deletedWhen: null,
  restoreLabel: "Ohbox",
} as unknown as WorldTrashRow);
const pages: { items: WorldTrashRow[] }[] = [];
const world = {
  message: (id: string) => ({ id, place: "ohbox", earlier: [] }),
  trash: { available: true },
  account: { name: "", email: "" }, ohbox: { unread: 0 }, screener: { waiting: [] }, reads: { newCount: 0 }, receipts: { newCount: 0 },
  actions: {
    trashList: vi.fn(async (_cursor: string | null) => ({ state: "ready" as const, items: pages.shift()?.items ?? [], nextCursor: null })),
    trashRestore: vi.fn(async (_id: string) => true),
  },
};
vi.mock("../src/state/world", () => ({ useWorld: () => world, useBodyStamp: () => 0 }));

const { mount } = await import("./_rendered-dom");
const { RouteKey } = (await import("expo-router")) as unknown as { RouteKey: import("react").Context<string> };
const { noteTrashLanded } = await import("../src/state/trash-hold");
const { ListDetail, useListDetail } = await import("../src/ui/list-detail");
const { default: TrashScreen } = await import("../app/trash/index");
const { default: MessageScreen } = await import("../app/message/[id]");

/* The Ohbox pair behind Trash: its reader's delete commit calls the pane's close (MessageActions' onDeleted). */
const ohbox = { close: () => undefined as void };
function OhboxPair() {
  const { open, close } = useListDetail((id) => `/message/${id}`);
  ohbox.close = close;
  return <ListDetail open={open} onClose={close} toRoute={(id) => `/message/${id}`} list={<div />} renderDetail={(id) => <i data-ohbox-reader={id} />} />;
}
const Route = ({ k, children }: { k: string; children: ReactNode }) => <RouteKey.Provider value={k}>{children}</RouteKey.Provider>;

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const listed = (el: Element) => [...el.querySelectorAll("[data-row]")].map((n) => n.getAttribute("data-row"));

afterEach(() => { pages.length = 0; nav.routes = {}; nav.front = ""; nav.stack = []; Object.assign(win, { width: 897, height: 718, hasFold: true }); vi.clearAllMocks(); });

describe("two panes: a letter chosen in Trash stays open", () => {
  it("through the Ohbox delete's commit and its late listing on top", async () => {
    pages.push({ items: [row("older-1"), row("older-2")] }, { items: [row("just-deleted"), row("older-1"), row("older-2")] });
    nav.routes = { ohbox: { open: "just-deleted" }, trash: {} };
    nav.front = "ohbox";
    const s = mount(<><Route k="ohbox"><OhboxPair /></Route><Route k="trash"><TrashScreen /></Route></>);
    // Delete pressed in the Ohbox reader; Trash opens over the tabs at once, before the window closes.
    await act(async () => { nav.front = "trash"; nav.routes = { ...nav.routes }; tell(); });
    await settle();
    const trash = s.el.children[1]!;
    expect(listed(trash)).toEqual(["older-1", "older-2"]);
    await act(async () => { trash.querySelector<HTMLElement>('[data-row="older-2"]')!.click(); });
    expect(trash.textContent).toContain("subject older-2");
    // The window closes: the Ohbox reader leaves its own pane, then the delete lands and lists late.
    await act(async () => { ohbox.close(); });
    await act(async () => { noteTrashLanded(); });
    await settle();
    expect(listed(trash)).toEqual(["just-deleted", "older-1", "older-2"]);
    expect(nav.routes.trash!.open).toBe("older-2");
    expect(trash.textContent).toContain("subject older-2");
    expect(trash.querySelector("[data-empty]")).toBeNull();
    // The Ohbox pane behind is closed, so its return shows no deleted letter.
    expect(nav.routes.ohbox!.open).toBe("");
    expect(s.el.querySelector("[data-ohbox-reader]")).toBeNull();
    s.unmount();
  });
});

describe("one pane: a letter pushed from Trash stays open", () => {
  it("when the pushed reader behind it commits its delete", async () => {
    // A phone in landscape: one pane, the nav rail stays over a pushed reader.
    Object.assign(win, { width: 915, height: 412, hasFold: false });
    nav.routes = { "message/X": { id: "X" } as { open?: string }, "trash/T": {} };
    nav.stack = ["message/X"];
    nav.front = "message/X";
    const s = mount(<><Route k="message/X"><MessageScreen /></Route><Route k="trash/T"><i data-trash-reader="T" /></Route></>);
    expect(s.el.querySelector("[data-message-reader]")?.getAttribute("data-message-reader")).toBe("X");
    // Delete pressed; within the window the rail's More > Trash > a row pushes /trash and /trash/T above it.
    await act(async () => { nav.stack = ["message/X", "more", "trash", "trash/T"]; nav.front = "trash/T"; tell(); });
    await act(async () => { reader.commit(); });
    expect(nav.stack.at(-1)).toBe("trash/T");
    // In front, the same commit still leaves the reader.
    await act(async () => { nav.stack = ["message/X"]; nav.front = "message/X"; tell(); });
    await act(async () => { reader.commit(); });
    expect(nav.stack).toEqual([]);
    s.unmount();
  });
});

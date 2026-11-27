/** @vitest-environment jsdom */
import { act, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount, styleOf } from "./_rendered-dom";

const device = vi.hoisted(() => ({
  width: 390,
  keyboardHeight: 0,
  pull: vi.fn(),
  account: "first",
  renewal: null as { onRenewed: (listener: () => void) => () => void } | null,
  hinge: null as { x: number; y: number; w: number; h: number } | null,
  engine: null as {
    searchPlaces: () => Promise<readonly { folder: string; count: number }[] | null>;
    read: () => { stampOf: () => number; list: () => readonly { folder: string }[] };
  } | null,
}));

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    ...rnDom,
    useWindowDimensions: () => ({ width: device.width, height: 844, scale: 3 }),
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    KeyboardAvoidingView: rnDom.View,
    Modal: ({ children }: { children: ReactNode }) => <main>{children}</main>,
    TextInput: rnDom.View,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ left: 0, right: 0, top: 54, bottom: 34 }),
}));
vi.mock("../src/ui/posture", async () => ({
  ...(await import("../src/ui/posture/derive")),
  usePosture: () => ({ fold: device.hinge ? "hard" : "none", hinge: device.hinge, panes: 1, split: "full" }),
}));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    mail: true, c: { float: "#fff", ink: "#161412", scrim: "#888" }, radius: { panel: 20, row: 10, pill: 999 }, type: {},
    lift: () => ({}), liftUp: () => ({}), zLayer: { sheet: 100 }, reduceMotion: true,
  }),
}));
vi.mock("../src/ui/keyboard-lift", () => ({
  useKeyboardHeight: () => device.keyboardHeight,
  useKeyboardLift: () => device.keyboardHeight,
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Button: ({ label, onPress, style }: { label: string; onPress: () => void; style?: unknown }) =>
      <rnDom.Pressable accessibilityLabel={label} onPress={onPress} style={style}>{label}</rnDom.Pressable>,
    Rule: () => null, Tap: rnDom.Pressable, Txt: rnDom.Text,
  };
});
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null, NavigationIcon: () => null }));
vi.mock("../src/ui/OhboxWhere", () => ({ OhboxWhere: () => null }));
vi.mock("../src/state/pull", () => ({
  usePullToSync: () => ({ refreshing: false, onRefresh: device.pull }),
}));
vi.mock("../src/state/live", () => ({ addressShaped: () => null }));
vi.mock("../src/state/world", () => ({
  useWorld: () => ({ folders: { list: [] }, addressBook: [], worldKey: device.account }),
  useLiveSession: () => device.engine ? { engine: device.engine, ownerKey: device.account, bearer: device.renewal } : null,
}));

const { Sheet, SheetRow } = await import("../src/ui/Sheet");
const { SearchFacets } = await import("../src/ui/SearchFacets");
const { SearchSort } = await import("../src/ui/SearchSort");
const { MailListMenu } = await import("../src/ui/MailListMenu");
const menu = (root: ParentNode) => root.querySelector('[data-label="More actions"]');
const press = (root: ParentNode, name: string) => {
  const el = root.querySelector<HTMLElement>(`[data-rn="Pressable"][data-label="${name}"]`);
  expect(el).not.toBeNull();
  act(() => el?.click());
};

describe("phone menus", () => {
  it.each([360, 390, 412])("keeps a lower menu inside the safe area at %ipt and exposes its actions", (width) => {
    device.width = width;
    device.keyboardHeight = 0;
    const close = vi.fn();
    const move = vi.fn();
    const r = mount(<Sheet open phoneMenu label="More actions" onClose={close}>
      <SheetRow label="Move" onPress={move} />
    </Sheet>);
    try {
      expect(styleOf(menu(r.el))).toMatchObject({ width: width - 16, bottom: 34, borderRadius: 20 });
      const row = r.el.querySelector<HTMLElement>('[data-label="Move"]');
      const cancel = r.el.querySelector<HTMLElement>('[data-label="Cancel"]');
      expect(row).not.toBeNull();
      expect(cancel).not.toBeNull();
      act(() => row?.click());
      act(() => cancel?.click());
      expect(move).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally { r.unmount(); }
  });

  it.each([360, 390, 412])("centers the irreversible action with a 16pt side inset and both actions at %ipt", (width) => {
    device.width = width;
    device.keyboardHeight = 0;
    const close = vi.fn();
    const commit = vi.fn();
    const r = mount(<Sheet open phoneMenu label="Screen out and unsubscribe" onClose={close}
      confirmation={{
        note: "Once sent, it cannot be undone.",
        action: { label: "Continue", onPress: commit },
      }}>
      <div>Sending follows the selected rule.</div>
    </Sheet>);
    try {
      const panel = r.el.querySelector('[data-label="Screen out and unsubscribe"]')!;
      expect(styleOf(panel.parentElement)).toMatchObject({
        alignItems: "center", justifyContent: "center",
        paddingHorizontal: 16, paddingVertical: 54,
      });
      expect(styleOf(panel)).toMatchObject({ borderRadius: 20, padding: 32, width: "100%" });
      expect(panel.textContent).toContain("Once sent, it cannot be undone.");
      const action = panel.querySelector('[data-label="Continue"]');
      const cancel = panel.querySelector('[data-label="Cancel"]');
      expect(action?.parentElement).toBe(cancel?.parentElement);
      expect(styleOf(action ?? null).minHeight).toBe(48);
      press(panel, "Cancel");
      expect(close).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      press(panel, "Continue");
      expect(commit).toHaveBeenCalledOnce();
    } finally {
      r.unmount();
    }
  });

  it("opens above and against the right edge of the trigger inside an existing overlay", () => {
    device.width = 390;
    device.keyboardHeight = 300;
    const r = mount(<Sheet open inlineAnchor phoneMenu label="More actions" onClose={() => undefined} anchorSide="above"
      anchorAlign="end" anchor={{ x: 330, y: 480, width: 48, height: 48 }}>
      <SheetRow label="Discard" onPress={() => undefined} />
    </Sheet>);
    try {
      expect(r.el.querySelector("main")).toBeNull();
      expect(styleOf(menu(r.el))).toMatchObject({ width: 232, left: 146, bottom: 372 });
    } finally { r.unmount(); }
  });

  it("keeps lower menu controls above an open keyboard", () => {
    device.keyboardHeight = 300;
    const r = mount(<Sheet open phoneMenu avoidKeyboard label="More actions" onClose={() => undefined}>
      <SheetRow label="Done" onPress={() => undefined} />
    </Sheet>);
    try {
      expect(styleOf(menu(r.el))).toMatchObject({ bottom: 308, maxHeight: 474 });
    } finally { r.unmount(); }
  });

  it("keeps an anchored menu on its trigger's side of a separating hinge", () => {
    device.width = 620;
    device.keyboardHeight = 0;
    device.hinge = { x: 305, y: 0, w: 10, h: 844 };
    const r = mount(<Sheet open phoneMenu label="More actions" onClose={() => undefined}
      anchor={{ x: 274, y: 160, width: 30, height: 30 }}>
      <SheetRow label="Done" onPress={() => undefined} />
    </Sheet>);
    try {
      const panel = styleOf(menu(r.el));
      expect(panel).toMatchObject({ top: 198, width: 232 });
      expect(Number(panel.left) + Number(panel.width)).toBeLessThanOrEqual(305);
    } finally { r.unmount(); device.hinge = null; }
  });
});

it("selects and clears Place, showing a genuine zero beside the known folder", async () => {
  device.width = 390;
  device.keyboardHeight = 0;
  device.engine = {
    searchPlaces: async () => [{ folder: "INBOX", count: 10 }, { folder: "ohmail/Quarantine", count: 0 }],
    read: () => ({ stampOf: () => 0, list: () => [] }),
  };
  const changed = vi.fn();
  function Search() {
    const [filters, setFilters] = useState({});
    return <SearchFacets order="relevance" filters={filters} locale="en" onOrder={() => undefined}
      onFilters={(value) => { changed(value); setFilters(value); }} />;
  }
  const r = mount(<Search />);
  try {
    press(r.el, "Place");
    await act(async () => undefined);
    expect(r.el.querySelector('[data-rn="View"][data-label="Place"]')?.textContent).toContain("Spam0");
    press(r.el, "Spam, 0");
    expect(changed).toHaveBeenLastCalledWith({ folder: "ohmail/Quarantine" });
    press(r.el, "Spam");
    expect(changed).toHaveBeenLastCalledWith({ folder: undefined });
  } finally { r.unmount(); device.engine = null; }
});

it("drops the previous account's inventory and distinguishes an unknown count from zero", async () => {
  let resolveFirst: (rows: readonly { folder: string; count: number }[]) => void = () => undefined;
  device.engine = {
    searchPlaces: () => new Promise((resolve) => { resolveFirst = resolve; }),
    read: () => ({ stampOf: () => 0, list: () => [] }),
  };
  const search = <SearchFacets order="relevance" filters={{}} locale="en" onOrder={() => undefined} onFilters={() => undefined} />;
  const r = mount(search);
  try {
    press(r.el, "Place");
    expect(r.el.querySelector('[data-label="Ohbox"]')).not.toBeNull();
    expect(r.el.querySelector('[data-label="Ohbox, 0"]')).toBeNull();
    device.account = "second";
    device.engine = {
      searchPlaces: async () => [{ folder: "INBOX", count: 0 }],
      read: () => ({ stampOf: () => 0, list: () => [] }),
    };
    r.render(<SearchFacets {...search.props} />);
    await act(async () => { resolveFirst([{ folder: "INBOX", count: 27 }]); });
    expect(r.el.querySelector('[data-label="Ohbox, 27"]')).toBeNull();
    expect(r.el.querySelector('[data-label="Ohbox, 0"]')).not.toBeNull();
  } finally { r.unmount(); device.engine = null; device.account = "first"; }
});

it("shows the confirmed Place counts after the session renews with the picker already open", async () => {
  const listeners = new Set<() => void>();
  const ask = vi.fn<NonNullable<typeof device.engine>["searchPlaces"]>()
    .mockResolvedValueOnce(null)
    .mockResolvedValue([{ folder: "INBOX", count: 1 }, { folder: "ohmail/Quarantine", count: 0 }]);
  device.engine = { searchPlaces: ask, read: () => ({ stampOf: () => 1, list: () => [{ folder: "INBOX" }] }) };
  device.renewal = { onRenewed: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const r = mount(<SearchFacets order="relevance" filters={{}} locale="en" onOrder={() => undefined} onFilters={() => undefined} />);
  try {
    press(r.el, "Place");
    await act(async () => undefined);
    expect(r.el.querySelector('[data-label="Spam, 0"]')).toBeNull();
    await act(async () => { for (const listener of listeners) listener(); });
    expect(r.el.querySelector('[data-label="Spam, 0"]')).not.toBeNull();
    await act(async () => { for (const listener of listeners) listener(); });
    expect(ask).toHaveBeenCalledTimes(2);
  } finally { r.unmount(); device.engine = null; device.renewal = null; }
  expect(listeners.size).toBe(0);
});

it("keeps the current sort in the small slot and chooses another order from the lower panel", () => {
  const order = vi.fn();
  const r = mount(<SearchSort order="relevance" onOrder={order} />);
  try {
    press(r.el, "Sort by");
    expect(r.el.querySelector('[data-rn="View"][data-label="Sort by"]')?.textContent).toContain("Best match");
    press(r.el, "Newest first");
    expect(order).toHaveBeenCalledWith("date_desc");
    expect(r.el.querySelector('[data-rn="View"][data-label="Sort by"]')).toBeNull();
  } finally { r.unmount(); }
});

it("gives the list's More menu Pull new mail and shows how many letters Mark all read will affect", () => {
  const mark = vi.fn();
  const r = mount(<MailListMenu unread={2} anchored={false} onMarkAll={mark} />);
  try {
    press(r.el, "More");
    expect(r.el.querySelector('[data-label="Pull new mail"]')).not.toBeNull();
    expect(r.el.querySelector('[data-label="Mark all read, 2"]')).not.toBeNull();
    press(r.el, "Mark all read, 2");
    expect(mark).toHaveBeenCalledOnce();
    press(r.el, "More");
    press(r.el, "Pull new mail");
    expect(device.pull).toHaveBeenCalledOnce();
    expect(r.el.querySelector('[data-label="Pull new mail"]')).toBeNull();
  } finally { r.unmount(); }
});

it("gives the anchored Paper list action the web's 44-point trigger", () => {
  const r = mount(<MailListMenu />);
  try {
    expect(styleOf(r.el.querySelector('[data-label="More"]'))).toMatchObject({ minWidth: 44 });
  } finally { r.unmount(); }
});

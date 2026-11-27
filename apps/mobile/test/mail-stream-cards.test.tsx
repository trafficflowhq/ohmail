/** @vitest-environment jsdom */
import { act, createElement as h, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fireLayout, mount, styleOf } from "./_rendered-dom";
import { setActiveLocale } from "../src/i18n/locale";
import type { FiledSince, WorldMail } from "../src/state/live";
import { paperMailType } from "../src/theme/type";

const opened = vi.hoisted(() => vi.fn());
const hydrated = vi.hoisted(() => vi.fn());
const fetchBody = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>());
const navigate = vi.hoisted(() => vi.fn());
type VisibleItems = { viewableItems: Array<{ item: { id: string }; index: number | null }> };
const fixture = vi.hoisted(() => ({
  ios: false, textLayout: undefined as ((event: unknown) => void) | undefined,
  fullBody: "", html: "", mailboxLabel: undefined as string | undefined,
  focused: true, bodyState: "full", visible: undefined as ((items: VisibleItems) => void) | undefined,
  session: { engine: { hydrateBody: fetchBody } },
  filed: null as FiledSince | null, paper: true, receiptHasAttachments: false, receiptHasOffer: false,
}));
const marks = ["read", "mine", "read", "mine", "read", "read", "mine", "unread"] as const;
const ownAddress = "delivery@example.test";
const letter = {
  id: "letter",
  from: { name: "Workshop", address: "mail@example.test" },
  time: "08:12",
  subject: "The workshop agenda",
  body: "",
  snippet: "Your next workshop takes place on Friday.",
  unread: true,
  earlier: [],
  recipients: { to: [{ address: ownAddress }], cc: [] },
} as unknown as WorldMail;

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    ...rnDom,
    useWindowDimensions: () => ({ fontScale: 1 }),
    Platform: { ...rnDom.Platform, get OS() { return fixture.ios ? "ios" : "android"; } },
    AppState: { currentState: "active", addEventListener: () => ({ remove: vi.fn() }) },
    Animated: { View: rnDom.View, ValueXY: class { x = { interpolate: () => 0 }; } },
    Easing: { bezier: () => (value: number) => value },
    PanResponder: { create: () => ({ panHandlers: {} }) },
  };
});
vi.mock("expo-router", () => ({
  router: { push: navigate },
  useFocusEffect: vi.fn(),
  useIsFocused: () => fixture.focused,
  useNavigation: () => ({ getState: () => undefined, addListener: () => vi.fn() }),
}));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    mail: fixture.paper, scheme: "light", c: new Proxy({}, { get: () => "#121212" }), radius: { card: 20, pill: 999 },
    type: { streamBody: { lineHeight: 27 } },
  }),
}));
vi.mock("../src/state/pull", () => ({ usePullToSync: () => undefined }));
vi.mock("../src/state/live", () => ({ firstSyncReadingSaid: () => null, moveTargetsFor: () => [] }));
vi.mock("../src/state/world", () => ({
  useEngineQueuesAsk: () => vi.fn(),
  useFilesStamp: vi.fn(),
  useLiveSession: () => fixture.session,
  useMessageBody: () => ({ body: fixture.fullBody || letter.snippet, bodyState: fixture.bodyState, html: fixture.html }),
  useWorld: () => ({
    boot: { settled: true },
    worldKey: "fixtures",
    ohbox: {
      resurfaced: [], fresh: [{ ...letter, marks, mailbox: { name: "Work", address: ownAddress }, mailboxLabel: "Work" }],
      seen: [], unreadIds: [letter.id], total: 1, filed: fixture.filed,
    },
    reads: { items: [{ ...letter, mailboxLabel: fixture.mailboxLabel }], meta: "23 new since you were here", unreadIds: [letter.id], newCount: 23 },
    receipts: { groups: [{ label: "Today", items: [{ ...letter, mailboxLabel: fixture.mailboxLabel, hasAttachments: fixture.receiptHasAttachments }] }], total: 1, meta: "23 new since you were here", unreadIds: [letter.id], newCount: 23 },
    mailboxes: { ownAddresses: [ownAddress] },
    eventsOf: () => [],
    filesOf: () => [],
    actions: { hydrateMessage: hydrated, holdFiles: vi.fn(), releaseFiles: vi.fn(), markOhboxVisit: vi.fn() },
  }),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const { useEffect } = await import("react");
  return {
    Badge: rnDom.View, Button: rnDom.Pressable, Empty: rnDom.View, Panel: rnDom.View, Screen: rnDom.View,
    Tail: rnDom.View, Tap: rnDom.Pressable, TapRow: rnDom.Pressable, Waterline: rnDom.View,
    Txt: ({ onTextLayout, variant, style, textBreakStrategy, ...props }: {
      children?: ReactNode;
      variant?: keyof typeof paperMailType;
      style?: unknown;
      textBreakStrategy?: string;
      onTextLayout?: (event: { nativeEvent: { lines: { y: number; height: number }[] } }) => void;
    }) => {
      useEffect(() => {
        if (fixture.ios && variant === "streamTitle") {
          if (onTextLayout) fixture.textLayout = onTextLayout as (event: unknown) => void;
          return;
        }
        if (typeof props.children !== "string") return;
        const lines = props.children.split("\n").map((_line, i) => ({ y: i * 27, height: 27 }));
        onTextLayout?.({ nativeEvent: { lines } });
      }, [props.children, onTextLayout, variant]);
      return h(rnDom.Text, {
        ...props, testID: textBreakStrategy,
        style: [fixture.paper && variant && paperMailType[variant], style],
      });
    },
    ViewHead: ({ meta, right, inline, children }: { meta?: string; right: ReactNode; inline?: (compact: boolean) => ReactNode; children: ReactNode }) =>
      h("header", null, meta, right, inline?.(false), children),
    useListInsets: () => ({ paddingBottom: 80 }),
  };
});
vi.mock("../src/ui/MailList", () => ({
  MailList: ({ groups, renderRow, head, foot, tail, onViewableItemsChanged }: {
    groups: { rows: WorldMail[] }[]; renderRow: (row: WorldMail) => ReactNode; head: ReactNode; foot?: ReactNode; tail?: ReactNode;
    onViewableItemsChanged?: (items: VisibleItems) => void;
  }) => {
    fixture.visible = onViewableItemsChanged;
    return h("main", null, head, groups.flatMap(({ rows }) => rows.map((row) => h("article", { key: row.id }, renderRow(row)))), foot, tail);
  },
}));
vi.mock("../src/ui/list-detail", () => ({
  ListDetail: ({ list }: { list: ReactNode }) => list,
  useListDetail: () => ({ open: null, openRow: opened, close: vi.fn() }),
}));
vi.mock("../src/ui/stream-seen", () => ({ useSeenRun: () => ({ run: {}, gestures: {} }) }));
vi.mock("../src/ui/BodyPages", () => ({ BodyPages: ({ text }: { text: string }) => h("p", null, text) }));
vi.mock("../src/ui/FadeOut", () => ({ FadeOut: () => null }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/chrome", () => ({ TopBar: () => null }));
vi.mock("../src/engine/organizer-session", () => ({
  onOrganizerState: () => vi.fn(), organizerStateVersion: () => 0, readingAtConnectSaid: () => null,
}));
vi.mock("../src/ui/OrganizerStrip", () => ({
  OrganizerStrip: () => null, useStandaloneClaim: () => ({ claim: null, strip: null }),
}));
vi.mock("../src/ui/not-organizing", () => ({ knockSlotOf: () => ({ k: "none" }) }));
vi.mock("../src/ui/standalone-form", () => ({ readingAtConnectNow: () => null }));
vi.mock("../src/ui/SeedOfferCard", () => ({ useSeedOffer: () => ({ offer: { kind: "waiting" } }) }));
vi.mock("../src/state/seed-offer", () => ({ unscreenedOffered: () => null }));
vi.mock("../src/ui/OhboxWhere", () => ({
  OhboxWhere: ({ mode, filed }: { mode?: string; filed?: FiledSince | null }) => h("span", null,
    mode === "filings" ? null : "Checked just now",
    filed?.counts.length ? h("a", { href: "/reads" }, "Since you were here, 3 to News") : null),
}));
vi.mock("../src/ui/FullMailboxNotice", () => ({ FullMailboxNotice: () => null }));
vi.mock("../src/ui/WaitingStrip", () => ({ WaitingStrip: () => null }));
vi.mock("../src/ui/FilingStrip", () => ({ FilingStrip: () => null }));
vi.mock("../src/ui/LateStrip", () => ({ LateStrip: () => null }));
vi.mock("../src/ui/MessageReader", () => ({ MessageReader: () => null, AttachmentTiles: () => null }));
vi.mock("../src/ui/EventCard", () => ({ EventCards: () => null }));
vi.mock("../src/ui/MailFoundEvents", () => ({
  MailFoundEvents: () => fixture.receiptHasOffer ? "Add to calendar" : null,
  useMailFoundEvents: () => fixture.receiptHasOffer ? { rows: [{}] } : null,
}));
vi.mock("../src/ui/MailCalendarSwitch", () => ({ MailCalendarSwitch: () => null }));
vi.mock("../src/ui/MailListMenu", () => ({ MailListMenu: () => h("i", null, "⋯") }));
vi.mock("../src/ui/MarkAllRead", () => ({ MarkAllRead: () => null }));
vi.mock("../src/ui/StreamMailMenu", () => ({ StreamMailMenu: () => null }));
vi.mock("react-native-webview", () => ({ WebView: () => null }));
vi.mock("../src/mail/frame-ceiling-native", () => ({ phoneFrameCeiling: () => 2_000_000 }));
vi.mock("../src/ui/MailLinks", () => ({ MailLinkSheet: () => null }));
vi.mock("../src/ui/MailBodyFrame", async (real) => ({
  ...await real<typeof import("../src/ui/MailBodyFrame")>(),
  MailBodyFrame: ({ m, preview }: { m: { html: string }; preview: { maxHeight: number; onClipped: (clipped: boolean) => void } }) =>
    h("div", { "data-body-html": m.html, "data-clip-height": preview.maxHeight, onClick: () => preview.onClipped(true) }),
}));
vi.mock("../src/ui/StreamCardVerbs", () => ({ StreamCardVerbs: () => null }));
vi.mock("../src/ui/PileNote", () => ({ PileNote: () => null }));
vi.mock("../src/ui/Skeleton", () => ({ SkeletonList: () => null }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));

import News from "../app/(tabs)/reads";
import Receipts from "../app/(tabs)/receipts";
import Ohbox from "../app/(tabs)/index";

afterEach(() => {
  setActiveLocale("en");
  opened.mockClear();
  hydrated.mockClear();
  fetchBody.mockReset();
  navigate.mockClear();
  fixture.ios = false;
  fixture.textLayout = undefined;
  fixture.fullBody = "";
  fixture.html = "";
  fixture.mailboxLabel = undefined;
  fixture.focused = true;
  fixture.bodyState = "full";
  fixture.visible = undefined;
  fixture.filed = null;
  fixture.paper = true;
  fixture.receiptHasAttachments = false;
  fixture.receiptHasOffer = false;
});

it.each([News, Receipts])("puts the stream header's More at the Paper edge", (Screen) => {
  const view = mount(h(Screen));
  try {
    const tools = view.el.querySelector('header [data-rn="View"]');
    expect(tools?.textContent).toContain("23 new");
    expect(styleOf(tools)).toMatchObject({ marginRight: -14 });
  } finally { view.unmount(); }
});

it.each([News, Receipts])("fits the stream headline into the Paper phone card width", (Screen) => {
  const view = mount(h(Screen));
  try {
    const card = view.el.querySelector("article")!;
    const subject = [...card.querySelectorAll('[data-rn="Text"]')]
      .find((text) => text.textContent === letter.subject)!;
    const subjectStyle = styleOf(subject);
    expect.soft(subjectStyle).toMatchObject({ fontSize: 22, fontWeight: "800", lineHeight: 26.4 });
    expect.soft(subjectStyle.letterSpacing).toBeCloseTo(-0.484, 4);
    expect.soft(subject.getAttribute("data-testid")).toBe("balanced");
    expect.soft(styleOf(card.firstElementChild)).toMatchObject({ marginHorizontal: -2 });
  } finally { view.unmount(); }
});

it("balances a wrapped Paper Receipt on iOS without changing its subject", () => {
  fixture.ios = true;
  const view = mount(h(Receipts));
  try {
    const title = () => [...view.el.querySelectorAll('[data-rn="Text"]')]
      .find((node) => node.textContent === letter.subject)!;
    fireLayout(title().parentElement!, 320);
    expect(fixture.textLayout).toBeTypeOf("function");
    const measure = (widths: number[]) => act(() => fixture.textLayout?.({
      nativeEvent: { lines: widths.map((width) => ({ width })) },
    }));
    measure([280, 55]);
    // The native probe fits in two lines down to 190 points.
    let probe = title().parentElement!.querySelector('[data-ax-hidden]');
    for (let step = 0; probe && step < 10; step++) {
      const width = styleOf(probe.firstElementChild).width as number;
      measure(width >= 190 ? [170, 165] : [110, 110, 115]);
      probe = title().parentElement!.querySelector('[data-ax-hidden]');
    }
    expect(probe).toBeNull();
    expect(styleOf(title()).width).toBeGreaterThanOrEqual(190);
    expect(styleOf(title()).width).toBeLessThan(196);
  } finally { view.unmount(); }
});

it("keeps the compact Receipt headline and body one Paper gap apart", () => {
  const view = mount(h(Receipts));
  try {
    const subject = [...view.el.querySelectorAll('[data-role="button"]')]
      .find((button) => button.textContent?.includes(letter.subject))!;
    expect(styleOf(subject)).toMatchObject({ gap: 0, paddingBottom: 10 });
  } finally { view.unmount(); }
});

it.each([News, Receipts])("shows a compact fresh count and opens recipient details without opening the letter", (Screen) => {
  const view = mount(h(Screen));
  try {
    expect(view.el.querySelector("header")?.textContent).toBe("23 new⋯");
    const card = view.el.querySelector("article")!;
    expect(card.textContent).toContain(`to you (${ownAddress}) details`);
    if (Screen === Receipts) {
      expect(card.textContent!.indexOf(letter.time)).toBeLessThan(card.textContent!.indexOf("to you"));
    }
    const details = view.el.querySelector<HTMLElement>('[data-label="Details"]')!;
    act(() => details.click());
    expect(details.getAttribute("data-expanded")).toBe("true");
    expect(card.textContent).toContain(`to ${ownAddress}`);
    expect(opened).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("shows the News mailbox chip with the time before opening recipient details", () => {
  fixture.mailboxLabel = "Customer enquiries";
  const view = mount(h(News));
  try {
    const chip = view.el.querySelector('[data-label="Delivered to Customer enquiries"]');
    expect(chip?.textContent).toBe("Delivered to Customer enquiries");
    expect(chip?.parentElement?.textContent).toContain(letter.time);
    expect(view.el.querySelector('[data-label="Details"]')?.getAttribute("data-expanded")).toBe("false");
  } finally {
    view.unmount();
  }
});

it("keeps distinct delivery out of the compact Receipt and opens its reader", () => {
  fixture.mailboxLabel = "receipts@example.test";
  const view = mount(h(Receipts));
  try {
    const preview = view.el.querySelector("article")!;
    expect(preview.textContent).toContain(letter.subject);
    expect(preview.textContent).not.toContain(fixture.mailboxLabel);
    expect(preview.querySelector('[data-label^="Delivered to "]')).toBeNull();
    const details = preview.querySelector<HTMLElement>('[data-label="Details"]')!;
    act(() => details.click());
    expect(preview.querySelector('[data-label^="Delivered to "]')).toBeNull();
    const subject = [...preview.querySelectorAll<HTMLElement>('[data-role="button"]')]
      .find((button) => button.textContent?.includes(letter.subject))!;
    act(() => subject.click());
    expect(opened).toHaveBeenCalledWith(letter.id);
  } finally {
    view.unmount();
  }
});

it.each([
  [News, undefined], [News, ownAddress], [Receipts, undefined], [Receipts, ownAddress],
] as const)("leaves an absent or repeated delivery address out of %s (%s)", (Screen, mailboxLabel) => {
  fixture.mailboxLabel = mailboxLabel;
  const view = mount(h(Screen));
  try {
    const details = view.el.querySelector<HTMLElement>('[data-label="Details"]')!;
    act(() => details.click());
    expect(view.el.querySelector('[data-label^="Delivered to "]')).toBeNull();
    expect(view.el.querySelector("article")?.textContent).not.toContain("Delivered to");
  } finally {
    view.unmount();
  }
});

it.each([News, Receipts])("opens a short card through its subject without a second reader control", (Screen) => {
  const view = mount(h(Screen));
  try {
    expect(view.el.querySelector("article")?.textContent).toContain(letter.snippet);
    expect(view.el.querySelector('[data-label="Read in full"]')).toBeNull();
    const subject = [...view.el.querySelectorAll<HTMLElement>('[data-role="button"]')]
      .find((button) => button.textContent?.includes(letter.subject))!;
    act(() => subject.click());
    expect(opened).toHaveBeenCalledWith(letter.id);
  } finally {
    view.unmount();
  }
});

it("opens a complete short receipt with an attachment through its subject", () => {
  fixture.receiptHasAttachments = true;
  fixture.fullBody = "The order is ready. The confirmation is attached.";
  const view = mount(h(Receipts));
  try {
    const card = view.el.querySelector("article")!;
    expect(card.textContent).toContain(fixture.fullBody);
    expect(card.querySelector('[data-label="Read in full"]')).toBeNull();
    const subject = [...card.querySelectorAll<HTMLElement>('[data-role="button"]')]
      .find((button) => button.textContent?.includes(letter.subject))!;
    act(() => subject.click());
    expect(opened).toHaveBeenCalledWith(letter.id);
  } finally {
    view.unmount();
  }
});

it("keeps the attachments opener when a receipt also offers a calendar event", () => {
  fixture.receiptHasAttachments = true;
  fixture.receiptHasOffer = true;
  const view = mount(h(Receipts));
  try {
    const card = view.el.querySelector("article")!;
    expect(card.textContent).toContain("Add to calendar");
    const full = card.querySelector<HTMLElement>('[data-label="Read in full"]')!;
    expect(full).not.toBeNull();
    act(() => full.click());
    expect(opened).toHaveBeenCalledWith(letter.id);
  } finally {
    view.unmount();
  }
});

it.each([false, true])("loads a visible cold short receipt without opening the reader (attachment: %s)", async (attached) => {
  fixture.receiptHasAttachments = attached;
  fixture.bodyState = "snippet";
  fetchBody.mockResolvedValue(undefined);
  const view = mount(h(Receipts));
  try {
    expect(view.el.querySelector('[data-label="Read in full"]')).not.toBeNull();
    expect(fetchBody).not.toHaveBeenCalled();
    await act(async () => fixture.visible?.({ viewableItems: [{ item: letter, index: 0 }] }));
    expect(fetchBody.mock.calls).toEqual([[letter.id]]);
    expect(opened).not.toHaveBeenCalled();
    fixture.bodyState = "full";
    fixture.fullBody = "The order is ready. Here are the final details.";
    view.render(h(Receipts));
    expect(view.el.querySelector("article")?.textContent).toContain(fixture.fullBody);
    expect(view.el.querySelector('[data-label="Read in full"]')).toBeNull();
  } finally {
    view.unmount();
  }
});

it("loads a visible short News body without opening it and hides the extra control when it fits", async () => {
  fixture.bodyState = "snippet";
  fetchBody.mockResolvedValue(undefined);
  const view = mount(h(News));
  try {
    expect(view.el.querySelector('[data-label="Read in full"]')).not.toBeNull();
    expect(fetchBody).not.toHaveBeenCalled();
    await act(async () => fixture.visible?.({
      viewableItems: [{ item: { id: "section" }, index: null }, { item: letter, index: 0 }],
    }));
    expect(fetchBody.mock.calls).toEqual([[letter.id]]);
    expect(opened).not.toHaveBeenCalled();
    fixture.bodyState = "full";
    view.render(h(News));
    expect(view.el.querySelector('[data-label="Read in full"]')).toBeNull();
  } finally {
    view.unmount();
  }
});

it("limits the automatic body reads to a small visible News window", async () => {
  const view = mount(h(News));
  fetchBody.mockResolvedValue(undefined);
  const visible = Array.from({ length: 7 }, (_, index) => ({ item: { id: `visible-${index}` }, index }));
  try {
    await act(async () => fixture.visible?.({ viewableItems: visible }));
    expect(fetchBody.mock.calls).toEqual(visible.slice(0, 4).map(({ item }) => [item.id]));
  } finally {
    view.unmount();
  }
});

it("stops asking for visible News bodies on leaving the list", async () => {
  let finish!: () => void;
  fetchBody.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = mount(h(News));
  try {
    await act(async () => fixture.visible?.({
      viewableItems: [{ item: letter, index: 0 }, { item: { id: "second-visible" }, index: 1 }],
    }));
    expect(fetchBody.mock.calls).toEqual([[letter.id]]);
    fixture.focused = false;
    view.render(h(News));
    await act(async () => finish());
    expect(fetchBody.mock.calls).toEqual([[letter.id]]);
  } finally {
    view.unmount();
  }
});

it.each([News, Receipts])("opens the full reader from the clipped preview's control", (Screen) => {
  fixture.fullBody = [letter.snippet, "Line two", "Line three", "Line four", "Line five", "Line six", "Line seven"].join("\n");
  const view = mount(h(Screen));
  try {
    expect(view.el.querySelector("article")?.textContent).toContain(letter.snippet);
    const full = view.el.querySelector<HTMLElement>('[data-label="Read in full"]')!;
    expect(full).not.toBeNull();
    act(() => full.click());
    expect(opened).toHaveBeenCalledWith(letter.id);
    expect(hydrated).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it.each([News, Receipts])("hands formatted cached mail to the bounded shared reader frame", (Screen) => {
  fixture.html = '<p><strong>Registration</strong> <a href="https://example.test/registration">Register</a></p>';
  const view = mount(h(Screen));
  try {
    const frame = view.el.querySelector<HTMLElement>("[data-body-html]")!;
    expect(frame?.getAttribute("data-body-html")).toBe(fixture.html);
    expect(Number(frame.getAttribute("data-clip-height"))).toBeGreaterThan(0);
    act(() => frame.click());
    expect(opened).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("uses the German recipient and count phrasing", () => {
  setActiveLocale("de");
  const view = mount(h(News));
  try {
    expect(view.el.querySelector("header")?.textContent).toBe("23 neu⋯");
    expect(view.el.querySelector("article")?.textContent).toContain(`an dich (${ownAddress}) Details`);
  } finally {
    view.unmount();
  }
});

it("keeps a long Ohbox conversation's marks beside the sender without the last-checked line", () => {
  const view = mount(h(Ohbox));
  try {
    expect(view.el.querySelector("header")?.textContent).not.toContain("Checked just now");
    const row = view.el.querySelector("article")!;
    expect(row.textContent).toContain(letter.from.name + letter.from.address);
    const strip = row.querySelector('[data-testid="row-marks"]')!;
    fireLayout(strip.parentElement!, 108);
    expect(strip.children).toHaveLength(marks.length);
  } finally {
    view.unmount();
  }
});

it("fits a sender's name before giving any spare room to its address", () => {
  const view = mount(h(Ohbox));
  try {
    const row = view.el.querySelector("article")!;
    const address = [...row.querySelectorAll('[data-rn="Text"]')]
      .find((node) => node.textContent === letter.from.address)!;
    expect(styleOf(address)).toMatchObject({ flexBasis: 0, flexGrow: 1, minWidth: 0 });
  } finally {
    view.unmount();
  }
});

it.each([true, false])("shows recent filing links only in the standalone Ohbox heading (Paper: %s)", (paper) => {
  fixture.paper = paper;
  fixture.filed = { at: "2026-10-19T11:00:00.000Z", counts: [{ pile: "reads", count: 3 }] };
  const view = mount(h(Ohbox));
  try {
    const head = view.el.querySelector("header")!;
    expect(head.textContent?.includes("Since you were here")).toBe(!paper);
    expect(Boolean(head.querySelector('a[href="/reads"]'))).toBe(!paper);
  } finally {
    view.unmount();
  }
});

it("offers History after the last Ohbox row", () => {
  const view = mount(h(Ohbox));
  try {
    const history = view.el.querySelector<HTMLElement>('[data-role="button"][data-label="History"]')!;
    expect(history).not.toBeNull();
    expect(history?.parentElement?.textContent).toContain("Older mail");
    expect(view.el.querySelector("article")!.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => history.click());
    expect(navigate).toHaveBeenCalledWith("/history");
  } finally {
    view.unmount();
  }
});

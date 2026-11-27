/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { WorldMail } from "../src/state/live";
import { SCREENER_ACKNOWLEDGEMENTS, type ScreenerAcknowledgement } from "@ohmail/app-logic/consent/screener-acknowledgements";
import { mount, rnDom, styleOf } from "./_rendered-dom";

const world = vi.hoisted(() => ({
  paper: false,
  draftReplies: false,
  message: () => undefined,
  resurfaceTime: null,
  screenerConfirmation: {
    acknowledged: 0,
    remember: vi.fn<(kind: ScreenerAcknowledgement) => void>(),
  },
  actions: { deleteMessage: vi.fn(), pileToggle: vi.fn(), forwardFetch: vi.fn(() => null), keptReply: vi.fn(() => ({ kind: "none" })) },
}));
vi.mock("react-native", () => rnDom);
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
}));
vi.mock("../src/ui/posture", async () => {
  const { derivePosture } = await import("../src/ui/posture/derive");
  const window = { width: 400, height: 800 };
  return {
    usePosture: () => derivePosture({ ...window, folds: [], platform: "android", hasFold: false }),
    useAppWindow: () => window,
  };
});
vi.mock("../src/theme", () => ({ useTheme: () => ({ mail: world.paper, c: {}, radius: { panel: 12 }, zLayer: { tabBar: 5 } }) }));
vi.mock("../src/ui/base", () => ({
  Tap: rnDom.Pressable, Txt: rnDom.Text, Button: () => null,
  Rule: ({ inset, style }: { inset: number; style?: Record<string, unknown> }) =>
    <hr data-style={JSON.stringify({ marginHorizontal: inset, ...style })} />,
}));
vi.mock("../src/ui/glass", () => ({
  GlassPill: ({ children }: { children: ReactNode }) => children,
  GlassActionBar: () => null,
  nextRoom: () => 0,
}));
vi.mock("../src/ui/Sheet", () => ({
  Sheet: ({ open, label, phoneMenu, children }: { open: boolean; label: string; phoneMenu?: boolean; children: ReactNode }) =>
    open ? <section aria-label={label} data-phone-menu={phoneMenu || undefined}>{children}</section> : null,
  SheetRow: ({ label, onPress, navigationIcon, disabled, accessibilityHint }: {
    label: string; onPress: () => void; navigationIcon?: string; disabled?: boolean; accessibilityHint?: string;
  }) => <button onClick={onPress} data-navigation-icon={navigationIcon} disabled={disabled} title={accessibilityHint}>{label}</button>,
}));
vi.mock("../src/compose/attach-native", () => ({ nativeAttachPicker: null, nativeImageShrink: null }));
vi.mock("../src/mail/open-attachment-native", () => ({ shareAttachmentBytes: null }));
vi.mock("../src/ui/keyboard-native", () => ({ showKeyboardWhenFocused: null }));
vi.mock("../src/ui/AttachmentPreview", () => ({ AttachmentPreview: () => null }));
vi.mock("../src/net/network-door", () => ({ useNetworkNow: () => "online" }));
vi.mock("../src/state/store", () => ({ usePrefs: () => ({}) }));
vi.mock("../src/ui/keyboard-lift", () => ({ useKeyboardLift: () => 0 }));
vi.mock("../src/ui/reader-cover", () => ({ useReaderCover: () => undefined }));
vi.mock("../src/ui/FadeOut", () => ({ FadeOut: () => null }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: ReactNode }) => world.paper ? null : children }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null, NavigationIcon: () => null }));
vi.mock("../src/ui/bottom-chrome", () => ({ useBottomChromeSlot: () => () => undefined }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/state/world", () => ({ useWorld: () => world }));

const { MessageActions } = await import("../src/ui/MessageActions");
const { Copy } = await import("../src/copy");

const letter: WorldMail = {
  id: "letter", subject: "A letter", from: { name: "A sender", address: "" },
  place: "ohbox", time: "", body: "", unread: false, earlier: [],
  folder: "INBOX", presentedFolder: "INBOX", mailboxId: "mailbox", pile: null,
  canReplyAll: false, replyAllHead: null, noForward: false, forwardAsk: null, labels: [],
};

it("the Paper reader opens its More verbs in the phone menu", () => {
  world.paper = true;
  const view = mount(<MessageActions m={letter} />);
  try {
    act(() => { view.el.querySelector<HTMLElement>(`[data-label="${Copy.actionMore}"]`)!.click(); });
    const menu = view.el.querySelector(`section[aria-label="${Copy.actionMore}"]`);
    expect(menu?.getAttribute("data-phone-menu")).toBe("true");
    expect(menu?.textContent).toContain(Copy.actionDelete);
  } finally { view.unmount(); world.paper = false; }
});

it("the Paper reader puts Park before Resurface and uses their navigation marks", () => {
  world.paper = true;
  const view = mount(<MessageActions m={letter} />);
  try {
    act(() => { view.el.querySelector<HTMLElement>(`[data-label="${Copy.actionMore}"]`)!.click(); });
    const menu = view.el.querySelector(`section[aria-label="${Copy.actionMore}"]`);
    const rows = [...(menu?.querySelectorAll("button") ?? [])];
    const park = rows.findIndex((row) => row.textContent === Copy.actionSetAside);
    const surface = rows.findIndex((row) => row.textContent === Copy.actionResurface);
    expect(park).toBeGreaterThanOrEqual(0);
    expect(park).toBeLessThan(surface);
    expect(rows[park]?.dataset.navigationIcon).toBe("parked");
    expect(rows[surface]?.dataset.navigationIcon).toBe("resurface");
  } finally { view.unmount(); world.paper = false; }
});

it("spaces the Paper Draft reply section and uses the web's Move and Mark unread marks", () => {
  world.paper = true;
  world.draftReplies = true;
  const view = mount(<MessageActions m={letter} />);
  try {
    act(() => { view.el.querySelector<HTMLElement>(`[data-label="${Copy.actionMore}"]`)!.click(); });
    const menu = view.el.querySelector(`section[aria-label="${Copy.actionMore}"]`);
    const find = (label: string) => [...(menu?.querySelectorAll("button") ?? [])].find((row) => row.textContent === label);
    const rule = find(Copy.draftAiReply)?.previousElementSibling ?? null;
    expect(rule?.tagName).toBe("HR");
    expect.soft(styleOf(rule)).toMatchObject({ height: 1, marginHorizontal: 12, marginVertical: 4 });
    expect.soft(find(Copy.actionMove)?.dataset.navigationIcon).toBe("move");
    expect.soft(find(Copy.actionMarkUnread)?.dataset.navigationIcon).toBe("unread");
    world.draftReplies = false;
    view.render(<MessageActions m={letter} />);
    expect(menu?.querySelector("hr")).toBeNull();
  } finally {
    view.unmount();
    world.paper = false;
    world.draftReplies = false;
  }
});

it("only offers Draft reply when allowed and opens an offer for the latest reply target", () => {
  world.paper = true;
  const inline = vi.fn();
  const latest = { ...letter, id: "latest" };
  const tree = <MessageActions m={letter} replyTo={latest} onInlineReply={inline} />;
  const view = mount(tree);
  const offer = () => [...view.el.querySelectorAll("button")].find((row) => row.textContent === "Draft reply");
  try {
    act(() => { view.el.querySelector<HTMLElement>(`[data-label="${Copy.actionMore}"]`)!.click(); });
    expect(offer()).toBeUndefined();
    world.draftReplies = true;
    view.render(<MessageActions m={letter} replyTo={latest} onInlineReply={inline} />);
    expect(inline).not.toHaveBeenCalled();
    expect(offer()).toBeDefined();
    act(() => { offer()!.click(); });
    expect(inline).toHaveBeenCalledTimes(1);
    expect(inline).toHaveBeenCalledWith(latest, { compose: "reply", offerDraftReply: true });
  } finally {
    view.unmount();
    world.paper = false;
    world.draftReplies = false;
  }
});

it("fetches the viewed original and hands a confirmed Forward to the inline composer", () => {
  world.paper = true;
  const sensitive = { ...letter, forwardAsk: "sensitive" as const };
  const inline = vi.fn();
  const view = mount(<MessageActions m={sensitive} onInlineReply={inline} />);
  const pressChoice = (label: string, choice: string) => {
    const panel = view.el.querySelector(`section[aria-label="${label}"]`);
    const button = [...(panel?.querySelectorAll("button") ?? [])].find((el) => el.textContent === choice);
    expect(button).toBeDefined();
    act(() => button?.click());
  };
  try {
    act(() => { view.el.querySelector<HTMLElement>(`[data-label="${Copy.actionMore}"]`)!.click(); });
    pressChoice(Copy.actionMore, Copy.actionForward);
    expect(world.actions.forwardFetch).toHaveBeenCalledWith(sensitive.id);
    expect(inline).not.toHaveBeenCalled();
    pressChoice(Copy.forwardAskQuestion, Copy.actionForward);
    expect(inline).toHaveBeenCalledWith(sensitive, { compose: "forward", confirmed: true });
  } finally { view.unmount(); world.paper = false; }
});

it.each(["reader", "inline"] as const)("holds both %s filing controls until a selected reply has a mailbox copy", (where) => {
  world.actions.pileToggle.mockClear();
  const reply = { ...letter, pendingReplyCopy: true as const };
  const close = vi.fn();
  const inlineMore = where === "inline" ? {
    render: (rows: ReactNode) => <section aria-label={Copy.actionMore}>{rows}</section>, close,
    afterClose: (press: () => void) => press(), hasWriterFocus: () => false, restoreWriterFocus: () => undefined,
  } : undefined;
  world.paper = where === "inline";
  const draw = (m: WorldMail) => <MessageActions m={m} inlineMore={inlineMore} />;
  const view = mount(draw(reply));
  try {
    if (where === "reader") act(() => { view.el.querySelector<HTMLElement>(`[data-label="${Copy.actionMore}"]`)!.click(); });
    const pane = within(view.el);
    const later = pane.getByRole<HTMLButtonElement>("button", { name: Copy.actionLater });
    const park = pane.getByRole<HTMLButtonElement>("button", { name: Copy.actionSetAside });
    expect(later.disabled).toBe(true);
    expect(park.disabled).toBe(true);
    expect(later.title).toBe(Copy.replyCopyWaiting);
    expect(park.title).toBe(Copy.replyCopyWaiting);
    expect(pane.getByText(Copy.replySending)).toBeTruthy();
    act(() => { later.click(); park.click(); });
    expect(world.actions.pileToggle).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    view.render(draw(letter));
    expect(pane.getByRole<HTMLButtonElement>("button", { name: Copy.actionLater }).disabled).toBe(false);
    expect(pane.queryByText(Copy.replySending)).toBeNull();
    act(() => pane.getByRole<HTMLButtonElement>("button", { name: Copy.actionSetAside }).click());
    expect(world.actions.pileToggle.mock.calls).toEqual([[letter.id, "setAside"]]);
  } finally {
    world.actions.pileToggle.mockClear();
    world.paper = false;
    view.unmount();
  }
});

it.each([
  [Copy.actionSetAside, "setAside"],
  [Copy.actionLater, "replyLater"],
])("keeps the ordinary filing call from the phone reader for %s", (label, kind) => {
  world.actions.pileToggle.mockClear();
  const view = mount(<MessageActions m={letter} />);
  try {
    act(() => { view.el.querySelector<HTMLElement>(`[data-label="${Copy.actionMore}"]`)!.click(); });
    const button = within(view.el).getByRole<HTMLButtonElement>("button", { name: label });
    expect(button.disabled).toBe(false);
    act(() => { button.click(); });
    expect(world.actions.pileToggle.mock.calls).toEqual([["letter", kind]]);
  } finally {
    world.actions.pileToggle.mockClear();
    view.unmount();
  }
});

it.each(["ohbox", "reads", "receipts"] as const)("the %s reader floats its actions over the letter", (place) => {
  const view = mount(<MessageActions m={{ ...letter, place }} />);
  try {
    const more = view.el.querySelector(`[data-label="${Copy.actionMore}"]`)!;
    const bar = more.closest('[data-rn="View"]');
    expect(styleOf(bar)).toMatchObject({ position: "absolute", bottom: 0 });
  } finally {
    view.unmount();
  }
});

it("the phone sheet asks before the first move and later presses use the same Undo action directly", () => {
  world.screenerConfirmation.remember.mockImplementation(() => {
    world.screenerConfirmation.acknowledged |= SCREENER_ACKNOWLEDGEMENTS.moveToTrash;
  });
  const view = mount(<MessageActions m={letter} />);
  const sheet = (label: string) => view.el.querySelector(`section[aria-label="${label}"]`);
  const remove = () => {
    act(() => { view.el.querySelector<HTMLElement>(`[data-label="${Copy.actionMore}"]`)!.click(); });
    const deleteRow = [...sheet(Copy.actionMore)!.querySelectorAll("button")]
      .find((button) => button.textContent === Copy.actionDelete);
    act(() => { deleteRow!.click(); });
  };

  try {
    remove();
    expect(world.actions.deleteMessage).not.toHaveBeenCalled();
    act(() => { sheet(Copy.deleteAsk)!.querySelector("button")!.click(); });
    expect(world.actions.deleteMessage).toHaveBeenCalledTimes(1);
    expect(world.actions.deleteMessage).toHaveBeenCalledWith("letter", { onCommitted: expect.any(Function) });

    remove();
    expect(sheet(Copy.deleteAsk)).toBeNull();
    expect(world.actions.deleteMessage).toHaveBeenCalledTimes(2);
    expect(world.screenerConfirmation.remember).toHaveBeenCalledTimes(1);
    expect(world.screenerConfirmation.remember).toHaveBeenCalledWith("moveToTrash");
  } finally {
    view.unmount();
  }
});

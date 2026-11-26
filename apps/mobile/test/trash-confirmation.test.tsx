/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { WorldMail } from "../src/state/live";
import { SCREENER_ACKNOWLEDGEMENTS, type ScreenerAcknowledgement } from "@ohmail/app-logic/consent/screener-acknowledgements";
import { mount, rnDom, styleOf } from "./_rendered-dom";

const world = vi.hoisted(() => ({
  resurfaceTime: null,
  screenerConfirmation: {
    acknowledged: 0,
    remember: vi.fn<(kind: ScreenerAcknowledgement) => void>(),
  },
  actions: { deleteMessage: vi.fn(), pileToggle: vi.fn() },
}));
vi.mock("react-native", () => rnDom);
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
vi.mock("../src/theme", () => ({ useTheme: () => ({ mail: false, c: {}, radius: { panel: 12 }, zLayer: { tabBar: 5 } }) }));
vi.mock("../src/ui/base", () => ({ Tap: rnDom.Pressable, Txt: rnDom.Text, Button: () => null, Rule: () => null }));
vi.mock("../src/ui/glass", () => ({
  GlassPill: ({ children }: { children: ReactNode }) => children,
  GlassActionBar: () => null,
  nextRoom: () => 0,
}));
vi.mock("../src/ui/Sheet", () => ({
  Sheet: ({ open, label, children }: { open: boolean; label: string; children: ReactNode }) =>
    open ? <section aria-label={label}>{children}</section> : null,
  SheetRow: ({ label, onPress, disabled, accessibilityHint }: {
    label: string; onPress: () => void; disabled?: boolean; accessibilityHint?: string;
  }) => <button onClick={onPress} disabled={disabled} title={accessibilityHint}>{label}</button>,
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
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
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

it("holds both filing controls on a selected reply until it has a mailbox copy", () => {
  const reply = { ...letter, pendingReplyCopy: true as const };
  const view = mount(<MessageActions m={reply} />);
  try {
    act(() => { view.el.querySelector<HTMLElement>(`[data-label="${Copy.actionMore}"]`)!.click(); });
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
  } finally {
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

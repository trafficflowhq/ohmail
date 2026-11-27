/** @vitest-environment jsdom */
/**
 * A NEW MAIL'S FROM AND ITS COPIES, rendered. With two connected mailboxes the From line opens a
 * list; the address picked is the mailbox the send names and the signature it carries. "Cc, Bcc"
 * shows the two fields, and what is typed there leaves with the send, each in its own list.
 */
import { act, createElement as h, forwardRef, type ComponentProps, type ReactNode } from "react";
import type { NativeSyntheticEvent } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, MutationRejectedError, OhmailEngine, mutationEffects, type SyncChange } from "@ohmail/client-engine";
import { createThreadRead } from "../src/ui/reader-seen";
import { openLetterSession, ownedLetters } from "../src/compose/letter-keeper";
import { restoreLetters, settleLetters } from "../src/compose/letter-restore";
import { letterDoor } from "../src/compose/letter-store";
import { flushQueued, keptRecipients, liveActions, liveDrafts, type DraftKeep } from "../src/state/live";

function inputEvent<T>(type: string, nativeEvent: T): NativeSyntheticEvent<T> {
  const target = document.activeElement as unknown as NativeSyntheticEvent<T>["target"];
  const event = new Event(type, { bubbles: true });
  return {
    nativeEvent, target, currentTarget: target, type,
    bubbles: event.bubbles, cancelable: event.cancelable, defaultPrevented: event.defaultPrevented,
    eventPhase: event.eventPhase, isTrusted: event.isTrusted, timeStamp: event.timeStamp,
    preventDefault: () => event.preventDefault(), isDefaultPrevented: () => event.defaultPrevented,
    stopPropagation: () => event.stopPropagation(), isPropagationStopped: () => event.cancelBubble,
    persist: () => undefined,
  };
}

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const React = await import("react");
  return {
    ...rnDom,
    Modal: (p: { children?: ReactNode; statusBarTranslucent?: boolean; navigationBarTranslucent?: boolean; onRequestClose?: () => void }) =>
      React.createElement("div", { "data-modal": "", "data-under-bars": String(p.statusBarTranslucent === true && p.navigationBarTranslucent === true),
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Escape") p.onRequestClose?.(); },
      }, p.children),
    KeyboardAvoidingView: (p: { children?: ReactNode; behavior?: string; style?: unknown }) => h("div", {
      "data-avoid": p.behavior ?? "", "data-style": JSON.stringify(p.style ?? {}),
    }, p.children),
    Platform: { ...rnDom.Platform, get OS() { return look.platform; } },
    Keyboard: { dismiss: () => undefined, addListener: () => ({ remove: () => undefined }) },
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    useWindowDimensions: () => ({ width: 400, height: look.windowHeight, scale: 2, fontScale: 1 }),
    Image: (p: { source?: { uri?: string }; resizeMethod?: string; onError?: () => void }) => {
      drawn.sources.push(p.source);
      return React.createElement("img", { "data-uri": p.source?.uri, "data-resize": p.resizeMethod, onError: p.onError });
    },
    TextInput: forwardRef<HTMLInputElement, ComponentProps<typeof import("react-native").TextInput>>(
      (p, ref) => {
        if (p.onSelectionChange) caret.select = (start, end) =>
          p.onSelectionChange?.(inputEvent("selectionchange", { target: 1, selection: { start, end } }));
        if (p.onContentSizeChange) caret.measure = (height) =>
          p.onContentSizeChange?.(inputEvent("contentsizechange", { target: 1, contentSize: { height, width: 320 } }));
        return React.createElement("input", {
        ref, value: p.value, "data-label": p.accessibilityLabel, "data-in-place": String(p.disableFullscreenUI === true), "data-keyboard": p.keyboardAppearance,
        onFocus: () => p.onFocus?.(inputEvent("focus", { target: 1 })),
        onBlur: () => p.onBlur?.(inputEvent("blur", { target: 1 })),
        "data-scroll": String(p.scrollEnabled === true), "data-keyboard-type": p.keyboardType,
        "data-autofocus": String(p.autoFocus === true),
        "data-selection": p.selection ? `${p.selection.start}:${p.selection.end ?? p.selection.start}` : undefined,
        "data-placeholder": p.placeholder, "data-style": JSON.stringify(Object.assign({}, ...[p.style].flat(2).filter(Boolean))),
        onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value),
        });
      },
    ),
  };
});
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: look.bottom, left: 0, right: 0 }) }));
const caret = vi.hoisted(() => ({
  select: null as null | ((start: number, end: number) => void),
  measure: null as null | ((height: number) => void),
}));
const look = vi.hoisted(() => ({
  paper: false, scheme: "light" as "light" | "dark", platform: "android" as "ios" | "android", bottom: 0, keyboardHeight: 0, windowHeight: 800,
}));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    mail: look.paper, scheme: look.scheme,
    c: new Proxy({}, { get: () => "#000" }), radius: new Proxy({}, { get: () => 8 }), type: new Proxy({}, { get: () => ({}) }),
    lift: () => ({}), liftUp: () => ({}), textCap: 2, hit: 48, reduceMotion: true,
  }),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Tap: (p: { accessibilityRole?: string; accessibilityLabel?: string; onPress?: () => void; children?: ReactNode; style?: unknown }) =>
      p.accessibilityLabel === "Back" ? h("button", { onClick: p.onPress }, p.accessibilityLabel)
        : h(rnDom.Pressable, { ...p, style: typeof p.style === "function" ? p.style({ pressed: false }) : p.style }),
    Txt: (p: { children?: ReactNode; style?: unknown }) => h("span", { "data-style": JSON.stringify(p.style ?? {}) }, p.children),
    Button: (p: { label: string; disabled?: boolean; onPress?: () => void; appearance?: { surface?: { backgroundColor?: string } } }) =>
      h("button", { "data-button": p.label, "data-face": p.appearance?.surface?.backgroundColor, disabled: p.disabled, onClick: p.onPress }, p.label),
    Rule: () => null,
  };
});
vi.mock("../src/ui/Icon", () => ({ Icon: ({ name }: { name: string }) => h("span", { "data-icon": name }) }));
vi.mock("../src/ui/FadeOut", () => ({ FadeOut: () => null }));
vi.mock("../src/ui/Sheet", () => ({
  Sheet: (p: { open: boolean; label: string; onClose: () => void; onDismiss?: () => void; phoneMenu?: boolean; inlineAnchor?: boolean; anchorSide?: string; title?: string; children?: ReactNode }) =>
    p.open ? h("section", { "aria-label": p.label, "data-phone-menu": p.phoneMenu ? p.inlineAnchor ? "inline" : "modal" : undefined,
      "data-anchor-side": p.anchorSide }, p.title, p.children, h("button", { "data-dismiss": "", onClick: p.onClose }))
      : p.onDismiss ? h("button", { "data-did-dismiss": "", onClick: p.onDismiss }) : null,
  SheetBackdrop: () => null,
  SheetRow: (p: { label: string; disabled?: boolean; onPress?: () => void }) =>
    h("button", { "data-menu-row": p.label, disabled: p.disabled, onClick: p.onPress }, p.label),
  useModalKey: () => "k", useSheetPanelBounds: () => ({}), useSheetRoom: (lift: number) => ({ paddingBottom: lift }),
}));
vi.mock("../src/ui/glass", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    GlassActionBar: () => null, nextRoom: () => 0,
    GlassPill: (p: { style?: object; children?: ReactNode }) => h(rnDom.View, { style: [{ borderRadius: 8 }, p.style] }, p.children),
  };
});
vi.mock("../src/ui/posture", async () => {
  const { derivePosture } = await import("../src/ui/posture/derive");
  const useAppWindow = () => ({ width: 400, height: look.windowHeight });
  return { useAppWindow, usePosture: () => ({
    ...derivePosture({ ...useAppWindow(), folds: [], platform: look.platform, hasFold: false }), heightClass: "regular", panes: 1,
  }) };
});
vi.mock("../src/ui/keyboard-lift", async (actual) => ({
  ...await actual<typeof import("../src/ui/keyboard-lift")>(),
  useKeyboardHeight: (enabled: boolean) => enabled ? look.keyboardHeight : 0,
}));
vi.mock("../src/ui/keyboard-native", () => ({ showKeyboardWhenFocused: () => undefined }));
vi.mock("../src/ui/reader-cover", () => ({ useReaderCover: () => undefined }));
vi.mock("../src/ui/bottom-chrome", () => ({ useBottomChromeSlot: () => undefined }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/net/network-door", () => ({ useNetworkNow: () => "online" }));
vi.mock("../src/state/store", () => ({ usePrefs: () => ({ pictureQuality: "medium" }) }));
const drawn = vi.hoisted(() => ({ sources: [] as unknown[] }));
const picker = vi.hoisted(() => ({ files: [] as unknown[] }));
vi.mock("../src/compose/attach-native", () => ({
  nativeAttachPicker: () => ({ pickFiles: async () => ({ kind: "picked", files: picker.files, unreadable: 0 }) }),
  nativeImageShrink: async () => null,
}));
const shared = vi.hoisted(() => ({ calls: [] as string[], ok: true }));
vi.mock("../src/mail/open-attachment-native", () => ({
  shareAttachmentBytes: async (_b: string, mime: string, name: string) => { shared.calls.push(`${name} ${mime}`); return shared.ok; },
}));
vi.mock("../src/ui/AttachmentPreview", () => ({
  AttachmentPreview: (p: { file: { filename: string; preview: string; base64: string }; onClose: () => void }) =>
    h("div", { "data-preview": `${p.file.preview} ${p.file.filename} ${p.file.base64}` }, h("button", { "data-button": "close-preview", onClick: p.onClose })),
}));
const scene = vi.hoisted(() => ({ world: null as unknown }));
vi.mock("../src/state/world", () => ({ useWorld: () => scene.world, useWorldToast: () => ({ say: () => undefined }) }));

const { buttonByName, mount, styleOf } = await import("./_rendered-dom");
const { ComposeSheet } = await import("../src/ui/MessageActions");
const { Copy } = await import("../src/copy");
const { onReplySend } = await import("../src/ui/sent-reveal");

const row = (id: string, address: string, createdAt: string) => ({
  id, address, createdAt, status: "connected", organizerRole: null, organizeConsentedAt: null, organizedBy: null,
  organizedByThisInstall: false, organizerState: null, junkFolder: null, sentFolder: null, smtpMaxSizeBytes: null,
  firstSyncStopFolder: null,
});

function composer(signature?: { text: string; html: string }, backLabel?: string, draft?: ComponentProps<typeof ComposeSheet>["draft"]) {
  const rows = [row("mb-1", "ann@x.test", "2026-01-01T00:00:00Z"), row("mb-2", "bob@x.test", "2026-02-01T00:00:00Z")];
  const sendNew = vi.fn(async (..._args: unknown[]) => ({ outcome: "sent" as const }));
  scene.world = {
    mailboxes: { known: true, rows, all: rows, sendingId: "mb-1", organizer: null, ownAddresses: [] },
    signatures: { "mb-1": signature?.text ?? "Ann's signature", "mb-2": "Bob's signature" },
    signing: { html: signature ? { "mb-1": signature.html } : {} },
    standalone: false, boot: { connection: null }, drafts: [], addressBook: [],
    sendOutcome: () => "unknown", sendSettlement: () => ({ draftId: null, failure: null }),
    actions: {
      sendNew, sendSurface: () => undefined, keepEnvelope: () => null, draftLeft: () => null,
      sendAndDoneOffered: () => false, draftKeep: async () => "kept", holdFiles: () => undefined, releaseFiles: () => undefined,
      forwardFiles: () => ({ state: "ready", parts: [] }), forwardPartsSupported: () => true,
      scheduleFilesKept: () => null,
    },
  };
  const closed: number[] = [];
  const draw = () => h(ComposeSheet, { m: null, mode: "new", onClose: () => closed.push(1), backLabel, draft });
  const r = mount(draw());
  const q = (sel: string) => r.el.querySelector(sel) as HTMLElement | null;
  const press = (sel: string) => act(() => { q(sel)!.click(); });
  const type = (label: string, v: string) => act(() => {
    const input = q(`input[data-label="${label}"]`) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = async () => { await act(async () => { q(`button[data-button="${Copy.replySend}"]`)!.click(); }); };
  return { ...r, q, press, type, send, sendNew, closed, redraw: () => r.render(draw()) };
}

let open: ReturnType<typeof composer> | null = null;
afterEach(() => {
  look.paper = false;
  look.platform = "android";
  look.bottom = 0;
  look.keyboardHeight = 0;
  look.windowHeight = 800;
  caret.measure = null;
  open?.unmount();
  open = null;
});

describe("the phone letter while writing", () => {
  const cancelLetter = async (el: HTMLElement) => {
    const cancel = el.querySelector<HTMLElement>(
      `[data-label="${Copy.replyCancel}"], [data-button="${Copy.replyCancel}"]`,
    )!;
    await act(async () => cancel.click());
  };
  it("keeps all address and subject labels in the same gutter with normal text entry", () => {
    look.paper = true;
    const c = open = composer();
    c.press(`button[data-button="${Copy.composeAddCopies}"]`);
    const labelWidth = (name: string) => styleOf([...c.el.querySelectorAll("span")].find((el) => el.textContent === name) ?? null).width;
    const fromWidth = labelWidth(Copy.composeFromLabel);
    expect(fromWidth).toBeGreaterThan(0);
    for (const name of [Copy.forwardTo, Copy.composeCc, Copy.composeBcc, Copy.composeSubject]) {
      expect(labelWidth(name), name).toEqual(fromWidth);
      const field = c.q(`input[data-label="${name}"]`);
      expect(field).not.toBeNull();
      expect(field?.getAttribute("data-placeholder")).toBe("");
      expect(field?.getAttribute("data-keyboard-type")).toBe(name === Copy.composeSubject ? "default" : "email-address");
    }
  });

  it("shows the place the writer returns to and gives an empty letter a neutral Send", async () => {
    look.paper = true;
    const c = open = composer(undefined, Copy.reads);
    expect(c.q(`button[data-button="${Copy.replySend}"]`)?.dataset.face).toBeTruthy();
    await act(async () => c.q(`[data-label="${Copy.reads}"]`)!.click());
    expect(c.closed).toEqual([1]);
  });

  it("grows the body a few lines, then scrolls inside it with the same focused field", () => {
    look.paper = true;
    const c = open = composer();
    const body = c.q(`input[data-label="${Copy.composePaperPlaceholder}"]`)!;
    act(() => body.focus());
    const start = Number(styleOf(body).height);
    expect(start).toBeGreaterThan(0);
    expect(caret.measure).not.toBeNull();
    act(() => caret.measure?.(start + 24));
    expect(Number(styleOf(body).height)).toBeGreaterThan(start);
    act(() => caret.measure?.(1500));
    const bound = Number(styleOf(body).height);
    expect(bound).toBeLessThan(200);
    expect(body.dataset.scroll).toBe("true");
    act(() => caret.measure?.(3000));
    expect(Number(styleOf(body).height)).toBe(bound);
    expect(document.activeElement).toBe(body);
  });

  it("keeps writing tools in the same floating pill as Send, Later and Discard", () => {
    look.paper = true;
    const c = open = composer();
    const body = c.q(`input[data-label="${Copy.composePaperPlaceholder}"]`)!;
    const letter = body.closest('[data-rn="ScrollView"]')!;
    const send = c.q(`button[data-button="${Copy.replySend}"]`)!;
    const later = c.q(`button[data-button="${Copy.sendLater}"]`)!;
    const discard = c.q(`button[data-button="${Copy.draftsDiscard}"]`)!;
    const format = c.q(`[data-label="${Copy.composeFormat}"]`)!;
    expect(letter.contains(format)).toBe(false);
    const pill = [...c.el.querySelectorAll('[data-rn="View"]')].find((view) => (
      styleOf(view).borderRadius === 8 && view.contains(send) && view.contains(later) && view.contains(discard) && view.contains(format)
    ));
    expect(pill).toBeDefined();
    expect(pill?.contains(body)).toBe(false);
    expect(pill?.contains(c.q(`[data-label="${Copy.composeFileTools}"]`))).toBe(true);
    expect(pill?.contains(c.q(`[data-label="${Copy.composeEmoji}"]`))).toBe(true);
  });

  it("opens From and Emoji above the composer without starting another modal or replacing the editor", () => {
    look.paper = true;
    const c = open = composer();
    const body = c.q(`input[data-label="${Copy.composePaperPlaceholder}"]`)!;
    const size = styleOf(body).height;
    act(() => body.focus());
    c.press(`[data-label="${Copy.composeFromChange("ann@x.test")}"]`);
    expect(c.q('[data-phone-menu="inline"]')?.contains(c.q('[data-label="bob@x.test"]'))).toBe(true);
    c.press('[data-label="bob@x.test"]');
    c.press(`[data-label="${Copy.composeEmoji}"]`);
    expect(c.q('[data-phone-menu="inline"]')?.textContent).toContain("🙂");
    expect(styleOf(c.q('[data-label="🙂"]')).minHeight).toBe(44);
    expect(c.el.querySelectorAll("[data-modal]")).toHaveLength(1);
    expect(styleOf(body).height).toBe(size);
    expect(document.activeElement).toBe(body);
  });

  it("uses the same phone menu row dimensions for From choices", () => {
    look.paper = true;
    const c = open = composer();
    c.press(`[data-label="${Copy.composeFromChange("ann@x.test")}"]`);
    const radio = c.q('[data-role="radiogroup"]');
    const choices = [...radio!.querySelectorAll('[data-role="radio"]')];
    expect(choices).toHaveLength(2);
    expect(styleOf(radio).gap).toBe(0);
    for (const choice of choices) expect(styleOf(choice)).toMatchObject({ minHeight: 48, paddingHorizontal: 12 });
  });

  it("opens Send later over the new letter without replacing the editor or losing text", () => {
    look.paper = true;
    const c = open = composer();
    c.type(Copy.forwardTo, "recipient@x.test");
    c.type(Copy.composePaperPlaceholder, "A synthetic letter");
    c.press(`button[data-button="${Copy.sendLater}"]`);
    expect(c.q('[data-phone-menu="inline"]')?.textContent).toContain(Copy.sendLaterPick);
    expect(c.q(`input[data-label="${Copy.composePaperPlaceholder}"]`)?.getAttribute("value")).toBe("A synthetic letter");
  });

  it("opens the forward More panel below the conversation, with no Send later", () => {
    look.paper = true;
    composer().unmount();
    const m = { id: "m1", mailboxId: "mb-1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan" };
    const c = mount(h(ComposeSheet, { m, mode: "forward", inline: true, onClose: () => undefined } as never));
    try {
      expect(c.el.querySelector(`input[data-label="${Copy.forwardNotePlaceholder}"]`)?.getAttribute("data-placeholder"))
        .toBe(Copy.forwardNotePlaceholder);
      act(() => c.el.querySelector<HTMLElement>(`[data-label="${Copy.tabMore}"]`)!.click());
      const overflow = c.el.querySelector('[data-phone-menu="modal"]:not([data-anchor-side])');
      expect(overflow?.textContent).toContain(Copy.draftsDiscard);
      expect(overflow?.textContent).not.toContain(Copy.sendLater);
    } finally {
      c.unmount();
    }
  });

  it("anchors More above the new letter's pill when the keyboard leaves a short window", () => {
    look.paper = true;
    look.windowHeight = 460;
    look.keyboardHeight = 280;
    const c = open = composer();
    c.press(`[data-label="${Copy.tabMore}"]`);
    expect(c.q('[data-anchor-side="above"]')?.textContent).toContain(Copy.draftsDiscard);
  });

  it.each(["android", "ios"] as const)("lifts the bottom controls while the %s keyboard is open", (platform) => {
    look.paper = true;
    look.platform = platform;
    look.bottom = 24;
    const c = open = composer();
    const room = c.q("[data-avoid]")!;
    const panel = room.firstElementChild!;
    expect(styleOf(panel).paddingBottom).toBeGreaterThanOrEqual(24);
    look.keyboardHeight = 280;
    c.redraw();
    expect(room.dataset.avoid).toBe(platform === "ios" ? "padding" : "");
    expect(styleOf(room).paddingBottom).toBe(platform === "android" ? 304 : 0);
    expect(styleOf(panel).paddingBottom).toBeGreaterThan(0);
    expect(styleOf(panel).paddingBottom).toBeLessThan(24);
  });

  it.each(["android", "ios"] as const)("shows the leading subject before editing and leaves its caret to the %s input after focus", (platform) => {
    look.paper = true;
    look.platform = platform;
    composer().unmount();
    const message = { id: "m1", from: { name: "Lena", address: "lena@fake.test" },
      subject: "Workshop plans and material samples", earlier: [] };
    const c = mount(h(ComposeSheet, { m: message, mode: "reply", inline: true, onClose: () => undefined } as never));
    try {
      const field = c.el.querySelector<HTMLInputElement>(`input[data-label="${Copy.composeSubject}"]`)!;
      expect(field.value).toBe("Re: Workshop plans and material samples");
      expect(field.dataset.selection).toBe(platform === "android" ? "0:0" : undefined);
      act(() => field.focus());
      act(() => field.setSelectionRange(12, 12));
      expect(field.dataset.selection).toBeUndefined();
      expect(field.selectionStart).toBe(12);
      act(() => field.blur());
      expect(field.dataset.selection).toBeUndefined();
      expect(field.selectionStart).toBe(12);
    } finally {
      c.unmount();
    }
  });

  it.each(["reply", "forward"] as const)("names the sender, audience and subject while composing a %s", (mode) => {
    look.paper = true;
    composer().unmount();
    const message = { id: "m1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan", earlier: [] };
    const c = mount(h(ComposeSheet, { m: message, mode, inline: mode === "reply", onClose: () => undefined } as never));
    try {
      expect(c.el.textContent).toContain(Copy.composeFromLabel);
      expect(c.el.textContent).toContain(Copy.composeSubject);
      if (mode === "reply") {
        expect(c.el.querySelector<HTMLInputElement>(`input[data-label="${Copy.composeSubject}"]`)?.value).toBe("Re: Q3 plan");
        expect(c.el.textContent).toContain(Copy.replyRecipientLabel);
        expect(c.el.textContent).toContain("Lena");
        expect(c.el.querySelector(`[data-label="${Copy.replyPlaceholder}"]`)?.getAttribute("data-autofocus")).toBe("true");
      } else {
        expect(c.el.textContent).toContain("Fwd: Q3 plan");
        expect(c.el.querySelector(`[data-label="${Copy.forwardTo}"]`)?.getAttribute("data-autofocus")).toBe("true");
      }
    } finally {
      c.unmount();
    }
  });

  it("keeps a reopened forward's copies when only its From changes", async () => {
    vi.useFakeTimers();
    look.paper = true;
    composer().unmount();
    const actions = (scene.world as { actions: Record<string, unknown> }).actions;
    const keep = vi.fn(async (_draft: unknown) => "kept" as const);
    actions.draftKeep = keep;
    const message = { id: "m1", mailboxId: "mb-1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan" };
    const draft = {
      id: "d-1", mailboxId: "mb-1", forwardOf: "m1", forwardParts: null, revision: null,
      subject: "Fwd: Q3 plan", body: "The plan", to: "peer@x.test", cc: "review@x.test", bcc: "records@x.test",
    };
    const c = mount(h(ComposeSheet, { m: message, mode: "forward", draft, onClose: () => undefined } as never));
    try {
      const field = (name: string) => c.el.querySelector<HTMLInputElement>(`input[data-label="${name}"]`);
      expect(field(Copy.composeCc)?.parentElement?.textContent).toContain(draft.cc);
      expect(field(Copy.composeBcc)?.parentElement?.textContent).toContain(draft.bcc);
      expect(field(Copy.composeCc)?.value).toBe("");
      expect(field(Copy.composeBcc)?.value).toBe("");
      const choose = (label: string) => act(() => c.el.querySelector<HTMLElement>(`[data-label="${label}"]`)!.click());
      choose(Copy.composeFromChange("ann@x.test"));
      choose("bob@x.test");
      await act(async () => { vi.advanceTimersByTime(2500); });
      expect(keep).toHaveBeenCalledWith(expect.objectContaining({
        mailboxId: "mb-2", draftId: draft.id, cc: [{ name: null, address: draft.cc }], bcc: [{ name: null, address: draft.bcc }],
      }));
    } finally {
      c.unmount();
      vi.useRealTimers();
    }
  });

  it.each(["disabled", "missing"] as const)("names the fallback From without moving a forward draft whose mailbox is %s", async (state) => {
    vi.useFakeTimers();
    look.paper = true;
    composer().unmount();
    const world = scene.world as { mailboxes: { rows: ReturnType<typeof row>[]; all: ReturnType<typeof row>[] }; actions: Record<string, unknown> };
    const [bound, fallback] = world.mailboxes.rows;
    world.mailboxes.rows = [fallback!];
    world.mailboxes.all = state === "disabled" ? [{ ...bound!, status: "disabled" }, fallback!] : [fallback!];
    const keep = vi.fn(async (_draft: unknown) => "kept" as const);
    world.actions.draftKeep = keep;
    const message = { id: "m1", mailboxId: "mb-1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan" };
    const draft = {
      id: "d-1", mailboxId: "mb-1", forwardOf: "m1", forwardParts: null, revision: null,
      subject: "Fwd: Q3 plan", body: "The plan", to: "peer@x.test", cc: "", bcc: "",
    };
    const c = mount(h(ComposeSheet, { m: message, mode: "forward", draft, onClose: () => undefined } as never));
    try {
      await act(async () => { vi.advanceTimersByTime(2500); });
      expect(keep).not.toHaveBeenCalled();
      expect(c.el.textContent).toContain("bob@x.test");
      expect(c.el.textContent).toContain(state === "disabled" ? Copy.composeFromSubstituted("ann@x.test") : Copy.composeFromSubstitutedUnknown);
    } finally {
      c.unmount();
      vi.useRealTimers();
    }
  });

  it.each([
    { edited: true, exit: "Cancel" },
    { edited: true, exit: "unmount" },
    { edited: false, exit: "Cancel" },
  ])("keeps forward recipients at $exit when edited is $edited", async ({ edited, exit }) => {
    look.paper = true;
    composer().unmount();
    const keep = vi.fn(async (_draft: unknown) => "kept" as const);
    (scene.world as { actions: Record<string, unknown> }).actions.draftKeep = keep;
    const message = { id: "m1", mailboxId: "mb-1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan" };
    const close = vi.fn();
    const c = mount(h(ComposeSheet, { m: message, mode: "forward", onClose: close } as never));
    let unmounted = false;
    try {
      if (edited) {
        const cc = c.el.querySelector<HTMLInputElement>(`input[data-label="${Copy.composeCc}"]`)!;
        act(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(cc, "review@x.test");
          cc.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      if (exit === "unmount") {
        await act(async () => c.unmount());
        unmounted = true;
      } else {
        await cancelLetter(c.el);
        expect(close).toHaveBeenCalledOnce();
      }
      if (edited) expect(keep).toHaveBeenCalledWith(expect.objectContaining({
        mode: "forward", body: "", subject: "Fwd: Q3 plan", cc: [{ name: null, address: "review@x.test" }],
      }));
      else expect(keep).not.toHaveBeenCalled();
    } finally {
      if (!unmounted) c.unmount();
    }
  });

  it.each(["forward", "reply"] as const)("keeps a %s draft when the sender is the only edit", async (mode) => {
    look.paper = true;
    composer().unmount();
    const keep = vi.fn(async (_draft: unknown) => "kept" as const);
    (scene.world as { actions: Record<string, unknown> }).actions.draftKeep = keep;
    const message = { id: "m1", mailboxId: "mb-1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan" };
    const c = mount(h(ComposeSheet, { m: message, mode, onClose: () => undefined } as never));
    try {
      const choose = (label: string) => c.el.querySelector<HTMLElement>(`[data-label="${label}"]`)!.click();
      act(() => choose(Copy.composeFromChange("ann@x.test")));
      act(() => choose("bob@x.test"));
      await cancelLetter(c.el);
      expect(keep).toHaveBeenCalledWith(expect.objectContaining({
        mode, mailboxId: "mb-2", messageId: "m1", to: [], body: "",
        ...(mode === "forward" ? { cc: [], bcc: [] } : {}),
      }));
      if (mode === "reply") {
        expect(keep.mock.calls[0]![0]).not.toHaveProperty("cc");
        expect(keep.mock.calls[0]![0]).not.toHaveProperty("bcc");
      }
    } finally {
      c.unmount();
    }
  });

  it("sends an inline reply and its signature from the chosen mailbox", async () => {
    look.paper = true;
    composer().unmount();
    const actions = (scene.world as { actions: Record<string, unknown> }).actions;
    const send = vi.fn(async (..._args: unknown[]) => ({ outcome: "sent" as const }));
    actions.sendReply = send;
    const m = { id: "m1", mailboxId: "mb-1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan" };
    const c = mount(h(ComposeSheet, { m, mode: "reply", inline: true, onClose: () => undefined } as never));
    try {
      const choose = (label: string) => {
        const control = c.el.querySelector<HTMLElement>(`[data-label="${label}"]`);
        expect(control, label).not.toBeNull();
        control!.click();
      };
      act(() => choose(Copy.composeFromChange("ann@x.test")));
      act(() => choose("bob@x.test"));
      expect(c.el.textContent).toContain("bob@x.test");
      act(() => {
        const body = c.el.querySelector<HTMLInputElement>(`input[data-label="${Copy.replyPlaceholder}"]`)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(body, "I can join.");
        body.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => c.el.querySelector<HTMLElement>(`[data-button="${Copy.replySend}"]`)!.click());
      expect(send.mock.calls[0]?.slice(0, 4)).toEqual(["m1", "I can join.", false, "Bob's signature"]);
      expect(send.mock.calls[0]?.at(-1)).toBe("mb-2");
    } finally {
      c.unmount();
    }
  });

  it("opens the reply-all audience for editing, focuses To, and sends only the edited envelope", async () => {
    look.paper = true;
    composer().unmount();
    const actions = (scene.world as { actions: Record<string, unknown> }).actions;
    const send = vi.fn(async (..._args: unknown[]) => ({ outcome: "sent" as const }));
    actions.sendReply = send;
    actions.keepEnvelope = () => ({
      to: [{ name: "Lena", address: "lena@x.test" }],
      cc: [{ name: "Peer", address: "peer@x.test" }],
      subject: "Re: Q3 plan",
    });
    const m = { id: "m1", mailboxId: "mb-1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan",
      replyAllHead: { to: "Lena", cc: "Peer" } };
    const c = mount(h(ComposeSheet, { m, mode: "replyAll", inline: true, onClose: () => undefined } as never));
    try {
      const field = (label: string) => c.el.querySelector<HTMLInputElement>(`input[data-label="${label}"]`);
      const type = (label: string, value: string) => act(() => {
        const input = field(label)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const press = (selector: string) => act(() => c.el.querySelector<HTMLElement>(selector)!.click());
      expect(field(Copy.forwardTo)).toBeNull();
      expect(field(Copy.composeSubject)?.value).toBe("Re: Q3 plan");
      const change = c.el.querySelector<HTMLElement>('[data-button="Change recipients"], [data-label="Change recipients"]');
      expect(change?.textContent).toBe("");
      expect(change?.querySelector('[data-icon="person"]')).not.toBeNull();
      act(() => change!.click());
      expect(document.activeElement).toBe(field(Copy.forwardTo));
      expect(field(Copy.composeCc)).not.toBeNull();
      expect(field(Copy.composeBcc)).not.toBeNull();
      press(`[data-label="${Copy.composeRemoveRecipient("Peer")}"]`);
      type(Copy.composeBcc, "quiet@x.test");
      type(Copy.composeSubject, "Agenda");
      type(Copy.replyPlaceholder, "I can join.");
      press(`[data-button="${Copy.replySend}"]`);
      await act(async () => {});
      expect(send.mock.calls[0]?.slice(0, 3)).toEqual(["m1", "I can join.", true]);
      expect(send.mock.calls[0]?.at(-1)).toEqual({
        replyEnvelope: { to: [{ name: "Lena", address: "lena@x.test" }], cc: [], bcc: [{ name: null, address: "quiet@x.test" }] },
        replySubject: "Agenda",
      });
    } finally {
      c.unmount();
    }
  });

  it("keeps Send as new from reverting an invalid edited reply audience to the parent", async () => {
    look.paper = true;
    composer().unmount();
    const actions = (scene.world as { actions: Record<string, unknown> }).actions;
    const send = vi.fn(async (..._args: unknown[]) => ({ outcome: "sent" as const }));
    actions.sendReply = send;
    actions.draftLeft = () => "sent";
    const m = { id: "m1", mailboxId: "mb-1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan" };
    const draft = { id: "d-1", replyTo: m.id, mailboxId: "mb-1", body: "First version", subject: "Plan",
      to: "guest@x.test", cc: "", bcc: "", forwardOf: null, forwardParts: null, revision: null };
    const c = mount(h(ComposeSheet, { m, mode: "reply", draft, onClose: () => undefined } as never));
    try {
      const type = (label: string, value: string) => act(() => {
        const input = c.el.querySelector<HTMLInputElement>(`input[data-label="${label}"]`)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const button = (label: string) => c.el.querySelector<HTMLButtonElement>(`[data-button="${label}"]`);
      type(Copy.replyPlaceholder, "New words.");
      await act(async () => button(Copy.replySend)!.click());
      expect(button(Copy.composeSendAsNew)).not.toBeNull();
      type(Copy.composeBcc, "unfinished@");
      await act(async () => button(Copy.composeSendAsNew)!.click());
      expect(send).not.toHaveBeenCalled();
      type(Copy.composeBcc, "private@x.test");
      await act(async () => button(Copy.composeSendAsNew)!.click());
      expect(send.mock.calls[0]?.[7]).toBeNull();
      expect(send.mock.calls[0]?.at(-1)).toMatchObject({ replyEnvelope: {
        to: [{ name: null, address: "guest@x.test" }], bcc: [{ name: null, address: "private@x.test" }],
      } });
    } finally {
      c.unmount();
    }
  });

  it("rechecks the edited reply audience at the Send later appointment", async () => {
    look.paper = true;
    composer().unmount();
    const actions = (scene.world as { actions: Record<string, unknown> }).actions;
    const send = vi.fn(async (..._args: unknown[]) => ({ outcome: "sent" as const }));
    actions.sendReply = send;
    const m = { id: "m1", mailboxId: "mb-1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan" };
    const c = mount(h(ComposeSheet, { m, mode: "reply", inline: true, onClose: () => undefined } as never));
    try {
      const type = (label: string, value: string) => act(() => {
        const input = c.el.querySelector<HTMLInputElement>(`input[data-label="${label}"]`)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const press = (selector: string) => act(() => c.el.querySelector<HTMLElement>(selector)!.click());
      press(`[data-label="${Copy.replyChangeRecipients}"], [data-button="${Copy.replyChangeRecipients}"]`);
      type(Copy.replyPlaceholder, "New words.");
      press(`[data-label="${Copy.tabMore}"]`);
      press(`[data-menu-row="${Copy.sendLater}"]`);
      type(Copy.composeCc, "unfinished@");
      await act(async () => c.el.querySelector<HTMLElement>(`[data-menu-row="${Copy.sendLaterTomorrow()}"]`)!.click());
      expect(send).not.toHaveBeenCalled();
    } finally {
      c.unmount();
    }
  });

  it("Change seeds the current reply plan and a later mailbox refresh cannot change the visible audience", async () => {
    look.paper = true;
    composer().unmount();
    const actions = (scene.world as { actions: Record<string, unknown> }).actions;
    const send = vi.fn(async (..._args: unknown[]) => ({ outcome: "sent" as const }));
    actions.sendReply = send;
    const owner = { name: "Owner", address: "owner@x.test" };
    const correspondent = { name: "Peer", address: "peer@x.test" };
    let audience = owner;
    actions.keepEnvelope = () => ({ to: [audience], cc: [], subject: "Re: Q3 plan" });
    const m = { id: "m1", mailboxId: "mb-1", from: owner, subject: "Q3 plan" };
    const draw = () => h(ComposeSheet, { m, mode: "reply", inline: true, onClose: () => undefined } as never);
    const c = mount(draw());
    try {
      audience = correspondent;
      c.render(draw());
      expect(c.el.textContent).toContain("Peer");
      act(() => c.el.querySelector<HTMLElement>(`[data-label="${Copy.replyChangeRecipients}"], [data-button="${Copy.replyChangeRecipients}"]`)!.click());
      expect(c.el.querySelector(`[data-label="${Copy.composeRemoveRecipient("Peer")}"]`)).not.toBeNull();
      audience = owner;
      c.render(draw());
      act(() => {
        const input = c.el.querySelector<HTMLInputElement>(`input[data-label="${Copy.replyPlaceholder}"]`)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "New words.");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => c.el.querySelector<HTMLElement>(`[data-button="${Copy.replySend}"]`)!.click());
      expect(send.mock.calls[0]?.at(-1)).toEqual({ replyEnvelope: { to: [correspondent], cc: [], bcc: [] } });
    } finally {
      c.unmount();
    }
  });

  it("records the actual fallback From before sending a reply whose chosen mailbox disconnected", async () => {
    look.paper = true;
    composer().unmount();
    const w = scene.world as {
      mailboxes: { rows: ReturnType<typeof row>[]; all: Array<Omit<ReturnType<typeof row>, "status"> & { status: string }> };
      actions: Record<string, unknown>;
    };
    w.actions.sendReply = vi.fn(async () => ({ outcome: "queued" as const }));
    const mirror = new MemoryMirrorStore();
    await mirror.load();
    const door = letterDoor(mirror);
    openLetterSession({ door, uuid: () => "reply-after-disconnect" });
    const m = { id: "m1", mailboxId: "mb-1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan" };
    const draw = () => h(ComposeSheet, { m, mode: "reply", inline: true, onClose: () => undefined } as never);
    const c = mount(draw());
    try {
      const choose = (label: string) => c.el.querySelector<HTMLElement>(`[data-label="${label}"]`)!.click();
      act(() => choose(Copy.composeFromChange("ann@x.test")));
      act(() => choose("bob@x.test"));
      w.mailboxes.rows = [w.mailboxes.rows[0]!];
      w.mailboxes.all = [w.mailboxes.rows[0]!, { ...w.mailboxes.all[1]!, status: "disabled" }];
      c.render(draw());
      expect(c.el.textContent).toContain(Copy.composeFromSubstituted("bob@x.test"));
      act(() => {
        const input = c.el.querySelector<HTMLInputElement>(`input[data-label="${Copy.replyPlaceholder}"]`)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "I can join.");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => c.el.querySelector<HTMLElement>(`[data-button="${Copy.replySend}"]`)!.click());
      expect(door.letter("reply-after-disconnect")).toMatchObject({ mailboxId: "mb-2", send: { mailboxId: "mb-1" } });
      await restoreLetters({
        door, owned: new Set(), keep: async () => "refused", hasMessage: () => true, drafts: () => [],
        firstSync: async () => undefined, parse: keptRecipients,
        outbox: () => [{ key: "fallback-send", mutation: {
          kind: "mail_send", inReplyTo: "m1", body: "I can join.\n\nAnn's signature", mailboxId: "mb-1",
        } }],
      });
      expect(door.letter("reply-after-disconnect")?.send?.key).toBe("fallback-send");
    } finally {
      c.unmount();
      openLetterSession(null);
    }
  });
});

it.each([
  { exit: "Back", answerFirst: "saved" },
  { exit: "System dismissal", answerFirst: "saved" },
  { exit: "Close sheet", answerFirst: "saved" },
  { exit: "Close sheet", answerFirst: "offline" },
  { exit: "Close sheet", answerFirst: "refused" },
])("keeps edits in Drafts when native $exit leaves after the first save was $answerFirst", async ({ exit, answerFirst }) => {
  let now = new Date("2026-11-25T08:00:00.000Z");
  const store = new MemoryMirrorStore();
  await store.load();
  let answer!: () => void;
  const firstAnswer = new Promise<void>((resolve) => { answer = resolve; });
  let writes = 0;
  let sequence = 0;
  const engine = new OhmailEngine({
    store,
    now: () => now,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: now.toISOString() }),
      withdrawSend: async () => ({ outcome: "unreachable" }),
      mutate: async (mutation) => {
        writes += 1;
        if (writes === 1) {
          await firstAnswer;
          if (answerFirst !== "saved") {
            throw new MutationRejectedError("Draft save unavailable", { retryable: answerFirst === "offline" });
          }
        }
        const changes = mutationEffects(store, mutation, { now: () => now, uuid: () => `kept-letter-${writes}` })
          .map((effect) => ({ type: effect.type, op: "update", id: effect.id, entity: effect.entity, seq: ++sequence, updatedAt: now.toISOString() })) as SyncChange[];
        return { changes, seq: sequence, ...(mutation.kind === "draft_save" && mutation.draftId === null ? { entityId: changes[0]!.id } : {}) };
      },
      fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    },
  });
  open = composer();
  open.unmount();
  open = null;
  look.paper = exit === "Back";
  const letters = letterDoor(store);
  openLetterSession({ door: letters, uuid: () => "letter-on-the-phone" });
  const actions = liveActions({ engine, toast: () => undefined, now: () => now, letters });
  const w = scene.world as { actions: Record<string, unknown> };
  w.actions.draftKeep = actions.draftKeep;
  const atClose: unknown[] = [];
  const sheet = () => h(ComposeSheet, {
    m: null, mode: "new", onClose: () => atClose.push(liveDrafts(engine.read(), { now, zone: "UTC" })),
  });
  const view = mount(sheet());
  const type = (label: string, value: string) => {
    const field = view.el.querySelector<HTMLInputElement>(`input[data-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const bodyLabel = look.paper ? Copy.composePaperPlaceholder : Copy.composeBodyPlaceholder;
  const close = () => act(async () => {
    if (exit === "System dismissal") view.el.querySelector("[data-modal]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else buttonByName(view.el, exit === "Back" ? Copy.back : Copy.replyCancel).click();
  });
  try {
    act(() => { type(Copy.composeSubject, "Unfinished letter"); type(bodyLabel, "The first words."); });
    await close();
    expect(writes).toBe(1);
    expect(atClose).toEqual([]);
    if (answerFirst !== "refused") act(() => { type(bodyLabel, "The first words. The last words too."); });
    await act(async () => { answer(); });
    if (answerFirst === "refused") {
      expect(atClose).toEqual([]);
      await close();
      expect(atClose).toEqual([[expect.objectContaining({ subject: "Unfinished letter", preview: "The first words." })]]);
      return;
    }
    const finalDraft = [expect.objectContaining({
      subject: "Unfinished letter", preview: "The first words. The last words too.",
    })];
    if (answerFirst === "offline") {
      expect(atClose).toHaveLength(1);
      expect(engine.pendingMutations()).toHaveLength(1);
      expect(await letters.landed()).toBe("stored");
      expect(letters.letters()).toEqual([expect.objectContaining({
        body: "The first words. The last words too.",
        keep: expect.objectContaining({ key: engine.pendingMutations()[0]!.key }),
      })]);
      now = new Date(now.getTime() + 60_000);
      const settled = await flushQueued(engine, actions.releaseConfirmed);
      const loose = settleLetters(letters, ownedLetters(), settled);
      await restoreLetters({
        door: letters, owned: ownedLetters(), only: new Set(loose.map(({ letter }) => letter)),
        outbox: () => engine.pendingMutations(), keep: actions.draftKeep, hasMessage: () => false,
        drafts: () => engine.read().entries<Record<string, unknown>>("draft").map(({ id, entity }) => ({ ...entity, id })),
        firstSync: () => engine.syncOnce().then(() => undefined), parse: keptRecipients,
      });
      expect(liveDrafts(engine.read(), { now, zone: "UTC" })).toEqual(finalDraft);
    } else {
      expect(atClose).toEqual([finalDraft]);
    }
    expect(writes).toBe(answerFirst === "offline" ? 3 : 2);
  } finally {
    answer();
    view.unmount();
    openLetterSession(null);
  }
});

it("unmount waits for a draft save and keeps the latest words and copies on the row it named", async () => {
  vi.useFakeTimers();
  const fixture = composer();
  fixture.unmount();
  let answer!: () => void;
  const first = new Promise<void>((resolve) => { answer = resolve; });
  const body = "Words added while the save was on the wire.";
  const updated = "Words added before the editor unmounted.";
  const draft = {
    id: "opened-letter", mailboxId: "mb-1", to: "", cc: "ann@x.test", bcc: "bob@x.test",
    subject: "Unfinished letter", body: "Earlier words.", forwardOf: null, forwardParts: null, revision: null,
  };
  const requests: DraftKeep[] = [];
  const w = scene.world as { actions: Record<string, unknown> };
  w.actions.draftKeep = async (request: DraftKeep) => {
    requests.push(request);
    if (requests.length === 1) {
      await first;
      request.rebind?.("replacement-letter");
      request.row?.({ draftId: "replacement-letter", key: "previous-save", revision: "current-revision" });
    }
    return "kept";
  };
  const onClose = vi.fn();
  const view = mount(h(ComposeSheet, { m: null, mode: "new", draft, onClose }));
  const editor = [...view.el.querySelectorAll("input")].find((input) => input.value === draft.body)!;
  const type = (text: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(editor, text);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    type(body);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(requests).toHaveLength(1);
    type(updated);
    view.render(null);
    expect(requests).toHaveLength(1);
    await act(async () => { answer(); });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      draftId: "replacement-letter", revision: "current-revision", waited: ["previous-save"], body: updated,
      cc: [{ address: draft.cc }], bcc: [{ address: draft.bcc }], quiet: true,
    });
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    answer();
    view.unmount();
    vi.useRealTimers();
  }
});

describe("a new mail from the second of two mailboxes", () => {
  it("press From, pick the second: the send names that mailbox and carries its signature", async () => {
    const c = open = composer();
    expect(c.q(`[data-role="radio"]`), "the list waits for the press").toBeNull();
    c.press(`[data-label="${Copy.composeFromChange("ann@x.test")}"]`);
    c.press(`[data-role="radio"][data-label="bob@x.test"]`);
    expect(c.q(`[data-role="radio"]`), "the pick closes the list").toBeNull();
    expect(c.q(`[data-label="${Copy.composeFromChange("bob@x.test")}"]`)).not.toBeNull();
    c.type(Copy.forwardTo, "peer@x.test");
    c.type(Copy.composeBodyPlaceholder, "Hello");
    await c.send();
    expect(c.sendNew).toHaveBeenCalledTimes(1);
    const args = c.sendNew.mock.calls[0]!;
    expect(args[0]).toBe("mb-2");
    expect(args[4]).toBe("Bob's signature");
    expect(c.closed).toEqual([1]);
  });

  it("untouched, it leaves from the oldest connected mailbox with that one's signature", async () => {
    const c = open = composer();
    c.type(Copy.forwardTo, "peer@x.test");
    c.type(Copy.composeBodyPlaceholder, "Hello");
    await c.send();
    expect(c.sendNew.mock.calls[0]![0]).toBe("mb-1");
    expect(c.sendNew.mock.calls[0]![4]).toBe("Ann's signature");
  });
});

it("keeps a long formatted signature folded until asked and sends it whole when folded", async () => {
  const url = "https://example.test/contact?source=signature";
  const signature = {
    text: `Regards,\nExample team\nContact us (${url})`,
    html: `<p>Regards,<br>Example team<br><a href="${url}">Contact us</a></p>`,
  };
  const c = open = composer(signature);
  const toggle = () => c.q(`[data-role="button"][data-label="${Copy.sigLabel}"]`);
  expect(toggle()?.getAttribute("data-expanded")).toBe("false");
  expect(c.el.textContent).not.toContain("Example team");
  act(() => toggle()!.click());
  expect(toggle()?.getAttribute("data-expanded")).toBe("true");
  expect(c.el.textContent).toContain("Example team");
  expect(c.q('[data-role="link"]')?.textContent).toBe("Contact us");
  expect(c.el.textContent).not.toContain(url);
  act(() => toggle()!.click());
  expect(c.el.textContent).not.toContain("Example team");
  c.type(Copy.forwardTo, "reader@example.test");
  c.type(Copy.composeBodyPlaceholder, "The letter's own words.");
  await c.send();
  expect(c.sendNew.mock.calls[0]?.[3]).toBe("The letter's own words.");
  expect(c.sendNew.mock.calls[0]?.[4]).toBe(signature.text);
  expect(c.sendNew.mock.calls[0]?.at(-1)).toBe(signature.html);
});

it("edits the expanded signature for this send without adding it to saved drafts", async () => {
  const signature = { text: "The first team", html: "<p><strong>The first team</strong></p>" };
  vi.useFakeTimers();
  try {
    const c = open = composer(signature, undefined, {
      id: "draft-1", mailboxId: "mb-1", body: "", to: "", cc: "", bcc: "", subject: "Workshop",
      revision: null, forwardOf: null, forwardParts: null,
    });
    const keep = vi.fn(async (_request: DraftKeep) => "kept");
    (scene.world as { actions: { draftKeep: typeof keep } }).actions.draftKeep = keep;
    c.type(Copy.forwardTo, "reader@example.test");
    c.type(Copy.composeBodyPlaceholder, "The letter's own words.");
    c.press(`[data-role="button"][data-label="${Copy.sigLabel}"]`);
    c.press(`button[data-button="${Copy.sigEditAsText}"]`);
    c.type(Copy.sigAria, "The substitute team");
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(keep.mock.calls.at(-1)?.[0].body).toBe("The letter's own words.");
    await c.send();
    const args = c.sendNew.mock.calls[0]!;
    expect(args[4]).toBe("The substitute team");
    expect(args).not.toContain(signature.html);
  } finally {
    vi.useRealTimers();
  }
});

describe("Cc and Bcc on a new mail", () => {
  it("one press shows both fields; what is typed there arrives with the send, each in its own list", async () => {
    const c = open = composer();
    expect(c.q(`input[data-label="${Copy.composeCc}"]`), "hidden until asked for").toBeNull();
    c.press(`button[data-button="${Copy.composeAddCopies}"]`);
    expect(c.q(`button[data-button="${Copy.composeAddCopies}"]`), "the offer goes once taken").toBeNull();
    c.type(Copy.forwardTo, "peer@x.test");
    c.type(Copy.composeCc, "cc@x.test, Dee <dee@x.test>");
    c.type(Copy.composeBcc, "bcc@x.test");
    c.type(Copy.composeBodyPlaceholder, "Hello");
    await c.send();
    const copies = c.sendNew.mock.calls[0]![8] as { cc: { address: string }[]; bcc: { address: string }[] };
    expect(copies.cc.map((r) => r.address)).toEqual(["cc@x.test", "dee@x.test"]);
    expect(copies.bcc.map((r) => r.address)).toEqual(["bcc@x.test"]);
  });

  it("a copy that does not parse holds Send: nothing goes", async () => {
    const c = open = composer();
    c.press(`button[data-button="${Copy.composeAddCopies}"]`);
    c.type(Copy.forwardTo, "peer@x.test");
    c.type(Copy.composeCc, "not an address");
    c.type(Copy.composeBodyPlaceholder, "Hello");
    await c.send();
    expect(c.sendNew).not.toHaveBeenCalled();
  });
});

/* Phone landscape: Android's full-screen IME editor hid the head, the attach row and Send while typing. */
describe("the composer stays on screen while typing", () => {
  it("every field keeps the sheet (no full-screen editor), and the dialog dims under both system bars", () => {
    const c = open = composer();
    c.press(`button[data-button="${Copy.composeAddCopies}"]`);
    const inputs = [...c.el.querySelectorAll("input")];
    expect(inputs.length, "To, Cc, Bcc, Subject, the body").toBeGreaterThanOrEqual(5);
    expect(inputs.filter((i) => i.getAttribute("data-in-place") !== "true").map((i) => i.getAttribute("data-label"))).toEqual([]);
    expect(c.q("[data-modal]")!.getAttribute("data-under-bars")).toBe("true");
  });

  it("every field opens the iOS keyboard in the app's scheme, Dark on a light system included", () => {
    look.scheme = "dark";
    try {
      const c = open = composer();
      c.press(`button[data-button="${Copy.composeAddCopies}"]`);
      const inputs = [...c.el.querySelectorAll("input")];
      expect(inputs.length).toBeGreaterThanOrEqual(5);
      expect(inputs.filter((i) => i.getAttribute("data-keyboard") !== "dark").map((i) => i.getAttribute("data-label"))).toEqual([]);
    } finally {
      look.scheme = "light";
    }
  });
});

/* THE READER UNDER THE SHEET HEARS A REPLY'S SEND (`sent-reveal.ts`): pressed, then confirmed, for the
   message answered; a send that did not go says only that it was pressed, a new mail says nothing. */
describe("a reply's send is said to the reader under the sheet", () => {
  const answer = (outcome: "sent" | "failed", mode: "reply" | "new" = "reply", inline = false, doneOnSend = false) => {
    const c = composer();
    c.unmount();
    const w = scene.world as { actions: Record<string, unknown> };
    const sendReply = vi.fn(async (..._args: unknown[]) => ({ outcome }));
    w.actions.sendReply = sendReply;
    const m = { id: "m1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan", to: [], cc: [], earlier: [], canReplyAll: false };
    const closed: number[] = [];
    const r = mount(h(ComposeSheet, { m: mode === "new" ? null : m, mode, inline, doneOnSend, onClose: () => closed.push(1) } as never));
    return { r, closed, sendReply };
  };
  const heard = (): { said: string[]; off: () => void } => {
    const said: string[] = [];
    return { said, off: onReplySend((n) => said.push(`${n.parentId}:${n.phase}`)) };
  };
  const sendIn = async (el: HTMLElement) => {
    act(() => {
      const body = el.querySelector(`input[data-label="${Copy.replyPlaceholder}"]`) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(body, "Thanks, see you there.");
      body.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { (el.querySelector(`button[data-button="${Copy.replySend}"]`) as HTMLElement).click(); });
  };

  it("sent: pressed, then sent, before the sheet closes", async () => {
    const ear = heard();
    const { r, closed } = answer("sent");
    await sendIn(r.el);
    expect(ear.said).toEqual(["m1:pressed", "m1:sent"]);
    expect(closed).toEqual([1]);
    ear.off();
    r.unmount();
  });

  it("sends the same reply from the conversation without opening a modal", async () => {
    const sheet = answer("sent");
    await sendIn(sheet.r.el);
    const inline = answer("sent", "reply", true);
    expect(inline.r.el.querySelector("[data-modal]")).toBeNull();
    await sendIn(inline.r.el);
    expect(inline.sendReply.mock.calls[0]?.slice(0, 8)).toEqual(sheet.sendReply.mock.calls[0]?.slice(0, 8));
    expect(inline.sendReply).toHaveBeenCalledTimes(1);
    expect(inline.closed).toEqual([1]);
    sheet.r.unmount();
    inline.r.unmount();
  });

  it("the Reply Run's single Send uses the existing Send and Done action", async () => {
    const run = answer("sent", "reply", true, true);
    const body = run.r.el.querySelector(`input[data-label="${Copy.replyPlaceholder}"]`) as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(body, "Thank you.");
      body.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const buttons = [...run.r.el.querySelectorAll<HTMLButtonElement>("button[data-button]")];
    const done = buttons.find((button) => button.dataset.button === Copy.sendAndDone);
    expect(done !== undefined, buttons.map((button) => button.dataset.button).join(", ")).toBe(true);
    await act(async () => { done!.click(); });
    expect(run.sendReply.mock.calls[0]?.slice(0, 7)).toEqual(["m1", "Thank you.", false, "Ann's signature", null, undefined, true]);
    expect(run.closed).toEqual([1]);
    run.r.unmount();
  });

  it("inserts a picked emoji as plain mail text", async () => {
    const { r, sendReply } = answer("sent", "reply", true);
    act(() => { r.el.querySelector<HTMLButtonElement>(`button[data-button="${Copy.composeEmoji}"]`)!.click(); });
    act(() => { r.el.querySelector<HTMLButtonElement>('button[data-button="🙂"]')!.click(); });
    await act(async () => { r.el.querySelector<HTMLButtonElement>(`button[data-button="${Copy.replySend}"]`)!.click(); });
    expect(sendReply.mock.calls[0]?.[1]).toBe("🙂");
    r.unmount();
  });

  it("saves and sends a formatted draft as plain text after its last mark is removed", async () => {
    vi.useFakeTimers();
    try {
      const c = composer();
      c.unmount();
      const keeps: Record<string, unknown>[] = [];
      const w = scene.world as { actions: Record<string, unknown> };
      w.actions.draftKeep = async (k: Record<string, unknown>) => { keeps.push(k); return "kept"; };
      const sendNew = w.actions.sendNew as ReturnType<typeof vi.fn>;
      const draft = { id: "d-1", body: "Thanks, Lena.", mailboxId: "mb-1", to: "lena@x.test", cc: "", bcc: "", subject: "Hi",
        forwardOf: null, forwardParts: null, revision: null };
      const r = mount(h(ComposeSheet, { m: null, mode: "new", draft, inline: true, onClose: () => undefined } as never));
      const body = [...r.el.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value === "Thanks, Lena.")!;
      const labels = () => [...r.el.querySelectorAll<HTMLButtonElement>("button")].map((b) => b.dataset.button);
      const press = async (label: string) => {
        const button = [...r.el.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.dataset.button === label);
        if (!button) throw new Error("no " + label + " in " + labels().join("|"));
        await act(async () => { button.click(); });
      };
      act(() => { body.focus(); caret.select?.(8, 12); });
      await press(Copy.composeFormat);
      await press(Copy.composeBold);
      await act(async () => { vi.advanceTimersByTime(5000); });
      act(() => { caret.select?.(8, 12); });
      if (!labels().includes(Copy.composeBold)) await press(Copy.composeFormat);
      await press(Copy.composeBold);
      await act(async () => { vi.advanceTimersByTime(5000); });
      await press(Copy.replySend);
      expect(keeps.map((k) => k.html)).toEqual(["<p>Thanks, <strong>Lena</strong>.</p>", null]);
      expect(sendNew.mock.calls[0]?.[11]).toBe(null);
      r.unmount();
    } finally { vi.useRealTimers(); }
  });

  it("sends the formatted range as HTML and keeps the text for the send checks", async () => {
    const { r, sendReply } = answer("sent", "reply", true);
    const body = [...r.el.querySelectorAll<HTMLInputElement>("input")].find((input) => input.dataset.label === Copy.replyPlaceholder)!;
    const press = async (label: string) => {
      const button = [...r.el.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.dataset.button === label)!;
      await act(async () => { button.click(); });
    };
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(body, "Thanks, Lena.");
      body.dispatchEvent(new Event("input", { bubbles: true }));
      caret.select?.(8, 12);
    });
    await press(Copy.composeFormat);
    await press(Copy.composeBold);
    await press(Copy.replySend);
    expect(sendReply.mock.calls[0]?.[1]).toBe("Thanks, Lena.");
    expect(sendReply.mock.calls[0]?.at(-1)).toBe("<p>Thanks, <strong>Lena</strong>.</p>");
    r.unmount();
  });

  it("refused: pressed only", async () => {
    const ear = heard();
    const { r } = answer("failed");
    await sendIn(r.el);
    expect(ear.said).toEqual(["m1:pressed"]);
    ear.off();
    r.unmount();
  });
});

/* THE OWNER'S ASK: an attached file shows a thumbnail, and a press on it or its name opens a preview
   of the file; closing comes back to the composer with nothing lost, and the remove control stays. */
describe("an attached file in the composer", () => {
  const file = (filename: string, contentType: string, uri?: string) =>
    ({ filename, contentType, contentBase64: "AAAA", sizeBytes: 3, ...(uri ? { uri } : {}) });
  const attach = async (c: ReturnType<typeof composer>, ...files: unknown[]) => {
    picker.files = files;
    await act(async () => { c.q(`button[data-button="${Copy.attachFile}"]`)!.click(); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  };
  afterEach(() => { shared.calls = []; shared.ok = true; });

  it("a picture shows itself; a PDF and another file show a type mark", async () => {
    const c = open = composer();
    await attach(c, file("beach.jpg", "image/jpeg", "file:///cache/beach.jpg"), file("plan.pdf", "application/pdf"), file("notes.docx", "application/octet-stream"));
    expect([...c.el.querySelectorAll("img")].map((i) => i.getAttribute("data-uri"))).toEqual(["file:///cache/beach.jpg"]);
    expect(c.el.textContent).toContain("PDF");
    expect(c.el.textContent).toContain("DOCX");
  });

  it("a kept draft's picture (bytes, no file) decodes at the box's size, built once while the letter is typed", async () => {
    const c = open = composer();
    await attach(c, file("big.webp", "image/webp"));
    const img = c.el.querySelector("img")!;
    expect(img.getAttribute("data-uri")).toBe("data:image/webp;base64,AAAA");
    expect(img.getAttribute("data-resize"), "Android resizes a data: URI only when asked").toBe("resize");
    drawn.sources = [];
    c.type(Copy.composeBodyPlaceholder, "H");
    c.type(Copy.composeBodyPlaceholder, "Hi");
    expect(drawn.sources.length).toBeGreaterThan(0);
    expect(new Set(drawn.sources).size, "one source for every keystroke's render").toBe(1);
  });

  it("a picture that cannot be drawn falls back to its type mark", async () => {
    const c = open = composer();
    await attach(c, file("IMG_1.HEIC", "image/heic", "file:///cache/IMG_1.HEIC"));
    act(() => { c.el.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(c.el.querySelector("img")).toBeNull();
    expect(c.el.textContent).toContain("HEIC");
  });

  it("pressing the name opens the preview on the file's bytes; closing keeps the letter and the file", async () => {
    const c = open = composer();
    c.type(Copy.composeBodyPlaceholder, "See the plan");
    await attach(c, file("plan.pdf", "application/pdf"));
    expect(c.q("[data-preview]")).toBeNull();
    c.press(`[data-role="button"][data-label="plan.pdf"]`);
    expect(c.q("[data-preview]")!.getAttribute("data-preview")).toBe("pdf plan.pdf AAAA");
    c.press(`button[data-button="close-preview"]`);
    expect(c.q("[data-preview]")).toBeNull();
    expect((c.q(`input[data-label="${Copy.composeBodyPlaceholder}"]`) as HTMLInputElement).value).toBe("See the plan");
    expect(c.q(`[data-label="${Copy.attachRemove("plan.pdf")}"]`)).not.toBeNull();
    expect(shared.calls).toEqual([]);
  });

  it("a file the app cannot show opens in another app; a refusal is said on its row", async () => {
    const c = open = composer();
    shared.ok = false;
    await attach(c, file("notes.docx", "application/octet-stream"));
    await act(async () => { c.q(`[data-role="button"][data-label="notes.docx"]`)!.click(); });
    expect(shared.calls).toEqual(["notes.docx application/octet-stream"]);
    expect(c.q("[data-preview]")).toBeNull();
    expect(c.el.textContent).toContain(Copy.attachmentShareRefused);
  });

  it("the remove control still takes the file off", async () => {
    const c = open = composer();
    await attach(c, file("beach.jpg", "image/jpeg", "file:///cache/beach.jpg"));
    c.press(`[data-label="${Copy.attachRemove("beach.jpg")}"]`);
    expect(c.el.querySelector("img")).toBeNull();
    expect(c.q(`[data-label="beach.jpg"]`)).toBeNull();
  });
});

it.each(["discarded", "queued"] as const)("closes a confirmed %s draft without keeping it again", async (outcome) => {
  const setup = composer();
  setup.unmount();
  look.paper = true;
  const w = scene.world as { actions: Record<string, unknown> };
  const discard = vi.fn(async (_id: string) => outcome);
  const keep = vi.fn(async () => "kept" as const);
  w.actions.draftDiscard = discard;
  w.actions.draftKeep = keep;
  const close = vi.fn();
  const draft = { id: "d-1", body: "Unsent words", mailboxId: "mb-1", to: "", cc: "", bcc: "", subject: "Hi",
    forwardOf: null, forwardParts: null, revision: null };
  const r = mount(h(ComposeSheet, { m: null, mode: "new", draft, onClose: close } as never));
  try {
    const press = async (label: string) => {
      const b = r.el.querySelector<HTMLButtonElement>(`[data-button="${label}"]`);
      expect(b).not.toBeNull();
      await act(async () => b!.click());
    };
    act(() => {
      const subject = r.el.querySelector<HTMLInputElement>(`[data-label="${Copy.composeSubject}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(subject, "Edited subject");
      subject.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(Copy.draftsDiscard);
    expect(discard).not.toHaveBeenCalled();
    await press(Copy.draftsDiscardCancel);
    expect(close).not.toHaveBeenCalled();
    await press(Copy.draftsDiscard);
    await press(Copy.draftsDiscardConfirm);
    expect(discard.mock.calls).toEqual([["d-1"]]);
    expect(close).toHaveBeenCalledOnce();
  } finally { r.unmount(); }
  expect(keep).not.toHaveBeenCalled();
});

describe("message actions while writing in a conversation", () => {
  const letter = {
    id: "root", mailboxId: "mb-1", from: { name: "A sender", address: "other@x.test" }, subject: "A conversation",
    place: "ohbox", time: "", body: "The original letter", unread: true, earlier: [],
    folder: "INBOX", presentedFolder: "INBOX", pile: null, canReplyAll: true, replyAllHead: null,
    noForward: false, forwardAsk: null, labels: [],
  } as const;

  function writing(mode: "reply" | "forward", ownMail = false) {
    look.paper = true;
    composer().unmount();
    const state = scene.world as { actions: Record<string, unknown> };
    const tag = { id: "plans", name: "Plans", hue: "grey" };
    const remember = vi.fn();
    const read = createThreadRead();
    const release = vi.spyOn(read, "release");
    const acts = {
      pileToggle: vi.fn(), resurfaceNow: vi.fn(), tagToggle: vi.fn(), move: vi.fn(), markSeen: vi.fn(),
      deleteMessage: vi.fn(), draftDiscard: vi.fn(), screeningRules: () => null, screeningStayed: () => null,
      screeningUnsubClaim: () => "none", screeningUnsubscribeIds: () => [], screeningForecast: () => null,
      screenSender: vi.fn(),
    };
    Object.assign(state, { worldKey: "work", tags: [tag], screenerConfirmation: { acknowledged: 0, remember } });
    Object.assign(state.actions, acts);
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    const message = { ...letter, ownMail, labels: [], earlier: [] };
    const target = { ...message, id: "answer-target" };
    const view = mount(h(ComposeSheet, { m: target, mode, inline: true, onClose, keyboardHeight: look.keyboardHeight,
      messageActions: { message, record: read, onDeleted } } as never));
    const q = <T extends HTMLElement>(selector: string) => view.el.querySelector<T>(selector);
    const click = (button: HTMLElement | null | undefined) => act(() => { expect(button).toBeTruthy(); button!.click(); });
    const more = () => click(q(`[data-label="${Copy.tabMore}"]`));
    const panel = (label: string) => q(`section[aria-label="${label}"]`);
    const choose = (label: string, choice: string) => click([...panel(label)?.querySelectorAll<HTMLElement>("[data-menu-row]") ?? []]
      .find((row) => row.dataset.menuRow === choice));
    const moreRows = () => [...panel(Copy.tabMore)?.querySelectorAll<HTMLElement>("[data-menu-row]") ?? []]
      .map((row) => row.dataset.menuRow);
    const body = q<HTMLInputElement>(`input[data-label="${mode === "forward" ? Copy.forwardNotePlaceholder : Copy.replyPlaceholder}"]`)!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(body, "My unsent words");
      body.dispatchEvent(new Event("input", { bubbles: true }));
      body.focus();
    });
    return { view, acts, tag, message, body, more, choose, moreRows, panel, release, onClose, onDeleted, remember, click };
  }

  it("uses the conversation's actions and pickers while the same typed reply stays open", () => {
    const writingReply = writing("reply");
    const { view, acts, tag, message, body, more, choose, moreRows, release, panel, onClose } = writingReply;
    try {
      more();
      expect(moreRows()).toEqual([
        Copy.sendLater, Copy.draftsDiscard, Copy.actionLater, Copy.actionSetAside, Copy.actionResurface,
        Copy.actionTag, Copy.actionScreening, Copy.actionMove, Copy.actionMarkRead, Copy.actionDelete,
      ]);
      choose(Copy.tabMore, Copy.actionLater);
      expect(acts.pileToggle.mock.calls).toEqual([[message.id, "replyLater"]]);
      more();
      choose(Copy.tabMore, Copy.actionSetAside);
      expect(acts.pileToggle).toHaveBeenLastCalledWith(message.id, "setAside");
      more();
      choose(Copy.tabMore, Copy.actionResurface);
      choose(Copy.resurfaceWhen, Copy.resurfaceNow);
      expect(acts.resurfaceNow.mock.calls).toEqual([[message.id]]);
      more();
      choose(Copy.tabMore, Copy.actionTag);
      choose(Copy.actionTag, tag.name);
      expect(acts.tagToggle.mock.calls).toEqual([[message.id, tag, true]]);
      more();
      choose(Copy.tabMore, Copy.actionScreening);
      expect(panel(Copy.actionScreening)?.textContent).toContain(Copy.screeningFor(message.from.name));
      choose(Copy.actionScreening, `→ ${Copy.placeOhbox}`);
      expect(acts.screenSender.mock.calls).toEqual([[message.id, "ohbox", "sender", true, undefined, undefined]]);
      more();
      choose(Copy.tabMore, Copy.actionMove);
      choose(Copy.actionMove, Copy.placeReads);
      expect(acts.move.mock.calls).toEqual([[message, "reads"]]);
      more();
      choose(Copy.tabMore, Copy.actionMarkRead);
      expect(acts.markSeen.mock.calls).toEqual([[message.id, false, [message.id], message.id]]);
      expect(release.mock.calls).toEqual([[message.id]]);
      expect(panel(Copy.tabMore)).toBeNull();
      expect(body.isConnected).toBe(true);
      expect(body.value).toBe("My unsent words");
      expect(document.activeElement).toBe(body);
      expect(onClose).not.toHaveBeenCalled();
      expect(acts.draftDiscard).not.toHaveBeenCalled();
    } finally { view.unmount(); }
  });

  it("keeps message Later in a forward and asks before moving the letter to Trash", () => {
    const { view, acts, message, body, more, choose, moreRows, panel, click, onClose, onDeleted, remember } = writing("forward", true);
    try {
      more();
      expect(moreRows()).toEqual([
        Copy.draftsDiscard, Copy.actionLater, Copy.actionSetAside, Copy.actionResurface,
        Copy.actionTag, Copy.actionMove, Copy.actionMarkRead, Copy.actionDelete,
      ]);
      choose(Copy.tabMore, Copy.actionDelete);
      expect(acts.deleteMessage).not.toHaveBeenCalled();
      click(panel(Copy.deleteAsk)?.querySelector("[data-dismiss]"));
      expect(acts.deleteMessage).not.toHaveBeenCalled();
      more();
      choose(Copy.tabMore, Copy.actionDelete);
      choose(Copy.deleteAsk, Copy.actionDelete);
      expect(remember.mock.calls).toEqual([["moveToTrash"]]);
      expect(acts.deleteMessage.mock.calls).toEqual([[message.id, { onCommitted: expect.any(Function) }]]);
      expect(onDeleted).not.toHaveBeenCalled();
      expect(body.isConnected).toBe(true);
      expect(body.value).toBe("My unsent words");
      expect(onClose).not.toHaveBeenCalled();
      act(() => (acts.deleteMessage.mock.calls[0]?.[1] as { onCommitted: () => void }).onCommitted());
      expect(onDeleted).toHaveBeenCalledOnce();
      expect(acts.draftDiscard).not.toHaveBeenCalled();
    } finally { view.unmount(); }
  });

  it("opens an iOS message picker after the writing menu is dismissed", () => {
    look.platform = "ios";
    const { view, more, choose, panel, click, body, tag, acts, message } = writing("reply");
    try {
      more();
      choose(Copy.tabMore, Copy.actionTag);
      expect(panel(Copy.tabMore)).toBeNull();
      expect(panel(Copy.actionTag)).toBeNull();
      click(view.el.querySelector<HTMLElement>("[data-did-dismiss]"));
      choose(Copy.actionTag, tag.name);
      expect(acts.tagToggle.mock.calls).toEqual([[message.id, tag, true]]);
      expect(body.value).toBe("My unsent words");
    } finally { view.unmount(); }
  });

  it.each([true, false])("returns to the writing field after Tag when the keyboard was open: %s", (keyboardOpen) => {
    look.platform = "ios";
    look.keyboardHeight = keyboardOpen ? 300 : 0;
    const { view, more, choose, panel, click, body } = writing("reply");
    try {
      body.setSelectionRange(4, 4);
      more();
      choose(Copy.tabMore, Copy.actionTag);
      click(view.el.querySelector<HTMLElement>("[data-did-dismiss]"));
      act(() => body.blur());
      click(panel(Copy.actionTag)?.querySelector("[data-dismiss]"));
      expect(document.activeElement).not.toBe(body);
      const dismissed = view.el.querySelector<HTMLElement>("[data-did-dismiss]");
      if (dismissed) click(dismissed);
      expect(document.activeElement === body).toBe(keyboardOpen);
      expect(body.selectionStart).toBe(4);
      expect(body.value).toBe("My unsent words");
    } finally { view.unmount(); }
  });
});

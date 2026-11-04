/** @vitest-environment jsdom */
/**
 * A NEW MAIL'S FROM AND ITS COPIES, rendered. With two connected mailboxes the From line opens a
 * list; the address picked is the mailbox the send names and the signature it carries. "Cc, Bcc"
 * shows the two fields, and what is typed there leaves with the send, each in its own list.
 */
import { act, createElement as h, forwardRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const React = await import("react");
  return {
    ...rnDom,
    Modal: (p: { children?: ReactNode }) => React.createElement("div", { "data-modal": "" }, p.children),
    KeyboardAvoidingView: rnDom.View,
    Keyboard: { dismiss: () => undefined, addListener: () => ({ remove: () => undefined }) },
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    useWindowDimensions: () => ({ width: 400, height: 800, scale: 2, fontScale: 1 }),
    TextInput: forwardRef<HTMLInputElement, { value: string; accessibilityLabel?: string; onChangeText?: (v: string) => void; onFocus?: () => void; onBlur?: () => void }>(
      (p, ref) => React.createElement("input", {
        ref, value: p.value, "data-label": p.accessibilityLabel, onFocus: p.onFocus, onBlur: p.onBlur,
        onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value),
      }),
    ),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    c: new Proxy({}, { get: () => "#000" }), radius: new Proxy({}, { get: () => 8 }), type: new Proxy({}, { get: () => ({}) }),
    liftUp: () => ({}), textCap: 2, hit: 48, reduceMotion: true,
  }),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    Tap: rnDom.Pressable,
    Txt: (p: { children?: ReactNode }) => h("span", null, p.children),
    Button: (p: { label: string; disabled?: boolean; onPress?: () => void }) =>
      h("button", { "data-button": p.label, disabled: p.disabled, onClick: p.onPress }, p.label),
    Rule: () => null,
  };
});
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/FadeOut", () => ({ FadeOut: () => null }));
vi.mock("../src/ui/Sheet", () => ({
  Sheet: () => null, SheetBackdrop: () => null, SheetRow: () => null,
  useModalKey: () => "k", useSheetPanelBounds: () => ({}), useSheetRoom: () => ({}),
}));
vi.mock("../src/ui/glass", () => ({ GlassActionBar: () => null, GlassPill: () => null, nextRoom: () => 0 }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({ heightClass: "regular" }) }));
vi.mock("../src/ui/keyboard-lift", () => ({ useKeyboardLift: () => 0 }));
vi.mock("../src/ui/keyboard-native", () => ({ showKeyboardWhenFocused: () => undefined }));
vi.mock("../src/ui/reader-cover", () => ({ useReaderCover: () => undefined }));
vi.mock("../src/ui/bottom-chrome", () => ({ useBottomChromeSlot: () => undefined }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/net/network-door", () => ({ useNetworkNow: () => "online" }));
vi.mock("../src/state/store", () => ({ usePrefs: () => ({ pictureQuality: "medium" }) }));
vi.mock("../src/compose/attach-native", () => ({ nativeAttachPicker: () => ({}), nativeImageShrink: async () => null }));
const scene = vi.hoisted(() => ({ world: null as unknown }));
vi.mock("../src/state/world", () => ({ useWorld: () => scene.world, useWorldToast: () => ({ say: () => undefined }) }));

const { mount } = await import("./_rendered-dom");
const { ComposeSheet } = await import("../src/ui/MessageActions");
const { Copy } = await import("../src/copy");
const { onReplySend } = await import("../src/ui/sent-reveal");

const row = (id: string, address: string, createdAt: string) => ({
  id, address, createdAt, status: "connected", organizerRole: null, organizeConsentedAt: null, organizedBy: null,
  organizedByThisInstall: false, organizerState: null, junkFolder: null, sentFolder: null, smtpMaxSizeBytes: null,
  firstSyncStopFolder: null,
});

function composer() {
  const rows = [row("mb-1", "ann@x.test", "2026-01-01T00:00:00Z"), row("mb-2", "bob@x.test", "2026-02-01T00:00:00Z")];
  const sendNew = vi.fn(async (..._args: unknown[]) => ({ outcome: "sent" as const }));
  scene.world = {
    mailboxes: { known: true, rows, all: rows, sendingId: "mb-1", organizer: null, ownAddresses: [] },
    signatures: { "mb-1": "Ann's signature", "mb-2": "Bob's signature" },
    standalone: false, boot: { connection: null }, drafts: [], addressBook: [],
    sendOutcome: () => "unknown", sendSettlement: () => ({ draftId: null, failure: null }),
    actions: {
      sendNew, sendSurface: () => undefined, keepEnvelope: () => null, draftLeft: () => null,
      sendAndDoneOffered: () => false, draftKeep: async () => "kept", holdFiles: () => undefined, releaseFiles: () => undefined,
    },
  };
  const closed: number[] = [];
  const r = mount(h(ComposeSheet, { m: null, mode: "new", onClose: () => closed.push(1) }));
  const q = (sel: string) => r.el.querySelector(sel) as HTMLElement | null;
  const press = (sel: string) => act(() => { q(sel)!.click(); });
  const type = (label: string, v: string) => act(() => {
    const input = q(`input[data-label="${label}"]`) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = async () => { await act(async () => { q(`button[data-button="${Copy.replySend}"]`)!.click(); }); };
  return { ...r, q, press, type, send, sendNew, closed };
}

let open: ReturnType<typeof composer> | null = null;
afterEach(() => {
  open?.unmount();
  open = null;
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

/* THE READER UNDER THE SHEET HEARS A REPLY'S SEND (`sent-reveal.ts`): pressed, then confirmed, for the
   message answered; a send that did not go says only that it was pressed, a new mail says nothing. */
describe("a reply's send is said to the reader under the sheet", () => {
  const answer = (outcome: "sent" | "failed", mode: "reply" | "new" = "reply") => {
    const c = composer();
    c.unmount();
    const w = scene.world as { actions: Record<string, unknown> };
    w.actions.sendReply = vi.fn(async () => ({ outcome }));
    const m = { id: "m1", from: { name: "Lena", address: "lena@x.test" }, subject: "Q3 plan", to: [], cc: [], earlier: [], canReplyAll: false };
    const closed: number[] = [];
    const r = mount(h(ComposeSheet, { m: mode === "new" ? null : m, mode, onClose: () => closed.push(1) } as never));
    return { r, closed };
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

  it("refused: pressed only", async () => {
    const ear = heard();
    const { r } = answer("failed");
    await sendIn(r.el);
    expect(ear.said).toEqual(["m1:pressed"]);
    ear.off();
    r.unmount();
  });
});

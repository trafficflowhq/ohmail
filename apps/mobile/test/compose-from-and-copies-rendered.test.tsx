/** @vitest-environment jsdom */
/**
 * A NEW MAIL'S FROM AND ITS COPIES, rendered. With two connected mailboxes the From line opens a
 * list; the address picked is the mailbox the send names and the signature it carries. "Cc, Bcc"
 * shows the two fields, and what is typed there leaves with the send, each in its own list.
 */
import { act, createElement as h, forwardRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, MutationRejectedError, OhmailEngine, mutationEffects, type SyncChange } from "@ohmail/client-engine";
import { openLetterSession, ownedLetters } from "../src/compose/letter-keeper";
import { restoreLetters, settleLetters } from "../src/compose/letter-restore";
import { letterDoor } from "../src/compose/letter-store";
import { flushQueued, keptRecipients, liveActions, liveDrafts, type DraftKeep } from "../src/state/live";

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const React = await import("react");
  return {
    ...rnDom,
    Modal: (p: { children?: ReactNode; statusBarTranslucent?: boolean; navigationBarTranslucent?: boolean; onRequestClose?: () => void }) =>
      React.createElement("div", { "data-modal": "", "data-under-bars": String(p.statusBarTranslucent === true && p.navigationBarTranslucent === true),
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Escape") p.onRequestClose?.(); },
      }, p.children),
    KeyboardAvoidingView: rnDom.View,
    Keyboard: { dismiss: () => undefined, addListener: () => ({ remove: () => undefined }) },
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    useWindowDimensions: () => ({ width: 400, height: 800, scale: 2, fontScale: 1 }),
    Image: (p: { source?: { uri?: string }; resizeMethod?: string; onError?: () => void }) => {
      drawn.sources.push(p.source);
      return React.createElement("img", { "data-uri": p.source?.uri, "data-resize": p.resizeMethod, onError: p.onError });
    },
    TextInput: forwardRef<HTMLInputElement, { value: string; accessibilityLabel?: string; disableFullscreenUI?: boolean; keyboardAppearance?: string; onChangeText?: (v: string) => void; onSelectionChange?: (e: { nativeEvent: { selection: { start: number; end: number } } }) => void; onFocus?: () => void; onBlur?: () => void }>(
      (p, ref) => {
        if (p.onSelectionChange) caret.select = (start, end) => p.onSelectionChange?.({ nativeEvent: { selection: { start, end } } });
        return React.createElement("input", {
        ref, value: p.value, "data-label": p.accessibilityLabel, "data-in-place": String(p.disableFullscreenUI === true), "data-keyboard": p.keyboardAppearance, onFocus: p.onFocus, onBlur: p.onBlur,
        onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value),
        });
      },
    ),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const caret = vi.hoisted(() => ({ select: null as null | ((start: number, end: number) => void) }));
const look = vi.hoisted(() => ({ paper: false, scheme: "light" as "light" | "dark" }));
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
    Tap: (p: { accessibilityRole?: string; accessibilityLabel?: string; onPress?: () => void; children?: ReactNode }) =>
      p.accessibilityLabel === "Back" ? h("button", { onClick: p.onPress }, p.accessibilityLabel) : h(rnDom.Pressable, p),
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
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({ heightClass: "regular", panes: 1 }) }));
vi.mock("../src/ui/keyboard-lift", () => ({ useKeyboardLift: () => 0 }));
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

const { buttonByName, mount } = await import("./_rendered-dom");
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
      scheduleFilesKept: () => null,
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
  look.paper = false;
  open?.unmount();
  open = null;
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

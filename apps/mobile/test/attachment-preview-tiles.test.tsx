/** @vitest-environment jsdom */
/**
 * A TAP ON A PICTURE OR A PDF PREVIEWS IT; SHARING IS ITS OWN VERB. The reader's attachment tiles,
 * rendered through React DOM with the WebView drawn as a div that keeps its props: a picture opens
 * a preview with JavaScript off, a PDF one with JavaScript on, neither has a channel back to the
 * app, and every other file is shared at the tap as before. Share sits in the preview's bar, and a
 * document past the frame ceiling is a sentence and Share.
 */
import { act, createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  const React = await import("react");
  return {
    ...rnDom,
    Modal: (p: { children?: ReactNode; onRequestClose?: () => void }) =>
      React.createElement("div", { "data-modal": "", onKeyDown: () => p.onRequestClose?.() }, p.children),
    ActivityIndicator: () => null,
    Animated: { View: rnDom.View, Value: class { setValue() {} }, timing: () => ({ start: () => undefined }) },
    AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
    Easing: { bezier: () => (x: number) => x },
    Linking: { openURL: async () => undefined },
    ScrollView: rnDom.ScrollView,
    useWindowDimensions: () => ({ width: 400, height: 800, scale: 2 }),
  };
});
const webviews = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("react-native-webview", async () => {
  const React = await import("react");
  return {
    WebView: (p: Record<string, unknown>) => { webviews.props.push(p); return React.createElement("div", { "data-webview": "" }); },
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const shared = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/mail/open-attachment-native", () => ({
  shareAttachmentBytes: async (_b: string, mime: string, name: string) => { shared.calls.push(`${name} ${mime}`); return true; },
}));
const ceiling = vi.hoisted(() => ({ chars: 8_000_000 }));
vi.mock("../src/mail/frame-ceiling-native", () => ({ phoneFrameCeiling: () => ceiling.chars }));
vi.mock("../src/mail/pdf-frame-native", () => ({ pdfFrameScripts: () => ({ lib: "/* lib */", worker: "/* worker */", controller: "/* controller */" }) }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }), radius: new Proxy({}, { get: () => 10 }), lift: () => ({}), reduceMotion: true }),
}));
vi.mock("../src/ui/base", async () => {
  const React = await import("react");
  const { rnDom } = await import("./_rendered-dom");
  return {
    Tap: rnDom.Pressable,
    Txt: (p: { children?: ReactNode }) => React.createElement("span", null, p.children),
    Button: (p: { label: string; onPress?: () => void }) => React.createElement("button", { onClick: p.onPress }, p.label),
    Chip: () => null, TagChip: () => null, Panel: rnDom.View, Screen: rnDom.View, Scroller: rnDom.View,
    useListInsets: () => ({}),
  };
});
const bytes = vi.hoisted(() => ({ next: null as unknown }));
vi.mock("../src/state/world", () => ({
  useWorld: () => ({ actions: { openAttachmentBytes: async () => bytes.next } }),
  useBodyStamp: () => 0, useFilesStamp: () => 0, useWorldToast: () => ({ say: () => undefined }),
}));
vi.mock("../src/state/live", () => ({ JUNK_REFILL_BOUND_MS: 10_000, readerZone: () => "UTC" }));
vi.mock("expo-router", () => ({ useIsFocused: () => true, router: { push: () => undefined } }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/Sheet", () => ({ Sheet: () => null, SheetRow: () => null, useModalKey: () => "k" }));
vi.mock("../src/ui/MessageActions", () => ({ MessageActions: () => null }));
vi.mock("../src/ui/MailBodyFrame", () => ({ MailBodyFrame: () => null }));
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null, PaneTop: () => null }));
vi.mock("../src/ui/BodyPages", () => ({ BodyPages: () => null }));
vi.mock("../src/ui/HistoryFold", () => ({ HistoryFold: () => null, HistoryRow: () => null }));
vi.mock("../src/ui/EventCard", () => ({ EventCards: () => null }));
vi.mock("../src/ui/FadeOut", () => ({ FadeOut: () => null }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({}) }));
vi.mock("../src/engine/ui-marks", () => ({ beginMark: () => undefined, endMark: () => undefined }));

const { mount } = await import("./_rendered-dom");
const { AttachmentTiles } = await import("../src/ui/MessageReader");

const tile = (filename: string, mime: string) => ({ id: filename, filename, size: "1 KB", sizeBytes: 1024, inline: false, mime, state: "idle" as const });
const ready = (filename: string, mime: string, preview: "image" | "pdf" | null) =>
  ({ state: "ready", base64: "JVBERi0=", mime, filename, preview });

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
async function press(filename: string, mime: string, preview: "image" | "pdf" | null) {
  bytes.next = ready(filename, mime, preview);
  const s = mount(h(AttachmentTiles, { m: { id: "m1", attachments: [tile(filename, mime)] } }));
  await act(async () => { (s.el.querySelector(`[data-label="${filename}"]`) as HTMLElement).click(); });
  await settle();
  return s;
}
const button = (el: HTMLElement, label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label);

afterEach(() => { webviews.props = []; shared.calls = []; ceiling.chars = 8_000_000; });

describe("a tap on an attachment", () => {
  it("a picture opens the preview with JavaScript off and no channel back; nothing is shared", async () => {
    const s = await press("beach.png", "image/png", "image");
    expect(s.el.querySelector("[data-modal]")).not.toBeNull();
    const p = webviews.props.at(-1)!;
    expect(p.javaScriptEnabled).toBe(false);
    expect(p).not.toHaveProperty("onMessage");
    expect(p).not.toHaveProperty("injectedJavaScript");
    expect(p).not.toHaveProperty("injectedJavaScriptBeforeContentLoaded");
    expect([p.allowFileAccess, p.domStorageEnabled, p.setSupportMultipleWindows, p.cacheEnabled, p.incognito]).toEqual([false, false, false, false, true]);
    expect(shared.calls).toEqual([]);
    s.unmount();
  });

  it("a PDF opens the preview with JavaScript on and still no channel back", async () => {
    const s = await press("plan.pdf", "application/pdf", "pdf");
    const p = webviews.props.at(-1)!;
    expect(p.javaScriptEnabled).toBe(true);
    expect(p).not.toHaveProperty("onMessage");
    expect(p).not.toHaveProperty("injectedJavaScript");
    expect(String((p.source as { html: string }).html)).toContain("script-src 'nonce-");
    s.unmount();
  });

  it("the preview admits its own document once and refuses every other navigation", async () => {
    const s = await press("beach.png", "image/png", "image");
    const go = webviews.props.at(-1)!.onShouldStartLoadWithRequest as (r: { url: string }) => boolean;
    expect([go({ url: "about:blank" }), go({ url: "about:blank" }), go({ url: "https://example.invalid/" })]).toEqual([true, false, false]);
    s.unmount();
  });

  it.each([["invite.ics", "text/calendar"], ["logo.svg", "image/svg+xml"]])("%s is shared at the tap, as before", async (name, mime) => {
    const s = await press(name, mime, null);
    expect(shared.calls).toEqual([`${name} ${mime}`]);
    expect(s.el.querySelector("[data-modal]")).toBeNull();
    s.unmount();
  });

  it("Share in the preview's bar shares the file", async () => {
    const s = await press("beach.png", "image/png", "image");
    await act(async () => { button(s.el, "Share")!.click(); });
    expect(shared.calls).toEqual(["beach.png image/png"]);
    s.unmount();
  });

  it("past the frame ceiling: no WebView, the sentence and Share", async () => {
    ceiling.chars = 10;
    const s = await press("plan.pdf", "application/pdf", "pdf");
    expect(webviews.props).toEqual([]);
    expect(s.el.textContent).toContain("This file is too large to show here. Share it to open it in another app.");
    await act(async () => { button(s.el, "Share")!.click(); });
    expect(shared.calls).toEqual(["plan.pdf application/pdf"]);
    s.unmount();
  });

  it("a renderer that dies: the sentence and Share", async () => {
    const s = await press("plan.pdf", "application/pdf", "pdf");
    await act(async () => { (webviews.props.at(-1)!.onRenderProcessGone as () => void)(); });
    expect(s.el.textContent).toContain("This file can't be shown here. Share it to open it in another app.");
    s.unmount();
  });
});

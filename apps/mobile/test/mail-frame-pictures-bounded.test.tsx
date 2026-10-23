/** @vitest-environment jsdom */
/**
 * ONE PICTURE BUDGET PER MESSAGE. The frame's consented fetch (`MailBodyFrame` → `fetchRemoteImages`)
 * spends the engine's inline-image ceilings once for a message, across every pass: a minted picture
 * re-renders the frame, and that re-render must not start a fresh budget, ask a failed url again, or
 * record the press again. Only the door's fetch is a counting double; the frame, the sanitizer and the
 * fetch are the real ones.
 */
import { createElement as h, act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INLINE_IMAGE_MAX_PARTS } from "@ohmail/client-engine";
import { mount } from "./_rendered-dom";

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return { ...rnDom, useWindowDimensions: () => ({ width: 400, height: 800, scale: 2, fontScale: 1 }), Linking: { openURL: async () => undefined } };
});
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("react-native-webview", () => ({ WebView: () => h("div", { "data-webview": "" }) }));
vi.mock("../src/mail/frame-ceiling-native", () => ({ phoneFrameCeiling: () => 512 * 1024 * 1024 }));
vi.mock("../src/mail/frame-nav", () => ({ frameNavDecision: () => ({ kind: "none" }), openConfirmedLink: () => undefined }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }), layout: { proseMax: 600 }, radius: { pill: 999 }, type: new Proxy({}, { get: () => ({}) }) }),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return { Txt: rnDom.Text, Tap: rnDom.Pressable };
});
vi.mock("../src/ui/Sheet", () => ({ Sheet: () => null, SheetRow: () => null }));
vi.mock("../src/ui/BodyPages", () => ({ BodyPages: () => null }));

const door = { gets: [] as string[], posts: 0, failing: new Set<string>() };
const fakeFetch = async (url: string, init?: { method?: string }) => {
  if (init?.method === "POST" && url.includes("/load-remote")) {
    door.posts++;
    return { ok: true, status: 200, json: async () => ({}) };
  }
  const u = new URL(url).searchParams.get("u") ?? "";
  door.gets.push(u);
  if (door.failing.has(u)) return { ok: false, status: 404 };
  return { ok: true, status: 200, blob: async () => ({ type: "image/png", size: 1024, arrayBuffer: async () => new Uint8Array(1024).buffer }) };
};
const route = { via: "proxy" as const, base: "https://door.example.net", fetch: fakeFetch, flavor: "managed" };
vi.mock("../src/state/world", () => ({
  useWorld: () => ({ images: route, actions: { loadInlineImages: () => undefined } }),
  useWorldToast: () => ({ say: () => undefined }),
}));

const { MailBodyFrame } = await import("../src/ui/MailBodyFrame");
const { Copy } = await import("../src/copy");

const good = (i: number) => `https://img.example.com/art/g${i}.png`;
const bad = (i: number) => `https://down.example.org/art/f${i}.png`;
function newsletter(goods: number, bads: number, badFirst = false): string {
  const g = Array.from({ length: goods }, (_, i) => `<p>Story ${i + 1}</p><img src="${good(i + 1)}" width="300" height="200">`);
  const b = Array.from({ length: bads }, (_, i) => `<p>Gone ${i + 1}</p><img src="${bad(i + 1)}" width="300" height="200">`);
  return `<html><body>${(badFirst ? [...b, ...g] : [...g, ...b]).join("")}</body></html>`;
}

/** Until the door has been quiet for a while. */
async function settle(): Promise<void> {
  let last = -1;
  let still = 0;
  for (let i = 0; i < 400 && still < 25; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    const now = door.gets.length * 1000 + door.posts;
    still = now === last ? still + 1 : 0;
    last = now;
  }
}

let mounted: ReturnType<typeof mount> | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; door.gets = []; door.posts = 0; door.failing = new Set(); });

const pressShowImages = (el: HTMLElement): void => {
  const btn = [...el.querySelectorAll<HTMLElement>('[data-role="button"]')].find((e) => e.textContent === Copy.mailShowImages);
  expect(btn, "Show images is offered").toBeTruthy();
  act(() => { btn!.click(); });
};
const repeats = (): number => door.gets.length - new Set(door.gets).size;

describe("the frame's pictures stay under one budget per message", () => {
  it("a press over 30 pictures: at most the part ceiling fetched, one consent, no url asked twice", async () => {
    for (let i = 1; i <= 5; i++) door.failing.add(bad(i));
    mounted = mount(h(MailBodyFrame, { m: { id: "m-1", html: newsletter(25, 5), body: "", loadedRemoteContent: false } as never, onShowAsText: () => undefined }));
    await settle();
    expect(door.gets).toHaveLength(0);
    pressShowImages(mounted.el);
    await settle();
    expect(door.gets.length).toBeLessThanOrEqual(INLINE_IMAGE_MAX_PARTS);
    expect(door.posts).toBe(1);
    expect(repeats()).toBe(0);
  });

  it("failing pictures first: each asked once, and the budget still ends the fetch", async () => {
    for (let i = 1; i <= 5; i++) door.failing.add(bad(i));
    mounted = mount(h(MailBodyFrame, { m: { id: "m-2", html: newsletter(25, 5, true), body: "", loadedRemoteContent: false } as never, onShowAsText: () => undefined }));
    await settle();
    pressShowImages(mounted.el);
    await settle();
    expect(door.gets.length).toBeLessThanOrEqual(INLINE_IMAGE_MAX_PARTS + 5);
    expect(door.posts).toBe(1);
    expect(repeats()).toBe(0);
  });

  it("the stored flag over 100 pictures: the part ceiling, nothing more", async () => {
    mounted = mount(h(MailBodyFrame, { m: { id: "m-3", html: newsletter(100, 0), body: "", loadedRemoteContent: true } as never, onShowAsText: () => undefined }));
    await settle();
    expect(door.gets).toHaveLength(INLINE_IMAGE_MAX_PARTS);
    expect(door.posts).toBe(0);
  });

  it("opening a folded history asks for its own pictures only", async () => {
    const html = `<html><body><p>Thanks, see you.</p><img src="${good(1)}" width="300" height="200">`
      + "<div>On Thu, 22 Oct 2026 at 09:14, A &lt;a@example.com&gt; wrote:</div>"
      + `<blockquote type="cite"><p>Old news.</p><img src="${good(2)}" width="300" height="200"><img src="${good(3)}" width="300" height="200"></blockquote></body></html>`;
    const m = { id: "m-4", html, body: "", loadedRemoteContent: true } as never;
    mounted = mount(h(MailBodyFrame, { m, onShowAsText: () => undefined }));
    await settle();
    expect(door.gets).toEqual([good(1)]);
    mounted.render(h(MailBodyFrame, { m, onShowAsText: () => undefined, historyOpen: true }));
    await settle();
    expect([...door.gets].sort()).toEqual([good(1), good(2), good(3)]);
  });
});

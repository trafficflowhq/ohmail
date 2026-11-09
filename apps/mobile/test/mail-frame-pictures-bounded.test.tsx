/** @vitest-environment jsdom */
/**
 * ONE PICTURE BUDGET PER MESSAGE. The frame's consented fetch (`MailBodyFrame` → `fetchRemoteImages`)
 * spends the engine's inline-image ceilings once for a message, across every pass: a minted picture
 * re-renders the frame, and that re-render must not start a fresh budget, ask a failed url again, or
 * record the press again. Only the door's fetch is a counting double; the frame, the sanitizer and the
 * fetch are the real ones.
 *
 * And an embedded (cid:) picture reaches the drawn document once its bytes land, through the reader's
 * own subscription over a real engine.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createElement as h, act, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { INLINE_IMAGE_MAX_PARTS, MemoryMirrorStore, OhmailEngine, type EngineAdapter, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import { mount, styleOf } from "./_rendered-dom";
import { letterInDark, paletteOf } from "../src/theme/palette";
import { contrastRatio, parseCssColor, relativeLuminance } from "../src/mail/paper";

vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    ...rnDom, useWindowDimensions: () => ({ width: 400, height: 800, scale: 2, fontScale: 1 }), Linking: { openURL: async () => undefined },
    AppState: { addEventListener: () => ({ remove: () => {} }), currentState: "active" },
  };
});
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("react-native-webview", () => ({
  WebView: ({ source }: { source?: { html?: string } }) => h("div", { "data-webview": "", "data-html": source?.html ?? "" }),
}));
const live = vi.hoisted(() => ({ engine: null as unknown, actions: null as unknown }));
vi.mock("../src/net/connection", () => ({
  useConnection: () => ({ state: live.engine ? { k: "live", session: { engine: live.engine } } : { k: "none" } }),
}));
vi.mock("../src/mail/frame-ceiling-native", () => ({ phoneFrameCeiling: () => 512 * 1024 * 1024 }));
vi.mock("../src/mail/frame-nav", () => ({ frameNavDecision: () => ({ kind: "none" }), openConfirmedLink: () => undefined }));
const look = vi.hoisted(() => ({ scheme: "light" as "light" | "dark" }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    scheme: look.scheme, face: "paper", c: new Proxy({}, { get: () => "#000" }), layout: { proseMax: 600 },
    radius: { pill: 999, card: 22 }, lift: () => ({}), type: new Proxy({}, { get: () => ({}) }),
  }),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return { Txt: rnDom.Text, Tap: rnDom.Pressable };
});
vi.mock("../src/ui/Sheet", () => ({ Sheet: () => null, SheetRow: () => null }));
vi.mock("../src/ui/BodyPages", () => ({ BodyPages: ({ text }: { text?: string }) => h("div", { "data-body-text": "" }, text ?? "") }));
/** A sanitizer that throws on the passes `when` names: a hostile letter's worst case. */
type SanitizeOpts = { fold?: boolean; inlineImages?: ReadonlyMap<string, string> } | undefined;
const boom = vi.hoisted(() => ({ when: null as null | ((opts: SanitizeOpts) => boolean) }));
vi.mock("../src/mail/sanitize", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/mail/sanitize")>();
  return {
    ...real,
    sanitizeMailHtmlPhone: (html: string, opts?: Parameters<typeof real.sanitizeMailHtmlPhone>[1]) => {
      if (boom.when?.(opts)) throw new RangeError("Maximum call stack size exceeded");
      return real.sanitizeMailHtmlPhone(html, opts);
    },
  };
});

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
  useWorld: () => ({ images: route, actions: live.actions ?? { loadInlineImages: () => undefined } }),
  useWorldToast: () => ({ say: () => undefined }),
}));

const { MailBodyFrame } = await import("../src/ui/MailBodyFrame");
const { Copy } = await import("../src/copy");
const { liveActions, liveMessage } = await import("../src/state/live");
const { useFilesStamp } = await import("../src/state/files-stamp");

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
afterEach(() => {
  mounted?.unmount(); mounted = null; door.gets = []; door.posts = 0; door.failing = new Set();
  live.engine = null; live.actions = null; boom.when = null;
});

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

describe("an embedded picture draws once its bytes land", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const DATA = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
  const REMOTE = "https://img.example.com/art/banner.png";
  const NOW = new Date("2026-10-25T09:00:00.000Z");
  const view = { now: NOW, zone: "UTC" };
  const html = `<p>Picture below.</p><p><img src="cid:pic@e2e.example" alt="a coloured block"></p><img src="${REMOTE}" width="300" height="200">`;

  async function letter(): Promise<OhmailEngine> {
    const store = new MemoryMirrorStore();
    await store.load();
    const at = NOW.toISOString();
    await store.applyChanges([
      { type: "message", op: "create", id: "m-cid", seq: 1, updatedAt: at, entity: {
        id: "m-cid", accountId: "acct-1", mailboxId: "mb-1", threadId: "th-cid", messageIdHeader: null, subject: "an inline picture",
        from: { name: "Chiara", address: "chiara@example.test" }, to: [], cc: [], date: at, folder: "INBOX", snippet: "Picture below.",
        unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: at,
      } as unknown as EngineMessage },
      { type: "rule", op: "create", id: "r-1", seq: 2, updatedAt: at, entity: {
        id: "r-1", kind: "sender", match: "chiara@example.test", destination: "INBOX", enabled: true, createdAt: at } },
    ] as SyncChange[]);
    const adapter = {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: at }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => ({ text: "Picture below.", html, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
      listAttachments: async () => [{ id: "a1", filename: "attachment-a1.bin", contentType: "image/png", sizeBytes: PNG.length, inline: true, contentId: "pic@e2e.example", messageId: "m-cid" }],
      // Node's Blob (jsdom's has no `arrayBuffer()`), typed as the server types it.
      fetchAttachment: async () => new Response(PNG, { headers: { "content-type": "image/png" } }).blob(),
    } as unknown as EngineAdapter;
    return new OhmailEngine({ store, now: () => NOW, adapter });
  }

  /** The reader's own reads: the row from the engine, redrawn by the files subscription. */
  function Reader({ engine, id }: { engine: OhmailEngine; id: string }): ReactNode {
    useFilesStamp([id]);
    return h(MailBodyFrame, { m: liveMessage(engine, id, view)!, onShowAsText: () => undefined });
  }

  it("the cid part's data: URI reaches the WebView's document; the remote picture stays blocked", async () => {
    const engine = await letter();
    const actions = liveActions({ engine, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC" } as never);
    live.engine = engine;
    live.actions = actions;
    await actions.openMessage("m-cid");
    await settle();
    mounted = mount(h(Reader, { engine, id: "m-cid" }));
    await settle();
    expect(engine.inlineImagesOf("m-cid").get("pic@e2e.example"), "the premise: the engine minted the picture").toBe(DATA);
    const drawn = mounted.el.querySelector("[data-webview]")?.getAttribute("data-html") ?? "";
    expect(drawn, "the frame drew a document").toContain("Picture below.");
    expect(drawn, "the minted picture is in the drawn document").toContain(`src="${DATA}"`);
    expect(drawn).not.toContain(REMOTE);
    expect(door.gets).toHaveLength(0);
  });
});

describe("a letter is read on a light sheet, and a dark reader inverts only a light one", () => {
  const FILTER = "filter:invert(1) hue-rotate(180deg)";
  const LIGHT = paletteOf("light", "paper");
  const open = (id: string, html: string): void => {
    mounted = mount(h(MailBodyFrame, { m: { id, html, body: "", loadedRemoteContent: false } as never, onShowAsText: () => undefined }));
  };
  const drawn = (): string => mounted!.el.querySelector("[data-webview]")?.getAttribute("data-html") ?? "";
  const sheet = () => styleOf(mounted!.el.querySelector('[data-testid="mail-sheet"]'));
  const button = (label: string) =>
    [...mounted!.el.querySelectorAll<HTMLElement>('[data-role="button"]')].find((e) => e.textContent === label);
  const letter = '<h1 style="color:#1d1d1f">See you in the larches</h1><p style="color:#444">Cabin 4 is ready.</p>';
  afterEach(() => { look.scheme = "light"; });

  it("dark: a light letter is inverted on the dark sheet, Original shows its own colours, Adapt to dark returns", async () => {
    look.scheme = "dark";
    open("d-1", letter);
    await settle();
    expect(drawn()).toContain(FILTER);
    expect(drawn()).toContain(`background:${LIGHT.panel};color:${LIGHT.ink}`);
    expect(sheet().backgroundColor).toBe(letterInDark.canvas);
    expect(button(Copy.mailShowAsText), "Show as text stays beside it").toBeTruthy();
    act(() => { button(Copy.mailDarkOriginal)!.click(); });
    await settle();
    expect(drawn()).not.toContain(FILTER);
    expect(sheet().backgroundColor).toBe(LIGHT.panel);
    act(() => { button(Copy.mailDarkAdapt)!.click(); });
    await settle();
    expect(drawn()).toContain(FILTER);
  });

  it("dark: a letter drawn dark by its sender is not inverted, sits on its own paper and offers no flip", async () => {
    look.scheme = "dark";
    open("d-2", '<html><body bgcolor="#111111"><p style="color:#eeeeee">Night edition</p></body></html>');
    await settle();
    expect(drawn()).not.toContain(FILTER);
    expect(drawn()).toContain("background:#111111;");
    expect(sheet().backgroundColor).toBe("#111111");
    expect(button(Copy.mailDarkOriginal)).toBeUndefined();
  });

  it("light: the same letter on the light sheet, untouched, with no flip and no outline", async () => {
    open("d-3", letter);
    await settle();
    expect(drawn()).not.toContain(FILTER);
    expect(sheet().backgroundColor).toBe(LIGHT.panel);
    expect(sheet().borderWidth ?? 0).toBe(0);
    expect(button(Copy.mailDarkOriginal)).toBeUndefined();
  });

  /** The drawn body's paper against its ink, the colours every unstyled line is set in. */
  const bodyContrast = (): number => {
    const got = /body\{margin:0;padding:[^;]*;background:([^;]+);color:([^;]+);/.exec(drawn());
    expect(got, "the document sets the body's paper and ink").toBeTruthy();
    return contrastRatio(parseCssColor(got![1]!)!, parseCssColor(got![2]!)!);
  };
  const SHIPPED = '<table width="100%"><tr><td bgcolor="#111111" style="color:#fff">Brand</td></tr><tr><td style="color:#333">Your order has shipped.</td></tr></table>';
  it.each([
    ["a body that sets its dark paper and light ink in its style", '<html><body style="background-color:#121212;color:#f5f5f5"><p>Hello there</p></body></html>'],
    ["a body that sets them as attributes",'<body bgcolor="#000000" text="#ffffff"><p>Dark body</p></body>'],
    ["a light-ink body around a dark table", '<body style="color:#ffffff"><table bgcolor="#000000"><tr><td>Night</td></tr></table></body>'],
    ["a dark header bar over unpainted text", SHIPPED],
  ])("%s reads at 4.5:1 or better, light and dark", async (_, html) => {
    for (const scheme of ["light", "dark"] as const) {
      look.scheme = scheme;
      open(`ink-${scheme}`, html);
      await settle();
      expect(bodyContrast(), scheme).toBeGreaterThanOrEqual(4.5);
      mounted!.unmount(); mounted = null;
    }
  });

  it("a letter whose only body rule sits in its own dark-scheme block is a light letter: readable light and dark, inverted in dark", async () => {
    const receipt = '<html><head><style>@media (prefers-color-scheme: dark){ .logo{display:none} body{background-color:#1e1e1e !important} }</style></head>'
      + '<body><table><tr><td style="color:#333333">Your receipt</td></tr></table></body></html>';
    for (const scheme of ["light", "dark"] as const) {
      look.scheme = scheme;
      open(`receipt-${scheme}`, receipt);
      await settle();
      const paper = /body\{margin:0;padding:[^;]*;background:([^;]+);/.exec(drawn())![1]!;
      expect(contrastRatio(parseCssColor(paper)!, parseCssColor("#333333")!), scheme).toBeGreaterThanOrEqual(4.5);
      expect(sheet().backgroundColor, scheme).toBe(scheme === "dark" ? letterInDark.canvas : LIGHT.panel);
      expect(drawn().includes(FILTER), scheme).toBe(scheme === "dark");
      mounted!.unmount(); mounted = null;
    }
  });

  it("a body painted in spaced rgb() colours is a dark page, set in its own ink and never inverted", async () => {
    for (const scheme of ["light", "dark"] as const) {
      look.scheme = scheme;
      open(`rgb-${scheme}`, '<html><body style="background-color: rgb(18, 18, 18); color: rgb(245, 245, 245)"><p>Hello there</p></body></html>');
      await settle();
      expect(drawn(), scheme).toContain("background:#121212;color:#f5f5f5");
      expect(drawn(), scheme).not.toContain(FILTER);
      expect(sheet().backgroundColor, scheme).toBe("#121212");
      mounted!.unmount(); mounted = null;
    }
  });

  it("a dark body that names no ink is set in the light sheet's ink, never a guessed one", async () => {
    look.scheme = "dark";
    open("bare-dark", '<body bgcolor="#111111"><table bgcolor="#ffffff"><tr><td>Your order has shipped</td></tr></table></body>');
    await settle();
    expect(drawn()).toContain(`background:#111111;color:${LIGHT.ink}`);
    expect(drawn()).toContain(`a{color:${LIGHT.accent}`);
  });

  it("a dark header bar paints itself; the sheet around the letter stays light", async () => {
    open("ship", SHIPPED);
    await settle();
    expect(drawn()).toContain(`background:${LIGHT.panel};color:${LIGHT.ink}`);
    expect(sheet().backgroundColor).toBe(LIGHT.panel);
  });
});

/** `hsl()` as numbers (the frame's gate never reads it; the cascade below must). */
function hslOf(token: string) {
  const m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(token);
  if (!m) return null;
  const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const ch = (t: number): number => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v = u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
    return Math.round(v * 255);
  };
  return { r: ch(h + 1 / 3), g: ch(h), b: ch(h - 1 / 3), a: 1 };
}

/**
 * What the frame PAINTS, read off the drawn document's cascade under an emulated OS appearance: the
 * rules whose media matches (the OS scheme for a prefers-color-scheme query), ordered by importance,
 * specificity and order, the inline style, inheritance for `color`, and the body's inversion.
 */
function paint(doc: string, os: "light" | "dark", id = "t", width = 375) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const d = frame.contentDocument!;
  d.open(); d.write(doc); d.close();
  const media = (text: string): boolean => text.split(",").some((q) => {
    const query = q.trim().toLowerCase();
    if (query === "not all") return false;
    const w = /\((min|max)-width\s*:\s*(\d+)px\)/.exec(query);
    if (w) return w[1] === "max" ? width <= Number(w[2]) : width >= Number(w[2]);
    const scheme = /prefers-color-scheme\s*:\s*([a-z]+)/.exec(query);
    return scheme ? scheme[1] === os : true;
  });
  type Rule = { selectorText: string; style: CSSStyleDeclaration; order: number };
  const rules: Rule[] = [];
  const walk = (list: CSSRuleList): void => {
    for (const r of [...list] as Array<CSSRule & { media?: MediaList; cssRules?: CSSRuleList; selectorText?: string; style?: CSSStyleDeclaration }>) {
      if (r.selectorText !== undefined && r.style) rules.push({ selectorText: r.selectorText, style: r.style, order: rules.length });
      else if (r.cssRules && (!r.media || media(r.media.mediaText))) walk(r.cssRules);
    }
  };
  for (const s of [...d.styleSheets]) walk(s.cssRules);
  const spec = (sel: string): number => {
    const ids = (sel.match(/#[\w-]+/g) ?? []).length;
    const classes = (sel.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
    const types = (sel.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+/g, " ").match(/[a-z][\w-]*/gi) ?? []).length;
    return ids * 10000 + classes * 100 + types;
  };
  const declared = (el: Element, names: string[]): string | null => {
    const hits: Array<{ value: string; rank: number[] }> = [];
    const take = (style: CSSStyleDeclaration, rank: (important: boolean) => number[]): void => {
      let found: { value: string; important: boolean } | null = null;
      for (let i = 0; i < style.length; i++) {
        if (names.includes(style[i]!)) found = { value: style.getPropertyValue(style[i]!), important: style.getPropertyPriority(style[i]!) === "important" };
      }
      if (found) hits.push({ value: found.value, rank: rank(found.important) });
    };
    for (const r of rules) {
      const sels = r.selectorText.split(",").map((s) => s.trim()).filter((s) => { try { return el.matches(s); } catch { return false; } });
      if (sels.length > 0) take(r.style, (imp) => [imp ? 1 : 0, 0, Math.max(...sels.map(spec)), r.order]);
    }
    take((el as HTMLElement).style, (imp) => [imp ? 1 : 0, 1, 0, 0]);
    const at = (a: number[], b: number[]): number => a.findIndex((v, i) => v !== b[i]);
    hits.sort((a, b) => (at(a.rank, b.rank) < 0 ? 0 : a.rank[at(a.rank, b.rank)]! - b.rank[at(a.rank, b.rank)]!));
    return hits.length > 0 ? hits[hits.length - 1]!.value : null;
  };
  const colourOf = (v: string | null) => {
    for (const token of (v ?? "").match(/(?:rgb|hsl)a?\([^)]*\)|#[0-9a-f]+|[a-z]+/gi) ?? []) {
      const c = parseCssColor(token) ?? hslOf(token);
      if (c && c.a >= 0.5) return c;
    }
    return null;
  };
  const nearest = (el: Element | null, read: (e: Element) => ReturnType<typeof colourOf>) => {
    for (let e = el; e; e = e.parentElement) { const c = read(e); if (c) return c; }
    return null;
  };
  const shown = (el: Element): boolean => {
    for (let e: Element | null = el; e; e = e.parentElement) if (declared(e, ["display"]) === "none") return false;
    return true;
  };
  const inverted = (declared(d.body, ["filter"]) ?? "").includes("invert");
  const flip = (c: { r: number; g: number; b: number; a: number }) => (inverted ? { r: 255 - c.r, g: 255 - c.g, b: 255 - c.b, a: 1 } : c);
  const t = d.getElementById(id)!;
  // The nearest painted box: its rules and inline style, then the `bgcolor` hint beneath them.
  const ground = flip(nearest(t, (e) => colourOf(declared(e, ["background", "background-color", "background-image"])) ?? colourOf(e.getAttribute("bgcolor")))!);
  const ink = flip(nearest(t, (e) => colourOf(declared(e, ["color"])))!);
  const logo = d.querySelector<HTMLElement>(".logo-light");
  const out = {
    inverted,
    contrast: contrastRatio(ground, ink),
    groundLight: relativeLuminance(ground) > 0.179,
    logo: logo === null ? null : { shown: shown(logo), counter: (declared(logo, ["filter"]) ?? "").includes("invert") },
    darkLogoShown: d.querySelector(".logo-dark") ? shown(d.querySelector(".logo-dark")!) : false,
  };
  frame.remove();
  return out;
}

describe("what the frame paints never depends on the device's own scheme", () => {
  const PROBE = '<html><head><style>@media (prefers-color-scheme: dark){ .logo{display:none} body{background-color:#1e1e1e !important} }</style></head>'
    + '<body><table><tr><td id="t" style="color:#333333">Your receipt</td></tr></table></body></html>';
  const ADAPTED = '<html><head><style>.logo-dark{display:none}@media (prefers-color-scheme: dark){ body,.bg{background-color:#1e1e1e !important} .tx{color:#f2f2f2 !important}'
    + ' .logo-light{display:none !important} .logo-dark{display:block !important} }</style></head><body><table class="bg"><tr><td>'
    + '<img class="logo-light" alt="Brand" src="data:image/png;base64,AAAA"><img class="logo-dark" alt="Brand" src="data:image/png;base64,AAAA"></td></tr>'
    + '<tr><td id="t" class="tx" style="color:#333333">Your receipt</td></tr></table></body></html>';
  const DARK = '<html><body bgcolor="#111111"><p id="t" style="color:#eeeeee">Night edition</p></body></html>';
  const drawnOf = async (id: string, html: string, historyOpen = false): Promise<string> => {
    mounted = mount(h(MailBodyFrame, { m: { id, html, body: "", loadedRemoteContent: false } as never, onShowAsText: () => undefined, historyOpen }));
    await settle();
    const doc = mounted.el.querySelector("[data-webview]")?.getAttribute("data-html") ?? "";
    mounted.unmount(); mounted = null;
    return doc;
  };
  afterEach(() => { look.scheme = "light"; });
  const COMBOS = (["light", "dark"] as const).flatMap((app) => (["light", "dark"] as const).map((os) => ({ app, os })));

  it.each(COMBOS)("app $app on an OS in $os: a receipt darkened only in its dark block reads at 4.5:1", async ({ app, os }) => {
    look.scheme = app;
    const p = paint(await drawnOf(`probe-${app}-${os}`, PROBE), os);
    expect(p.contrast).toBeGreaterThanOrEqual(4.5);
    expect(p.inverted).toBe(app === "dark");
  });

  it.each(COMBOS)("app $app on an OS in $os: a dark-adapted letter shows its light page, inverted only by the app, its logo visible", async ({ app, os }) => {
    look.scheme = app;
    const p = paint(await drawnOf(`adapted-${app}-${os}`, ADAPTED), os);
    expect(p.contrast).toBeGreaterThanOrEqual(4.5);
    expect(p.inverted).toBe(app === "dark");
    expect(p.groundLight).toBe(app === "light");
    expect(p.logo).toEqual({ shown: true, counter: app === "dark" });
    expect(p.darkLogoShown).toBe(false);
  });

  it.each(COMBOS)("app $app on an OS in $os: a letter dark by default keeps its own paper, uninverted", async ({ app, os }) => {
    look.scheme = app;
    const p = paint(await drawnOf(`dark-${app}-${os}`, DARK), os);
    expect(p.inverted).toBe(false);
    expect(p.groundLight).toBe(false);
    expect(p.contrast).toBeGreaterThanOrEqual(4.5);
  });

  const REPLY = '<p id="t" style="color:#333">Thanks, see below.</p><div><div>On Thu, 22 Oct 2026 at 09:14, A wrote:</div><blockquote type="cite">'
    + '<style>body{background:#000000}</style><p id="h" style="color:#fff">Old dark letter</p></blockquote></div>';
  it.each(COMBOS)("app $app on an OS in $os: a folded reply is read off its own text, not the dark sheet in the history it does not draw", async ({ app, os }) => {
    look.scheme = app;
    const folded = await drawnOf(`fold-${app}-${os}`, REPLY);
    expect(folded).not.toContain("Old dark letter");
    const p = paint(folded, os);
    expect(p.contrast).toBeGreaterThanOrEqual(4.5);
    expect(p.inverted).toBe(app === "dark");
    // Opened, the history's sheet is drawn and the whole letter is read: its dark page, uninverted.
    const opened = paint(await drawnOf(`open-${app}-${os}`, REPLY, true), os, "h");
    expect(opened.inverted).toBe(false);
    expect(opened.groundLight).toBe(false);
    expect(opened.contrast).toBeGreaterThanOrEqual(4.5);
  });

  // A dark body that names no ink around a white card: the card's text is judged against the card.
  const CARD = (attrs: string, head = "") => `<html><head>${head}</head><body bgcolor="#000000"><table ${attrs}><tr><td id="t">Your order has shipped</td></tr></table></body></html>`;
  const CARDS: Array<[string, string]> = [
    ["bgcolor", CARD('bgcolor="#ffffff"')],
    ["an rgb() style with spaces", CARD('style="background-color: rgb(255, 255, 255)"')],
    ["a class rule", CARD('class="card"', "<style>.card{background-color: rgb(255, 255, 255)}</style>")],
    ["an hsl() style", CARD('style="background-color: hsl(0, 0%, 100%)"')],
    ["a gradient", CARD('style="background-image: linear-gradient(#ffffff, #ffffff)"')],
  ];
  it.each(COMBOS.flatMap((c) => CARDS.map(([card, html]) => ({ ...c, card, html }))))(
    "app $app on an OS in $os: a white card painted by $card inside a dark body that names no ink reads at 4.5:1",
    async ({ app, os, card, html }) => {
      look.scheme = app;
      const p = paint(await drawnOf(`card-${app}-${os}-${card}`, html), os);
      expect(p.groundLight, "the premise: the text sits on the white card").toBe(true);
      expect(p.contrast).toBeGreaterThanOrEqual(4.5);
    },
  );

  const OWN_INK: Array<[string, string]> = [
    ["in its style", '<html><body style="background-color:#121212;color:#f5f5f5"><p id="t">Hello there</p></body></html>'],
    ["as attributes", '<html><body bgcolor="#000000" text="#ffffff"><p id="t">Dark body</p></body></html>'],
    ["as spaced rgb() colours", '<html><body style="background-color: rgb(18, 18, 18); color: rgb(245, 245, 245)"><p id="t">Hello there</p></body></html>'],
  ];
  it.each(COMBOS.flatMap((c) => OWN_INK.map(([how, html]) => ({ ...c, how, html }))))(
    "app $app on an OS in $os: a dark body that names its light ink $how reads in that ink",
    async ({ app, os, how, html }) => {
      look.scheme = app;
      const p = paint(await drawnOf(`own-${app}-${os}-${how}`, html), os);
      expect(p.groundLight).toBe(false);
      expect(p.contrast).toBeGreaterThanOrEqual(4.5);
    },
  );

  const NIGHTLY = (wrap: string) => `<html><head><style>${wrap ? `${wrap}{ body{background:#0b0b0b} }` : "body{background:#0b0b0b}"}</style></head><body><p id="t" style="color:#eeeeee">Night edition</p></body></html>`;
  it.each(COMBOS.flatMap((c) => ["", "@media screen", "@supports (display:grid)"].map((wrap) => ({ ...c, wrap }))))(
    "app $app on an OS in $os: a dark newsletter whose page rule sits in $wrap is dark, never inverted",
    async ({ app, os, wrap }) => {
      look.scheme = app;
      const p = paint(await drawnOf(`wrap-${app}-${os}-${wrap}`, NIGHTLY(wrap)), os);
      expect(p.inverted).toBe(false);
      expect(p.groundLight).toBe(false);
      expect(p.contrast).toBeGreaterThanOrEqual(4.5);
    },
  );

  // The body's own background is never drawn, so a page rule in a drawn sheet is the page, ink judged on it.
  const PAGE_RULES: Array<[string, string, boolean]> = [
    ["a head rule paints white under a black body's white ink", '<html><head><style>body{background:#ffffff}</style></head><body style="background:#000;color:#fff"><p id="t">words</p></body></html>', true],
    ["a body sheet paints white under a black body's white ink", '<html><body style="background:#000;color:#fff"><style>body{background:#ffffff}</style><p id="t">words</p></body></html>', true],
    ["a head rule paints black under a white body's light ink", '<html><head><style>html{background:#0b0b0b}</style></head><body style="background:#fff;color:#eee"><p id="t">words</p></body></html>', false],
    ["an undrawn sheet beside the body names black, the body white", '<style>body{background:#000000}</style><body style="background:#fff;color:#111"><p id="t">words</p></body>', true],
    ["an undrawn sheet beside the body names white, the body black", '<style>body{background:#ffffff}</style><body style="background:#000;color:#fff"><p id="t">words</p></body>', false],
  ];
  it.each(COMBOS.flatMap((c) => PAGE_RULES.map(([how, html, light]) => ({ ...c, how, html, light }))))(
    "app $app on an OS in $os: $how; it reads at 4.5:1",
    async ({ app, os, how, html, light }) => {
      look.scheme = app;
      const p = paint(await drawnOf(`page-${app}-${os}-${how}`, html), os);
      expect(p.contrast).toBeGreaterThanOrEqual(4.5);
      expect(p.inverted).toBe(light && app === "dark");
    },
  );

  const WIDE = '<html><head><style>@media only screen and (max-width:600px){body{background-color:#000000}}</style></head><body><p id="t">Wide words</p></body></html>';
  it.each(COMBOS)("app $app on an OS in $os: a page rule for narrow screens is not the page of a letter read wide", async ({ app, os }) => {
    look.scheme = app;
    const p = paint(await drawnOf(`wide-${app}-${os}`, WIDE), os, "t", 730);
    expect(p.inverted).toBe(app === "dark");
    expect(p.contrast).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * THE CAPTION ROW, LAID OUT: the mounted frame's views as CSS flexbox (React Native's defaults) in
 * headless Chromium at a phone's 375 pt and the 13-inch iPad's 730-pt pane. The sentence is a line of
 * its own; the links follow it in one right-aligned row, in one order, at every width.
 */
describe("the blocked-images sentence stands alone; its links are one right-aligned row under it", () => {
  const require_ = createRequire(resolve(process.cwd(), "package.json"));
  const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(() => { look.scheme = "light"; });

  const UNITLESS = new Set(["flex", "flexGrow", "flexShrink", "opacity", "zIndex"]);
  /** The caption views as a page: every view a flex column that does not shrink, text measured to its box. */
  const asPage = (root: HTMLElement): string => {
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelector('[data-testid="mail-sheet"]')?.remove();
    for (const el of clone.querySelectorAll<HTMLElement>("[data-style]")) {
      for (const [k, v] of Object.entries(styleOf(el))) {
        const prop = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        el.style.setProperty(prop, typeof v === "number" && !UNITLESS.has(k) ? `${v}px` : String(v));
      }
    }
    return `<!doctype html><html><head><style>body{margin:0}
      [data-rn]{display:flex;flex-direction:column;flex-shrink:0;box-sizing:border-box;min-width:0;position:relative}
      [data-rn=Text]{display:block;max-width:100%;font:13px/18px sans-serif}</style></head><body>${clone.outerHTML}</body></html>`;
  };
  type Box = { text: string; left: number; right: number; top: number; bottom: number };
  const LETTER = '<p>Cabin 4 is ready.</p><img src="https://img.example.com/cabin.png" width="600" height="300">';

  it.each([375, 730])("at %i pt: the sentence on its own line, then Show images, Original, Show as text in one row at the right", async (width) => {
    look.scheme = "dark";
    mounted = mount(h(MailBodyFrame, { m: { id: `caption-${width}`, html: LETTER, body: "", loadedRemoteContent: false } as never, onShowAsText: () => undefined }));
    await settle();
    const page = await browser!.newPage({ viewport: { width, height: 600 } });
    try {
      await page.setContent(asPage(mounted.el));
      const got = await page.evaluate(() => {
        const box = (e: Element) => { const r = e.getBoundingClientRect(); return { text: e.textContent ?? "", left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        return {
          note: [...document.querySelectorAll('[data-rn="Text"]:not([data-role])')].map(box),
          links: [...document.querySelectorAll('[data-role="button"]')].map(box),
          right: document.body.firstElementChild!.getBoundingClientRect().right,
        };
      }) as { note: Box[]; links: Box[]; right: number };
      expect(got.note, "one sentence").toHaveLength(1);
      expect(got.links.map((l) => l.text)).toEqual([Copy.mailShowImages, Copy.mailDarkOriginal, Copy.mailShowAsText]);
      const tops = new Set(got.links.map((l) => Math.round(l.top)));
      expect(tops.size, "the links share one row").toBe(1);
      for (const l of got.links) expect(l.top, `${l.text} sits under the sentence`).toBeGreaterThanOrEqual(got.note[0]!.bottom);
      for (let i = 1; i < got.links.length; i++) expect(got.links[i]!.left - got.links[i - 1]!.right, "12 pt apart").toBeCloseTo(12, 0);
      expect(got.links.at(-1)!.right, "right-aligned").toBeCloseTo(got.right, 0);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("a sanitizer throw costs this one letter its drawing, never the reader", () => {
  const PICTURE = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64")}`;
  const html = '<html><body><p>Hello there.</p><p><img src="cid:pic@x.example" alt="a block"></p></body></html>';
  const STAND_IN = "data:image/gif;base64,Q";
  const passes: Array<[string, (opts: SanitizeOpts) => boolean]> = [
    ["the folded pass", (o) => o?.fold === true],
    ["the bare pass", (o) => o?.fold !== true && o?.inlineImages === undefined],
    ["the length's dry run", (o) => [...(o?.inlineImages?.values() ?? [])].some((v) => v.startsWith(STAND_IN))],
    ["the pictured pass", (o) => [...(o?.inlineImages?.values() ?? [])].includes(PICTURE)],
  ];
  for (const [name, when] of passes) {
    it(`${name} throws: the letter shows as text with a short notice, the list beside it stays`, async () => {
      boom.when = when;
      const m = { id: "m-boom", html, body: "Hello there, as text.", loadedRemoteContent: false, inlineImages: new Map([["pic@x.example", PICTURE]]) };
      mounted = mount(h("div", null, h("div", { "data-list": "" }, "the list"), h(MailBodyFrame, { m: m as never, onShowAsText: () => undefined })));
      await settle();
      expect(mounted.el.querySelector("[data-list]")?.textContent, "the screen around the letter").toBe("the list");
      expect(mounted.el.textContent).toContain(Copy.mailUnreadable);
      expect(mounted.el.querySelector("[data-body-text]")?.textContent).toBe("Hello there, as text.");
      expect(mounted.el.querySelector("[data-webview]"), "no frame is drawn").toBeNull();
    });
  }
  it("with no throw the same letter is drawn in its frame, its picture in it", async () => {
    const m = { id: "m-calm", html, body: "Hello there, as text.", loadedRemoteContent: false, inlineImages: new Map([["pic@x.example", PICTURE]]) };
    mounted = mount(h(MailBodyFrame, { m: m as never, onShowAsText: () => undefined }));
    await settle();
    expect(mounted.el.textContent).not.toContain(Copy.mailUnreadable);
    expect(mounted.el.querySelector("[data-webview]")?.getAttribute("data-html")).toContain(`src="${PICTURE}"`);
  });
});

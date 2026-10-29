/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE PRODUCT DOCUMENT CARRIES THE FIRST SCREEN'S COPY, NOT THE WHOLE CATALOGUE. Every
 * `(product)` document is `no-store`, and it inlined the whole catalogue — 250 KB of copy
 * re-sent with every load of the app and every credential screen. The layout now hands
 * `LocaleShell` the cut `i18n/first-screen.ts` names, and the shell loads the rest as a
 * content-hashed chunk. Three things hold that: the cut stays under a ceiling set just above
 * its measured size; every first screen renders the same HTML under the cut as under the whole
 * catalogue (so nothing on it waits for the chunk); and until the chunk lands a namespace the
 * document did not carry renders nothing — never its dotted key — and then renders.
 */

/* The layout's inputs: the cookie that picks the locale, and the nonce header. */
const cookie = vi.hoisted(() => ({ value: "" }));
vi.mock("next/headers", () => ({
  headers: () => new Headers(cookie.value === "" ? {} : { cookie: cookie.value }),
  cookies: () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {}, back() {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error("notFound"); },
}));

/* The chunk the shell loads, held or refused per case; the real loader otherwise. */
const chunk = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  /* Holds the FIRST ask only, so a later one (a switch) can land before it. */
  holdFirst: null as Promise<void> | null,
  failures: 0,
  asked: [] as string[],
}));
vi.mock("../i18n/catalog", async (original) => {
  const real = await original<typeof import("../i18n/catalog")>();
  /* Both doors, told apart in `asked`: the shell's first load is `whole:`, a switch `switch:`. */
  const door = (name: "whole" | "switch", load: (l: "en" | "de") => Promise<unknown>) =>
    async (locale: "en" | "de") => {
      chunk.asked.push(`${name}:${locale}`);
      if (chunk.failures > 0) { chunk.failures -= 1; throw new Error("ChunkLoadError"); }
      if (chunk.hold) await chunk.hold;
      const first = chunk.holdFirst;
      chunk.holdFirst = null;
      if (first) await first;
      return load(locale);
    };
  return { ...real, loadCatalog: door("switch", real.loadCatalog), loadWholeCatalog: door("whole", real.loadWholeCatalog) };
});

process.env.NEXT_PUBLIC_API_BASE = "/api";
(window as unknown as { matchMedia: unknown }).matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
}));

type Messages = { [key: string]: string | Messages };
type Tree = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } };

/** The ceilings on the inlined cut, just above its measured size in each language (the whole
 *  catalogue is many times that). A first-screen string added in a namespace the table
 *  carries whole lands under them; a namespace added whole may have to raise them, said here.
 *  Raised 2026-10-09 for both languages: the Ohbox's "Not organizing yet"
 *  doorbell and the join wizard's "Your mailbox is connected" step are first-screen strings.
 *  Raised 2026-10-17: the mailbox step's note says the factor is asked in place (join), and the
 *  sign-in names its wizard continuation (login); both namespaces are carried whole.
 *  Raised 2026-10-17 (both): the plan step's way out says what it does (join, carried whole).
 *  Raised 2026-10-17 (both): the plan step names the site's choice and the trial (join).
 *  Raised 2026-10-17 (de): German says Account and Mails, a few bytes longer than Konto and Post.
 *  Raised 2026-10-17 (both): the signup's refusals in the screen's words, sentences shown the
 *  moment a submit is refused (join, verify; both carried whole), and Account for Konto there.
 *  Raised 2026-10-17 (both): the authenticator's Copy and QR label, the codes' Copy and Download,
 *  "Did you mean" and "Wrong address?" (join, carried whole).
 *  Raised 2026-10-18 (both): the splash's waiting line and the sign-in's sentence for a pending
 *  sign-out (resume, carried whole).
 *  Raised 2026-10-23 (both): the reader's Mark unread and the conversation squares' spoken labels
 *  (message, carried whole).
 *  Raised 2026-10-24 (both): the squares' chip says you, today and yesterday (message, carried whole).
 *  Raised 2026-10-25 (both): the mailbox step's Microsoft sign-in, its refusal hint, the sentences
 *  for a sign-in that came back unconnected, and its ways out (join, carried whole).
 *  Raised 2026-10-25 (both): the account step's sign-in link (join, carried whole).
 *  Raised 2026-10-26 (both): the reader's folded To and Cc say "and N others", "you", and the
 *  fold's spoken label (message, carried whole).
 *  Raised 2026-10-26 (both): the setup names a trial only where one never started, says it is waiting
 *  after a return, continues in the tab already waiting, says codes were made elsewhere, and its rail
 *  ends with Organize (join, verify; both carried whole).
 *  Raised 2026-10-29 (both): the splash's and the sign-in's sentence for a sign-in a reuse sweep
 *  ended (resume, carried whole); the account strip's sentences for it stay out of the cut (settings).
 *  Raised 2026-10-29 (both): the rail's pile, tag and Drafts counts say what they count as a title
 *  (rail, carried whole).
 *  Raised 2026-10-29 (both): the key sheet says when both layouts look the same at this window width
 *  (shortcuts, carried whole). */
const INLINE_CEILING_BYTES = { en: 40_230, de: 45_960 } as const;

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");
const leafCount = (m: Messages): number =>
  Object.values(m).reduce((n, v) => n + (typeof v === "string" ? 1 : leafCount(v)), 0);

function findProps(node: unknown, type: unknown): Record<string, unknown> | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findProps(child, type); if (hit) return hit; }
    return null;
  }
  const el = node as Tree;
  if (el.type === type) return el.props ?? {};
  return findProps(el.props?.children, type);
}

beforeEach(() => {
  cookie.value = "";
  chunk.hold = null;
  chunk.holdFirst = null;
  chunk.failures = 0;
  chunk.asked = [];
});

describe("the (product) layout inlines the first screen's cut", () => {
  for (const locale of ["en", "de"] as const) {
    it(`${locale}: under the ceiling, and far from the whole catalogue`, async () => {
      cookie.value = locale === "de" ? "ohmail.locale=de" : "";
      const { default: RootLayout } = await import("../app/(product)/layout");
      const { LocaleShell } = await import("../app/(product)/LocaleShell");
      const { loadCatalog } = await import("../i18n/catalog");
      const tree = await RootLayout({ children: null });
      const props = findProps(tree, LocaleShell);
      expect(props, "the layout no longer renders LocaleShell").not.toBeNull();
      expect(props!.initialLocale).toBe(locale);
      const inline = props!.initialMessages as Messages;
      const whole = await loadCatalog(locale);
      const size = bytes(inline);
      expect(size, `the ${locale} document inlines ${size} B of copy`).toBeLessThanOrEqual(INLINE_CEILING_BYTES[locale]);
      // The refusal the ceiling exists for, said on its own: the whole catalogue came back.
      expect(size * 4, "the whole catalogue is inline again").toBeLessThan(bytes(whole));
      expect(leafCount(inline)).toBeLessThan(leafCount(whole) / 4);
    });
  }
});

/* Each first screen the (product) group serves, as its page renders it. */
async function firstScreens(): Promise<Array<[string, () => unknown]>> {
  const React = await import("react");
  const h = React.createElement;
  const { LoginScreen } = await import("../app/(product)/login/LoginScreen");
  const { JoinScreen } = await import("../app/(product)/join/JoinScreen");
  const { InviteScreen } = await import("../app/(product)/join/invite/InviteScreen");
  const { ApproveScreen } = await import("../app/(product)/approve/ApproveScreen");
  const { VerifyEmailScreen } = await import("../app/(product)/verify-email/VerifyEmailScreen");
  const { ResumeScreen } = await import("../app/(product)/resume/ResumeScreen");
  const { SetupScreen } = await import("../app/(product)/setup/SetupScreen");
  const { LinkDesktopScreen } = await import("../app/(product)/link-desktop/LinkDesktopScreen");
  const { AuthorizeDesktopScreen } = await import("../app/(product)/authorize-desktop/AuthorizeDesktopScreen");
  const { CloudShell } = await import("../app/(product)/mailbox/CloudShell");
  const { AppShell } = await import("../app/shell/AppShell");
  const { default: ProductError } = await import("../app/(product)/error");
  return [
    ["login", () => h(LoginScreen, { publicSignup: false })],
    ["login (public signup)", () => h(LoginScreen, { publicSignup: true })],
    ["join", () => h(JoinScreen, { initialCode: "", publicSignup: true })],
    ["join (code)", () => h(JoinScreen, { initialCode: "ABCD-" + "1234", publicSignup: false })],
    ["join/invite", () => h(InviteScreen)],
    ["approve", () => h(ApproveScreen, { request: "" })],
    ["verify-email", () => h(VerifyEmailScreen, { initialToken: "t".repeat(40) })],
    ["resume", () => h(ResumeScreen, { initialOwner: null })],
    ["setup", () => h(SetupScreen)],
    ["link-desktop", () => h(LinkDesktopScreen, { challenge: "" })],
    ["authorize-desktop", () => h(AuthorizeDesktopScreen, { request: "" })],
    ["mailbox (session)", () => h(CloudShell, { demo: false })],
    ["mailbox (demo)", () => h(CloudShell, { demo: true })],
    ["demo", () => h(AppShell, { demo: true } as never)],
    ["error", () => h(ProductError, { error: new Error("x"), reset() {} } as never)],
  ];
}

/** The server render of `screen` inside the real shell, over `messages`. */
async function render(locale: "en" | "de", messages: Messages, screen: unknown): Promise<string> {
  const React = await import("react");
  const { renderToString } = await import("react-dom/server");
  const { LocaleShell } = await import("../app/(product)/LocaleShell");
  const { Providers } = await import("../app/(product)/providers");
  return renderToString(React.createElement(LocaleShell, {
    initialLocale: locale, initialMessages: messages,
    children: React.createElement(Providers, null, screen as never),
  }));
}

/** What the cut lacks for `screen` — the keys a render under it could not resolve. */
async function missingKeys(locale: "en" | "de", messages: Messages, screen: unknown): Promise<string[]> {
  const React = await import("react");
  const { renderToString } = await import("react-dom/server");
  const { NextIntlClientProvider } = await import("next-intl");
  const { Providers } = await import("../app/(product)/providers");
  const missed = new Set<string>();
  renderToString(React.createElement(NextIntlClientProvider, {
    locale, messages, timeZone: "UTC", onError: () => {},
    getMessageFallback: ({ namespace, key }: { namespace?: string; key: string }) => {
      missed.add(namespace ? `${namespace}.${key}` : key);
      return "";
    },
    children: React.createElement(Providers, null, screen as never),
  }));
  return [...missed].sort();
}

async function census(): Promise<void> {
  const { loadCatalog } = await import("../i18n/catalog");
  const { firstScreenCatalog } = await import("../i18n/first-screen");
  for (const locale of ["en", "de"] as const) {
    const whole = await loadCatalog(locale);
    const cut = firstScreenCatalog(whole);
    for (const [name, screen] of await firstScreens()) {
      const underWhole = await render(locale, whole, screen());
      const underCut = await render(locale, cut, screen());
      expect(underWhole.length, `${name} rendered nothing — a census of nothing`).toBeGreaterThan(200);
      if (underCut !== underWhole) {
        const lacks = await missingKeys(locale, cut, screen());
        expect.fail(`${locale} ${name}: the first screen renders copy the document does not carry — add to FIRST_SCREEN: ${lacks.join(", ") || "(a non-hook English fallback; diff the two renders)"}`);
      }
    }
  }
}

describe("every first screen renders the same under the cut as under the whole catalogue", () => {
  it("the managed build", async () => {
    await census();
  }, 60_000);

  it("the self-host build", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";
    try {
      const { SELF_HOST_BUILD } = await import("../app/hello");
      expect(SELF_HOST_BUILD, "the flavour did not reach the modules — a second managed pass").toBe(true);
      await census();
    } finally {
      delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
      vi.resetModules();
    }
  }, 60_000);
});

describe("the first load refuses a locale file that did not load; a switch answers English", () => {
  afterEach(() => { vi.doUnmock("../messages/de.json"); vi.resetModules(); });
  it("loadWholeCatalog rejects where loadCatalog falls back", async () => {
    vi.resetModules();
    vi.doMock("../messages/de.json", () => { throw new Error("ChunkLoadError"); });
    const real = await vi.importActual<typeof import("../i18n/catalog")>("../i18n/catalog");
    const en = await real.loadCatalog("en");
    expect(await real.loadCatalog("de"), "a switch whose file failed is not English").toEqual(en);
    await expect(real.loadWholeCatalog("de"), "the first load answered English for German").rejects.toThrow();
  });
});

describe("before the chunk lands, the rest renders nothing — never its key", () => {
  const act = async (fn: () => Promise<void> | void): Promise<void> => {
    const React = await import("react");
    await (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act(fn);
  };
  let unmount: (() => Promise<void>) | null = null;
  /* A fresh module per case: the shell asks for the catalogue as it EVALUATES, for `<html lang>`. */
  beforeEach(() => { vi.resetModules(); document.documentElement.lang = ""; });
  afterEach(async () => { await unmount?.(); unmount = null; vi.useRealTimers(); });

  /** Mount the shell over the English cut with one line of copy from a namespace it does not carry. */
  async function mount(): Promise<{ host: HTMLElement; switchTo: (l: "en" | "de") => Promise<void> }> {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useTranslations } = await import("next-intl");
    const { LocaleShell } = await import("../app/(product)/LocaleShell");
    const { LocaleContext } = await import("../app/shell/LocaleContext");
    const { firstScreenCatalog } = await import("../i18n/first-screen");
    // The cut is built from the REAL loader: the held one is the shell's, under test.
    const real = await vi.importActual<typeof import("../i18n/catalog")>("../i18n/catalog");
    const cut = firstScreenCatalog(await real.loadCatalog("en"));
    let controls: { setLocale: (l: "en" | "de") => Promise<void> } | null = null;
    function Line() {
      const t = useTranslations("faq");
      const tl = useTranslations("login");
      controls = React.useContext(LocaleContext) as never;
      return React.createElement("p", null, `[${t("title")}|${tl("title")}]`);
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(() => {
      root.render(React.createElement(LocaleShell, { initialLocale: "en", initialMessages: cut, children: React.createElement(Line) }));
    });
    unmount = async () => { await act(() => root.unmount()); host.remove(); };
    return { host, switchTo: async (l) => { await act(async () => { await controls!.setLocale(l); }); } };
  }

  it("the carried namespace renders at once; the other waits for the chunk, blank, then renders", async () => {
    const { default: en } = await import("../messages/en.json");
    const faq = (en as unknown as { faq: { title: string } }).faq.title;
    const login = (en as unknown as { login: { title: string } }).login.title;
    let release!: () => void;
    chunk.hold = new Promise<void>((r) => { release = r; });
    const { host } = await mount();
    expect(host.textContent, "the pending render shows the dotted key").not.toContain("faq.title");
    expect(host.textContent).toBe(`[|${login}]`);
    expect(chunk.asked, "the shell never asked for the whole catalogue").toEqual(["whole:en"]);
    await act(async () => { release(); await chunk.hold; await Promise.resolve(); });
    expect(host.textContent).toBe(`[${faq}|${login}]`);
  });

  it("the ask starts as the module evaluates, for the document's locale, and the mount reuses it", async () => {
    document.documentElement.lang = "en";
    await import("../app/(product)/LocaleShell");
    expect(chunk.asked, "nothing was asked before the first render").toEqual(["whole:en"]);
    const { host } = await mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(chunk.asked, "the mount asked a second time").toEqual(["whole:en"]);
    expect(host.textContent?.startsWith("[|"), "the early catalogue never rendered").toBe(false);
  });

  it("a refused chunk is asked for again, and lands", async () => {
    vi.useFakeTimers();
    chunk.failures = 1;
    const { host } = await mount();
    expect(host.textContent?.startsWith("[|"), "rendered before any load").toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(chunk.asked, "the refused load was never retried").toEqual(["whole:en", "whole:en"]);
    expect(host.textContent?.startsWith("[|"), "the retried load never rendered").toBe(false);
  });

  it("a switch made while the first load is pending is not overwritten by it", async () => {
    let release!: () => void;
    const late = new Promise<void>((r) => { release = r; });
    chunk.holdFirst = late;
    const { host, switchTo } = await mount();
    await switchTo("de");
    const { default: de } = await import("../messages/de.json");
    const faqDe = (de as unknown as { faq: { title: string } }).faq.title;
    expect(host.textContent, "the switch did not land").toContain(faqDe);
    // The late English load settles now; German still stands.
    await act(async () => { release(); await late; await Promise.resolve(); await Promise.resolve(); });
    expect(chunk.asked).toEqual(["whole:en", "switch:de"]);
    expect(host.textContent, "the first load overwrote the switch").toContain(faqDe);
  });
});

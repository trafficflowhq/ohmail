/** @vitest-environment jsdom */
/**
 * SETTINGS → GENERAL → LANGUAGE, today's row (`LanguageRow`): moved word for word from `locale-account.test.tsx`, whose
 * other cases read only the kept locale module. It waits for the General pane's mount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement, type ReactNode } from "react";
import { IntlProvider } from "next-intl";
import { ToastHost } from "@ohmail/ui";
import { DEFAULT_LOCALE, LOCALE_COOKIE, setActiveCatalog, type AppLocale } from "../app/shell/locale";
import { LocaleContext, type LocaleControls } from "../app/shell/LocaleContext";
import { LanguageRow } from "../app/shell/LanguageRow";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (l: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(HERE, "..", "messages", `${l}.json`), "utf8"));
const EN = read("en");
const EN_SETTINGS = EN.settings as Record<string, string>;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.localStorage.clear();
  document.cookie = `${LOCALE_COOKIE}=; Path=/; Max-Age=0`;
});
afterEach(() => {
  setActiveCatalog(DEFAULT_LOCALE, null);
  vi.restoreAllMocks();
});

/* ── THE SELECTOR ───────────────────────────────────────────────────────────────────────────── */

function mount(node: ReactNode): { host: HTMLElement; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(node); });
  return { host, unmount: () => { act(() => { root.unmount(); }); host.remove(); } };
}

/**
 * The row inside the two providers it genuinely needs. `ToastHost` is one of them: the row reports a
 * refused write through `useToast`, and that hook is called BEFORE the `controls === null` early
 * return because the rules of hooks require it — so a bare render throws rather than drawing nothing.
 * Every host mounts a `ToastHost`; this mirrors that rather than working around it.
 */
function withLocale(controls: LocaleControls | null, children: ReactNode): ReactNode {
  return createElement(
    IntlProvider as unknown as (p: Record<string, unknown>) => ReactNode,
    { locale: controls?.locale ?? "en", messages: EN },
    createElement(
      ToastHost,
      null,
      createElement(LocaleContext.Provider, { value: controls }, children),
    ),
  );
}

function controlsFor(
  locale: AppLocale,
  setLocale: (l: AppLocale) => Promise<void>,
  scope: LocaleControls["scope"] = "account",
): LocaleControls {
  return { locale, locales: ["en", "de"], setLocale, adoptLocale: setLocale, busy: false, scope };
}

describe("Settings → General → Language", () => {
  /**
   * THE ROW STATES HOW FAR THE CHOICE REACHES, and the two hosts do not reach the same distance.
   *
   * "Applies to this app everywhere you sign in" is the ACCOUNT's promise — `AccountLocale` writes
   * `PATCH /consent/settings` and the value follows the person to any browser. On a standalone
   * install nothing of the sort happens: `DesktopLocale` writes `localStorage` and that is the
   * whole of it, on the hosted door as well, because the Cloud adapter is aliased out of that
   * bundle. The account-wide sentence was rendered there anyway. `LocaleControls.scope` is what
   * the host declares, and it is required, so a new host cannot inherit the wrong claim by
   * omission. Mutation: make `LanguageRow` read `languageHint` unconditionally → the second case
   * goes red. Run.
   */
  it("promises an account-wide language only where a host writes the account", () => {
    const account = mount(withLocale(controlsFor("en", async () => {}, "account"), createElement(LanguageRow)));
    expect(account.host.textContent).toContain(EN_SETTINGS.languageHint);
    expect(account.host.textContent).not.toContain(EN_SETTINGS.languageHintLocal);
    account.unmount();

    const install = mount(withLocale(controlsFor("en", async () => {}, "install"), createElement(LanguageRow)));
    expect(install.host.textContent).toContain(EN_SETTINGS.languageHintLocal);
    expect(
      install.host.textContent,
      "a standalone install promised a language that follows an account it has no client for",
    ).not.toContain(EN_SETTINGS.languageHint);
    install.unmount();
  });

  it("offers both languages, each named in its own language, with the active one pressed", () => {
    const { host, unmount } = mount(withLocale(controlsFor("de", async () => {}), createElement(LanguageRow)));
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["English", "Deutsch"]);
    const pressed = [...host.querySelectorAll("button")]
      .filter((b) => b.getAttribute("aria-checked") === "true" || b.getAttribute("aria-selected") === "true"
        || b.className.includes("on"));
    expect(pressed.map((b) => b.textContent)).toEqual(["Deutsch"]);
    unmount();
  });

  it("pressing a language calls setLocale ONCE with that language", async () => {
    const calls: AppLocale[] = [];
    const { host, unmount } = mount(withLocale(
      controlsFor("en", async (l) => { calls.push(l); }),
      createElement(LanguageRow),
    ));
    const german = [...host.querySelectorAll("button")].find((b) => b.textContent === "Deutsch")!;
    await act(async () => { german.click(); });
    expect(calls).toEqual(["de"]);
    // Pressing the ALREADY-ACTIVE language does nothing — no write, no round trip.
    const english = [...host.querySelectorAll("button")].find((b) => b.textContent === "English")!;
    await act(async () => { english.click(); });
    expect(calls).toEqual(["de"]);
    unmount();
  });

  it("a REFUSED write leaves the control where it was and SAYS so", async () => {
    const { unmount } = mount(withLocale(
      controlsFor("en", async () => { throw new Error("500"); }),
      createElement(LanguageRow),
    ));
    const german = [...document.querySelectorAll("button")].find((b) => b.textContent === "Deutsch")!;
    await act(async () => { german.click(); });
    // THE ROW DOES NOT MOVE. `controls.locale` is still `en` because the host never applied it —
    // the account write comes first and rejected, so the interface never claimed otherwise.
    const pressed = [...document.querySelectorAll("button")].filter((b) => b.className.includes("on"));
    expect(pressed.map((b) => b.textContent)).toEqual(["English"]);
    // …and the failure is on screen rather than swallowed. The ToastHost renders into its own node.
    expect(document.body.textContent).toContain(EN_SETTINGS.languageFailed);
    unmount();
  });

  it("NO PROVIDER ⇒ NO ROW — the demo and every bare pane, rather than a control that cannot control", () => {
    const { host, unmount } = mount(withLocale(null, createElement(LanguageRow)));
    expect(host.textContent).toBe("");
    unmount();
  });
});

/* ── THE PRECEDENCE RULE ────────────────────────────────────────────────────────────────────── */

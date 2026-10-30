/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * A CODE-SPLIT VIEW WHOSE CHUNK FAILED LOADS ON THE NEXT OPEN.
 *
 * `React.lazy` keeps a rejected import for the life of the page: one failed fetch of the Settings
 * chunk made every later Settings open in that tab throw the same failure. The chunks here fail
 * the way a fetch does — the module's import rejects once and succeeds when asked again, which is
 * what the bundler's loader does after a failed script. The census at the bottom holds every
 * `lazy()` under `app/` to the one helper.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const chunks = vi.hoisted(() => ({ settingsFails: 0, settingsLoads: 0, settingsThrows: false, editorFails: 0, editorLoads: 0, editorGone: "" }));

const settingsChunk = vi.hoisted(() => async () => {
  chunks.settingsLoads += 1;
  if (chunks.settingsFails > 0) {
    chunks.settingsFails -= 1;
    throw new Error("Loading chunk settings failed");
  }
  const { createElement } = await import("react");
  return {
    SettingsView: () => {
      if (chunks.settingsThrows) throw new Error("a render throw, not a load");
      return createElement("section", { className: "view view-settings-stub" }, "Settings stub");
    },
  };
});
const editorChunk = vi.hoisted(() => async (importOriginal: () => Promise<unknown>) => {
  chunks.editorLoads += 1;
  if (chunks.editorGone) throw Object.assign(new Error("Loading chunk rich-editor failed"), { name: "ChunkLoadError", request: chunks.editorGone });
  if (chunks.editorFails > 0) {
    chunks.editorFails -= 1;
    throw new Error("Loading chunk rich-editor failed");
  }
  return importOriginal();
});
vi.mock("../app/views/SettingsView", settingsChunk);
vi.mock("../app/shell/RichEditor", editorChunk);

/* A door lives as long as its module, which is the page session: a case that needs a fresh one
   starts a fresh module graph, and the mocks are registered again because a reset keeps the
   mocked module a previous case loaded. */
function freshModules(): void {
  vi.resetModules();
  vi.doMock("../app/views/SettingsView", settingsChunk);
  vi.doMock("../app/shell/RichEditor", editorChunk);
}

const LOAD_FAILED = messages.viewError.loadFailed;
const CRASH_TITLE = messages.viewError.title;

let roots: Root[] = [];

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked; the shell still boots */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null, dispatchEvent: () => false,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.assign(chunks, { settingsFails: 0, settingsLoads: 0, settingsThrows: false, editorFails: 0, editorLoads: 0, editorGone: "" });
});

afterEach(async () => {
  // Off the Ohbox first: its drag hook's cleanup reads `document.body`, which a document root's
  // unmount has already taken away.
  if (document.querySelector(".view-ohbox")) await goTo("drafts");
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  if (!document.documentElement) {
    const html = document.createElement("html");
    html.append(document.createElement("head"), document.createElement("body"));
    document.appendChild(html);
  }
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/** Bounded by the clock, not by ticks: a fresh module graph imports the editor for real. */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 10_000;
  while (!cond() && Date.now() < until) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  expect(cond(), what).toBe(true);
}

async function goTo(view: "settings" | "ohbox" | "drafts"): Promise<void> {
  const { go } = await import("../app/shell/routing");
  await act(async () => { go(view); window.dispatchEvent(new HashChangeEvent("hashchange")); });
}

const alertText = (): string => Array.from(document.querySelectorAll("[role=alert]")).map((n) => n.textContent ?? "").join(" | ");
const crashCard = (): boolean => Array.from(document.querySelectorAll(".view-fail h1")).some((n) => n.textContent === CRASH_TITLE);
const settingsShown = (): boolean => document.querySelector(".view-settings-stub") != null;
/** The Try again beside the sentence — by its words, since the shell carries alerts of its own. */
const tryAgain = (): HTMLButtonElement | undefined => Array.from(document.querySelectorAll("[role=alert]"))
  .filter((n) => (n.textContent ?? "").includes(LOAD_FAILED))
  .flatMap((n) => Array.from(n.querySelectorAll("button")))
  .find((b) => b.textContent === messages.viewError.tryAgain);

/** The shipped shell, rendered the way the App Router renders it: React's root IS `document`. */
async function shellOnDocument(): Promise<void> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const root = createRoot(document as unknown as Element);
  roots.push(root);
  await act(async () => {
    root.render(
      h("html", null, h("head"), h("body", null,
        h(NextIntlClientProvider, {
          locale: "en",
          messages,
          timeZone: "UTC",
          now: new Date("2026-08-02T09:00:00.000Z"),
          children: h(ThemeProvider, {
            storageKey: null,
            children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
          }),
        }))),
    );
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
  await waitFor(() => document.querySelector(".view-ohbox") != null, "the shell did not open on the Ohbox");
}

// The whole shell boots per case: vitest's 5 s default is shorter than one boot on a loaded host.
describe("Settings, whose chunk failed once", { timeout: 30_000 }, () => {
  beforeEach(freshModules);

  it("the next open of Settings asks for the chunk again and shows Settings", async () => {
    await shellOnDocument();
    chunks.settingsFails = 1;
    await goTo("settings");
    await waitFor(() => chunks.settingsLoads >= 1 && (alertText() !== "" || crashCard()), "the failed open painted nothing");
    await goTo("ohbox");
    await waitFor(() => document.querySelector(".view-ohbox") != null, "could not leave Settings");
    await goTo("settings");
    await waitFor(() => settingsShown() || crashCard() || alertText() !== "", "the second open painted nothing");
    expect(chunks.settingsLoads, "the second open never asked for the chunk: the first failure was kept").toBe(2);
    expect(settingsShown(), "a failed import stayed failed: the second open showed the first failure").toBe(true);
  });

  it("a failed open says so, offers Try again, and the press shows Settings", async () => {
    await shellOnDocument();
    chunks.settingsFails = 1;
    await goTo("settings");
    await waitFor(() => alertText() !== "" || crashCard(), "the failed open painted nothing");
    expect(crashCard(), "a chunk that did not load crashed the view").toBe(false);
    expect(alertText()).toContain(LOAD_FAILED);
    const retry = tryAgain();
    expect(retry, "no Try again beside the sentence").toBeTruthy();
    await act(async () => { retry!.click(); });
    await waitFor(settingsShown, "Try again did not show Settings");
    expect(chunks.settingsLoads).toBe(2);
  });

  it("a chunk that keeps failing is asked for once per open or press, never in a loop", async () => {
    await shellOnDocument();
    chunks.settingsFails = 5;
    await goTo("settings");
    await waitFor(() => alertText().includes(LOAD_FAILED), "the failed open did not say so");
    for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(chunks.settingsLoads, "a failed open fetched again on its own").toBe(1);
    expect(tryAgain(), "no Try again beside the sentence").toBeTruthy();
    await act(async () => { tryAgain()!.click(); });
    await waitFor(() => chunks.settingsLoads >= 2 && alertText().includes(LOAD_FAILED), "Try again did not ask again");
    for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(chunks.settingsLoads, "one press fetched more than once").toBe(2);
  });

  it("CONTROL: a view that loaded and then threw is still the crash card, not Try again", async () => {
    await shellOnDocument();
    chunks.settingsThrows = true;
    await goTo("settings");
    await waitFor(() => crashCard() || alertText() !== "", "the throwing view painted nothing");
    expect(crashCard(), "a render throw no longer reached the view's crash card").toBe(true);
    expect(alertText(), "a render throw was offered a reload of code that had loaded").not.toContain(LOAD_FAILED);
  });
});

/* AFTER the shell cases: a root on a `<div>` marks `document` as listened to, and a later root on
   `document` then attaches no listeners of its own. */
describe("the editor's door, whose chunk failed once", () => {
  beforeEach(freshModules);

  async function mountEditor(): Promise<HTMLElement> {
    const { RichEditor } = await import("../app/shell/RichEditorLazy");
    const { EMPTY_RICH } = await import("../app/shell/rich-text");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(RichEditor, { value: EMPTY_RICH, onChange: () => {}, ariaLabel: "Message", className: "compose-editor" }),
      }));
    });
    return host;
  }

  it("says so inside the editor's frame, and Try again loads the editor", async () => {
    chunks.editorFails = 1;
    const host = await mountEditor();
    await waitFor(() => (host.textContent ?? "").includes(LOAD_FAILED) || host.querySelector(".rte-surface") != null,
      "the failed editor painted nothing");
    expect(host.querySelector(".compose-editor"), "the sentence left the editor's frame").not.toBeNull();
    expect(host.querySelector("[role=alert]")?.textContent).toContain(LOAD_FAILED);
    await act(async () => { host.querySelector<HTMLButtonElement>("[role=alert] button")!.click(); });
    await waitFor(() => host.querySelector(".rte-surface") != null, "Try again did not load the editor");
    expect(chunks.editorLoads).toBe(2);
  });

  it("a chunk gone after an update says so inside the editor's frame, with Reload", async () => {
    chunks.editorGone = `${location.origin}/_next/static/chunks/rich-editor.js`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 404 }));
    const host = await mountEditor();
    await waitFor(() => host.querySelector("[role=alert]") != null, "the failed editor painted nothing");
    expect(host.querySelector(".compose-editor [role=alert]")?.textContent).toContain((messages.viewError as Record<string, string>).updated);
    expect(host.querySelector("[role=alert] button")?.textContent).toBe(messages.viewError.action);
  });
});

describe("the helper, when a render lands as the import fails", () => {
  it("shows the failure and does not fetch again unseen", async () => {
    const { lazyView } = await import("../app/shell/lazy-view");
    let loads = 0;
    let reject: (e: unknown) => void = () => {};
    const View = lazyView((): Promise<{ default: React.ComponentType<{ n: number }> }> => {
      loads += 1;
      return new Promise((_, r) => { reject = r; });
    });
    let bump: () => void = () => {};
    function Parent() {
      const [n, setN] = React.useState(0);
      bump = () => setN((v) => v + 1);
      return h(View, { n });
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(Parent) }));
    });
    // The rejection and a parent's render in one tick: the render must not read a replaced door.
    await act(async () => { reject(new Error("Loading chunk failed")); bump(); });
    await waitFor(() => (host.textContent ?? "").includes(LOAD_FAILED) || loads > 1, "the failure never showed");
    expect(loads, "a render fetched again before the failure was on screen").toBe(1);
    expect(host.querySelector("[role=alert]")?.textContent).toContain(LOAD_FAILED);
  });

  it("a failure that lands after the view closed: the next open asks again", async () => {
    const { lazyView } = await import("../app/shell/lazy-view");
    let loads = 0;
    let reject: (e: unknown) => void = () => {};
    const View = lazyView((): Promise<{ default: React.ComponentType<object> }> => {
      loads += 1;
      if (loads === 1) return new Promise((_, r) => { reject = r; });
      return Promise.resolve({ default: () => h("p", { id: "loaded" }, "loaded") });
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    const show = (on: boolean) => h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: on ? h(View) : null });
    await act(async () => { root.render(show(true)); });
    await act(async () => { root.render(show(false)); });
    await act(async () => { reject(new Error("Loading chunk failed")); });
    await act(async () => { root.render(show(true)); });
    await waitFor(() => host.querySelector("#loaded") != null || (host.textContent ?? "").includes(LOAD_FAILED), "the reopened view painted nothing");
    expect(loads, "the next open did not ask again").toBe(2);
    expect(host.querySelector("#loaded"), "the next open showed a failure nobody had seen").not.toBeNull();
  });
});

/*
 * AFTER A SERVER UPGRADE an open tab asks for its own build's chunks, which the new server no longer
 * has (404). Retrying fetches the same missing file; only a reload helps, and the network is fine.
 */
describe("a chunk the server no longer has, after an update", () => {
  const UPDATED = (messages.viewError as Record<string, string>).updated;
  const RELOAD = messages.viewError.action;
  const CHUNK = "/_next/static/chunks/9592.js";
  /** webpack's own shape for a script that did not load. */
  const chunkLoadError = (src: string): Error => Object.assign(
    new Error(`Loading chunk 9592 failed.\n(error: ${src})`), { name: "ChunkLoadError", type: "error", request: src });

  function server(answer: (url: string, init?: RequestInit) => Promise<Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => answer(String(input), init));
  }

  async function mountFailing(cause: unknown): Promise<{ host: HTMLElement; loads: () => number }> {
    const { lazyView } = await import("../app/shell/lazy-view");
    let loads = 0;
    const View = lazyView((): Promise<{ default: React.ComponentType<object> }> => { loads += 1; return Promise.reject(cause); });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => { root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(View) })); });
    await waitFor(() => host.querySelector("[role=alert]") != null, "the failed view painted nothing");
    return { host, loads: () => loads };
  }

  const buttons = (host: HTMLElement): string[] => Array.from(host.querySelectorAll("[role=alert] button")).map((b) => b.textContent ?? "");

  it("says ohmail was updated with a Reload press, never blames the connection", async () => {
    const asked = server(async (url) => new Response(null, { status: url.endsWith(CHUNK) ? 404 : 200 }));
    const { page } = await import("../app/shell/lazy-view");
    const reload = vi.spyOn(page, "reload").mockImplementation(() => {});
    const { host, loads } = await mountFailing(chunkLoadError(`${location.origin}${CHUNK}`));
    const text = host.querySelector("[role=alert]")?.textContent ?? "";
    expect(text).toContain(UPDATED);
    expect(text, "a build change blamed the connection").not.toContain(LOAD_FAILED);
    expect(buttons(host), "Try again would fetch the same missing chunk").toEqual([RELOAD]);
    expect(asked).toHaveBeenCalledWith(`${location.origin}${CHUNK}`, expect.objectContaining({ method: "HEAD", cache: "no-store" }));
    expect(reload, "the page reloaded on its own").not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLButtonElement>("[role=alert] button")!.click(); });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(loads(), "the gone chunk was fetched again").toBe(1);
  });

  it("reads the chunk from a browser's module import error too", async () => {
    server(async () => new Response(null, { status: 404 }));
    const { host } = await mountFailing(new TypeError(`Failed to fetch dynamically imported module: ${location.origin}/_next/static/chunks/app/compose.js`));
    expect(host.querySelector("[role=alert]")?.textContent).toContain(UPDATED);
  });

  it("CONTROL: the server still has the chunk: the connection sentence and Try again stay", async () => {
    server(async () => new Response(null, { status: 200 }));
    const { host } = await mountFailing(chunkLoadError(`${location.origin}${CHUNK}`));
    expect(host.querySelector("[role=alert]")?.textContent).toContain(LOAD_FAILED);
    expect(buttons(host)).toEqual([messages.viewError.tryAgain]);
  });

  it("CONTROL: the network is down: it still says to check the connection", async () => {
    server(async () => { throw new TypeError("Failed to fetch"); });
    const { host } = await mountFailing(chunkLoadError(`${location.origin}${CHUNK}`));
    expect(host.querySelector("[role=alert]")?.textContent).toContain(LOAD_FAILED);
    expect(buttons(host)).toEqual([messages.viewError.tryAgain]);
  });

  it("a chunk named on another origin is never asked about", async () => {
    const asked = server(async () => new Response(null, { status: 404 }));
    const { host } = await mountFailing(chunkLoadError(`https://elsewhere.example${CHUNK}`));
    expect(asked).not.toHaveBeenCalled();
    expect(host.querySelector("[role=alert]")?.textContent).toContain(LOAD_FAILED);
  });

  it.each([
    ["an /api URL", `${location.origin}/api/messages/m1/body`],
    ["a page path", `${location.origin}/settings`],
    ["a non-static /_next path", `${location.origin}/_next/data/build/x.json`],
  ])("only a build chunk is asked about: %s named on this origin probes nothing", async (_what, url) => {
    const asked = server(async () => new Response(null, { status: 404 }));
    const { host } = await mountFailing(new TypeError(`Failed to fetch dynamically imported module: ${url}`));
    expect(asked, "a probe left for a URL that is not a build chunk").not.toHaveBeenCalled();
    expect(host.querySelector("[role=alert]")?.textContent).toContain(LOAD_FAILED);
    expect(buttons(host)).toEqual([messages.viewError.tryAgain]);
  });

  it.each([404, 410])("a /_next/static/ chunk that answers %i shows Reload", async (status) => {
    server(async () => new Response(null, { status }));
    const { host } = await mountFailing(chunkLoadError(`${location.origin}${CHUNK}`));
    expect(host.querySelector("[role=alert]")?.textContent).toContain(UPDATED);
    expect(buttons(host)).toEqual([RELOAD]);
  });
});

/*
 * THE CENSUS: every `lazy(` under `app/` is the helper's own. Comments and strings are blanked
 * first, so prose naming the function is not a call; the positive controls plant each spelling.
 */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../app");
const HELPER = "shell/lazy-view.tsx";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const lazyCalls = (src: string): number => (withoutCommentsAndLiterals(src).match(/(?<![\w$])lazy\s*\(/g) ?? []).length;
const helperCalls = (src: string): number => (withoutCommentsAndLiterals(src).match(/(?<![\w$])lazyView\s*[<(]/g) ?? []).length;

describe("every lazy view goes through the one helper", () => {
  const files = sources(APP);

  it("CONTROL: the scan counts a call in each spelling and nothing in prose", () => {
    expect(lazyCalls("const A = lazy(() => import" + "('./a'));")).toBe(1);
    expect(lazyCalls("const B = React.lazy(() => import" + "('./b'));")).toBe(1);
    expect(lazyCalls("const C = lazy (async () => ({ default: Cx }));")).toBe(1);
    expect(lazyCalls("// a lazy( in a comment\nconst s = \"lazy(\"; lazyView(x); isLazy(y);")).toBe(0);
    expect(helperCalls("const V = lazyView<P>(() => import" + "('./v'));")).toBe(1);
  });

  it("no file under app/ calls lazy() but the helper, which calls it once", () => {
    expect(files.length, "the walk found no sources — the census would pass for nothing").toBeGreaterThan(100);
    const offenders = files
      .filter((f) => relative(APP, f) !== HELPER && lazyCalls(readFileSync(f, "utf8")) > 0)
      .map((f) => relative(APP, f));
    expect(offenders, "a lazy() outside the helper keeps a failed chunk for the life of the page").toEqual([]);
    expect(lazyCalls(readFileSync(join(APP, HELPER), "utf8"))).toBe(1);
  });

  it("the three split views are the helper's: Compose, Settings and the editor", () => {
    const at = Object.fromEntries(files.map((f) => [relative(APP, f), helperCalls(readFileSync(f, "utf8"))]));
    expect(at["shell/AppShell.tsx"], "Compose and Settings").toBe(2);
    expect(at["shell/RichEditorLazy.tsx"], "the editor").toBe(1);
  });
});

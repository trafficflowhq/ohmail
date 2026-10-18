/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { NextIntlClientProvider } from "next-intl";

import { MessageBody, sanitizeMailHtml } from "../../webapp/app/components/MessageBody";
import { setRenderedLinksSink } from "../../webapp/app/shell/rendered-links";
import { enableExternalLinks, interceptLinkClicks, OPEN_EXTERNAL_COMMAND } from "../../webapp/app/shell/open-external";
import { PROVIDERS } from "../../webapp/app/shell/providers";
import { RichEditor } from "../../webapp/app/shell/RichEditor";
import type { RichValue } from "../../webapp/app/shell/rich-text";
import { SignatureBlock } from "../../webapp/app/shell/SignatureBlock";
import { SIG_FOLLOWING } from "../../webapp/app/shell/signature";
import { HeldUnsubscribe } from "../../webapp/app/views/ScreenerView";
import messages from "../../webapp/messages/en.json";
import { ACCOUNT_PAGE_SURFACE, leaveForAccountPage } from "../src/DesktopSubscription.js";
import { reportRenderedLinksToShell } from "../src/native.js";

/**
 * THE LINKS ON SCREEN REACH THE SHELL BEFORE ANYBODY CAN PRESS ONE. The shell's `open_external`
 * and its new-window door open an address only when a renderer reported it (`rendered_links.rs`),
 * so the half that can be built, tested and unreachable is this one: a sink nobody armed, a
 * renderer that draws a link and never reports it, a report in a spelling the open does not use.
 * The renderers are mounted over a fake shell with the window armed exactly as `main.tsx` arms it,
 * and every command the window sends is recorded in order. Mutations watched red: the renderer's
 * report removed (each mount row); the unmount's empty report removed (the unmount rows); the
 * frame reporting while the prose is on screen (the letter row's one surface); the press reporting
 * after its click (the account row); the editor reading its links only when it arrives or only on
 * `update`, reporting the mark's raw href, or reporting only when it is read-only (the draft row).
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

/** Every command the window sent the shell, in order. */
const sent: Array<{ command: string; payload?: Record<string, unknown> }> = [];
const reports = (): Array<{ surface: string; urls: string[] }> =>
  sent.filter((s) => s.command === "rendered_links").map((s) => s.payload as { surface: string; urls: string[] });
const opens = (): string[] => sent.filter((s) => s.command === OPEN_EXTERNAL_COMMAND).map((s) => String(s.payload?.url));
const firstOf = (command: string): number => sent.findIndex((s) => s.command === command);

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;
let dispose: (() => void) | null = null;

async function turns(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => { root!.render(element); });
  await turns();
  return mountPoint;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  mountPoint?.remove();
  mountPoint = null;
}

async function press(a: HTMLAnchorElement): Promise<void> {
  a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  await turns(2);
}

beforeEach(() => {
  sent.length = 0;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      sent.push({ command, payload });
      return null;
    },
  };
  // What `main.tsx` arms before the first render: the interceptor, and the sink to the shell.
  enableExternalLinks();
  dispose = interceptLinkClicks(document, { trustSameOrigin: true });
  setRenderedLinksSink(reportRenderedLinksToShell);
});

afterEach(async () => {
  await unmount();
  dispose?.();
  dispose = null;
  setRenderedLinksSink(null);
  delete host.__TAURI_INTERNALS__;
});

/** A designed mail: the 600px canvas keeps it in its frame. */
const FRAMED =
  '<table width="600" cellpadding="0"><tr><td>' +
  '<p><a href="https://example.test/a?b=1&amp;c=2#f">one</a> <a href="HTTP://EXAMPLE.TEST/Path">two</a></p>' +
  '<p><a href="https://bücher.example/ü">three</a> <a href="mailto:x@y.test">mail</a> <a href="cid:p@x.test">cid</a></p>' +
  "</td></tr></table>";

describe("a message's links are on the shell's list while it is on screen", () => {
  it("a framed message reports the frame's links at mount, before any open, and takes them back", async () => {
    const el = await mount(h(MessageBody, { messageId: "m1", text: "one two three", html: FRAMED }));
    expect(el.querySelector("iframe"), "this fixture must render in its frame").not.toBeNull();
    const [first, ...rest] = reports();
    expect(first, "the frame's links never reached the shell").toBeDefined();
    expect(first!.urls).toEqual(sanitizeMailHtml(FRAMED).links);
    expect(first!.urls).toEqual([
      "https://example.test/a?b=1&c=2#f",
      "http://example.test/Path",
      "https://xn--bcher-kva.example/%C3%BC",
    ]);
    expect(rest, "an unchanged frame reported again").toEqual([]);
    expect(opens()).toEqual([]);
    await unmount();
    expect(reports().at(-1), "the unmount left the frame's links on the list").toEqual({ surface: first!.surface, urls: [] });
  });

  it("a prose link opens with the exact bytes its renderer reported, and the report came first", async () => {
    const el = await mount(h(MessageBody, { messageId: "m2", text: "see https://example.test/a?b=1&c=2 and <https://bücher.example/ü>", html: null }));
    const [report] = reports();
    expect(report?.urls).toEqual(["https://example.test/a?b=1&c=2", "https://xn--bcher-kva.example/%C3%BC"]);
    for (const a of el.querySelectorAll<HTMLAnchorElement>("a.msg-link")) await press(a);
    expect(opens()).toEqual(report!.urls);
    expect(firstOf("rendered_links")).toBeLessThan(firstOf(OPEN_EXTERNAL_COMMAND));
  });

  it("an html letter set in the app's own type reports its anchors the same way", async () => {
    const html = '<p>Hello, <a href="https://example.test/letter?x=1">the page</a>.</p>';
    const el = await mount(h(MessageBody, { messageId: "m3", text: "Hello, the page.", html }));
    expect(el.querySelector("iframe"), "a letter renders in the app's type").toBeNull();
    const a = el.querySelector<HTMLAnchorElement>("a.msg-link");
    expect(a, "the letter's anchor is not on screen").not.toBeNull();
    await press(a!);
    expect(reports().flatMap((r) => r.urls)).toContain("https://example.test/letter?x=1");
    expect(opens()).toEqual(["https://example.test/letter?x=1"]);
    // One surface: the frame that is not on screen reports nothing beside the prose that is.
    expect(new Set(reports().map((r) => r.surface)).size).toBe(1);
  });

  it("the Screener's unsubscribe link is reported while it is drawn", async () => {
    const url = "https://lists.example.test/unsubscribe?id=7";
    const el = await mount(
      h(NextIntlClientProvider, {
        locale: "en",
        messages: messages as never,
        timeZone: "UTC",
        children: h(HeldUnsubscribe, { state: "not_one_click", url, onUnsubscribe: async () => null }),
      }),
    );
    expect(el.querySelector("a.hm-unsub-link")?.getAttribute("href")).toBe(url);
    expect(reports().flatMap((r) => r.urls)).toEqual([url]);
    await unmount();
    expect(reports().at(-1)?.urls).toEqual([]);
  });

  it("the account page a press minted is reported before the click that opens it", async () => {
    const minted = "https://account.example.test/manage?t=abc";
    leaveForAccountPage(minted);
    await turns(2);
    expect(sent.map((s) => s.command)).toEqual(["rendered_links", OPEN_EXTERNAL_COMMAND]);
    expect(reports()).toEqual([{ surface: ACCOUNT_PAGE_SURFACE, urls: [minted] }]);
    expect(opens()).toEqual([minted]);
  });

  it("with no sink armed — the web app's state — nothing is reported", async () => {
    setRenderedLinksSink(null);
    await mount(h(MessageBody, { messageId: "m4", text: "x", html: FRAMED }));
    await unmount();
    await mount(h(MessageBody, { messageId: "m5", text: "see https://example.test/plain", html: null }));
    await unmount();
    expect(reports()).toEqual([]);
  });
});

/** The anchors the editor drew, once its lazy chunk has arrived and ProseMirror has drawn them. */
async function drawn(el: HTMLElement, selector: string): Promise<HTMLAnchorElement[]> {
  for (let i = 0; i < 40; i++) {
    const found = [...el.querySelectorAll<HTMLAnchorElement>(selector)];
    if (found.length > 0) return found;
    await turns(1);
  }
  throw new Error(`the editor drew nothing matching ${selector}`);
}

const OUR_SITE = "https://example.test/our-site";

describe("the editor's links — a signature's, a draft's — are on the list while it is mounted", () => {
  it("a signature's link, drawn by the read-only editor, is reported before its click opens it", async () => {
    const el = await mount(
      h(NextIntlClientProvider, {
        locale: "en",
        messages: messages as never,
        timeZone: "UTC",
        children: h(SignatureBlock, {
          sig: SIG_FOLLOWING,
          onSig: () => {},
          signatures: { "mb-1": "Anna, our site" },
          signaturesHtml: { "mb-1": `<p>Anna, <a href="${OUR_SITE}">our site</a></p>` },
          mailboxId: "mb-1",
          disabled: false,
        }),
      }),
    );
    const [a] = await drawn(el, ".sig-rich a[href]");
    expect(a!.closest('[contenteditable="false"]'), "the signature is not the read-only view").not.toBeNull();
    const report = reports().find((r) => r.urls.includes(OUR_SITE));
    expect(report, "the signature's link never reached the shell").toBeDefined();
    await press(a!);
    expect(opens()).toEqual([OUR_SITE]);
    expect(firstOf("rendered_links")).toBeLessThan(firstOf(OPEN_EXTERNAL_COMMAND));
    await unmount();
    expect(reports().at(-1), "the unmount left the signature's link on the list").toEqual({ surface: report!.surface, urls: [] });
  });

  it("a draft's links follow its document, and a click opens the bytes its editor reported", async () => {
    let replace: ((next: RichValue) => void) | null = null;
    function Draft(): React.ReactElement {
      const [value, setValue] = React.useState<RichValue>({
        text: "old",
        html: '<p><a href="https://example.test/old">old</a></p>',
      });
      replace = setValue;
      return h(RichEditor, { value, onChange: setValue, ariaLabel: "Message" });
    }
    const el = await mount(
      h(NextIntlClientProvider, { locale: "en", messages: messages as never, timeZone: "UTC", children: h(Draft) }),
    );
    await drawn(el, ".rte a[href]");
    expect(reports().at(-1)?.urls, "the draft's link never reached the shell").toEqual(["https://example.test/old"]);

    // A restored or generated draft lands through `setContent`, which emits no update.
    await act(async () => {
      replace!({ text: "new", html: '<p><a href="HTTPS://Bücher.example/ü?x=1#f">new</a></p>' });
    });
    await turns();
    const last = reports().at(-1)!;
    expect(last.urls, "the replaced draft's link is not the one on the list").toEqual([
      "https://xn--bcher-kva.example/%C3%BC?x=1#f",
    ]);
    expect(new Set(reports().map((r) => r.surface)).size, "one editor is one surface").toBe(1);

    // A change that keeps the same links sends nothing.
    const before = reports().length;
    await act(async () => {
      replace!({ text: "new, again", html: '<p><a href="HTTPS://Bücher.example/ü?x=1#f">new</a>, again</p>' });
    });
    await turns();
    expect(reports().length, "a change that kept the links reported them again").toBe(before);

    const [a] = await drawn(el, ".rte a[href]");
    await press(a!);
    expect(opens()).toEqual(last.urls);
    await unmount();
    expect(reports().at(-1)).toEqual({ surface: last.surface, urls: [] });
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE WIRING, FROM SOURCE: who may report, where the sink is armed, what the shell treats as its
   own, and that both doors ask the one predicate.
   ───────────────────────────────────────────────────────────────────────────────────────── */

/* The repository root, from the root suite or from `apps/desktop` (`sourceOf`'s two places). */
const REPO = existsSync(resolve(process.cwd(), "apps/desktop/src-tauri")) ? process.cwd() : resolve(process.cwd(), "../..");
const source = (rel: string): string => readFileSync(join(REPO, rel), "utf8");

function filesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "test" || e.name.startsWith(".")) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(relative(REPO, path));
    }
  };
  walk(join(REPO, rel));
  return out;
}

/** One `fn`'s body, from its signature to the brace that closes it. */
function bodyOf(src: string, signature: string): string {
  const at = src.indexOf(signature);
  expect(at, `${signature} is not in the source any more`).toBeGreaterThan(-1);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${signature} does not close`);
}

describe("the wiring, from source", () => {
  it("only the renderers, the minted account page and the desktop entry reach the seam", () => {
    const sources = ["apps/webapp/app", "apps/desktop/src", "packages"].flatMap(filesUnder);
    const reaching = sources.filter((f) => /from\s+["'][^"']*\/rendered-links(?:\.js)?["']/.test(source(f))).sort();
    expect(reaching).toEqual([
      "apps/desktop/src/DesktopSubscription.tsx",
      "apps/desktop/src/main.tsx",
      "apps/webapp/app/components/MessageBody.tsx",
      "apps/webapp/app/shell/BodyText.tsx",
      "apps/webapp/app/shell/RichEditor.tsx",
      "apps/webapp/app/views/ScreenerView.tsx",
    ]);
  });

  it("the desktop entry arms the shell's reporter before the first render", () => {
    const main = source("apps/desktop/src/main.tsx");
    const armed = main.indexOf("setRenderedLinksSink(reportRenderedLinksToShell)");
    expect(armed, "main.tsx does not arm the sink").toBeGreaterThan(-1);
    expect(armed, "the sink is armed after the first render").toBeLessThan(main.indexOf("createRoot("));
  });

  it("the command is named in the window's own native module and nowhere in the shared code", () => {
    expect(source("apps/desktop/src/native.ts")).toMatch(/"rendered_links"/);
    for (const f of [...filesUnder("apps/webapp/app"), ...filesUnder("packages")]) {
      expect(source(f), `${f} names the shell command`).not.toMatch(/["'`]rendered_links["'`]/);
    }
    // And both artifacts are read for it: the window must name it, the served page must not.
    expect(source("apps/desktop/scripts/scan-artifact.mjs")).toMatch(
      /SHELL_COMMAND_MARKERS = \[[^\]]*"rendered_links"/,
    );
  });

  it("the shell's own links are the provider help pages, verbatim and in URL.href form", () => {
    const rs = source("apps/desktop/src-tauri/src/rendered_links.rs");
    const list = /pub const OWN_LINKS: \[&str; (\d+)\] = \[([\s\S]*?)\];/.exec(rs);
    expect(list, "OWN_LINKS has stopped matching this reader").not.toBeNull();
    const own = [...list![2]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(Number(list![1])).toBe(own.length);
    const help = PROVIDERS.flatMap((p) => (p.helpUrl ? [p.helpUrl] : []));
    expect(help.length).toBeGreaterThan(5);
    expect([...own].sort()).toEqual([...help].sort());
    for (const u of own) expect(new URL(u).href, u).toBe(u);
  });

  it("both doors ask the one predicate, and the state is in before the grant", () => {
    const engine = source("apps/desktop/src-tauri/src/engine.rs");
    const open = bodyOf(engine, "fn open_external(");
    expect(open).toMatch(/admitted\(&url, held\)/);
    expect(open).toMatch(/spawn_opener\(target\)/);
    expect(open, "a refusal at the command door is not logged").toMatch(/log_refusal\(Door::Command/);
    expect(bodyOf(engine, "pub fn popup_route(")).toMatch(/rendered_links::admitted\(url, set\)/);
    expect(bodyOf(engine, "pub fn on_new_window<")).toMatch(/read_managed\(&app/);
    expect(bodyOf(engine, "pub fn link_door<")).toMatch(/read_managed\(&app/);
    const manage = bodyOf(engine, "pub fn manage(");
    expect(manage.indexOf("RenderedLinks::default()"), "the links are never managed").toBeGreaterThan(-1);
    expect(manage.indexOf("RenderedLinks::default()")).toBeLessThan(manage.indexOf("add_capability("));
  });
});

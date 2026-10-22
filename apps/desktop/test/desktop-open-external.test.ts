/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ═══ A LINK IN A MESSAGE OPENS THE USER'S BROWSER, AND NEVER THIS WINDOW ═══════════════════
 *
 * The defect: clicking any link in the desktop app did NOTHING. Not an error, not a blank page,
 * not a log line — nothing, on every link in the product, in a mail body and out of it.
 *
 * The mechanism, because it is worth stating precisely and none of the obvious three: every
 * outbound link carries `target="_blank"` (the sanitizer forces it onto every `<a>` in a body,
 * and the shell's hand-written link-outs spell it out). A `_blank` click is not a navigation, it
 * is a request for a NEW WINDOW. The webview forwards that to whatever the host application
 * registered to answer it; this app registered nothing; a webview with no new-window handler
 * returns no window. So no navigation policy refused it, no CSP blocked it and no Tauri
 * permission was missing — nothing was invoked to be denied. The click was answered correctly by
 * a component whose correct answer is "no window", which is exactly why it was silent.
 *
 * ── WHAT THIS FILE HOLDS DOWN ───────────────────────────────────────────────────────────────
 *
 *  1. a clicked http/https link becomes the webview's own new-window request for the EXACT
 *     address, made inside the click (the shell opens it only on the person's own click,
 *     `link_gate.rs`), and the click is cancelled so the webview cannot navigate;
 *  2. no other scheme ever becomes that request — `cid:` above all, which names a part of the
 *     message being read and must not leave the machine;
 *  3. in a document where nothing is the app's own navigation (`trustSameOrigin: false`),
 *     nothing but an http/https address leaves; a MESSAGE FRAME carries no listener at all —
 *     its links are the shell's new-window door (`popup_route` in `engine.rs`);
 *  4. the WEB app is untouched: nothing is installed, no listener exists, and an anchor keeps
 *     the semantics the browser gives it;
 *  5. the window names no address to the shell: `open_external` is registered, declared and
 *     granted nowhere, so a script in the window cannot report a link and open it with no click.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · drop the `ev.preventDefault()` in the http arm            → the "does not navigate" case
 *    goes red (the webview would have been left to open the address itself);
 *  · open after an `await`, or hand the address to a command   → the "inside the click" case
 *                                                                goes red;
 *  · let an unrecognised scheme fall through instead of        → the `cid:`/`mailto:` case goes
 *    refusing it                                                 red;
 *  · make `interceptLinkClicks` install regardless of          → the web-app case goes red;
 *    `enableExternalLinks`
 *  · pass `trustSameOrigin: true` for the untrusted document  → that case goes red;
 *  · register `open_external` again                            → the absence case goes red;
 *  · install the listener on the frame again in `MessageBody`  → the wiring case goes red.
 */

type Invoked = { command: string; payload?: Record<string, unknown> };

let invoked: Invoked[] = [];
/** Every new-window request the window made, as `window.open`'s three arguments. */
let opened: unknown[][] = [];

interface Host {
  __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> };
}
const host = globalThis as unknown as Host;

/**
 * Listeners installed by a case, taken off after it.
 *
 * The suite shares ONE jsdom document, and the web app's case is an assertion that NOTHING is
 * listening on it — which a leftover listener from the case before would satisfy in the wrong
 * direction, quietly. `vi.resetModules()` gives each case a fresh module (so its armed flag and
 * its installed-document set start empty) and cannot reach a listener already on the document.
 */
let disposers: Array<() => void> = [];

beforeEach(() => {
  invoked = [];
  opened = [];
  host.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      invoked.push({ command, payload });
      return Promise.resolve(null);
    },
  };
  // The webview's new-window request: recorded, and answered with no window, as the shell does.
  vi.spyOn(window, "open").mockImplementation((...args: unknown[]) => {
    opened.push(args);
    return null;
  });
  document.body.innerHTML = "";
  vi.resetModules();
});

afterEach(() => {
  for (const off of disposers) off();
  disposers = [];
  delete host.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

/** A fresh copy of the module — its "armed" flag and its installed-document set are per-module. */
async function freshModule() {
  return import("../../webapp/app/shell/open-external.js");
}

/** Install, and register the teardown in one step so a case cannot forget it. */
function install(
  mod: Awaited<ReturnType<typeof freshModule>>,
  doc: Document,
  trustSameOrigin: boolean,
): void {
  disposers.push(mod.interceptLinkClicks(doc, { trustSameOrigin }));
}

/**
 * Click an anchor the way a person does. Answers whether the default was left to the browser.
 *
 * The event is constructed from THIS realm's `MouseEvent` rather than the target document's:
 * `createHTMLDocument` — which is how the message frame's separate document is made here — has
 * no `defaultView` at all, and the listener reads `button` and `preventDefault`, neither of
 * which cares which realm minted the object.
 */
function clickAnchor(doc: Document, href: string): boolean {
  const a = doc.createElement("a");
  a.setAttribute("href", href);
  a.textContent = "link";
  doc.body.appendChild(a);
  return a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE CLASSIFIER — the whole decision, driven directly rather than through an event.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("what counts as an address to hand to the browser", () => {
  const BASE = "http://localhost:3000/mailbox";

  it("http and https resolve to themselves", async () => {
    const { externalTargetOf } = await freshModule();
    expect(externalTargetOf("https://example.test/a?b=1#c", BASE))
      .toBe("https://example.test/a?b=1#c");
    expect(externalTargetOf("http://example.test/", BASE)).toBe("http://example.test/");
    // Whitespace a mail body wrapped around the value is not part of the address.
    expect(externalTargetOf("  https://example.test/  ", BASE)).toBe("https://example.test/");
  });

  it("no other scheme is ever an address — `cid:` least of all", async () => {
    const { externalTargetOf } = await freshModule();
    for (const href of [
      "cid:part1@example.test",
      "mailto:someone@example.test",
      "tel:+41000000000",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ohmail://link?code=stolen",
      "",
      "   ",
    ]) {
      expect(externalTargetOf(href, BASE), `${href} was treated as an address`).toBeNull();
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE DESKTOP WINDOW.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("the desktop window, armed", () => {
  it("a clicked link is ONE new-window request for the exact address, and does NOT navigate", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);

    const notPrevented = clickAnchor(document, "https://example.test/story?id=7#top");

    expect(notPrevented, "the click was left to the webview, which would have navigated").toBe(false);
    expect(opened).toEqual([["https://example.test/story?id=7#top", "_blank", "noopener,noreferrer"]]);
    expect(invoked, "the window handed the shell an address").toEqual([]);
  });

  /* INSIDE THE CLICK, OR NOT AT ALL. WebKit counts the person's gesture only while their event is
     handled (and its own short chain after it), so the request is made before the listener
     returns: no await, no promise, no command first. Read with no turn of the event loop between
     the dispatch and the assertion. */
  it("the request is made inside the click, before the listener returns", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);

    clickAnchor(document, "https://example.test/now");
    expect(opened, "the open waited for a later turn").toHaveLength(1);
  });

  it("a scheme that is not http(s) is stopped and never becomes a request", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);

    for (const href of ["cid:part1@example.test", "mailto:a@b.test", "tel:+41000000000"]) {
      clickAnchor(document, href);
    }
    expect(opened, "a non-http scheme was asked for as a window").toEqual([]);
    expect(invoked, "a non-http scheme was handed to the shell").toEqual([]);
  });

  it("the app's own navigation is left alone — a hash route is not an outing", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);

    expect(clickAnchor(document, "#/settings"), "an in-page route was cancelled").toBe(true);
    expect(opened).toEqual([]);
    expect(invoked).toEqual([]);
  });

  /**
   * THE ORDERING CASE, and the one this file could not see until the handler was run in a real
   * browser against a real origin.
   *
   * The same-origin test used to sit AFTER the http/https classifier, which made it dead code
   * for the only scheme it judges: `/mailbox` resolves to an `http:` URL, the classifier claimed
   * it, and the client's own route was posted to the platform's browser. macOS hid it — that
   * window is served from `tauri://localhost`, so an in-app link is not http and reached the
   * same-origin arm anyway — while on Windows and Linux, served from `http://tauri.localhost`,
   * every internal link in the app would have left for the browser.
   *
   * jsdom's document has a real http origin, so the case belongs here and not only in a browser.
   * Move the same-origin test back below the classifier and this goes red.
   */
  it("a same-origin PATH is the client's own route, not an address to open", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);

    for (const own of ["/mailbox#/settings", "/login", "./drafts", location.origin + "/mailbox"]) {
      expect(clickAnchor(document, own), `${own} was cancelled`).toBe(true);
    }
    expect(opened, "the app's own routes were sent to the platform's browser").toEqual([]);
  });

  it("installing twice does not answer one click twice", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);
    install(mod, document, true);

    clickAnchor(document, "https://example.test/");
    expect(opened).toHaveLength(1);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   A SECOND DOCUMENT, and nothing in it is the app's own navigation.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("in a document that is not the app's own", () => {
  it("an http link goes out, and a same-origin one does NOT get to navigate the app", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    // A document of its own, as `srcdoc` gives the sender. `trustSameOrigin` is false here: a
    // sender writing a link to the app's own origin is not the client routing itself.
    const frame = document.implementation.createHTMLDocument("mail");
    install(mod, frame, false);

    expect(clickAnchor(frame, "https://newsletter.test/unsubscribe?u=9")).toBe(false);
    expect(opened).toEqual([["https://newsletter.test/unsubscribe?u=9", "_blank", "noopener,noreferrer"]]);

    opened = [];
    // `cid:` in a frame is the sharp one: it names a part of THIS message.
    expect(clickAnchor(frame, "cid:part1@example.test"), "a cid: link was left to the frame")
      .toBe(false);
    expect(opened).toEqual([]);
    expect(invoked).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE WEB APP — the same shared module, imported and inert.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("the web app is not touched", () => {
  it("without arming, nothing is installed and an anchor keeps the browser's own semantics", async () => {
    const mod = await freshModule();
    expect(mod.externalLinksEnabled()).toBe(false);
    // The shared reading surface calls this on every frame load, on the web too. It must do
    // nothing there — not "invoke and fail", not "cancel and do nothing": nothing.
    install(mod, document, true);

    expect(clickAnchor(document, "https://example.test/"), "the web app cancelled a link click")
      .toBe(true);
    expect(opened, "the web app replaced the browser's own link with a script's open").toEqual([]);
    expect(invoked, "the web app called a desktop shell command").toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE SHELL'S HALF, FROM SOURCE, in `desktop-attach-cap.test.ts`'s method. The window used to
   hand the shell an address over `open_external`, and a script already in the window could
   report a link and open it with no click. The command is gone from all three places a command
   lives — the handler, the declaration and the grant — and the module that called it names no
   shell command at all. Read from source because what regresses in this family is a name in a
   literal.
   ───────────────────────────────────────────────────────────────────────────────────────── */

function sourceOf(rel: string): string {
  try {
    return readFileSync(resolve(process.cwd(), `apps/desktop/${rel}`), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), rel), "utf8");
  }
}

describe("the window hands the shell no address", () => {
  const engine = sourceOf("src-tauri/src/engine.rs");

  it("`open_external` is not registered, not declared and not granted", () => {
    const handler = /generate_handler!\[([^\]]*)\]/s.exec(engine)?.[1] ?? "";
    expect(handler, "the invoke handler could not be read").toMatch(/\bopen_link\b/);
    expect(handler.replace(/\/\/[^\n]*/g, ""), "open_external is still in the invoke handler")
      .not.toMatch(/\bopen_external\b/);

    const build = sourceOf("src-tauri/build.rs");
    const declared = /const WINDOW_COMMANDS: &\[&str\] = &\[([^\]]*)\]/s.exec(build)?.[1] ?? "";
    expect(declared, "WINDOW_COMMANDS could not be read").toMatch(/"open_link"/);
    expect(declared, "build.rs still declares open_external").not.toMatch(/"open_external"/);

    const cap = engine.match(/const LOCAL_ENGINE_CAPABILITY: &str = r#"([\s\S]*?)"#;/);
    expect(cap, "LOCAL_ENGINE_CAPABILITY could not be read out of engine.rs").not.toBeNull();
    const grant = JSON.parse(cap![1]!) as { windows: string[]; permissions: string[] };

    expect(grant.permissions, "the window may still call open_external").not.toContain("allow-open-external");
    expect(grant.permissions).toContain("allow-open-link");
    // The grant stays the main window's and stays one-directional: it may hear the shell and
    // never make the shell hear it.
    expect(grant.windows).toEqual(["main"]);
    expect(grant.permissions).toContain("core:event:allow-listen");
    expect(grant.permissions).not.toContain("core:event:allow-emit");
  });

  it("the interceptor names no shell command and keeps no second refusal path", async () => {
    const mod = await freshModule();
    const code = sourceOf("../webapp/app/shell/open-external.ts").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/__TAURI_INTERNALS__|\binvoke\(|open_external/);
    // A refusal is the shell's `link:refused`, said by the gate (`desktop-link-refused.test.tsx`).
    expect("setOpenFailureSink" in mod, "the module still keeps a failure sink of its own").toBe(false);
    expect("OPEN_EXTERNAL_COMMAND" in mod).toBe(false);
  });

  it("only http and https can be spawned, and no shell parses the address on Windows", () => {
    // The gate itself is proven in `engine_tests.rs` (`only_an_http_address_with_a_host_is_ever
    // _opened`); what is asserted here is the property no unit test of a pure function can see —
    // that the spawn goes through no interpreter. `cmd /c start` was correct for the fixed key
    // table and is command injection for an address out of a mail body: Rust quotes an argument
    // for `CommandLineToArgvW`, not for cmd's grammar, so a URL carrying `&` (most URLs with a
    // query) arrives unquoted and cmd reads it as a command separator.
    expect(engine, "the Windows opener is a shell again").not.toMatch(/Command::new\("cmd"\)/);
    expect(engine).toMatch(/Command::new\("rundll32\.exe"\)/);
    expect(engine).toMatch(/pub\(crate\) fn spawn_opener\(url: &str\)/);
  });
});

/* A MESSAGE FRAME CARRIES NO LISTENER. WebKit (macOS, Linux) calls none in a frame sandboxed
   without scripts, so the frame's one door is the shell's new-window handler, on every engine;
   a listener here would be a second door on Chromium alone (the frame-links rig measures both). */
describe("the message frame is left to the shell's new-window door", () => {
  it("MessageBody installs no link listener on the frame's document", () => {
    const rel = "apps/webapp/app/components/MessageBody.tsx";
    let body: string;
    try {
      body = readFileSync(resolve(process.cwd(), rel), "utf8");
    } catch {
      body = readFileSync(resolve(process.cwd(), "../webapp/app/components/MessageBody.tsx"), "utf8");
    }
    expect(body, "a link listener is installed in the mail renderer again").not.toMatch(/interceptLinkClicks/);
    expect(body, "a click listener is put on a document in the mail renderer").not.toMatch(/addEventListener\(\s*["']click["']/);
    // Positive control: the frame whose links leave by the door is still this file's.
    expect(body).toMatch(/sandbox=\{FRAME_SANDBOX\}/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   A WEBVIEW THAT ANSWERS THE REQUEST WITH NOTHING. The shell never raises a second window, so
   `window.open` answers null; a refusal reaches the person as the shell's `link:refused`
   (`desktop-link-refused.test.tsx`), not as anything this listener waits for.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("the request is answered by the shell, not awaited here", () => {
  it("a null answer still leaves the click cancelled, and nothing throws", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);
    expect(clickAnchor(document, "https://example.test/"), "the click was left to the webview")
      .toBe(false);
    expect(opened).toHaveLength(1);
    expect(invoked).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE PLATFORM TABLE, ON EVERY PLATFORM. Only one arm of `opener_command` compiles per build,
   so the Rust unit beside it can only ever assert the arm it was built for; these read all
   three out of the source, which runs everywhere. Anchored on the FUNCTION'S OWN BODY rather
   than matched against the whole file — a needle that can be satisfied by a comment three
   thousand lines away is not an assertion about this function.
   ───────────────────────────────────────────────────────────────────────────────────────── */

/** One `fn`'s body, from its signature to the brace that closes it. */
function bodyOf(source: string, signature: string): string {
  const at = source.indexOf(signature);
  expect(at, `${signature} is not in the source any more`).toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${signature} does not close`);
}

describe("the one platform table, read on every platform", () => {
  const engine = sourceOf("src-tauri/src/engine.rs");
  const table = bodyOf(engine, "fn opener_command(");

  it("macOS opens with the system opener, by absolute path", () => {
    expect(table).toMatch(/Command::new\("\/usr\/bin\/open"\)/);
  });

  it("Windows opens through rundll32 and never through a shell", () => {
    // `cmd /c start` re-parses its own command line, so a URL out of a mail body carrying `&`
    // arrives unquoted and cmd reads it as a command separator. Asserted on the table's body so
    // the prose above it cannot satisfy either half.
    expect(table).not.toMatch(/Command::new\("cmd"\)/);
    expect(table).toMatch(/Command::new\("rundll32\.exe"\)/);
    expect(table).toMatch(/url\.dll,FileProtocolHandler/);
  });

  it("Linux runs an xdg-open it has LOOKED FOR, and names its absence", () => {
    // A bare name is resolved by whatever `PATH` the child is handed, and the AppImage launcher
    // puts its own bin first on that. The lookup is the repair; the sentence is what a person
    // gets instead of an ENOENT wearing the words "would not open a browser".
    expect(table).not.toMatch(/Command::new\("xdg-open"\)/);
    expect(table).toMatch(/xdg_open_program\(\)/);
    const at = engine.indexOf("const XDG_OPEN_LOCATIONS");
    expect(at, "the places to look for xdg-open are gone").toBeGreaterThan(-1);
    const locations = engine.slice(at, engine.indexOf(";", at));
    expect(locations).toContain("/usr/bin/xdg-open");
    expect(locations).toContain("/usr/local/bin/xdg-open");
    const named = engine.indexOf("const NO_OPENER");
    expect(named, "the sentence for a machine with no xdg-open is gone").toBeGreaterThan(-1);
    expect(engine.slice(named, engine.indexOf(";", named))).toContain("install xdg-utils");
  });

  it("the browser is not handed this bundle's own wiring", () => {
    expect(table).toMatch(/scrub_bundled_environment\(&mut command\)/);
    const list = engine.slice(engine.indexOf("const BUNDLE_ENV"), engine.indexOf("const BUNDLE_PATH_LISTS"));
    // Measured on a released AppImage: these are what the launcher exports, plus the two list
    // variables below, which are pruned rather than dropped because their host half is needed.
    for (const key of [
      "LD_LIBRARY_PATH", "GTK_PATH", "GTK_EXE_PREFIX", "GTK_DATA_PREFIX", "GTK_IM_MODULE_FILE",
      "GTK_THEME", "GDK_PIXBUF_MODULE_FILE", "GIO_EXTRA_MODULES", "GSETTINGS_SCHEMA_DIR",
    ]) {
      expect(list, `the opener passes ${key} to the browser`).toContain(`"${key}"`);
    }
    // `scrub_from` is the half that does the work; `scrub_bundled_environment` only supplies the
    // process environment to it, so that this can be driven with an AppImage's variables in hand.
    const scrub = bodyOf(engine, "fn scrub_from<F>(");
    expect(scrub).toMatch(/env_remove/);
    expect(scrub).toMatch(/host_half/);
    expect(bodyOf(engine, "fn scrub_bundled_environment(")).toMatch(/scrub_from\(/);
  });

  it("a spawn that started is not an open that happened", () => {
    // The reported case: `xdg-open` with no handler exits 3 while the `Ok` is already back at the
    // window. The shell reads the child's verdict within a bound instead of dropping it.
    //
    // The bound used to be a 25 ms `try_wait` loop and is now a thread blocked on the child with
    // the wait on this side — so the needles name the bound (`recv_timeout`) and the wait, which
    // together assert more than the old one did: the verdict is not only read within a bound, the
    // child is also reaped rather than left as a zombie for every link opened.
    const run = bodyOf(engine, "fn run_opener(");
    expect(run).toMatch(/recv_timeout\(OPENER_VERDICT\)/);
    expect(run).toMatch(/child\.wait\(\)/);
    expect(run).toMatch(/status\.success\(\)/);
    expect(run).not.toMatch(/\.map\(\|_\| \(\)\)/);
  });
});

describe("the window is granted the two sibling commands as well", () => {
  const engine = sourceOf("src-tauri/src/engine.rs");
  const grant = (() => {
    const cap = engine.match(/const LOCAL_ENGINE_CAPABILITY: &str = r#"([\s\S]*?)"#;/);
    expect(cap, "LOCAL_ENGINE_CAPABILITY could not be read out of engine.rs").not.toBeNull();
    return JSON.parse(cap![1]!) as { windows: string[]; permissions: string[] };
  })();

  it("`open_link` is registered AND named; `open_attachment` is neither", () => {
    // 0.9.7's shape, which is what makes this family fail silently: a command registered and not
    // granted is refused at the ACL with no window and no log. `open_link` spawns the shell's one
    // opener. `open_attachment` is gone (it launched bytes the window chose), and so is
    // `open_external` (it opened an address the window named, with no click).
    expect(engine, "open_link is not in the invoke handler").toMatch(/generate_handler!\[[^\]]*\bopen_link\b/s);
    expect(grant.permissions, "the window may not call open_link").toContain("allow-open-link");
    expect(engine).not.toMatch(/generate_handler!\[[^\]]*\bopen_attachment\b/s);
    expect(grant.permissions).not.toContain("allow-open-attachment");
    expect(grant.permissions).not.toContain("allow-open-external");
  });

  it("a permission this binary cannot resolve is DROPPED AND NAMED, never dropped quietly", () => {
    // 0.9.8 turned the launch abort into a degrade, which was right and is why a mismatch now
    // produces a window whose links do nothing. The log line is the only thread back from that
    // symptom to its cause, so it is held down here by the name it must carry.
    const reconcile = engine.slice(engine.indexOf("match resolvable_grant(LOCAL_ENGINE_CAPABILITY"));
    const arm = reconcile.slice(0, reconcile.indexOf("Err(reason)"));
    expect(arm, "the drop no longer loops over what went missing").toMatch(/for permission in &missing/);
    expect(arm, "the log line does not name the permission that was dropped")
      .toMatch(/\{permission\}/);
    expect(arm).toMatch(/build defect/);
  });
});

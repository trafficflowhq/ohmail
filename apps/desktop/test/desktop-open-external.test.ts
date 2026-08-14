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
 *  1. a clicked http/https link reaches the shell's opener with the EXACT address, and the
 *     click is cancelled so the webview cannot navigate;
 *  2. no other scheme ever reaches the opener — `cid:` above all, which names a part of the
 *     message being read and must not leave the machine;
 *  3. a message frame is a second document with its own listener, and inside one NOTHING is
 *     "the app's own navigation";
 *  4. the WEB app is untouched: nothing is installed, no listener exists, and an anchor keeps
 *     the semantics the browser gives it;
 *  5. the shell's grant names the command. This is the silent shape the whole slice is about —
 *     a command registered and not granted fails at the ACL with no window and no log, which is
 *     indistinguishable from a link that was never wired up.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · drop the `ev.preventDefault()` in the http arm            → the "does not navigate" case
 *    goes red (the webview would have been left to open the address itself);
 *  · let an unrecognised scheme fall through instead of        → the `cid:`/`mailto:` case goes
 *    refusing it                                                 red;
 *  · make `interceptLinkClicks` install regardless of          → the web-app case goes red;
 *    `enableExternalLinks`
 *  · pass `trustSameOrigin: true` from the frame               → the frame case goes red;
 *  · register `open_external` and leave it out of the          → the grant case goes red;
 *    capability
 *  · stop installing on the frame in `MessageBody`             → the wiring case goes red.
 */

type Invoked = { command: string; payload?: Record<string, unknown> };

let invoked: Invoked[] = [];

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
  host.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      invoked.push({ command, payload });
      return Promise.resolve(null);
    },
  };
  document.body.innerHTML = "";
  vi.resetModules();
});

afterEach(() => {
  for (const off of disposers) off();
  disposers = [];
  delete host.__TAURI_INTERNALS__;
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
  it("a clicked link reaches the opener with the exact address, and does NOT navigate", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);

    const notPrevented = clickAnchor(document, "https://example.test/story?id=7#top");

    expect(notPrevented, "the click was left to the webview, which would have navigated").toBe(false);
    expect(invoked).toEqual([
      {
        command: mod.OPEN_EXTERNAL_COMMAND,
        payload: { url: "https://example.test/story?id=7#top" },
      },
    ]);
  });

  it("a scheme that is not http(s) is stopped and never reaches the opener", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);

    for (const href of ["cid:part1@example.test", "mailto:a@b.test", "tel:+41000000000"]) {
      clickAnchor(document, href);
    }
    expect(invoked, "a non-http scheme was handed to the platform opener").toEqual([]);
  });

  it("the app's own navigation is left alone — a hash route is not an outing", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);

    expect(clickAnchor(document, "#/settings"), "an in-page route was cancelled").toBe(true);
    expect(invoked).toEqual([]);
  });

  it("installing twice does not answer one click twice", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);
    install(mod, document, true);

    clickAnchor(document, "https://example.test/");
    expect(invoked).toHaveLength(1);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   A MESSAGE FRAME — a second document, and nothing in it is the app's own navigation.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("inside a message frame", () => {
  it("an http link goes out, and a same-origin one does NOT get to navigate the app", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    // A document of its own, as `srcdoc` gives the sender. `trustSameOrigin` is false here: a
    // sender writing a link to the app's own origin is not the client routing itself.
    const frame = document.implementation.createHTMLDocument("mail");
    install(mod, frame, false);

    expect(clickAnchor(frame, "https://newsletter.test/unsubscribe?u=9")).toBe(false);
    expect(invoked).toEqual([
      {
        command: mod.OPEN_EXTERNAL_COMMAND,
        payload: { url: "https://newsletter.test/unsubscribe?u=9" },
      },
    ]);

    invoked = [];
    // `cid:` in a frame is the sharp one: it names a part of THIS message.
    expect(clickAnchor(frame, "cid:part1@example.test"), "a cid: link was left to the frame")
      .toBe(false);
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
    expect(invoked, "the web app called a desktop shell command").toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE SHELL'S HALF, FROM SOURCE — the config guard, in `desktop-attach-cap.test.ts`'s method.
   A command registered and not GRANTED is refused by the ACL with no window and no log, which
   is the silent shape this whole slice is about. Read from source because what regresses in
   this family is a name missing from a literal.
   ───────────────────────────────────────────────────────────────────────────────────────── */

function sourceOf(rel: string): string {
  try {
    return readFileSync(resolve(process.cwd(), `apps/desktop/${rel}`), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), rel), "utf8");
  }
}

describe("the window is granted the command it calls", () => {
  const engine = sourceOf("src-tauri/src/engine.rs");

  it("`open_external` is registered AND named in the capability", () => {
    expect(engine, "open_external is not in the invoke handler")
      .toMatch(/generate_handler!\[[^\]]*\bopen_external\b/s);

    const cap = engine.match(/const LOCAL_ENGINE_CAPABILITY: &str = r#"([\s\S]*?)"#;/);
    expect(cap, "LOCAL_ENGINE_CAPABILITY could not be read out of engine.rs").not.toBeNull();
    const grant = JSON.parse(cap![1]!) as { windows: string[]; permissions: string[] };

    expect(grant.permissions, "the window may not call open_external")
      .toContain("allow-open-external");
    // The grant stays the main window's and stays one-directional: it may hear the shell and
    // never make the shell hear it. Asserted beside the addition so a widening fails here too.
    expect(grant.windows).toEqual(["main"]);
    expect(grant.permissions).toContain("core:event:allow-listen");
    expect(grant.permissions).not.toContain("core:event:allow-emit");
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
    expect(engine).toMatch(/fn open_external/);
  });
});

describe("the message frame is wired to the same handler", () => {
  it("MessageBody installs the interceptor on the frame's own document", () => {
    const rel = "apps/webapp/app/components/MessageBody.tsx";
    let body: string;
    try {
      body = readFileSync(resolve(process.cwd(), rel), "utf8");
    } catch {
      body = readFileSync(resolve(process.cwd(), "../webapp/app/components/MessageBody.tsx"), "utf8");
    }
    expect(body).toMatch(/interceptLinkClicks\(\s*frameDoc\s*,\s*\{\s*trustSameOrigin:\s*false/);
    expect(body).toMatch(/contentDocument/);
  });
});

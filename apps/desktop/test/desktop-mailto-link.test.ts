/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ═══ A `mailto:` LINK IS THE ONE LINK THIS APP ANSWERS ITSELF ══════════════════════════════
 *
 * The defect this file holds down is the SECOND half of "every link in the desktop app does
 * nothing", and it survived the first fix precisely because that fix was written about the
 * browser: `open-external.ts` learned to hand `http`/`https` to the platform's opener, and
 * every other scheme was cancelled and dropped on the floor. Cancelling is right for `cid:`
 * (it names a part of the message being read) and for `javascript:`/`file:`/`data:`. It is
 * WRONG for `mailto:`, and wrong in the one product where it is least excusable: this app IS
 * the mail client. A person who clicks an address in a newsletter, in a signature, or on the
 * "contact us" line of a receipt got exactly what the original bug gave them — nothing, with
 * no error anywhere.
 *
 * It is not a missing capability and never was. The machinery has been here the whole time:
 * `src/mailto.ts` reads a mailto into a bounded compose prefill, and `DesktopGate` already
 * seeds the compose form from it — but only for a link the OPERATING SYSTEM delivered
 * (`mailto_claim`, the take-once slot a cold-start activation lands in). A link clicked
 * INSIDE the window never reached that parser, because the click seam refused it two layers
 * earlier.
 *
 * ── THE SCHEME TABLE THIS FILE IS THE STATEMENT OF ──────────────────────────────────────────
 *
 *   http:, https:   → the shell's opener, the user's own browser, never this window
 *   mailto:         → THIS window, through `parseMailto` → the compose form. Never the opener.
 *   everything else → cancelled, and nothing happens. `cid:` above all: it names a part of
 *                     this very message and must not leave the machine.
 *
 * The middle row is what this file adds. The other two are `desktop-open-external.test.ts`'s,
 * and both are re-asserted here from the mailto side — a fix that routed `mailto:` by widening
 * what reaches the platform opener would be a worse bug than the one it closed, since the
 * argument comes out of a message a stranger wrote.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · delete the `mailto:` arm from the handler            → "the app answers it" cases go red;
 *  · hand the mailto to `askShellToOpen` instead of the   → "never the platform opener" goes
 *    sink                                                    red;
 *  · fire the sink without `ev.preventDefault()`          → "does not navigate" goes red;
 *  · let `cid:`/`tel:`/`javascript:` reach the sink       → "only mailto is answered" goes red;
 *  · register the sink regardless of `enableExternalLinks`→ the web-app case goes red.
 */

type Invoked = { command: string; payload?: Record<string, unknown> };

let invoked: Invoked[] = [];
/** Every raw href the window's own mailto sink was handed, in order. */
let composed: string[] = [];

interface Host {
  __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> };
}
const host = globalThis as unknown as Host;

let disposers: Array<() => void> = [];

beforeEach(() => {
  invoked = [];
  composed = [];
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

async function freshModule() {
  return import("../../webapp/app/shell/open-external.js");
}

function install(
  mod: Awaited<ReturnType<typeof freshModule>>,
  doc: Document,
  trustSameOrigin: boolean,
): void {
  disposers.push(mod.interceptLinkClicks(doc, { trustSameOrigin }));
}

/** Click an anchor the way a person does. Answers whether the default was left to the browser. */
function clickAnchor(doc: Document, href: string): boolean {
  const a = doc.createElement("a");
  a.setAttribute("href", href);
  a.textContent = "link";
  doc.body.appendChild(a);
  return a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE CLASSIFIER — pure, driven directly.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("what counts as a compose this window opens", () => {
  const BASE = "http://localhost:3000/mailbox";

  it("a mailto is answered here, with the address exactly as written", async () => {
    const { mailtoTargetOf } = await freshModule();
    expect(mailtoTargetOf("mailto:someone@example.test", BASE))
      .toBe("mailto:someone@example.test");
    // The query survives untouched — `parseMailto` is the one parser, and it is downstream.
    expect(mailtoTargetOf("mailto:a@b.test?subject=Hi%20there&body=x", BASE))
      .toBe("mailto:a@b.test?subject=Hi%20there&body=x");
    // A bare `mailto:` still means "compose" — the parser answers it with an empty draft.
    expect(mailtoTargetOf("mailto:", BASE)).toBe("mailto:");
    // Case is not a scheme's business.
    expect(mailtoTargetOf("MAILTO:a@b.test", BASE)).toBe("MAILTO:a@b.test");
  });

  it("nothing else is ever a compose — `cid:` least of all", async () => {
    const { mailtoTargetOf } = await freshModule();
    for (const href of [
      "cid:part1@example.test",
      "tel:+41000000000",
      "https://example.test/",
      "http://example.test/",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ohmail://link?code=stolen",
      "/mailbox#/settings",
      "",
      "   ",
    ]) {
      expect(mailtoTargetOf(href, BASE), `${href} was treated as a compose`).toBeNull();
    }
  });

  it("the two classifiers never claim the same href", async () => {
    const { mailtoTargetOf, externalTargetOf } = await freshModule();
    for (const href of [
      "mailto:a@b.test",
      "https://example.test/",
      "cid:part1@example.test",
      "tel:+41",
    ]) {
      const both = mailtoTargetOf(href, BASE) !== null && externalTargetOf(href, BASE) !== null;
      expect(both, `${href} was claimed by both classifiers`).toBe(false);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE DESKTOP WINDOW.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("the desktop window, armed, with a compose sink", () => {
  async function armed() {
    const mod = await freshModule();
    mod.enableExternalLinks();
    mod.setMailtoSink((raw) => composed.push(raw));
    disposers.push(() => mod.setMailtoSink(null));
    return mod;
  }

  it("a clicked mailto opens a compose here, and does NOT navigate", async () => {
    const mod = await armed();
    install(mod, document, true);

    const notPrevented = clickAnchor(document, "mailto:someone@example.test?subject=Hello");

    expect(notPrevented, "the click was left to the webview, which would have navigated").toBe(false);
    expect(composed).toEqual(["mailto:someone@example.test?subject=Hello"]);
  });

  it("a mailto is NEVER handed to the platform opener", async () => {
    const mod = await armed();
    install(mod, document, true);

    clickAnchor(document, "mailto:someone@example.test");

    expect(invoked, "a mailto was posted to the platform's browser").toEqual([]);
    expect(composed).toHaveLength(1);
  });

  it("only mailto is answered — every other refused scheme reaches nothing at all", async () => {
    const mod = await armed();
    install(mod, document, true);

    for (const href of [
      "cid:part1@example.test",
      "tel:+41000000000",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ohmail://link?code=stolen",
    ]) {
      expect(clickAnchor(document, href), `${href} was left to the webview`).toBe(false);
    }
    expect(composed, "a scheme that is not mailto opened a compose").toEqual([]);
    expect(invoked, "a scheme that is not http(s) reached the opener").toEqual([]);
  });

  it("http still goes to the browser, and never to the compose form", async () => {
    const mod = await armed();
    install(mod, document, true);

    clickAnchor(document, "https://example.test/story");

    expect(invoked).toEqual([
      { command: mod.OPEN_EXTERNAL_COMMAND, payload: { url: "https://example.test/story" } },
    ]);
    expect(composed, "an http address opened a compose form").toEqual([]);
  });

  it("with no sink registered the click is still stopped, and nothing throws", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    install(mod, document, true);

    expect(clickAnchor(document, "mailto:a@b.test")).toBe(false);
    expect(invoked).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   A MESSAGE FRAME — where the address a stranger wrote actually lives.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("inside a message frame", () => {
  it("an address in someone else's mail opens a compose, and opens nothing else", async () => {
    const mod = await freshModule();
    mod.enableExternalLinks();
    mod.setMailtoSink((raw) => composed.push(raw));
    disposers.push(() => mod.setMailtoSink(null));

    const frame = document.implementation.createHTMLDocument("mail");
    install(mod, frame, false);

    expect(clickAnchor(frame, "mailto:sales@newsletter.test?subject=Unsubscribe%20me")).toBe(false);
    expect(composed).toEqual(["mailto:sales@newsletter.test?subject=Unsubscribe%20me"]);
    expect(invoked, "a mailto from a message reached the platform opener").toEqual([]);

    composed = [];
    // `cid:` in a frame is the sharp one: it names a part of THIS message.
    expect(clickAnchor(frame, "cid:part1@example.test")).toBe(false);
    expect(composed).toEqual([]);
    expect(invoked).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE WEB APP — the same shared module, imported and inert.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("the web app is not touched", () => {
  it("without arming, a mailto keeps the browser's own semantics and no sink fires", async () => {
    const mod = await freshModule();
    // A sink may be registered by shared code without arming; the listener is what gates it.
    mod.setMailtoSink((raw) => composed.push(raw));
    disposers.push(() => mod.setMailtoSink(null));
    install(mod, document, true);

    expect(clickAnchor(document, "mailto:a@b.test"), "the web app cancelled a mailto").toBe(true);
    expect(composed, "the web app opened its own compose for a mailto").toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE WIRING, FROM SOURCE — the sink has to be plugged into the one parser and the one form,
   or every case above passes against a seam nothing is on the other end of.
   ───────────────────────────────────────────────────────────────────────────────────────── */

function sourceOf(rel: string): string {
  try {
    return readFileSync(resolve(process.cwd(), `apps/desktop/${rel}`), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), rel), "utf8");
  }
}

describe("the sink is wired to the compose form", () => {
  const gate = sourceOf("src/DesktopGate.tsx");

  it("DesktopGate registers the sink and feeds it through the one mailto parser", () => {
    expect(gate, "DesktopGate never registers the in-window mailto sink")
      .toMatch(/setMailtoSink\(/);
    // The same parser the OS activation goes through — not a second reading of RFC 6068.
    expect(gate).toMatch(/parseMailto/);
    expect(gate, "the parsed draft never reaches the compose form")
      .toMatch(/setMailtoDraft/);
  });

  it("the shell's own gate still refuses a mailto, whatever the window does", () => {
    const engine = sourceOf("src-tauri/src/engine.rs");
    // `external_url` admits http:// and https:// and nothing else. A mailto that somehow
    // reached the command must still be refused by the process that spawns the opener.
    expect(engine).toMatch(/only http and https are opened/);
    expect(engine).toMatch(/fn external_url/);
  });
});

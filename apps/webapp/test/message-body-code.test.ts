/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * ── CODE IN RECEIVED MAIL: A SNIPPET STAYS A SNIPPET, AND NEVER WIDENS THE PANE ──────────
 *
 * The native rich rendering walks a prose-classified html mail into nodes and builds every
 * element itself. `pre` and `code` were the two shapes it had no node for: a `pre` fell into
 * the "unhandled block, walk its content in place" branch, so a stack trace arrived as an
 * ordinary paragraph with its indentation collapsed — the whitespace that WAS the content,
 * gone — and a `<code>` run dissolved into the surrounding sentence with nothing to mark it.
 * Both now have kinds, and this file holds the three properties that make them worth having.
 *
 * ── WHY THE STYLESHEET IS LOADED RATHER THAN GREPPED ────────────────────────────────────
 *
 * The load-bearing requirement here is a LAYOUT one — a hostile code block must scroll inside
 * the letter instead of pushing the message pane sideways — and a class name on an element
 * proves nothing about that on its own. So the real `message-body.css` is parsed into the
 * jsdom document and the assertions read `getComputedStyle` of the elements the component
 * actually rendered: the rule and the markup have to agree, through the cascade, or these go
 * red. jsdom does not lay out, so this is containment asserted STRUCTURALLY — the element that
 * scrolls is an ancestor of the element that is allowed to be wide — which is the property the
 * rule exists to create; the pixel result of it is the browser's arithmetic, not ours.
 *
 * Custom properties are the one thing jsdom will not resolve (`var(--tint2)` computes to the
 * empty string), so the tint is asserted against the DECLARATION instead, in the last describe.
 *
 * MUTATION WATCH — each applied, watched go red, reverted:
 *   · `overflow-x: auto` deleted from `.msg-pre-wrap` → "a wide code block would push the pane".
 *   · `white-space: pre` deleted from `.msg-pre` → the preserved-whitespace case.
 *   · the whole `.msg-code` rule deleted → the inline-code case.
 *   · the `pre` branch dropped from the walker → every structural case, starting with the
 *     anti-vacuity one; the snippet comes back as a paragraph with its indentation collapsed.
 *   · the `code` branch dropped from `appendInline` → the inline-code case.
 *   · `min-width: max-content` deleted from `.msg-pre` → the scrolled-ground case.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHEET_PATH = "apps/webapp/app/letter-body/message-body.css";
const SHEET = readFileSync(resolve(process.cwd(), SHEET_PATH), "utf8");

/* ── reading the sheet as SOURCE, for the declarations jsdom cannot testify about ──────────
   Two of the properties this file cares about are ALREADY the browser's default for the
   element they are declared on — `pre` is `white-space: pre` in the UA stylesheet and `code`
   is `font-family: monospace` — so a `getComputedStyle` assertion on either one stays green
   with our rule deleted. Measured, not assumed: both mutations were applied and both runs
   passed. They are therefore asserted against the DECLARATION, which is the only reading that
   can go red, and everything jsdom can genuinely answer for (the overflow, the widths) stays a
   computed-style assertion on the rendered element. Comments stripped first — a commented-out
   declaration is not a declaration. */
const bare = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const MSG_CSS = bare(SHEET);

/** The declarations of one rule, by exact selector. */
const ruleOf = (css: string, selector: string): string => {
  const re = new RegExp(`(^|[{}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`);
  const m = re.exec(css);
  return m ? m[2] : "";
};
const decl = (rule: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(rule);
  return m ? m[1].trim() : null;
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sheet: HTMLStyleElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  sheet?.remove();
  root = null;
  host = null;
  sheet = null;
}
afterEach(async () => { await unmount(); });

type Mod = typeof import("../app/letter-body/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/letter-body/MessageBody.js");

/** Render a message with the real sheet in the document, so computed style means something. */
async function render(props: Parameters<Mod["MessageBody"]>[0]): Promise<HTMLDivElement> {
  await unmount();
  const { MessageBody } = await mod();
  sheet = document.createElement("style");
  sheet.textContent = SHEET;
  document.head.appendChild(sheet);
  host = document.createElement("div");
  host.className = "msg-body";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(MessageBody, props)); });
  return host;
}

/** `sanitizeMailHtml(html).prose` — the classification, read from the real pass. */
async function proseOf(html: string): Promise<boolean> {
  const { sanitizeMailHtml } = await mod();
  return sanitizeMailHtml(html, {}).prose;
}

/** The snippet a developer actually pastes: two lines, and the second one is indented. */
const SNIPPET = 'def greet(name):\n    return f"hello {name}"';

const CODE_LETTER =
  `<p>The failing call is below.</p>` +
  `<pre><code>${SNIPPET}</code></pre>` +
  `<p>Set <code>Reply-To:</code> and try again.</p>`;

describe("a code block in received mail is a code block", () => {
  /**
   * ANTI-VACUITY, and it is not decoration: a fixture the classifier sends to the frame would
   * make every assertion below pass against a walker nobody ran.
   */
  it("the code letter really is the prose class, rendered natively", async () => {
    expect(await proseOf(CODE_LETTER), "the code letter was mistaken for a designed layout")
      .toBe(true);
    const el = await render({ text: "fallback", html: CODE_LETTER });
    expect(el.querySelector("iframe"), "the code letter went to the frame — nothing below tests anything")
      .toBeNull();
  });

  /**
   * The whitespace IS the content. `textContent` is compared to the sender's exact string:
   * a walker that folded the `pre` into a paragraph collapses the four leading spaces, and
   * that is the defect this kind exists to fix.
   */
  it("the snippet renders as a `pre` that carries the styled class and the exact characters", async () => {
    const el = await render({ text: "fallback", html: CODE_LETTER });
    const pre = el.querySelector<HTMLPreElement>("pre.msg-pre");
    expect(pre, "the snippet did not render as a native code block").not.toBeNull();
    expect(pre!.textContent, "the sender's indentation was rewritten").toBe(SNIPPET);
    // `pre > code` is ONE block, not a code run inside it: the block form and the inline form
    // are different kinds, and a nested `.msg-code` would style a box inside a box.
    expect(pre!.querySelector(".msg-code"), "the block's `code` became an inline run too").toBeNull();
    // And it is a real `pre` element this code constructed — not a `div` wearing the class.
    expect(pre!.tagName).toBe("PRE");
  });

  /**
   * THE LOAD-BEARING ONE. The element that is allowed to be wide (`white-space: pre` makes the
   * block as wide as its longest line) must sit inside an element that scrolls. Read through
   * the cascade from the real sheet, so deleting the rule is what turns this red.
   */
  it("the block preserves whitespace and its own container is what scrolls", async () => {
    const el = await render({ text: "fallback", html: CODE_LETTER });
    const pre = el.querySelector<HTMLPreElement>("pre.msg-pre")!;
    const wrap = pre.parentElement!;
    expect(wrap.className, "the code block is not inside its own container").toBe("msg-pre-wrap");

    // Whitespace from the DECLARATION and not from `getComputedStyle` — see the note at the
    // top of the file: `pre` is `white-space: pre` in jsdom's UA sheet, so the computed read
    // is green with our rule gone. `.msg-p`'s neighbours (`.msg-body` declares `pre-line`,
    // `.mb` declares `normal`) are why the block states its own answer rather than inheriting.
    expect(decl(ruleOf(MSG_CSS, ".msg-pre"), "white-space"),
      "the code block reflows — a stack trace is not a paragraph").toBe("pre");
    // The tinted ground follows the longest line rather than stopping at the container's edge.
    expect(getComputedStyle(pre).minWidth, "the shading would end mid-snippet once the reader scrolls")
      .toBe("max-content");

    const wrapStyle = getComputedStyle(wrap);
    expect(wrapStyle.overflowX, "a wide code block would push the message pane sideways")
      .toBe("auto");
    expect(wrapStyle.maxWidth, "the container may grow past the letter it sits in")
      .toBe("100%");
  });

  /**
   * The hostile case stated as itself: mail is not a friendly document source. Thousands of
   * characters with no break in them is a real shape (a base64 blob, a JWT, a URL in a header
   * dump). It must arrive INTACT — truncating a stranger's content is not containment — and it
   * must be contained by an ancestor that scrolls, with nothing between it and the column
   * declaring a width of its own.
   */
  it("a hostile 4 000-character line is kept whole and contained, not truncated", async () => {
    const wide = "A".repeat(4000);
    const el = await render({ text: "fallback", html: `<p>Header dump:</p><pre>${wide}</pre>` });
    const pre = el.querySelector<HTMLPreElement>("pre.msg-pre");
    expect(pre, "the hostile block did not render").not.toBeNull();
    expect(pre!.textContent!.length, "the sender's line was truncated").toBe(4000);

    // Walk from the block out to the message column: something on the way scrolls, and nothing
    // on the way sets a width — the two halves of "it cannot widen the pane".
    let scrolls = false;
    for (let n: HTMLElement | null = pre!.parentElement; n && n !== el; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX === "auto" || s.overflowX === "scroll") scrolls = true;
      expect(n.getAttribute("width"), "a width attribute reached the native tree").toBeNull();
      expect(s.width === "" || s.width === "auto" || s.width === "100%").toBe(true);
    }
    expect(scrolls, "nothing between the code block and the letter scrolls — the pane grows")
      .toBe(true);
  });
});

describe("inline code is marked, quietly", () => {
  /**
   * Mutation: drop the `code` branch from `appendInline` — the run dissolves back into the
   * sentence as bare text and the element disappears.
   */
  it("a `code` run in a sentence renders as a styled element with the sender's characters", async () => {
    const el = await render({ text: "fallback", html: CODE_LETTER });
    const code = el.querySelector<HTMLElement>("code.msg-code");
    expect(code, "inline code dissolved into the sentence").not.toBeNull();
    expect(code!.tagName).toBe("CODE");
    expect(code!.textContent).toBe("Reply-To:");
    // It is INSIDE the paragraph it belongs to — a run, not a block that broke the sentence.
    expect(code!.closest("p.msg-p"), "inline code was lifted out of its paragraph").not.toBeNull();
  });

  /**
   * Mutation: delete the `.msg-code` rule — the size assertion goes red.
   *
   * The SIZE is the computed one and the STACK is the declared one, for the reason at the top
   * of the file: jsdom hands a `code` element `font-family: monospace` whether we style it or
   * not, so only the declaration can testify that this app chose the stack the composer uses.
   */
  it("inline code is set in the app's monospace stack at a reduced size", async () => {
    const el = await render({ text: "fallback", html: CODE_LETTER });
    const s = getComputedStyle(el.querySelector<HTMLElement>("code.msg-code")!);
    expect(s.fontSize, "inline code is not held below the surrounding line").toBe("0.92em");
    expect(decl(ruleOf(MSG_CSS, ".msg-code"), "font-family"),
      "inline code is not set in the app's own monospace stack").toMatch(/^ui-monospace,/);
  });
});

/**
 * ── WHAT THE WALKER MUST NOT PUT IN A SNIPPET ────────────────────────────────────────────
 *
 * `preTextOf` exists instead of `el.textContent` for exactly these two cases, and a rewrite
 * back to `textContent` is a one-word edit, so both are held here.
 */
describe("the snippet is the sender's text and nothing else", () => {
  it("a `style` inside a `pre` does not become part of the code", async () => {
    const el = await render({
      text: "fallback",
      html: `<p>Config:</p><pre>keep me<style>.leaked{color:red}</style></pre>`,
    });
    const pre = el.querySelector("pre.msg-pre");
    expect(pre, "the block vanished").not.toBeNull();
    expect(pre!.textContent, "a stylesheet was folded into the snippet as if it were code")
      .toBe("keep me");
  });

  it("a `br` inside a `pre` is the line the sender drew", async () => {
    const el = await render({ text: "fallback", html: `<pre>one<br>two</pre>` });
    expect(el.querySelector("pre.msg-pre")!.textContent, "two lines were joined into one")
      .toBe("one\ntwo");
  });

  /** A `pre` of nothing but whitespace is a mail builder's spacer, not content. */
  it("an empty `pre` renders nothing at all", async () => {
    const el = await render({ text: "fallback", html: `<p>Hello.</p><pre>   \n  </pre>` });
    expect(el.querySelector("pre.msg-pre"), "a whitespace spacer became an empty tinted box")
      .toBeNull();
  });
});

/**
 * ── ONE CODE LOOK ACROSS COMPOSE AND READ ────────────────────────────────────────────────
 *
 * The composer already styles the two shapes (`app.css`, `.rte-surface pre` / `code`). A
 * reader who writes a snippet and then reads the reply quoting it should see one thing, so the
 * ground, the stack and the size are asserted to be THE SAME VALUES rather than merely
 * plausible ones — and the ground is asserted to be a token, because a literal colour is a
 * value that only holds in one theme.
 */
describe("the read surface wears the composer's code look", () => {
  const APP_CSS = bare(readFileSync(resolve(process.cwd(), "apps/webapp/app/app.css"), "utf8"));
  const COMPOSER_PRE = ruleOf(APP_CSS, ".rte-surface pre");
  const COMPOSER_CODE = ruleOf(APP_CSS, ".rte-surface code");
  const READ_PRE = ruleOf(MSG_CSS, ".msg-pre");
  const READ_CODE = ruleOf(MSG_CSS, ".msg-code");

  it("ANCHOR — all four rules were found, so nothing below passes on an empty scan", () => {
    for (const [name, rule] of Object.entries({ COMPOSER_PRE, COMPOSER_CODE, READ_PRE, READ_CODE })) {
      expect(rule.length, `${name} matched nothing — the selector moved`).toBeGreaterThan(0);
    }
  });

  it("the ground, the stack and the size are the composer's, on both shapes", () => {
    for (const [read, composed] of [[READ_PRE, COMPOSER_PRE], [READ_CODE, COMPOSER_CODE]] as const) {
      for (const prop of ["background", "font-family", "font-size"]) {
        expect(decl(read, prop), `code is styled two ways: ${prop}`).toBe(decl(composed, prop));
      }
    }
  });

  it("the ground is a token, so it holds in both themes", () => {
    for (const rule of [READ_PRE, READ_CODE]) {
      expect(decl(rule, "background"), "a literal colour would only be right in one theme")
        .toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
  });
});

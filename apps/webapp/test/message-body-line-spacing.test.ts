/** @vitest-environment jsdom */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ═══ A LINE IS A LINE — NOT A PARAGRAPH ════════════════════════════════════════════════════
 *
 * Reported against a real message: ohmail put a blank line between every line of a letter where
 * Apple Mail put none. The message was `multipart/mixed` with a text part of 14 lines and an HTML
 * part of twelve `<div>` blocks, two of them `<div><br></div>`, and zero `<p>` — which is not one
 * client's quirk but the shape Apple Mail, Gmail and Outlook all compose: ONE DIV PER LINE, and a
 * blank line written as a div holding a single `<br>`. (The fixtures below are synthetic bodies
 * with that structure. Nobody's mail is in this repository.)
 *
 * The walk gave every run it flushed the paragraph kind, `.msg-p`, `margin: 0 0 10px`. So:
 *
 *  · twelve consecutive lines rendered with eleven 10px gaps — a blank line between every line;
 *  · and the two blank lines the writer actually typed rendered as NOTHING, because a run holding
 *    only a `br` trims to no words and "no words" was the rule for dropping the whitespace between
 *    a mail builder's divs.
 *
 * Wrong in both directions at once, which is why the fix is two rules rather than a margin change:
 * the CONTAINER decides the spacing (only a `<p>` — and a list item, which the list's own sheet
 * spaces — is a paragraph), and a wordless run is dropped only when it is pure whitespace.
 *
 * ── WHAT IS ASSERTED, AND WHAT THIS ENVIRONMENT CAN ANSWER ─────────────────────────────────
 *
 * jsdom does not lay out, so no assertion here reads a pixel. It reads the two things that decide
 * the pixels and that jsdom answers exactly: the NODE KINDS the walker emits, and the DOM the
 * renderer builds from them. The margins themselves are asserted against the stylesheet's own
 * text, which is where they live.
 *
 * ── MUTATIONS WATCHED RED ──────────────────────────────────────────────────────────────────
 *
 *  · put `div` back in `RICH_PARAGRAPH_CONTAINERS`          → the Apple/Gmail line-kind rows go red;
 *  · drop the `children.some(n => n.kind === "break")` arm   → the blank-line rows go red;
 *  · give `.msg-line` a bottom margin                        → the stylesheet row goes red.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}
afterEach(async () => { await unmount(); });

type BodyMod = typeof import("../app/letter-body/MessageBody.js");
type TextMod = typeof import("../app/letter-body/BodyText.js");

/** The walker's own output for one html part — the real sanitize pass, not a hand-built tree. */
async function richOf(html: string) {
  const { sanitizeMailHtml } = (await import("../app/letter-body/MessageBody.js")) as BodyMod;
  const mail = sanitizeMailHtml(html, {});
  expect(mail.prose, "this fixture was classified as a design, so the walker never ran").toBe(true);
  expect(mail.rich, "the walker emitted nothing for a letter").not.toBeNull();
  return mail.rich!;
}

/** `BodyText` rendered over a body — the rich path when `rich` is passed, the text path when not. */
async function renderBody(text: string, rich?: unknown): Promise<HTMLDivElement> {
  await unmount();
  const { BodyText } = (await import("../app/letter-body/BodyText.js")) as TextMod;
  host = document.createElement("div");
  host.className = "msg-body";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(BodyText as unknown as React.FunctionComponent<Record<string, unknown>>, { text, rich }));
  });
  return host;
}

/** The kind each top-level node renders as, in order — `p:line`, `p:para`, `quote`, … */
function shapeOf(nodes: ReadonlyArray<{ kind: string; spacing?: string }>): string[] {
  return nodes.map((n) => (n.kind === "rich" ? `rich:${n.spacing}` : n.kind));
}

/* Apple Mail's and Gmail's own composition: a div per line, a blank line as a div holding a br.
   Six source lines, one of them blank. */
const APPLE_LETTER =
  `<div>Hi Sam,</div>` +
  `<div><br></div>` +
  `<div>The plans arrived this morning.</div>` +
  `<div>I have read them twice.</div>` +
  `<div>Nothing to change.</div>`;

/* Gmail's wrapper, which is the same shape one level deeper. */
const GMAIL_LETTER =
  `<div dir="ltr"><div>First line.</div><div><br></div><div>Second line.</div></div>`;

/* Outlook composes paragraphs, not lines — `<p class="MsoNormal">` per block. Its spacing is a
   real paragraph's and stays one. */
const OUTLOOK_LETTER =
  `<p class="MsoNormal">First paragraph.</p>` +
  `<p class="MsoNormal">Second paragraph.</p>`;

describe("a div is a line", () => {
  it("Apple Mail's letter is five lines and one blank line, and no paragraph", async () => {
    const nodes = await richOf(APPLE_LETTER);
    // FOUR lines of words plus the one blank line the writer typed, in source order. A paragraph
    // anywhere in this list is the defect: it is a 10px gap the sender did not write.
    expect(shapeOf(nodes)).toEqual([
      "rich:line", // Hi Sam,
      "rich:line", // the blank line
      "rich:line",
      "rich:line",
      "rich:line",
    ]);
    expect(shapeOf(nodes).filter((k) => k === "rich:paragraph")).toEqual([]);

    const body = await renderBody("", nodes);
    const rendered = [...body.querySelectorAll("p")];
    expect(rendered).toHaveLength(5);
    expect(rendered.every((p) => p.classList.contains("msg-line"))).toBe(true);
    expect(body.querySelector(".msg-p"), "a div produced a paragraph").toBeNull();

    // The blank one is one line box: a `p` whose only element child is a `br` and whose text is
    // empty. jsdom does not lay out, so the LINE BOX is asserted as the shape that makes one.
    const blank = rendered[1]!;
    expect(blank.textContent!.trim()).toBe("");
    expect(blank.querySelectorAll("br")).toHaveLength(1);
    expect(rendered[0]!.textContent).toBe("Hi Sam,");
    expect(rendered[2]!.textContent).toBe("The plans arrived this morning.");
  });

  it("and the block count is the source's line count, not half of it", async () => {
    // The reported message's own proportions: twelve divs, two of them blank. Every one of the
    // twelve is a block, which is the claim a reader checks by counting lines on screen.
    const twelve = Array.from({ length: 12 }, (_, i) =>
      i === 4 || i === 9 ? `<div><br></div>` : `<div>Line ${i + 1}.</div>`,
    ).join("");
    const nodes = await richOf(twelve);
    expect(nodes).toHaveLength(12);
    expect(new Set(shapeOf(nodes))).toEqual(new Set(["rich:line"]));
  });

  it("Gmail's wrapper does not change the answer", async () => {
    expect(shapeOf(await richOf(GMAIL_LETTER))).toEqual(["rich:line", "rich:line", "rich:line"]);
  });

  it("a real <p> still earns paragraph spacing — Outlook's MsoNormal blocks", async () => {
    const nodes = await richOf(OUTLOOK_LETTER);
    expect(shapeOf(nodes)).toEqual(["rich:paragraph", "rich:paragraph"]);
    const body = await renderBody("", nodes);
    expect(body.querySelectorAll(".msg-p")).toHaveLength(2);
    expect(body.querySelector(".msg-line")).toBeNull();
  });

  it("the whitespace BETWEEN a builder's divs is still not content", async () => {
    // The rule the blank-line arm had to be carved out of, kept intact: a run with no words and
    // no `br` is the newline a generator wrote between two elements, and it renders as nothing.
    const spaced = `<div>One.</div>\n   \n<div>Two.</div>`;
    expect(shapeOf(await richOf(spaced))).toEqual(["rich:line", "rich:line"]);
  });

  it("a quoted reply's div lines are lines too", async () => {
    const quoted =
      `<div>Yes — Friday works.</div>` +
      `<blockquote><div>Are we still on?</div><div><br></div><div>— Sam</div></blockquote>`;
    const nodes = await richOf(quoted);
    expect(shapeOf(nodes)).toEqual(["rich:line", "quote"]);
    const inside = (nodes[1] as unknown as { children: Array<{ kind: string; spacing?: string }> }).children;
    expect(shapeOf(inside)).toEqual(["rich:line", "rich:line", "rich:line"]);
  });
});

describe("the plain-text path was already right, and stays right", () => {
  /**
   * Measured before anything was changed: `toBlocks` joins a run of consecutive non-blank lines
   * into ONE block with `\n` between them, rendered under `white-space: pre-line`, and only a
   * BLANK line ends a block. So a single newline is one line break inside one paragraph and a
   * double newline is one paragraph boundary — neither doubles. Asserted here so the claim in
   * this file's header is a measurement rather than a reading of the code.
   */
  it("single newlines stay inside one block; a blank line starts the next", async () => {
    const body = await renderBody("Hi Sam,\nThe plans arrived.\nNothing to change.\n\nThanks.");
    const paras = [...body.querySelectorAll("p")];
    expect(paras).toHaveLength(2);
    expect(paras[0]!.textContent).toBe("Hi Sam,\nThe plans arrived.\nNothing to change.");
    expect(paras[1]!.textContent).toBe("Thanks.");
    expect(paras.every((p) => p.classList.contains("msg-p"))).toBe(true);
  });
});

describe("the stylesheet says what the kinds mean", () => {
  const css = readFileSync(resolve(process.cwd(), "packages/ui/src/composites/message.css"), "utf8");

  it("a line has no margin of its own and a paragraph has one", () => {
    expect(css, ".msg-line has no rule at all").toMatch(/^\.msg-line\{[^}]*margin:0[;}]/m);
    // Not `margin: 0 0 10px` by any spelling — the whole point is that a line contributes none.
    const line = css.match(/^\.msg-line\{([^}]*)\}/m)![1]!;
    expect(line).not.toMatch(/margin[^;]*10px/);
    expect(css).toMatch(/^\.msg-p\{margin:0 0 10px/m);
  });
});

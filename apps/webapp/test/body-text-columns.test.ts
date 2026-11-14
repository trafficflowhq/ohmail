/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * ── SPACE-ALIGNED COLUMNS IN PLAIN-TEXT MAIL KEEP THEIR ALIGNMENT ───────────────────────
 *
 * Seen on a live install: a plain-text receipt whose sender lined its amounts up with runs of
 * spaces rendered with every run collapsed to one space — `white-space: pre-line`, the rule
 * that gives the plain path its paragraph rhythm, collapses INTRA-line whitespace by
 * definition. The alignment IS the content of such a block: "Pro plan      15.00" and
 * "Pro plan 15.00" are different documents, and no amount of styling the collapsed one
 * restores what the sender typed.
 *
 * The repair reuses machinery that already exists rather than inventing a third rendering:
 * a block whose lines are COLUMN-SHAPED — interior runs of three-plus spaces (or a tab) on
 * at least two lines, and on at least half of the block — is emitted as the same `PreNode`
 * a code block arrives as, which renders `.msg-pre-wrap > .msg-pre`: monospace, literal
 * whitespace, and a scroll container of its own so a wide receipt scrolls inside the letter
 * (the exact construction `message-body-code.test.ts` guards).
 *
 * The detection is deliberately conservative, and the negative cases below are the contract:
 * prose — including the two-spaces-after-a-period habit — must stay prose, because the cost
 * of a false positive is a paragraph of somebody's words set in monospace.
 *
 * Every assertion below was watched go red against the pre-fix `BodyText` (blocks were
 * unconditionally paragraphs) — the fixture rendered as `.msg-p` with its runs collapsed by
 * the stylesheet this suite does not even load.
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

async function render(text: string): Promise<HTMLDivElement> {
  await unmount();
  const { BodyText } = await import("../app/letter-body/BodyText.js");
  host = document.createElement("div");
  host.className = "msg-body";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(BodyText, { text })); });
  return host;
}

/** A real receipt shape: an intro line of prose, a blank line, then the aligned block. */
const RECEIPT = [
  "Thanks for your order.",
  "",
  "Item                      Qty        Amount",
  "Pro plan (annual)           1     3,528.00",
  "Priority support            2       145.00",
  "Total                             3,673.00",
  "",
  "Questions? Just reply to this mail.",
].join("\n");

describe("a space-aligned block renders as preformatted text", () => {
  it("the aligned lines become one .msg-pre with every space run intact", async () => {
    const el = await render(RECEIPT);
    const pre = el.querySelector<HTMLPreElement>("pre.msg-pre");
    expect(pre, "the receipt's columns rendered as a paragraph — pre-line collapses the runs").not.toBeNull();
    // The characters, exactly. `textContent` sees through any styling; a renderer that joined
    // the lines with single spaces or trimmed the runs fails here whatever it looks like.
    expect(pre!.textContent).toContain("Pro plan (annual)           1     3,528.00");
    expect(pre!.textContent).toContain("Item                      Qty        Amount");
    // Inside the container that scrolls — the same construction as a code block, on purpose.
    expect(pre!.parentElement!.className, "the columns are not inside their own scroll container")
      .toBe("msg-pre-wrap");
  });

  it("the prose around the block stays prose", async () => {
    const el = await render(RECEIPT);
    const paras = [...el.querySelectorAll("p.msg-p")].map((p) => p.textContent);
    expect(paras).toContain("Thanks for your order.");
    expect(paras).toContain("Questions? Just reply to this mail.");
  });

  it("tab-separated values count as columns too", async () => {
    const el = await render("Betrag\t145.00 CHF\nDatum\t12.08.2026");
    expect(el.querySelector("pre.msg-pre"), "tab-aligned rows collapsed into prose").not.toBeNull();
  });
});

describe("prose is never mistaken for columns", () => {
  it("two-spaces-after-a-period prose stays a paragraph", async () => {
    // The typist's habit. Two spaces is a sentence gap, not a column gap — the threshold is
    // three, and lowering it re-renders half of older correspondents' mail in monospace.
    const el = await render("First sentence.  Second sentence.\nAnother line.  And more.");
    expect(el.querySelector("pre.msg-pre")).toBeNull();
    expect(el.querySelector("p.msg-p")).not.toBeNull();
  });

  it("a single aligned line inside a prose block does not convert the block", async () => {
    // Half the block must be column-shaped: one stray run in a paragraph is an accident of
    // typing, and converting the whole paragraph would set the sender's words in monospace.
    const el = await render(
      [
        "Dear customer, your delivery arrives tomorrow morning.",
        "Reference   ABC-123",
        "We will ring the bell twice and wait for a signature.",
        "If nobody answers we leave a card and try again the next day.",
      ].join("\n"),
    );
    expect(el.querySelector("pre.msg-pre")).toBeNull();
  });

  it("quoted receipts align as well — the decision is per block, at any depth", async () => {
    const el = await render(
      ["On Tue, shop wrote:", "> Item        Amount", "> Pro plan    15.00"].join("\n"),
    );
    const quoted = el.querySelector(".msg-quote pre.msg-pre");
    expect(quoted, "a quoted receipt lost its columns").not.toBeNull();
    expect(quoted!.textContent).toContain("Item        Amount");
  });
});

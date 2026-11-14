/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * A HUGE MESSAGE NEVER FREEZES THE WINDOW. The 0.25.8 Windows cell held a 2 MiB plain body from a
 * first-time sender; the Screener drew it whole as ONE paragraph and the desktop window's main thread
 * stopped 0.8-1.0 s each time it was shown (WebKitGTK, measured in the packaged app). Every surface
 * that draws a body or a derivative of one draws a bounded slice: a page of BODY_PAGE_CHARS with a
 * press for the next, and a row's preview at ROW_PREVIEW_MAX_CHARS.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** The cell's body, in shape: ten distinct words a line, CRLF, to 2 MiB, no blank line anywhere. */
function hugeBody(): string {
  const lines: string[] = [];
  let len = 0;
  for (let n = 0; len < 2 * 1024 * 1024;) {
    const w: string[] = [];
    for (let k = 0; k < 10; k++, n++) w.push(`b${n.toString(36)}x`);
    const l = w.join(" ");
    lines.push(l);
    len += l.length + 2;
  }
  return lines.join("\r\n");
}
const HUGE = hugeBody();

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

async function mount(el: React.ReactElement): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
  return host;
}

/** Characters of message text in the DOM: every paragraph's text, the press excluded. */
const drawn = (el: HTMLElement): number =>
  [...el.querySelectorAll("p")].reduce((n, p) => n + (p.textContent ?? "").length, 0);

describe("pageEnd — where a page of a long body ends", () => {
  it("cuts at a paragraph break, else a line break, else a space, and the pages rebuild the text", async () => {
    const { pageEnd, pageEnds } = await import("@ohmail/ui");
    const para = `${"a".repeat(90)}\n\n${"b".repeat(40)}`;
    expect(pageEnd(para, 0, 100)).toBe(92);
    const line = `${"a".repeat(95)}\n${"b".repeat(40)}`;
    expect(pageEnd(line, 0, 100)).toBe(96);
    const words = `${"a".repeat(95)} ${"b".repeat(40)}`;
    expect(pageEnd(words, 0, 100)).toBe(96);
    // No break inside the page's last eighth: a hard cut at the bound, never a short page.
    expect(pageEnd("x".repeat(300), 0, 100)).toBe(100);
    expect(pageEnd(`${"a".repeat(10)}\n${"x".repeat(300)}`, 0, 100)).toBe(100);
    const ends = pageEnds(HUGE, 1000);
    expect(ends[ends.length - 1]).toBe(HUGE.length);
    expect(ends.every((e, i) => e > (i === 0 ? 0 : ends[i - 1]!))).toBe(true);
    const pieces = ends.map((e, i) => HUGE.slice(i === 0 ? 0 : ends[i - 1]!, e));
    expect(pieces.join("")).toBe(HUGE);
  });
});

describe("BodyText draws a long plain body a page at a time", () => {
  it("a 2 MiB body draws at most one page, with a press that adds exactly one more", async () => {
    const { BodyText } = await import("../app/letter-body/BodyText.js");
    const { BODY_PAGE_CHARS } = await import("@ohmail/ui");
    const el = await mount(h(BodyText, { text: HUGE }));
    const first = drawn(el);
    expect(first).toBeGreaterThan(BODY_PAGE_CHARS * 0.8);
    expect(first).toBeLessThanOrEqual(BODY_PAGE_CHARS);
    const more = el.querySelectorAll<HTMLButtonElement>("button.msg-page-more");
    expect(more).toHaveLength(1);
    expect(more[0]!.textContent).toBe("Show more (3% shown)");
    const firstPage = el.querySelector(".msg-page p");
    await act(async () => { more[0]!.click(); });
    expect(drawn(el)).toBeLessThanOrEqual(2 * BODY_PAGE_CHARS);
    expect(drawn(el)).toBeGreaterThan(first);
    // The page already on screen is the same node: a press lays out one page, not all of them.
    expect(el.querySelector(".msg-page p")).toBe(firstPage);
    expect(el.querySelectorAll(".msg-page")).toHaveLength(2);
  });

  it("an ordinary letter is drawn exactly as before — whole, with its history fold and no press", async () => {
    const { BodyText } = await import("../app/letter-body/BodyText.js");
    const letter = "Thanks, that works.\n\nOn Mon, Ann wrote:\n> the question\n> and more";
    const el = await mount(h(BodyText, { text: letter }));
    expect(el.querySelector("button.msg-page-more")).toBeNull();
    expect(el.querySelector(".msg-page")).toBeNull();
    expect(el.querySelector("button.msg-history-toggle")?.textContent).toBe("Show history");
  });

  it("a body of exactly one page is drawn whole, and one character more is paged", async () => {
    const { BodyText } = await import("../app/letter-body/BodyText.js");
    const { BODY_PAGE_CHARS } = await import("@ohmail/ui");
    const exact = HUGE.slice(0, BODY_PAGE_CHARS);
    let el = await mount(h(BodyText, { text: exact }));
    expect(el.querySelector("button.msg-page-more")).toBeNull();
    expect(el.querySelector(".msg-page")).toBeNull();
    await act(async () => { root!.unmount(); });
    host?.remove();
    el = await mount(h(BodyText, { text: HUGE.slice(0, BODY_PAGE_CHARS + 1) }));
    expect(el.querySelector("button.msg-page-more")).not.toBeNull();
  });
});

describe("the stream card and the row bound what they draw", () => {
  it("a News card holding a 2 MiB body draws one page, and pages on when open", async () => {
    const { StreamCard, BODY_PAGE_CHARS } = await import("@ohmail/ui");
    const el = await mount(h(StreamCard, {
      id: "m1", from: "Long Sender", time: "09:00", subject: "Long", body: HUGE,
      expandLabel: "Expand", collapseLabel: "Collapse", moreLabel: (p: number) => `more ${p}`,
    }));
    expect(drawn(el)).toBeLessThanOrEqual(BODY_PAGE_CHARS);
    expect(el.querySelector("button.msg-page-more")).toBeNull();
    await act(async () => { el.querySelector<HTMLElement>("article")!.click(); });
    const more = el.querySelector<HTMLButtonElement>("button.msg-page-more");
    expect(more?.textContent).toBe("more 3");
    await act(async () => { more!.click(); });
    expect(drawn(el)).toBeGreaterThan(BODY_PAGE_CHARS);
    expect(drawn(el)).toBeLessThanOrEqual(2 * BODY_PAGE_CHARS);
  });

  it("a row handed a whole body draws a line of it", async () => {
    const { MessageRow, ROW_PREVIEW_MAX_CHARS } = await import("@ohmail/ui");
    const el = await mount(h(MessageRow, { id: "r1", from: "Long Sender", subject: "Long", preview: HUGE }));
    expect(el.querySelector(".prev")!.textContent!.length).toBe(ROW_PREVIEW_MAX_CHARS);
    await act(async () => { root!.unmount(); });
    host?.remove();
    const ok = await mount(h(MessageRow, { id: "r2", from: "Ann", subject: "Hi", preview: "the ingest snippet" }));
    expect(ok.querySelector(".prev")!.textContent).toBe("the ingest snippet");
  });
});

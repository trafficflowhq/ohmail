/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * ── OPENING THE NEXT MESSAGE TEARS THE PREVIOUS BODY DOCUMENT DOWN ──────────────────────────
 *
 * Writing `srcdoc` on a frame that is already on screen is a NAVIGATION. The frame element
 * survives it, and so does its back/forward list: every document that frame has held stays on
 * it, and WebKit keeps those alive whole — render tree, compositing layers, decoded pictures.
 * None of it is reachable from JavaScript, so a forced collect returns none of it and a heap
 * snapshot cannot see it. Measured on the corrected renderer rig: sixty opens grew the web
 * process by tens of megabytes and the frame's `history.length` by exactly one per open, while the JS
 * heap moved a fraction of a megabyte.
 *
 * The fix is that a different document is a different ELEMENT: the frame is keyed on the bytes
 * it carries, so React takes the old frame out of the document and the browser drops the whole
 * frame with its list. Same bytes, same element — a re-render must not throw away a document it
 * already has.
 *
 * jsdom performs no layout and keeps no page cache, so what this file can watch is the
 * RECONCILIATION: which element is on screen after the second message. The bytes are the rig's
 * to weigh.
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

type Mod = typeof import("../app/letter-body/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/letter-body/MessageBody.js");

/** Mount once; `open` then re-renders the SAME root, which is what a reading session does. */
async function mount(): Promise<void> {
  await unmount();
  host = document.createElement("div");
  host.className = "msg-body";
  document.body.appendChild(host);
  root = createRoot(host);
}

async function open(props: Parameters<Mod["MessageBody"]>[0]): Promise<HTMLIFrameElement | null> {
  const { MessageBody } = await mod();
  await act(async () => { root!.render(h(MessageBody, props)); });
  return host!.querySelector("iframe");
}

/**
 * A declared 600px canvas with a nested layout table — rigid AND designed, which is what the
 * sanitiser frames. A letter would render through `BodyText` and there would be no frame to
 * reason about at all.
 */
const newsletter = (n: number): string =>
  `<table width="600" cellpadding="0"><tr><td><table width="100%"><tr><td>`
  + `<p>Issue ${n} — this month at the atelier.</p></td></tr></table></td></tr></table>`;

describe("the body frame is torn down between messages", () => {
  it("opening the next message mounts a NEW frame element, not a new document in the old one", async () => {
    // THE DEFECT, AND THE FIX. Mutation: remove `key={mail.frameKey}` from the `<iframe>` —
    // React then reconciles the two renders onto one element, `first === second`, and this
    // goes red on the identity while every other assertion in the file still passes.
    await mount();
    const first = await open({ messageId: "m1", text: "issue one", html: newsletter(1) });
    expect(first, "the first message must render framed").not.toBeNull();
    const second = await open({ messageId: "m2", text: "issue two", html: newsletter(2) });
    expect(second, "the second message must render framed").not.toBeNull();

    expect(second).not.toBe(first);
    // And the old one is GONE from the document — a detached frame is what releases the
    // browser-side document; one still parented would keep its list alive.
    expect(first!.isConnected).toBe(false);
    expect(second!.isConnected).toBe(true);
    expect(host!.querySelectorAll("iframe").length).toBe(1);
    expect(second!.getAttribute("srcdoc")).toContain("Issue 2");
  });

  it("a REBUILT document with the same bytes keeps the frame it has", async () => {
    // THE COST OF GETTING THE KEY WRONG, and why it is a hash of the bytes rather than a
    // counter. `cidImages` is a memo dependency whose identity moves once per arrival batch, so
    // a fresh map re-runs the whole sanitize-and-build pass and hands the frame the SAME bytes —
    // which must not cost a loaded document. Passing identical props instead would prove only
    // that React's memo bailed out, which is a property of React and not of this key.
    // Mutation: make `frameIdentity` answer a fresh value per call (a counter) — the rebuild
    // throws the document away, and this goes red where identical props would stay green.
    await mount();
    const first = await open({ messageId: "m1", text: "issue one", html: newsletter(1), cidImages: new Map() });
    const again = await open({ messageId: "m1", text: "issue one", html: newsletter(1), cidImages: new Map() });
    expect(again).toBe(first);
    expect(again!.isConnected).toBe(true);
  });
});

describe("frameIdentity", () => {
  it("names the bytes: equal documents share a name, one changed byte does not", async () => {
    // Mutation: return a constant — the first expectation still passes and the second goes red,
    // which is the pair that makes this a reading of the CONTENT and not of the call.
    const { frameIdentity } = await mod();
    const a = "<html><body>one</body></html>";
    const b = "<html><body>ono</body></html>";
    expect(frameIdentity(a)).toBe(frameIdentity(a));
    expect(frameIdentity(a)).not.toBe(frameIdentity(b));
    // The length travels with the hash, so two documents of different sizes can never collide.
    expect(frameIdentity(a).endsWith(`-${a.length}`)).toBe(true);
  });
});

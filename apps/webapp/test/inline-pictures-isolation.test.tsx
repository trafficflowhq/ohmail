/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";
import { buildMailDocument, buildRichNodes, MessageBody, sanitizeMailHtml } from "../app/components/MessageBody";
import { BodyText, type BodyNode } from "../app/shell/BodyText";

/**
 * EMBEDDED PICTURES BY OBJECT URL, MESSAGE BY MESSAGE. On a browser door a `cid:` part is drawn
 * from the object URL the engine minted for THAT message (`inlineImageUrls: "object"`), and the
 * frame admits `blob:`. So a `blob:` must reach a src only from this message's own map: the real
 * sanitizer over a real engine's maps, two messages, and every way a sender could name another
 * message's live URL. A `blob:` passes a sink only by membership in the message's own map values
 * (`inlineImageAdmitted`); a sender's `blob:` or preview-scheme URL never reaches one at all.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

type UrlStatics = { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };
const U = URL as unknown as UrlStatics;
const saved = { create: U.createObjectURL, revoke: U.revokeObjectURL };
let live: Set<string>;
beforeEach(() => {
  live = new Set();
  let n = 0;
  // Deterministic, in the shape a browser mints: this window's origin, then a fresh id.
  U.createObjectURL = () => {
    const url = `blob:https://app.ohmail.app/00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    live.add(url);
    return url;
  };
  U.revokeObjectURL = (url: string) => { live.delete(url); };
});
afterEach(() => {
  U.createObjectURL = saved.create;
  U.revokeObjectURL = saved.revoke;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}
afterEach(async () => { await unmount(); });
async function mount(el: React.ReactElement): Promise<HTMLDivElement> {
  await unmount();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
  return host;
}

function part(id: string, messageId: string) {
  return { id, filename: `${id}.png`, contentType: "image/png", sizeBytes: PNG.length, inline: true, contentId: "logo@corp", messageId };
}

/** Two messages that both carry a `logo@corp` part, drawn by object URL as the browser doors draw them. */
async function twoMessages(): Promise<{ engine: OhmailEngine; a: string; b: string; mapA: ReadonlyMap<string, string>; mapB: ReadonlyMap<string, string> }> {
  const parts = [part("pa", "A"), part("pb", "B")];
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async (messageId: string) => parts.filter((p) => p.messageId === messageId),
    fetchAttachment: async () => new Blob([PNG], { type: "image/png" }),
  };
  const engine = new OhmailEngine({ adapter, inlineImageUrls: "object" });
  await engine.loadInlineImages("A", ["logo@corp"]);
  await engine.loadInlineImages("B", ["logo@corp"]);
  const mapA = engine.inlineImagesOf("A");
  const mapB = engine.inlineImagesOf("B");
  return { engine, a: mapA.get("logo@corp")!, b: mapB.get("logo@corp")!, mapA, mapB };
}

/** Every `src` an image run in a walked tree carries. */
function imageRunSrcs(nodes: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.kind === "image" && typeof o.src === "string") out.push(o.src);
      for (const x of Object.values(o)) walk(x);
    }
  };
  walk(nodes);
  return out;
}

/** B's letter: its own picture by `cid:`, and A's live URL named in every position a sender has. */
const naming = (aUrl: string) =>
  `<p>Hello from B.</p><p><img src="cid:logo@corp" alt="B's own"></p>` +
  `<p><img src="${aUrl}" alt="A by src"></p><p><img srcset="${aUrl} 1x" alt="A by srcset"></p>` +
  `<div style="background:url(${aUrl})">A by style</div><table background="${aUrl}"><tr><td>A by background</td></tr></table>`;

describe("a message draws its own pictures and never another message's", () => {
  it("the engine mints each message its own URL; the maps share none", async () => {
    const { a, b } = await twoMessages();
    expect(a).toMatch(/^blob:/);
    expect(b).toMatch(/^blob:/);
    expect(a).not.toBe(b);
  });

  it("B's html naming A's live URL — src, srcset, style, background — draws nothing of A's; B's own cid resolves", async () => {
    const { a, b, mapB } = await twoMessages();
    const out = sanitizeMailHtml(naming(a), { cidImages: mapB });
    expect(out.html, "A's URL reached B's document").not.toContain(a);
    expect(out.html).toContain(`src="${b}"`);
    // The sender's two `<img>` that named A are the ordinary blanked box.
    const doc = new DOMParser().parseFromString(out.html, "text/html");
    const imgs = [...doc.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([b, BLANK, BLANK]);
    expect(imgs.some((i) => i.hasAttribute("srcset"))).toBe(false);
    expect(doc.querySelector("table")!.hasAttribute("background")).toBe(false);
    expect(doc.querySelector("div")!.getAttribute("style")).toMatch(/background:\s*none/);
    expect(out.cids, "A's URL is not a part to fetch, and B's own resolved").toEqual([]);
    // The walk (the prose rendering) carries B's picture and nothing of A's.
    expect(imageRunSrcs(out.rich)).toEqual([b]);
  });

  it("rendered, prose and framed: B shows its own picture, A's URL appears nowhere", async () => {
    const { a, b, mapB } = await twoMessages();
    const prose = await mount(h(MessageBody, { text: "Hello from B.", html: naming(a), cidImages: mapB }));
    expect(prose.querySelector("iframe"), "the fixture must render as prose").toBeNull();
    expect([...prose.querySelectorAll("img.msg-img")].map((i) => i.getAttribute("src"))).toEqual([b]);
    expect(prose.innerHTML).not.toContain(a);

    const canvas = `<table width="600"><tr><td>${naming(a)}</td></tr></table>`;
    const framed = await mount(h(MessageBody, { text: "Hello from B.", html: canvas, cidImages: mapB }));
    const srcdoc = framed.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcdoc, "the fixture must render framed").toContain("<html");
    expect(srcdoc).toContain(`src="${b}"`);
    expect(srcdoc).not.toContain(a);
  });

  it("a blob: that is not this message's own is refused at the walk and at the element write", async () => {
    const { a, b, mapA, mapB } = await twoMessages();
    const ownA = new Set(mapA.values());
    const ownB = new Set(mapB.values());
    // The walk, over a tree that holds A's URL (the sanitizer never leaves one there; the gate must not rely on it).
    const tree = document.createElement("div");
    tree.innerHTML = `<p>x</p><p><img src="${a}" alt="a"></p>`;
    expect(imageRunSrcs(buildRichNodes(tree, ownB)), "B's walk copied A's URL").toEqual([]);
    expect(imageRunSrcs(buildRichNodes(tree, ownA)), "control: A's own walk").toEqual([a]);
    // The element write, over a node built by anything at all.
    const run = (src: string): BodyNode[] => [{ kind: "rich", attribution: false, spacing: "paragraph", children: [{ kind: "image", src, alt: "" }] }];
    const asB = await mount(h(BodyText, { text: "x", rich: run(a), ownImages: ownB }));
    expect(asB.querySelector("img"), "B's prose drew A's URL").toBeNull();
    const asA = await mount(h(BodyText, { text: "x", rich: run(a), ownImages: ownA }));
    expect(asA.querySelector("img")?.getAttribute("src"), "control: A's own prose").toBe(a);
    const ownBDrawn = await mount(h(BodyText, { text: "x", rich: run(b), ownImages: ownB }));
    expect(ownBDrawn.querySelector("img")?.getAttribute("src")).toBe(b);
  });

  it("a map value that is a preview-scheme URL blanks, in an <img> and in a style url(cid:)", async () => {
    const hostile = new Map([
      ["p@x", `attachment-preview://localhost/${"0f".repeat(16)}`],
      ["q@x", `http://attachment-preview.localhost/${"0f".repeat(16)}`],
    ]);
    const out = sanitizeMailHtml(
      `<img src="cid:p@x"><img src="cid:q@x"><div style="background:url(cid:p@x)">s</div>`,
      { cidImages: hostile },
    );
    expect(out.html).not.toContain("attachment-preview");
    expect(out.html.split(`src="${BLANK}"`).length - 1).toBe(2);
    expect(out.cids).toEqual(["p@x", "q@x"]);
    expect(imageRunSrcs(out.rich)).toEqual([]);
  });
});

describe("the preview scheme and any window's blob: never reach a sink from a sender's html", () => {
  const VECTORS = [
    "blob:tauri://localhost/2f6c2a0e-6c1f-4f0e-9a4a-6d0c2e1b7a11",
    "blob:https://app.ohmail.app/2f6c2a0e-6c1f-4f0e-9a4a-6d0c2e1b7a11",
    `attachment-preview://localhost/${"0123456789abcdef".repeat(2)}`,
    `http://attachment-preview.localhost/${"0123456789abcdef".repeat(2)}`,
  ];
  for (const v of VECTORS) {
    it(`${v.slice(0, 36)}… in src, srcset, a style url(), a sheet and background is blanked`, () => {
      const html =
        `<style>.x{background:url(${v})}</style><p class="x">Letter.</p><p><img src="${v}" alt="s"></p>` +
        `<p><img srcset="${v} 1x" alt="ss"></p><div style="background-image:url('${v}')">st</div>` +
        `<table background="${v}"><tr><td>bg</td></tr></table>`;
      // Even when this message's own map holds the very URL: a sender names no picture but by `cid:`.
      const out = sanitizeMailHtml(html, { cidImages: new Map([["own@x", v]]) });
      expect(out.html, "the vector survived into the document").not.toContain(v);
      const doc = new DOMParser().parseFromString(out.html, "text/html");
      expect([...doc.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([BLANK, BLANK]);
      expect(imageRunSrcs(out.rich)).toEqual([]);
      expect(out.cids).toEqual([]);
      expect(buildMailDocument(out.html)).not.toContain(v);
    });
  }
});

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";
import { MessageBody } from "../app/components/MessageBody";

/**
 * THE FRAME'S DOCUMENT IS THE SIZE OF THE LETTER, NOT OF ITS PICTURES. Twelve embedded pictures
 * of 16 MiB in all, drawn by object URL, add a URL each to the `srcdoc` the reader's frame is
 * handed: the document stays within the letter's html plus 64 KiB (its sheet and head). The
 * control is the `data:` carrier the browser doors used, where the same document holds every byte
 * again as base64 — the copy that was then copied at every step that read it.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const MIB = 1024 * 1024;
const KIB = 1024;

type UrlStatics = { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };
const U = URL as unknown as UrlStatics;
const saved = { create: U.createObjectURL, revoke: U.revokeObjectURL };
beforeEach(() => {
  let n = 0;
  U.createObjectURL = () => `blob:https://app.ohmail.app/00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  U.revokeObjectURL = () => {};
});
afterEach(() => {
  U.createObjectURL = saved.create;
  U.revokeObjectURL = saved.revoke;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});
async function srcdocOf(html: string, cidImages: ReadonlyMap<string, string>): Promise<string> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(MessageBody, { text: "Twelve pictures.", html, cidImages })); });
  return host.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
}

const CIDS = Array.from({ length: 12 }, (_, i) => `pic${i}@letter`);
/** A designed letter (a 600 px canvas), so it renders framed, naming twelve embedded pictures. */
const LETTER = `<table width="600"><tr><td><p>Twelve pictures.</p>${CIDS.map((c) => `<p><img src="cid:${c}" width="32" height="32" alt=""></p>`).join("")}</td></tr></table>`;

describe("the reader's frame document and the pictures in it", () => {
  it("twelve pictures of 16 MiB by object URL: the document stays within the letter plus 64 KiB", async () => {
    const part = Math.floor((16 * MIB) / 12);
    const parts = CIDS.map((contentId, i) => ({
      id: `p${i}`, filename: `p${i}.png`, contentType: "image/png", sizeBytes: part, inline: true, contentId, messageId: "m1",
    }));
    const adapter: EngineAdapter = {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
      listAttachments: async () => parts,
      fetchAttachment: async () => new Blob([new Uint8Array(part)], { type: "image/png" }),
    };
    const engine = new OhmailEngine({ adapter, inlineImageUrls: "object" });
    await engine.loadInlineImages("m1", CIDS);
    const map = engine.inlineImagesOf("m1");
    expect(map.size).toBe(12);
    const doc = await srcdocOf(LETTER, map);
    for (const url of map.values()) expect(doc).toContain(`src="${url}"`);
    expect(doc.length, `the document is ${doc.length} chars for a ${LETTER.length}-char letter`).toBeLessThanOrEqual(LETTER.length + 64 * KIB);
  });

  it("THE CONTROL: the same letter drawn from data: pictures carries their bytes in the document", async () => {
    const part = 96 * KIB;
    const b64 = Buffer.from(new Uint8Array(part).map((_, i) => (i * 31) & 0xff)).toString("base64");
    const map = new Map(CIDS.map((c) => [c, `data:image/png;base64,${b64}`]));
    const doc = await srcdocOf(LETTER, map);
    expect(doc.length).toBeGreaterThan(LETTER.length + 64 * KIB);
    expect(doc.length).toBeGreaterThan(12 * b64.length);
  });
});

/**
 * THE ATTACHMENT PREVIEW'S DOCUMENTS: which parts preview, what each document may run, and the PDF
 * page's controller run in jsdom against a stand-in pdf.js (jsdom runs classic scripts, not modules,
 * so the library is the stand-in the test installs before the document is parsed).
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  IMAGE_PREVIEW_CSP, PDF_PREVIEW_MAX_PAGES, imagePreviewDocument, pdfPreviewCsp, pdfPreviewDocument, previewFits, previewKindOf, previewNonce,
} from "../src/mail/attachment-preview";
import { pdfFrameSource } from "../scripts/bundle-engine.mjs";

/* jsdom ships no types here: the two constructors this file uses, as it uses them. */
type Page = { window: Window & Record<string, unknown> };
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, opts: { runScripts: string; virtualConsole: object; beforeParse(w: Window): void }) => Page;
  VirtualConsole: new () => object;
};

const THEME = { bg: "rgb(1, 2, 3)", ink: "rgb(4, 5, 6)", paper: "rgb(7, 8, 9)" };
/* The controller as the phone build carries it, from the generator itself. */
const frame = { exports: {} as Record<string, string> };
new Function("module", pdfFrameSource())(frame);
const SCRIPTS = {
  lib: "/* the library */ globalThis.lib = 1;", worker: "/* the worker */ globalThis.worker = 1;", controller: frame.exports.PDF_CONTROLLER!,
};
const SAID = { cant: "Can't show <this> & that.", more: "More pages." };
const NONCE = "0123456789abcdef0123456789abcdef";
const PDF_B64 = Buffer.from("%PDF-1.7 not really").toString("base64");

describe("which parts preview", () => {
  it.each([
    ["image/png", "image/png", "image"],
    ["image/jpeg", "image/jpeg", "image"],
    ["IMAGE/GIF", "image/gif", "image"],
    ["image/webp; name=a.webp", "image/webp", "image"],
    ["application/pdf", "application/pdf", "pdf"],
    ["image/svg+xml", "application/octet-stream", null],
    ["image/svg+xml", "image/svg+xml", null],
    ["application/octet-stream", "application/octet-stream", null],
    ["text/plain", "text/plain", null],
    ["text/calendar", "application/octet-stream", null],
    ["image/png", "application/octet-stream", null],
    ["image/png", "image/jpeg", null],
    ["application/pdf", "image/png", null],
  ] as const)("declared %s, bytes typed %s: %s", (declared, blob, kind) => {
    expect(previewKindOf(declared, blob)).toBe(kind);
  });

  it("a document fits up to the ceiling and not past it", () => {
    expect([previewFits(100, 100), previewFits(101, 100)]).toEqual([true, false]);
  });

  it("a nonce is 32 hex characters, fresh each time", () => {
    const a = previewNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(previewNonce()).not.toBe(a);
  });
});

describe("a picture's document", () => {
  it("runs no script, under the exact CSP, with one picture of the closed type", () => {
    const doc = imagePreviewDocument("iVBORw0KGgo=", "Image/PNG; name=\"<b>.png\"", THEME)!;
    expect(doc).not.toMatch(/<script/i);
    expect(doc).toContain(`content="${IMAGE_PREVIEW_CSP}"`);
    expect(IMAGE_PREVIEW_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(doc.match(/<img /g)).toHaveLength(1);
    expect(doc).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(doc).not.toContain("<b>");
  });

  it("refuses bytes that are not base64, and a type outside the set", () => {
    expect(imagePreviewDocument('AAAA"><script>x()</script>', "image/png", THEME)).toBeNull();
    expect(imagePreviewDocument("AAAA", "image/svg+xml", THEME)).toBeNull();
  });
});

describe("a PDF's document", () => {
  const doc = pdfPreviewDocument(PDF_B64, SCRIPTS, SAID, NONCE, THEME)!;

  it("carries its nonce on every script, allows no eval, and states the exact CSP", () => {
    const scripts = doc.match(/<script[^>]*>/g)!;
    expect(scripts).toHaveLength(3);
    for (const s of scripts) expect(s).toContain(`nonce="${NONCE}"`);
    expect(doc).not.toContain("unsafe-eval");
    expect(doc).toContain(`content="${pdfPreviewCsp(NONCE)}"`);
    expect(pdfPreviewCsp(NONCE)).toBe(
      `default-src 'none'; script-src 'nonce-${NONCE}'; style-src 'unsafe-inline'; img-src data: blob:; form-action 'none'; base-uri 'none'`,
    );
    // Our controller first (classic), then the worker module, then the library.
    expect(doc.indexOf("the worker")).toBeLessThan(doc.indexOf("the library"));
    expect(scripts[0]).not.toContain("module");
  });

  it("escapes its sentences and refuses bad bytes, a bad nonce, or a library that would end its script", () => {
    expect(doc).toContain("Can&#39;t show &lt;this&gt; &amp; that.");
    expect(pdfPreviewDocument('AAAA";alert(1);"', SCRIPTS, SAID, NONCE, THEME)).toBeNull();
    expect(pdfPreviewDocument(PDF_B64, SCRIPTS, SAID, "nonce\" onload=\"x", THEME)).toBeNull();
    expect(pdfPreviewDocument(PDF_B64, { ...SCRIPTS, lib: "x = '</script><script>y()'" }, SAID, NONCE, THEME)).toBeNull();
    expect(pdfPreviewDocument(PDF_B64, { ...SCRIPTS, controller: "<!-- x" }, SAID, NONCE, THEME)).toBeNull();
  });

  /** The document parsed in jsdom with `lib` installed as pdf.js before any script runs. */
  const run = async (lib: unknown) => {
    const page = new JSDOM(doc, {
      runScripts: "dangerously",
      virtualConsole: new VirtualConsole(),
      beforeParse(window: Window) {
        // A WebView's WebRTC, which no CSP directive covers: the controller takes it away.
        Object.assign(window, { RTCPeerConnection: class {}, RTCDataChannel: class {} });
        if (lib !== undefined) Object.assign(window, { pdfjsLib: lib });
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    const d = page.window.document;
    return {
      cant: d.getElementById("cant")!.hidden === false,
      more: d.getElementById("more")!.hidden === false,
      canvases: d.querySelectorAll("canvas").length,
      rtc: [page.window.RTCPeerConnection, page.window.RTCDataChannel]
        .some((c) => c !== undefined),
    };
  };
  const pageOf = () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve() }),
  });
  const docOf = (numPages: number) => ({ numPages, getPage: async () => pageOf() });

  it("without pdf.js: the sentence", async () => {
    expect(await run(undefined)).toMatchObject({ cant: true, canvases: 0 });
  });

  it("a PDF pdf.js refuses: the sentence", async () => {
    expect(await run({ getDocument: () => ({ promise: Promise.reject(new Error("bad pdf")) }) })).toMatchObject({ cant: true, canvases: 0 });
  });

  it("two pages: two canvases, no sentence; pdf.js was handed the bytes and no URL", async () => {
    const asked: Record<string, unknown>[] = [];
    const got = await run({ getDocument: (o: Record<string, unknown>) => { asked.push(o); return { promise: Promise.resolve(docOf(2)) }; } });
    expect(got).toEqual({ cant: false, more: false, canvases: 2, rtc: false });
    expect(Object.keys(asked[0]!).sort()).toEqual(
      ["data", "disableAutoFetch", "disableRange", "disableStream", "enableXfa", "isEvalSupported", "useWasm"],
    );
    expect(asked[0]).toMatchObject({ isEvalSupported: false, enableXfa: false, useWasm: false, disableAutoFetch: true });
    expect(Buffer.from(asked[0]!.data as Uint8Array).toString()).toBe("%PDF-1.7 not really");
  });

  it("past the page bound: the bound's pages and the sentence that says so", async () => {
    const got = await run({ getDocument: () => ({ promise: Promise.resolve(docOf(PDF_PREVIEW_MAX_PAGES + 3)) }) });
    expect(got).toMatchObject({ cant: false, more: true, canvases: PDF_PREVIEW_MAX_PAGES });
  });
});

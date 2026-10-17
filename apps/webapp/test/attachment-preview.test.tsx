/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as React from "react";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OhmailEngine, type EngineAdapter, threadOf } from "@ohmail/client-engine";
import { useMessageAttachments } from "../app/shell/attachments.js";
import { AttachmentPreview, isPreviewable, previewKind } from "../app/components/AttachmentPreview.js";
import { KeymapProvider } from "../app/shell/keymap.js";

/**
 * ═══ pdf.js STANDS IN, AND THE STAND-IN IS HELD TO THE REAL LIBRARY'S SHAPE ═══════════════
 *
 * The real thing cannot run here — it needs a canvas 2D context and a worker, and jsdom has
 * neither — so the module is replaced. The replacement is only worth something if it is
 * shaped like pdf.js actually is, which is why `THE pdf.js TEARDOWN CONTRACT` below reads the
 * installed package's own type declarations and fails if these two ever part company:
 *
 *   · the LOADING TASK owns `destroy()` — it aborts the load and terminates the worker;
 *   · the DOCUMENT the task resolves to does NOT have one.
 *
 * Getting that backwards is what put "Application error: a client-side exception has occurred"
 * on screen every time somebody closed a PDF preview.
 */
const pdfDestroy = vi.fn(async () => {});
const pdfLoads = vi.fn();

vi.mock("pdfjs-dist", () => {
  const page = {
    getViewport: () => ({ width: 600, height: 800 }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  };
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    getDocument: () => {
      pdfLoads();
      return {
        // No `destroy` on the document — pdfjs-dist has none, and a mock that grew one would
        // make the regression below unable to fail.
        promise: Promise.resolve({ numPages: 2, getPage: async () => page }),
        destroy: pdfDestroy,
      };
    },
  };
});

/**
 * ═══ QUICK LOOK — THE OVERLAY, IN A REAL DOM ══════════════════════════════════════════════
 *
 * pdf.js cannot run in jsdom (no canvas 2d, no worker), so PDF RASTERISATION is proven on the
 * live host. What is proven here is everything a jsdom test CAN bite:
 *
 *  · the cost invariant — one `cost:"connection"` fetch for the item on screen, and NOT its
 *    neighbours: a speculative prefetch of the whole set would be a real regression;
 *  · the type dispatch — an SVG is never fetched to be rendered, it downloads;
 *  · the two inert render shapes jsdom can see — an image `<img>` and a text `<pre>`;
 *  · the keyboard — Esc closes, ← / → move, through the registry's `overlay` scope.
 */

// jsdom's Blob predates the async accessors every real browser has had for years; the component
// reads text with `blob.text()`. Shim it (via jsdom's FileReader) so the render path this test
// exercises matches the browser it ships to. Real browsers need no shim.
if (typeof (Blob.prototype as { text?: unknown }).text !== "function") {
  (Blob.prototype as unknown as { text: () => Promise<string> }).text = function (this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsText(this);
    });
  };
}
if (typeof (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
  (Blob.prototype as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
    function (this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as ArrayBuffer);
        fr.onerror = () => reject(fr.error);
        fr.readAsArrayBuffer(this);
      });
    };
}

/* jsdom has no 2D context and says so by THROWING out of `getContext`, which the component
   reads as "no canvas" via a null. Answering null directly keeps that stderr novel out of the
   run without changing which branch is taken. */
(HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null;

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface WireOver {
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  inline?: boolean;
}
function wire(id: string, over: WireOver = {}) {
  return {
    id,
    filename: over.filename ?? `${id}.png`,
    contentType: over.contentType ?? "image/png",
    sizeBytes: over.sizeBytes ?? 1000,
    inline: over.inline ?? false,
    messageId: "m1",
  };
}

function adapterWith(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => [wire("a1"), wire("a2"), wire("a3")],
    fetchAttachment: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    fetchAllAttachments: async () => new Blob(["PK"], { type: "application/zip" }),
    ...over,
  };
}

let closed: boolean;
let navCalls: string[];

function Harness({ engine, initialId }: { engine: OhmailEngine; initialId: string }) {
  const chrome = useMessageAttachments(engine, "m1", { conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: () => {} });
  const [activeId, setActiveId] = useState(initialId);
  // `includeInlineParts: true` — the overlay must be able to find the id it was opened on, and an
  // inline image is a real clickable tile in the strip. This mirrors `AppShell`'s overlay mount.
  const view = chrome?.itemsOf("m1", { includeInlineParts: true });
  const items = view?.state === "ready" ? view.items : [];
  if (!chrome || items.length === 0) return null;
  return h(AttachmentPreview, {
    items,
    activeId,
    onActiveIdChange: (id: string) => {
      navCalls.push(id);
      setActiveId(id);
    },
    ensure: (aid: string, opts?: { retry?: boolean }) => chrome.ensure("m1", aid, opts),
    blobOf: (aid: string) => chrome.blobOf("m1", aid),
    onDownload: (aid: string) => chrome.open("m1", aid),
    onClose: () => {
      closed = true;
    },
  });
}

const App = (props: { engine: OhmailEngine; initialId: string }) =>
  h(KeymapProvider, null, h(Harness, props));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(engine: OhmailEngine, initialId = "a1"): Promise<void> {
  // Prime the metadata so the overlay mounts on a ready list on its first render.
  await engine.loadAttachments("m1");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(h(App, { engine, initialId })));
  await act(async () => {}); // flush the fetch the overlay starts for the active item
}

function key(name: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

/**
 * THE OVERLAY UNDER SOMETHING THAT CAN CATCH — the production arrangement, in miniature.
 *
 * Closing is a state change in an ancestor, not `root.unmount()`, because that is what the
 * shell does and because the difference is the whole bug: React hands a throw from an effect
 * CLEANUP to the nearest error boundary, and in the shipped app the nearest one is the
 * framework's, whose error page replaced the entire client.
 */
let boundaryCaught: unknown[] = [];

class Boundary extends React.Component<{ children: React.ReactNode }, { err: unknown }> {
  override state = { err: null as unknown };
  static getDerivedStateFromError(err: unknown) {
    boundaryCaught.push(err);
    return { err };
  }
  override render() {
    return this.state.err
      ? h("p", { className: "boundary-tripped" }, "the app fell over")
      : (this.props.children as React.ReactElement);
  }
}

function ClosingHarness({ engine, initialId }: { engine: OhmailEngine; initialId: string }) {
  const chrome = useMessageAttachments(engine, "m1", { conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: () => {} });
  const [openId, setOpenId] = useState<string | null>(initialId);
  const view = chrome?.itemsOf("m1", { includeInlineParts: true });
  const items = view?.state === "ready" ? view.items : [];
  if (!chrome || items.length === 0 || !openId) return h("p", { className: "overlay-closed" }, "closed");
  return h(AttachmentPreview, {
    items,
    activeId: openId,
    onActiveIdChange: (id: string) => setOpenId(id),
    ensure: (aid: string, opts?: { retry?: boolean }) => chrome.ensure("m1", aid, opts),
    blobOf: (aid: string) => chrome.blobOf("m1", aid),
    onDownload: (aid: string) => chrome.open("m1", aid),
    onClose: () => setOpenId(null),
  });
}

beforeEach(() => {
  closed = false;
  navCalls = [];
  boundaryCaught = [];
  pdfDestroy.mockClear();
  pdfLoads.mockClear();
  (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () =>
    `blob:http://localhost/obj`;
  (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe("previewKind / isPreviewable — the dispatch that keeps a document from rendering", () => {
  it("renders the four raster images, PDF and text; refuses everything else", () => {
    expect(previewKind("image/png")).toBe("image");
    expect(previewKind("image/jpeg")).toBe("image");
    expect(previewKind("application/pdf")).toBe("pdf");
    expect(previewKind("text/plain; charset=utf-8")).toBe("text");
    // SVG is a document that executes script — never rendered, always downloaded.
    expect(previewKind("image/svg+xml")).toBe("other");
    expect(previewKind("application/octet-stream")).toBe("other");
    expect(isPreviewable("image/svg+xml")).toBe(false);
    expect(isPreviewable("application/pdf")).toBe(true);
    expect(isPreviewable("text/csv")).toBe(true);
  });
});

describe("an INLINE image opens in the overlay (item 4 — the Webshop PNG)", () => {
  it("clicking a message's only attachment — an inline png — opens the overlay and shows it", async () => {
    // THE BUG: the overlay built its item list without inline images, so a message whose only
    // attachment is an INLINE picture (`Content-Disposition: inline`, shown in the body) produced
    // an EMPTY list and the overlay silently declined to open — clicking did nothing. Mutation:
    // drop `{ includeInlineParts: true }` from the harness's `itemsOf` (as `AppShell` used to) and
    // `items` is empty, `Harness` returns null, and `img.ap-img` is never rendered.
    const fetchAttachment = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    const engine = new OhmailEngine({
      adapter: adapterWith({
        listAttachments: async () => [wire("pic", { inline: true, filename: "pasted.png" })],
        fetchAttachment,
      }),
    });
    await mount(engine, "pic");

    const img = host!.querySelector("img.ap-img") as HTMLImageElement | null;
    expect(img, "the inline image never reached the overlay").not.toBeNull();
    expect(img!.getAttribute("src")).toContain("blob:");
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });
});

describe("the cost invariant — one connection for the item on screen, never its neighbours", () => {
  it("opens fetching ONLY the active attachment", async () => {
    const fetchAttachment = vi.fn(async () => new Blob([new Uint8Array([1])], { type: "image/png" }));
    const engine = new OhmailEngine({ adapter: adapterWith({ fetchAttachment }) });
    await mount(engine, "a1");
    expect(fetchAttachment, "the overlay prefetched neighbours").toHaveBeenCalledTimes(1);
    // the active image reached `<img>`
    const img = host!.querySelector("img.ap-img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toContain("blob:");
  });

  it("moving to the next attachment fetches exactly it — two total, never three", async () => {
    const fetchAttachment = vi.fn(async () => new Blob([new Uint8Array([1])], { type: "image/png" }));
    const engine = new OhmailEngine({ adapter: adapterWith({ fetchAttachment }) });
    await mount(engine, "a1");
    await act(async () => key("ArrowRight"));
    await act(async () => {});
    expect(navCalls).toEqual(["a2"]);
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
  });
});

describe("the type dispatch inside the overlay", () => {
  it("an SVG landed on by ← / → is never fetched — it offers a download", async () => {
    const fetchAttachment = vi.fn(async () => new Blob(["<svg/>"], { type: "image/svg+xml" }));
    const engine = new OhmailEngine({
      adapter: adapterWith({
        listAttachments: async () => [wire("s1", { contentType: "image/svg+xml", filename: "x.svg" })],
        fetchAttachment,
      }),
    });
    await mount(engine, "s1");
    expect(fetchAttachment, "a non-previewable type was fetched for a render").not.toHaveBeenCalled();
    expect(host!.querySelector(".ap-card")).not.toBeNull();
  });

  it("a text part renders as escaped text", async () => {
    const engine = new OhmailEngine({
      adapter: adapterWith({
        listAttachments: async () => [wire("t1", { contentType: "text/plain", filename: "note.txt" })],
        fetchAttachment: async () => new Blob(["hello <b>world</b>"], { type: "text/plain" }),
      }),
    });
    await mount(engine, "t1");
    const pre = host!.querySelector("pre.ap-text");
    expect(pre?.textContent).toContain("hello <b>world</b>");
    // It is a text node, not parsed markup — the <b> is literal.
    expect(pre?.querySelector("b")).toBeNull();
  });
});

describe("closing a PDF preview tears the document down without taking the app with it", () => {
  const pdfEngine = () =>
    new OhmailEngine({
      adapter: adapterWith({
        listAttachments: async () => [wire("p1", { contentType: "application/pdf", filename: "report.pdf" })],
        fetchAttachment: async () => new Blob(["%PDF-1.4"], { type: "application/pdf" }),
      }),
    });

  async function mountClosing(engine: OhmailEngine): Promise<void> {
    await engine.loadAttachments("m1");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(h(KeymapProvider, null, h(Boundary, null, h(ClosingHarness, { engine, initialId: "p1" })))),
    );
    await act(async () => {}); // the fetch the overlay starts
    await act(async () => {}); // `getDocument().promise`, which is what makes a document to tear down
  }

  it("THE REGRESSION: the close button does not throw out of the teardown", async () => {
    await mountClosing(pdfEngine());

    // The preconditions, asserted rather than assumed. Without a LOADED document there is
    // nothing to destroy, the cleanup never runs, and a broken teardown would pass here.
    expect(pdfLoads, "no document was ever loaded — this test cannot see the defect").toHaveBeenCalledTimes(1);
    expect(host!.querySelector("canvas.ap-canvas"), "the PDF panel never rendered").not.toBeNull();

    const close = host!.querySelector<HTMLButtonElement>("button.ap-close")!;
    await act(async () => close.click());
    await act(async () => {});

    expect(
      boundaryCaught.map(String),
      "closing the preview threw into the error boundary — this is the client-side exception",
    ).toEqual([]);
    expect(host!.querySelector(".boundary-tripped")).toBeNull();
    expect(host!.querySelector(".overlay-closed"), "the overlay did not actually close").not.toBeNull();
  });

  it("…and the worker is really terminated, through the LOADING TASK", async () => {
    // The half a `try {} catch {}` around the cleanup would silently lose: a preview session
    // that never destroys anything leaves a pdf.js worker per PDF alive in the tab.
    await mountClosing(pdfEngine());
    expect(pdfDestroy).not.toHaveBeenCalled();
    const close = host!.querySelector<HTMLButtonElement>("button.ap-close")!;
    await act(async () => close.click());
    await act(async () => {});
    expect(pdfDestroy, "the pdf.js loading task was never destroyed").toHaveBeenCalledTimes(1);
  });

  it("Escape takes the same path", async () => {
    await mountClosing(pdfEngine());
    await act(async () => key("Escape"));
    await act(async () => {});
    expect(boundaryCaught.map(String)).toEqual([]);
    expect(pdfDestroy).toHaveBeenCalledTimes(1);
  });
});

describe("THE pdf.js TEARDOWN CONTRACT — what the stand-in above is held to", () => {
  /**
   * Read from the INSTALLED package, so a `pdfjs-dist` bump that moves `destroy()` fails here
   * rather than in a browser. The declarations are the right source: the crash was a
   * hand-written interface asserting a method the library does not have, reached through
   * `as unknown as`, so the compiler compared it with nothing.
   */
  const api = (): string => {
    const require = createRequire(import.meta.url);
    return readFileSync(require.resolve("pdfjs-dist/types/src/display/api.d.ts"), "utf8");
  };
  const classBody = (src: string, name: string): string => {
    const from = src.indexOf(`export class ${name} `);
    expect(from, `pdfjs-dist no longer declares ${name}`).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport class ", from + 1);
    return src.slice(from, next < 0 ? src.length : next);
  };

  it("PDFDocumentLoadingTask.destroy() is the teardown", () => {
    expect(classBody(api(), "PDFDocumentLoadingTask")).toMatch(/\bdestroy\(\): Promise<void>;/);
  });

  it("PDFDocumentProxy has NO destroy — calling one is the client-side exception", () => {
    expect(
      classBody(api(), "PDFDocumentProxy"),
      "pdfjs-dist grew PDFDocumentProxy.destroy — the mock above is now weaker than reality",
    ).not.toMatch(/^\s*destroy\(/m);
  });
});

describe("the keyboard, through the registry's overlay scope", () => {
  it("Escape closes", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, "a1");
    expect(closed).toBe(false);
    await act(async () => key("Escape"));
    expect(closed).toBe(true);
  });

  it("← / → move between attachments and wrap", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, "a1");
    await act(async () => key("ArrowLeft")); // wraps to the last
    expect(navCalls[navCalls.length - 1]).toBe("a3");
  });
});

describe("the desktop's staged preview, from the overlay's side", () => {
  async function render(items: import("../app/components/AttachmentStrip.js").AttachmentItem[], onRelease: () => void, downloads: string[]) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(h(KeymapProvider, null, h(AttachmentPreview, {
      items, activeId: items[0]!.id, onActiveIdChange: () => {}, ensure: () => {}, blobOf: () => undefined,
      onDownload: (id: string) => downloads.push(id), onClose: () => {}, onRelease,
    }))));
  }

  it("a text over the shell's cap says too large and offers the save", async () => {
    const downloads: string[] = [];
    await render([{ id: "t1", filename: "big.log", mimeType: "text/plain", sizeBytes: 40 << 20, state: "ready", previewTooLarge: true }], () => {}, downloads);
    const card = host!.querySelector(".ap-card");
    expect(card?.textContent).toContain("Too large to preview");
    expect(card?.textContent).toContain("Save it instead.");
    await act(async () => (card!.querySelector("button") as HTMLButtonElement).click());
    expect(downloads).toEqual(["t1"]);
  });

  it("closing the overlay releases what it staged, once", async () => {
    const released = vi.fn();
    await render([{ id: "a1", filename: "p.png", mimeType: "image/png", sizeBytes: 9, state: "ready", objectUrl: "attachment-preview://localhost/x" }], released, []);
    expect(host!.querySelector("img.ap-img")?.getAttribute("src")).toBe("attachment-preview://localhost/x");
    expect(released).not.toHaveBeenCalled();
    await act(async () => root!.unmount());
    root = null;
    expect(released).toHaveBeenCalledTimes(1);
  });
});

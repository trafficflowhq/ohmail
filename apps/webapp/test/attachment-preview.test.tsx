/** @vitest-environment jsdom */
import type { ComposeAttachment } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AttachmentPreview } from "../app/components/AttachmentPreview.js";
import { AttachThumb } from "../app/components/compose-attach-look.js";
import type { AttachmentItem } from "../app/components/AttachmentStrip.js";
import { KeymapContext, useKeymapStore } from "@ohmail/app-logic/keys";
/**
 * These compose cases still exercise the historical thumbnail and preview. The live Reader
 * cases and the installed PDF contract live in the sandboxed viewer's own test files.
 */
/** What the teardown did, in order: the task, the PDFWorker, the worker. */
const pdfEvents: string[] = [];
const pdfDestroy = vi.fn(async () => {
  pdfEvents.push("task.destroy");
});
const pdfLoads = vi.fn();
/** The library's own option bag: the overlay never points it at a worker. */
const pdfWorkerOptions = { workerSrc: "" };
/** A document a case holds back; by default every load resolves. */
let pdfHeld: Promise<unknown> | null = null;
/** The page's own size, the pages asked for, a page a case holds back, and every render's viewport. */
let pageSize = { width: 600, height: 800 };
const pageAsks: number[] = [];
let pageHeld: Promise<unknown> | null = null;
const pageRenders: { width: number; height: number }[] = [];

function pdfDoc() {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: pageSize.width * scale, height: pageSize.height * scale }),
    render: (p: { viewport: { width: number; height: number } }) => {
      pageRenders.push(p.viewport);
      return { promise: Promise.resolve(), cancel: () => {} };
    },
  };
  return {
    numPages: 2,
    getPage: async (n: number) => {
      pageAsks.push(n);
      if (pageHeld) await pageHeld;
      return page;
    },
  };
}

vi.mock("pdfjs-dist", () => {
  class PDFWorker {
    static create(params: { port: unknown }) {
      return new PDFWorker(params.port);
    }
    constructor(readonly port: unknown) {}
    destroy() {
      pdfEvents.push("pdfWorker.destroy");
    }
  }
  return {
    GlobalWorkerOptions: pdfWorkerOptions,
    PDFWorker,
    getDocument: (src: { worker?: unknown }) => {
      pdfLoads(src);
      return {
        // No `destroy` on the document — pdfjs-dist has none, and a mock that grew one would
        // make the regression below unable to fail.
        promise: pdfHeld ?? Promise.resolve(pdfDoc()),
        destroy: pdfDestroy,
      };
    },
  };
});

/** The page's module Worker: built, refused, or dead on a case's say. */
class FakeWorker extends EventTarget {
  static built: FakeWorker[] = [];
  static refuse: Error | null = null;
  constructor(readonly url: string | URL, readonly options?: WorkerOptions) {
    super();
    if (FakeWorker.refuse) throw FakeWorker.refuse;
    FakeWorker.built.push(this);
  }
  postMessage(): void {}
  terminate(): void {
    pdfEvents.push("worker.terminate");
  }
}

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
/**
 * THE KEY REGISTRY AS THE NEW FRAME MOUNTS IT (`packages/app/src/frame/Frame.tsx`: `KeymapContext.Provider` over
 * `useKeymapStore()`), where today's `KeymapProvider` stood (share reader-1: it leaves with today's keys; the store
 * and its overlay scope are the same).
 */
function FrameKeys({ children }: { children?: React.ReactNode }): React.ReactElement {
  return h(KeymapContext.Provider, { value: useKeymapStore() }, children);
}
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function key(name: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

const pdfCard = (): string => host!.querySelector(".ap-card")?.textContent ?? "";

beforeEach(() => {
  pdfDestroy.mockClear();
  pdfLoads.mockClear();
  pdfEvents.length = 0;
  pdfHeld = null;
  pageSize = { width: 600, height: 800 };
  pageAsks.length = 0;
  pageHeld = null;
  pageRenders.length = 0;
  FakeWorker.built = [];
  FakeWorker.refuse = null;
  (globalThis as unknown as { Worker?: unknown }).Worker = FakeWorker;
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
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

/** Flush until `ready` holds, within a bound: a PDF loads a few steps deep. */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !ready(); i += 1) await act(async () => {});
}

describe("the overlay without a Download — the compose preview's own bytes", () => {
  async function show(items: AttachmentItem[], blobOf: (id: string) => Blob | undefined = () => undefined): Promise<void> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(h(FrameKeys, null, h(AttachmentPreview, {
      items, activeId: items[0]!.id, onActiveIdChange: () => {}, ensure: () => {}, blobOf, onClose: () => {},
    }))));
  }
  const buttonsSaying = (word: string) =>
    [...host!.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(word));

  it("a file it cannot draw says only that, with no Download anywhere", async () => {
    await show([{ id: "d1", filename: "plan.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 9, state: "ready" }]);
    const card = host!.querySelector(".ap-card")!;
    expect(card.textContent).toBe("No preview");
    expect(card.querySelector("button")).toBeNull();
    expect(buttonsSaying("Download"), "the compose preview offered a Download").toEqual([]);
  });

  it("a PDF it cannot draw says only that", async () => {
    FakeWorker.refuse = new Error("refused by worker-src");
    await show(
      [{ id: "p1", filename: "r.pdf", mimeType: "application/pdf", sizeBytes: 8, state: "ready" }],
      () => new Blob(["%PDF-1.4"], { type: "application/pdf" }),
    );
    await until(() => pdfCard() !== "");
    expect(pdfCard()).toBe("Can't show this PDF here");
    expect(host!.querySelector(".ap-card button")).toBeNull();
  });

  it("a long text ends by saying it was cut, without sending anyone to download it", async () => {
    await show(
      [{ id: "t1", filename: "log.txt", mimeType: "text/plain", sizeBytes: 600_000, state: "ready" }],
      () => new Blob(["x".repeat(512 * 1024 + 10)], { type: "text/plain" }),
    );
    await until(() => host!.querySelector("pre.ap-text") !== null);
    const text = host!.querySelector("pre.ap-text")!.textContent ?? "";
    expect(text.endsWith("— preview truncated.")).toBe(true);
    expect(text).not.toContain("Download");
  });

  it("closing gives focus to the element named for the file on screen", async () => {
    const targets = ["a", "b"].map((id) => {
      const b = document.createElement("button");
      b.id = `row-${id}`;
      document.body.appendChild(b);
      return b;
    });
    const asked: string[] = [];
    function Open() {
      const [at, setAt] = useState<string | null>("a");
      if (at === null) return null;
      return h(AttachmentPreview, {
        items: ["a", "b"].map((id) => ({ id, filename: `${id}.docx`, mimeType: "application/zip", sizeBytes: 1, state: "ready" as const })),
        activeId: at, onActiveIdChange: setAt, ensure: () => {}, blobOf: () => undefined, onClose: () => setAt(null),
        focusOnClose: (id: string) => {
          asked.push(id);
          return document.getElementById(`row-${id}`);
        },
      });
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(h(FrameKeys, null, h(Open))));
    await act(async () => key("ArrowRight"));
    await act(async () => key("Escape"));
    expect(host!.querySelector(".ap-panel")).toBeNull();
    expect(asked).toEqual(["b"]);
    expect(document.activeElement).toBe(targets[1]);
    for (const t of targets) t.remove();
  });

});

describe("a PDF attached to a message being written shows its first page", () => {
  const getContext = HTMLCanvasElement.prototype.getContext;
  const toDataURL = HTMLCanvasElement.prototype.toDataURL;
  beforeEach(() => {
    (HTMLCanvasElement.prototype as unknown as { getContext: () => object }).getContext = () => ({});
    (HTMLCanvasElement.prototype as unknown as { toDataURL: () => string }).toDataURL = () => "data:image/png;base64,UEFHRQ==";
  });
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = getContext;
    HTMLCanvasElement.prototype.toDataURL = toDataURL;
    vi.useRealTimers();
  });

  const pdfAtt = (name: string): ComposeAttachment => ({ filename: name, contentType: "application/pdf", contentBase64: btoa("%PDF-1.4") });
  async function thumbs(atts: ComposeAttachment[]): Promise<void> {
    if (!root) {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
    }
    await act(async () => root!.render(h("div", null, atts.map((att) => h(AttachThumb, { key: att.filename, att, url: null })))));
  }
  const pictures = () => [...host!.querySelectorAll<HTMLImageElement>("img.att-thumb")];
  function deferred(): { promise: Promise<unknown>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<unknown>((r) => { resolve = () => r(pdfDoc()); });
    return { promise, resolve };
  }

  it("draws page 1 only, over the page's own worker, and tears down task, PDFWorker, worker", async () => {
    await thumbs([pdfAtt("a.pdf")]);
    await until(() => pictures().length === 1 && pdfEvents.length >= 3);
    expect(pictures()[0]!.getAttribute("src")).toBe("data:image/png;base64,UEFHRQ==");
    expect(pageAsks).toEqual([1]);
    const src = pdfLoads.mock.calls[0]![0] as { worker?: { port?: unknown }; disableAutoFetch?: boolean; disableStream?: boolean };
    expect(src.worker?.port).toBe(FakeWorker.built[0]);
    expect(src).toMatchObject({ disableAutoFetch: true, disableStream: true });
    expect(pdfEvents).toEqual(["task.destroy", "pdfWorker.destroy", "worker.terminate"]);
  });

  it("a crafted page size cannot ask for a large canvas", async () => {
    pageSize = { width: 1, height: 100_000 };
    await thumbs([pdfAtt("tall.pdf")]);
    await until(() => pictures().length === 1);
    expect(pageRenders).toHaveLength(1);
    expect(pageRenders[0]!.width).toBeLessThanOrEqual(64);
    expect(pageRenders[0]!.height).toBeLessThanOrEqual(256);
  });

  it("showing the same file again does not load it again", async () => {
    const att = pdfAtt("once.pdf");
    await thumbs([att]);
    await until(() => pictures().length === 1);
    await thumbs([]);
    await thumbs([att]);
    await until(() => pictures().length === 1);
    expect(pictures()).toHaveLength(1);
    expect(pdfLoads).toHaveBeenCalledTimes(1);
  });

  it("two PDFs load one after the other, never side by side", async () => {
    const first = deferred();
    pdfHeld = first.promise;
    await thumbs([pdfAtt("one.pdf"), pdfAtt("two.pdf")]);
    await until(() => pdfLoads.mock.calls.length > 0);
    for (let i = 0; i < 10; i += 1) await act(async () => {});
    expect(pdfLoads, "a second PDF was opened while the first was still loading").toHaveBeenCalledTimes(1);
    pdfHeld = null;
    await act(async () => first.resolve());
    await until(() => pictures().length === 2);
    expect(pdfLoads).toHaveBeenCalledTimes(2);
  });

  it("a file removed before its turn is never loaded", async () => {
    const first = deferred();
    pdfHeld = first.promise;
    const keep = pdfAtt("keep.pdf");
    await thumbs([keep, pdfAtt("gone.pdf")]);
    await until(() => pdfLoads.mock.calls.length > 0);
    await thumbs([keep]);
    pdfHeld = null;
    await act(async () => first.resolve());
    for (let i = 0; i < 20; i += 1) await act(async () => {});
    expect(pdfLoads).toHaveBeenCalledTimes(1);
    expect(FakeWorker.built).toHaveLength(1);
  });

  it("a page that never draws is given up after a while, and the file shows its type", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    pageHeld = new Promise(() => {});
    await thumbs([pdfAtt("stuck.pdf")]);
    await until(() => pageAsks.length === 1);
    expect(pdfDestroy).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    await until(() => pdfEvents.length >= 3);
    expect(pdfDestroy, "a stuck page held its worker open").toHaveBeenCalledTimes(1);
    expect(pictures()).toEqual([]);
    expect(host!.querySelector(".att-leaf svg")).not.toBeNull();
  });

  it("without a Worker pdf.js is never asked to open the file", async () => {
    delete (globalThis as unknown as { Worker?: unknown }).Worker;
    await thumbs([pdfAtt("noworker.pdf")]);
    for (let i = 0; i < 20; i += 1) await act(async () => {});
    expect(pdfLoads).not.toHaveBeenCalled();
    expect(pictures()).toEqual([]);
    expect(host!.querySelector(".att-leaf svg")).not.toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildPdfFrame, PDF_FRAME_CSP } from "../../../packages/app/pdf-preview/build.mjs";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdfjs-dist/package.json"));
const moduleOpening = '<script type="module">';
const html = buildPdfFrame(root);
const runner = html.slice(html.lastIndexOf(moduleOpening) + moduleOpening.length, html.lastIndexOf("</script>"));

type FontRequest = { kind: string; filename: string };

function frame(over: { refuseWorker?: boolean; holdDocument?: boolean; failOnDestroy?: boolean } = {}) {
  const replies: unknown[] = [];
  const events: string[] = [];
  const workers: WorkerFixture[] = [];
  const urls: Blob[] = [];
  const revoked: string[] = [];
  const workerSrc = { workerSrc: "" };
  const cancel = vi.fn();
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel }));
  const getPage = vi.fn(async () => ({ getViewport: () => ({ width: 400, height: 600 }), render }));
  const destroyTask = vi.fn(async () => {
    events.push("task.destroy");
    if (over.failOnDestroy) throw new Error("worker already stopped");
  });
  const documentProxy = { numPages: 1, getPage };
  const getDocument = vi.fn((_options: {
    worker: unknown; useWorkerFetch: boolean; useSystemFonts: boolean;
    BinaryDataFactory: new () => { fetch(input: FontRequest): Promise<Uint8Array> };
  }) => ({
    promise: over.holdDocument ? new Promise(() => {}) : Promise.resolve(documentProxy),
    destroy: destroyTask,
  }));
  const workerLease = { destroy: () => events.push("pdfWorker.destroy") };
  const create = vi.fn((_options: { port: WorkerFixture }) => workerLease);

  class WorkerFixture extends EventTarget {
    constructor(readonly url: string) {
      super();
      if (over.refuseWorker) throw new Error("worker unavailable");
      workers.push(this);
    }
    terminate() { events.push("worker.terminate"); }
  }

  const parent = {};
  const listeners = new Map<string, (event: unknown) => void>();
  const window = {
    origin: "null",
    parent,
    pdfjsLib: { PDFWorker: { create }, getDocument, GlobalWorkerOptions: workerSrc },
    document: { querySelector: () => ({ getContext: () => ({}) }) },
    addEventListener: (kind: string, handle: (event: unknown) => void) => { listeners.set(kind, handle); },
    removeEventListener: (kind: string) => { listeners.delete(kind); },
  };
  const sandbox = {
    window, Object, Number, ArrayBuffer, Uint8Array, Blob, atob, Worker: WorkerFixture,
    URL: {
      createObjectURL: (blob: Blob) => {
        urls.push(blob);
        return "blob:fixture-worker";
      },
      revokeObjectURL: (url: string) => { revoked.push(url); },
    },
  };
  runInNewContext(runner, sandbox);
  const port: {
    postMessage: (message: unknown) => void;
    onmessage?: (event: { data: ArrayBuffer }) => Promise<void>;
    close: () => void;
  } = {
    postMessage: (message) => { replies.push(message); },
    close: () => { events.push("port.close"); },
  };
  listeners.get("message")!({ source: parent, data: "pdf-preview", ports: [port] });
  expect(replies).toEqual(["ready"]);

  return {
    load: () => port.onmessage!({ data: new ArrayBuffer(1) }),
    close: () => listeners.get("pagehide")!(undefined),
    create, getDocument, destroyTask, getPage, cancel, render, events, replies, workers, urls, revoked,
    workerLease, workerSrc, sandbox, window,
  };
}

describe("the PDF is parsed in a worker the page builds and hands pdf.js as a port", () => {
  it("one module worker from the content-named worker, and pdf.js is handed the PDFWorker on it", async () => {
    const viewer = frame();
    await viewer.load();
    expect(viewer.getPage.mock.calls).toEqual([[1]]);
    expect(viewer.replies).toEqual(["ready", { page: 1, total: 1 }]);
    expect(viewer.workers).toHaveLength(1);
    expect(viewer.workers[0]?.url).toBe("blob:fixture-worker");
    expect(viewer.create.mock.calls).toEqual([[{ port: viewer.workers[0] }]]);
    expect(viewer.getDocument.mock.calls[0]?.[0].worker).toBe(viewer.workerLease);
    // The fenced document runs the installed worker in a blob, with only its module wrapper changed.
    const installed = readFileSync(join(root, "build/pdf.worker.min.mjs"), "utf8");
    const expected = installed.replace(/export\{[^{}]+\};?\s*(?:\/\/# sourceMappingURL=[^\r\n]*)?\s*$/, "")
      .replaceAll("import.meta.url", "self.location.href");
    expect(viewer.urls).toHaveLength(1);
    expect(viewer.urls[0]?.type).toBe("text/javascript");
    expect(await viewer.urls[0]?.text()).toBe(expected);
    expect(PDF_FRAME_CSP).toContain("worker-src blob:");
    expect(PDF_FRAME_CSP).toContain("connect-src 'none'");
    viewer.close();
  });

  it("pdf.js reads the standard fonts from this origin on the page, never the machine's own fonts", async () => {
    const viewer = frame();
    await viewer.load();
    const [options] = viewer.getDocument.mock.calls[0]!;
    expect(options).toMatchObject({ useSystemFonts: false, useWorkerFetch: false });
    expect(PDF_FRAME_CSP).toContain("connect-src 'none'");
    const filename = "FoxitSerif.pfb";
    const fonts = new options.BinaryDataFactory();
    const supplied = await fonts.fetch({ kind: "standardFontDataUrl", filename });
    expect(Buffer.from(supplied)).toEqual(readFileSync(join(root, "standard_fonts", filename)));
    await expect(fonts.fetch({ kind: "standardFontDataUrl", filename: "outside.ttf" })).rejects.toThrow();
    viewer.close();
  });

  it("a worker the page refuses says it cannot show the PDF, and pdf.js is never asked", async () => {
    const viewer = frame({ refuseWorker: true });
    await viewer.load();
    expect(viewer.replies).toEqual(["ready", "failed"]);
    expect(viewer.create).not.toHaveBeenCalled();
    expect(viewer.getDocument).not.toHaveBeenCalled();
    viewer.close();
  });

  it("a worker that dies fails the load instead of leaving it pending", () => {
    const viewer = frame({ holdDocument: true });
    void viewer.load();
    expect(viewer.getDocument).toHaveBeenCalledTimes(1);
    expect(viewer.workers).toHaveLength(1);
    expect(viewer.replies).toEqual(["ready"]);
    viewer.workers[0]!.dispatchEvent(new Event("error"));
    expect(viewer.replies).toEqual(["ready", "failed"]);
    viewer.close();
  });

  it("closing tears down the task, then the PDFWorker, then the worker", async () => {
    const viewer = frame();
    await viewer.load();
    viewer.close();
    expect(viewer.events).toEqual(["task.destroy", "pdfWorker.destroy", "worker.terminate", "port.close"]);
    expect(viewer.revoked).toEqual(["blob:fixture-worker"]);
  });

  it("never points the library at a worker of its own, nor sets the main-thread worker global", async () => {
    const viewer = frame();
    await viewer.load();
    expect(viewer.replies.at(-1)).toEqual({ page: 1, total: 1 });
    expect(viewer.workerSrc.workerSrc).toBe("");
    expect("pdfjsWorker" in viewer.window).toBe(false);
    expect("pdfjsWorker" in viewer.sandbox).toBe(false);
    viewer.close();
  });
});

describe("closing a PDF preview tears the document down without taking the app with it", () => {
  it("…and the worker is really terminated, through the LOADING TASK", async () => {
    const viewer = frame({ failOnDestroy: true });
    await viewer.load();
    expect(viewer.close).not.toThrow();
    await Promise.resolve();
    expect(viewer.destroyTask).toHaveBeenCalledTimes(1);
    expect(viewer.cancel).toHaveBeenCalledTimes(1);
    expect(viewer.events).toEqual(["task.destroy", "pdfWorker.destroy", "worker.terminate", "port.close"]);
  });
});

describe("THE pdf.js TEARDOWN CONTRACT — what the stand-in above is held to", () => {
  const api = readFileSync(require.resolve("pdfjs-dist/types/src/display/api.d.ts"), "utf8");
  const classBody = (name: string): string => {
    const from = api.indexOf(`export class ${name} `);
    expect(from, `pdfjs-dist no longer declares ${name}`).toBeGreaterThan(-1);
    const next = api.indexOf("\nexport class ", from + 1);
    return api.slice(from, next < 0 ? api.length : next);
  };

  it("PDFDocumentLoadingTask.destroy() is the teardown", () => {
    expect(classBody("PDFDocumentLoadingTask")).toMatch(/\bdestroy\(\): Promise<void>;/);
  });

  it("PDFDocumentProxy has NO destroy — calling one is the client-side exception", () => {
    expect(classBody("PDFDocumentProxy")).not.toMatch(/^\s*destroy\(/m);
  });
});

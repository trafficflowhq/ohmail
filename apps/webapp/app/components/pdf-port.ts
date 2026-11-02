/**
 * pdf.js over a worker built HERE and handed to pdf.js as a port, for the web's preview
 * (`AttachmentPreview.tsx`) and the desktop window's (`apps/desktop/src/window-pdfjs.ts`). Left to
 * start one itself, pdf.js answers a refused worker by parsing the document on the page's own
 * thread (its "fake worker"), the one that holds the session; with a port, a refused or dead worker
 * fails the load instead. Types only from `pdfjs-dist`: the caller loads the library, on the first
 * PDF, so it never lands in the boot chunk.
 */

import type { PDFDocumentLoadingTask, PDFWorker } from "pdfjs-dist";

export type Pdfjs = typeof import("pdfjs-dist");
export type PdfSource = NonNullable<Parameters<Pdfjs["getDocument"]>[0]>;
/** What `AttachmentPreview` reads of a loading task. */
export type PdfTask = Pick<PDFDocumentLoadingTask, "promise" | "destroy">;

/**
 * Load `src` with the library `load` resolves to, over a module worker from `workerUrl`. The
 * PDFWorker comes from that same library: pdf.js starts a worker of its own beside any other.
 */
export function openOverPort(load: () => Promise<Pdfjs>, workerUrl: () => string | URL, src: PdfSource): PdfTask {
  let closed = false;
  let worker: Worker | null = null;
  let pdfWorker: PDFWorker | null = null;
  let task: PDFDocumentLoadingTask | null = null;
  /** Settles when the worker reports an error, so a teardown never waits on a dead one. */
  let died: Promise<unknown> = new Promise(() => {});
  let teardown: Promise<void> | null = null;

  const promise = (async () => {
    const pdfjs = await load();
    if (closed) throw new Error("the PDF preview closed before pdf.js loaded");
    // A worker the policy refuses throws here or fires `error` below; either fails the load.
    const port = new Worker(workerUrl(), { type: "module" });
    worker = port;
    const dead = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error("the PDF worker stopped"));
      port.addEventListener("error", fail);
      port.addEventListener("messageerror", fail);
    });
    died = dead.catch(() => undefined);
    // `create` rather than `new`: its parameters are typed, the constructor's declare `port` null.
    pdfWorker = pdfjs.PDFWorker.create({ port });
    task = pdfjs.getDocument({ ...src, worker: pdfWorker });
    return Promise.race([task.promise, dead]);
  })();

  const destroy = (): Promise<void> => {
    closed = true;
    promise.catch(() => {});
    teardown ??= (async () => {
      try {
        // pdf.js's own teardown waits for an answer a dead worker never sends.
        if (task) await Promise.race([task.destroy(), died]);
      } finally {
        pdfWorker?.destroy();
        worker?.terminate();
      }
    })();
    return teardown;
  };

  return { promise, destroy } satisfies PdfTask;
}

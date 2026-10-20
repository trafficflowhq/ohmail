/**
 * pdf.js in the desktop WINDOW. `vite.config.ts` aliases `pdfjs-dist` here for the window build;
 * the host client keeps `no-pdfjs.ts`. `AttachmentPreview.tsx` calls `getDocument`, reads the
 * task's `promise` and `destroy`, and writes `GlobalWorkerOptions.workerSrc` and reads it back.
 *
 * The library and its worker are the build's own two files at the dist root, copied byte for byte
 * from this package's `pdfjs-dist` (`windowPdfjs` in `vite.config.ts`), and loaded on the first
 * PDF, never at boot. The worker is built HERE and handed to pdf.js as a port. Left to start one
 * itself, pdf.js answers a refused worker by parsing the document on this thread (its "fake
 * worker"); with a port a refused or dead worker fails the load instead. The worker is admitted by
 * `worker-src 'self'`, and the shell answers its script with `default-src 'none'`
 * (`navigation.rs`), so inside it there is no network, no import and no eval.
 */

import type { PDFDocumentLoadingTask, PDFWorker } from "pdfjs-dist";

type Pdfjs = typeof import("pdfjs-dist");
type Params = NonNullable<Parameters<Pdfjs["getDocument"]>[0]>;
/** What `AttachmentPreview` reads of a loading task. */
type Task = Pick<PDFDocumentLoadingTask, "promise" | "destroy">;

/** The two files the window build emits at its root: the library, then its worker. */
export const PDFJS_FILES = ["pdf.min.mjs", "pdf.worker.min.mjs"] as const;

/** Written and read back by `AttachmentPreview`; never used to choose the worker. */
export const GlobalWorkerOptions = { workerSrc: "" } satisfies Pick<Pdfjs["GlobalWorkerOptions"], "workerSrc">;

let library: Promise<Pdfjs> | null = null;

/** The real library, imported on the first PDF and kept; a failed import is asked again next time. */
function load(): Promise<Pdfjs> {
  library ??= (import(/* @vite-ignore */ new URL("pdf.min.mjs", document.baseURI).href) as Promise<Pdfjs>).catch(
    (err: unknown) => {
      library = null;
      throw err;
    },
  );
  return library;
}

export function getDocument(src: Params): Task {
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
    const port = new Worker(new URL("pdf.worker.min.mjs", document.baseURI), { type: "module" });
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

  return { promise, destroy } satisfies Task;
}

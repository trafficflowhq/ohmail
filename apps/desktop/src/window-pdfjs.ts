/**
 * pdf.js in the desktop WINDOW. `vite.config.ts` aliases `pdfjs-dist` here for the window build;
 * the host client keeps `no-pdfjs.ts`. `AttachmentPreview.tsx` reads `seam` and calls
 * `getDocument`, then reads the task's `promise` and `destroy`.
 *
 * The library and its worker are the build's own two files at the dist root, copied byte for byte
 * from this package's `pdfjs-dist` (`windowPdfjs` in `vite.config.ts`), and loaded on the first
 * PDF, never at boot. The worker is built HERE and handed to pdf.js as a port (`openOverPort`,
 * shared with the web). Left to start one itself, pdf.js answers a refused worker by parsing the
 * document on this thread (its "fake worker"); with a port a refused or dead worker fails the load
 * instead. The worker is admitted by `worker-src 'self'`, and the shell answers its script with
 * `default-src 'none'` (`navigation.rs`), so inside it there is no network, no import and no eval.
 */

import { openOverPort, type Pdfjs, type PdfSource, type PdfTask } from "../../webapp/app/components/pdf-port";

/** The two files the window build emits at its root: the library, then its worker. */
export const PDFJS_FILES = ["pdf.min.mjs", "pdf.worker.min.mjs"] as const;

/** This module builds its own worker: `AttachmentPreview` hands it the load as it is. */
export const seam = true;

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

export function getDocument(src: PdfSource): PdfTask {
  return openOverPort(load, () => new URL("pdf.worker.min.mjs", document.baseURI), src);
}

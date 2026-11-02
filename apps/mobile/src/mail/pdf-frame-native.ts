/**
 * pdf.js for the attachment preview, as the phone build writes it (`scripts/bundle-engine.mjs`):
 * the web app's pinned pdfjs-dist, its library and worker modules byte for byte, and the page's
 * controller. A static `require`,
 * so a build without the file cannot be produced (`src/engine/artifact-present.js` names the
 * generator first). The `-native` suffix keeps the node suite from importing it.
 */
import type { PdfScripts } from "./attachment-preview";

/* eslint-disable @typescript-eslint/no-var-requires */
const frame = require("../../generated/pdf-frame.js") as {
  PDFJS_VERSION: string; PDF_LIB: string; PDF_WORKER: string; PDF_CONTROLLER: string;
};
/* eslint-enable */

export function pdfFrameScripts(): PdfScripts {
  return { lib: frame.PDF_LIB, worker: frame.PDF_WORKER, controller: frame.PDF_CONTROLLER };
}

// A stand-in for pdf.js's library, at the name `src/window-pdfjs.ts` imports, for
// `window-pdfjs.test.ts`: every member delegates to the case's hooks on `globalThis`.
const hooks = () => globalThis.__windowPdfjsFake;
hooks().loads += 1;

export class PDFWorker {
  static create(params) {
    return new PDFWorker(params);
  }
  constructor(params) {
    this.port = params.port;
    this.destroyed = false;
    hooks().workers.push(this);
  }
  destroy() {
    this.destroyed = true;
    hooks().events.push("pdfWorker.destroy");
  }
}

export const GlobalWorkerOptions = { workerSrc: "" };

export function getDocument(src) {
  hooks().calls.push(src);
  return hooks().getDocument(src);
}

/**
 * pdf.js, absent from the HOST CLIENT only, the page a desktop host serves to a phone.
 * `AttachmentPreview.tsx` dynamically imports `pdfjs-dist`; `vite.config.ts` aliases it here in
 * that build, whose policy says `worker-src 'none'` (`host.html`), so pdf.js has no worker to
 * start. The overlay opens and says it cannot show the PDF, with a Download. The window build
 * gets the real library instead (`window-pdfjs.ts`).
 */

/*
 * WHICH LINE REFUSES: the shared surface hands a seam the load as it is, so `getDocument` below
 * throws where it is called instead of drawing a blank page. Keep this module small and side-effect
 * free: the build emits a single chunk (`inlineDynamicImports`), so the dynamic import is inlined
 * and this stub is what makes that cost nothing. Runtime substitution only —
 * `apps/desktop/tsconfig.json` still maps `pdfjs-dist` at the real package for types.
 */

/** A seam, as the window's module is: the reader calls `getDocument` below and nothing else. */
export const seam = true;

/**
 * The one entry point the reader calls, and the line that actually refuses, every time somebody
 * opens a PDF on the served page. The reader catches this and shows its cannot-render state.
 */
export function getDocument(): never {
  throw new Error("pdf preview is not available in this build");
}

/**
 * pdf.js, absent from BOTH desktop artifacts. `AttachmentPreview.tsx` dynamically imports
 * `pdfjs-dist`; `vite.config.ts` aliases it here, OUTSIDE the build conditional, because this
 * is a property of the WINDOW: the CSP says `worker-src 'none'` in both artifacts
 * (`tauri.conf.json`; the engine conf overrides `bundle` alone), pdf.js cannot start its
 * worker, and its module-initialisation breaks the bundle's boot under the locked policy.
 * Inline PDF preview is therefore not a capability either artifact has: a PDF is handed to the
 * shell (`app/shell/open-attachment.ts`), written under its own directory, opened with the
 * platform's opener — and `MessagePane` withholds the in-app viewer for PDFs.
 */

/*
 * WHICH LINE REFUSES: the shared surface sets `GlobalWorkerOptions.workerSrc` on this file's
 * own object, so its non-empty check PASSES — `getDocument` below is what throws, surfacing
 * the failure where it is called instead of drawing a blank page. Keep this module small and
 * side-effect free: the build emits a single chunk (`inlineDynamicImports`), so the dynamic
 * import is inlined and this stub is what makes that cost nothing. Runtime substitution only —
 * `apps/desktop/tsconfig.json` still maps `pdfjs-dist` at the real package for types.
 */

/**
 * Stand-in for `GlobalWorkerOptions`. The reader assigns `workerSrc` and then reads it back as
 * its own guard, so this has to be a real mutable object rather than a frozen blank — see the
 * header for why that guard passes here and `getDocument` is what refuses.
 */
export const GlobalWorkerOptions: { workerSrc: string } = { workerSrc: "" };

/**
 * The one entry point the reader calls, and the line that actually refuses. Unreachable in the
 * fixtures-only build, which has no attachment bytes to open; REACHED in the engine-bearing one,
 * every time somebody opens a PDF. The reader catches this and shows its cannot-render state.
 */
export function getDocument(): never {
  throw new Error("pdf preview is not available in this build");
}

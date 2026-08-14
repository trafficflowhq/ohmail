/**
 * pdf.js, absent from the desktop runtime — from BOTH artifacts this directory builds.
 *
 * `apps/webapp/app/components/AttachmentPreview.tsx` dynamically imports `pdfjs-dist` to render a
 * PDF attachment in the reader's Quick Look. `vite.config.ts` aliases `pdfjs-dist` to this stub,
 * and that alias sits OUTSIDE the conditional that separates the two builds — unlike the sync
 * client's, which the engine-bearing build deliberately does without. The reason is that this one
 * is a property of the WINDOW rather than of the mail behind it:
 *
 *  · pdf.js will not render without its worker, and the shell's CSP says `worker-src 'none'` in
 *    both artifacts. `tauri.conf.json` sets that policy; `src-tauri/tauri.engine.conf.json`
 *    overrides `bundle` alone and touches no security key, so the engine-bearing build inherits
 *    it unchanged. Even shipped, the real library's worker could not start here.
 *  · the real library's module-initialisation code assumes that worker environment and breaks the
 *    bundle's boot under the locked policy — so keeping it out of the runtime bundle is what
 *    makes the window open at all, in either artifact.
 *
 * The consequence is worth stating rather than leaving to be discovered: **inline PDF preview is
 * not a capability either desktop artifact has.** The interface preview serves no attachment
 * bytes at all. The engine-bearing build does serve them — it is a mail client reading a real
 * mailbox — and a PDF among them still cannot be drawn in the window; it is written to a file and
 * opened in whatever the operating system uses for PDFs.
 *
 * ── THAT LAST SENTENCE WAS A CLAIM AND NOT A DESCRIPTION, UNTIL IT WAS MADE ONE ─────────────
 *
 * It used to say the PDF "is downloaded and opened in whatever the operating system uses for
 * PDFs", and no part of that happened. The webview cancels a `<a download>` when its host has
 * registered no download handler, and this app had registered none — so the panel this stub
 * produces said to download the file, above a button that delivered nothing. Two dead ends in one
 * press, and the second was written down here as though it worked.
 *
 * It now works, by a route that does not involve a download at all:
 * `apps/webapp/app/shell/open-attachment.ts` hands the bytes to the shell, which writes the file
 * under its own directory and opens the path with the platform's opener. And a PDF no longer
 * reaches this stub from the reading pane in the first place — `MessagePane` withholds the in-app
 * viewer for the one type this build cannot draw, so the tile's own press is the whole gesture.
 * `getDocument` below stays a throw for anything that reaches it another way.
 *
 * WHICH LINE REFUSES, exactly, because the chain is not the obvious one: the shared surface sets
 * `GlobalWorkerOptions.workerSrc` and then checks it is non-empty before calling `getDocument`.
 * That assignment lands on this file's own object, so the check PASSES — `getDocument` below is
 * what throws. It throws rather than returning something empty so the failure surfaces where it
 * is called instead of drawing a blank page.
 *
 * Keep this module small and free of side effects: the build emits a single chunk
 * (`inlineDynamicImports`), so `AttachmentPreview.tsx`'s dynamic import is inlined into it rather
 * than split out, and this stub is what makes that cost nothing.
 *
 * This is the RUNTIME substitution only. `apps/desktop/tsconfig.json` still points the
 * `pdfjs-dist` path at the real package, so `AttachmentPreview.tsx` typechecks against pdf.js's
 * real types.
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

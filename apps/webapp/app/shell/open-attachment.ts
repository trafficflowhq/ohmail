/**
 * ═══ AN ATTACHMENT, ON A DESKTOP WHERE `<a download>` IS ANSWERED "NO" ══════════════════════
 *
 * Pressing an attachment in the desktop app did NOTHING. Not an error, not a partial file, not a
 * line in any log — the same silence every link in the product used to produce, and for a
 * structurally identical reason.
 *
 * ── THE MECHANISM, WHICH IS ONE LINE IN THE WEBVIEW LAYER ───────────────────────────────────
 *
 * The web client delivers a file the only way a page can: it mints a `blob:` URL for the bytes it
 * fetched and clicks a hidden `<a download>` (`attachments.ts#saveObjectUrl`). The `download`
 * attribute is not a request to navigate — it asks the webview to turn the navigation into a
 * download, which the webview forwards to whatever the host application registered to perform one.
 * This app registers nothing, and a webview with no download handler CANCELS the navigation. So:
 *
 *  · it is NOT the CSP — no policy is consulted for a download, and `connect-src 'none'` governs
 *    fetches rather than navigations;
 *  · it is NOT a missing permission — nothing was invoked to be denied;
 *  · it is NOT the link interceptor in `open-external.ts` refusing a `blob:` URL. That interceptor
 *    would refuse one, correctly — a `blob:` is not an http address — but it never sees this: the
 *    anchor is created, clicked and removed inside one function, and the download is cancelled a
 *    layer below where the click is judged.
 *
 * The press is answered correctly, by a component whose correct answer is "no download". Which is
 * why nothing appeared anywhere.
 *
 * ── AND THE PDF PANEL WAS A SECOND, INDEPENDENT DEAD END ───────────────────────────────────
 *
 * `AttachmentPreview` draws a PDF with pdf.js, which will not run without a worker, which this
 * window's policy forbids (`worker-src 'none'`) — so both desktop bundles alias the library away
 * (`apps/desktop/src/no-pdfjs.ts`). A reader who pressed a PDF therefore got a panel saying to
 * download it instead, above a Download button that could not deliver a file. Two dead ends, one
 * press, and neither of them said so.
 *
 * ── THE SHAPE: THE COMPUTER'S OWN VIEWER, WHICH IS WHAT A MAIL APP HAS ALWAYS DONE ─────────
 *
 * The window sends the bytes it already fetched and the name the message gave them. The shell
 * writes that file into a directory it owns and hands the PATH to the same platform opener a link
 * goes to — `open` on macOS, so a PDF lands in Preview and a picture lands in the picture viewer,
 * with the platform's own Quick Look gestures available on it. `engine.rs#open_attachment` owns
 * every part of the path; nothing this file sends names a place on the disk.
 *
 * This is also the safest possible answer for bytes a stranger sent: they never become a document
 * inside this app's origin, which is the rule `AttachmentPreview`'s header states and the one every
 * client bug in this space has broken.
 *
 * ── OFF EVERYWHERE EXCEPT THE ONE BUILD THAT NEEDS IT ──────────────────────────────────────
 *
 * {@link enableDesktopAttachments} is called by the desktop entry point of the engine-bearing
 * build and by nothing else, so:
 *
 *  · in the WEB app nothing is armed and the anchor keeps exactly the semantics the browser gives
 *    it — a download, into the browser's own downloads. This module is imported by shared code and
 *    is inert there by construction rather than by a branch that could be got wrong;
 *  · in the desktop PREVIEW nothing is armed either. That artifact serves no attachment bytes at
 *    all, its grant is empty, and its published claim is that it calls no command — a press that
 *    invoked one and was refused by the ACL would make the claim false while still opening nothing.
 *    A build-time literal removes the call, and `scripts/scan-artifact.mjs` reads the emitted bytes
 *    for the command's name in both directions.
 */

/** The shell command that writes one attachment and opens it. `engine.rs` owns the path. */
export const OPEN_ATTACHMENT_COMMAND = "open_attachment";

/**
 * Whether this window hands files to the operating system instead of downloading them.
 *
 * A module-level flag rather than a probe for `__TAURI_INTERNALS__`, for the reason
 * `open-external.ts` gives: the probe cannot tell the two desktop artifacts apart, because the
 * runtime defines that object in the preview too. The build that has the command says so.
 */
let armed = false;

/** Switch the handoff on. Called once, from the engine-bearing desktop build's entry point. */
export function enableDesktopAttachments(): void {
  armed = true;
}

/** Whether {@link openAttachmentWithSystemViewer} will do anything. Read by the seam and by the suite. */
export function desktopAttachmentsEnabled(): boolean {
  return armed;
}

/**
 * Whether this build must hand a type to the operating system rather than draw it itself.
 *
 * PDF and PDF only, and the reason is specific rather than a policy: the renderer is aliased out of
 * both desktop bundles because it cannot start under this window's `worker-src 'none'`
 * (`apps/desktop/src/no-pdfjs.ts` carries the chain). Images and text are drawn from bytes the app
 * already holds, by an `<img>` and a text node, and neither needs anything this window lacks.
 *
 * `MessagePane` reads this to decide which tiles are offered the in-app viewer at all. A `true`
 * here removes the small eye and leaves the tile's own press, which opens the file in the program
 * this computer uses for it — one press instead of a viewer that would have to apologise.
 *
 * The type test is spelled out here rather than imported from `AttachmentPreview`, which imports
 * this module's siblings and would close a cycle. It is one string, and the suite pins the pair.
 */
export function opensInSystemViewer(mimeType: string): boolean {
  if (!armed) return false;
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase() === "application/pdf";
}

interface TauriInternals {
  invoke(command: string, payload?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Ask the shell to write one attachment and open it, and say so if it will not.
 *
 * ── THE BYTES GO UP AS AN ARRAY OF NUMBERS, WHICH IS THE BRIDGE'S OWN WIRE ─────────────────
 *
 * `offline-guard.ts` deliberately refuses the runtime's custom-scheme IPC transport, so every
 * command in this app travels the message channel — which is JSON. The same attachment already
 * came DOWN that channel the same way (`bridge-fetch.ts#asBytes` handles exactly this shape), so
 * this is the wire the bytes are already on rather than a new cost being introduced. The bound is
 * the mail service's own single-fetch ceiling, enforced twice: the client never fetches a part over
 * it — such a part is a tile that is not a button — and the shell refuses one over it again.
 *
 * The rejection arm is a `console.error` and not a swallow, for the reason `open-external.ts`
 * gives: this whole slice exists because a press failed without a trace, and a second silent
 * failure mode inside the repair would be the same defect wearing the fix. Answers whether the
 * shell was asked at all, so the caller can tell "handed over" from "there is no shell here".
 */
export async function openAttachmentWithSystemViewer(blob: Blob, filename: string): Promise<boolean> {
  const host = globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> };
  const internals = host.__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== "function") return false;
  try {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await (internals as TauriInternals).invoke(OPEN_ATTACHMENT_COMMAND, { filename, bytes });
  } catch (err) {
    console.error(`ohmail: the shell would not open ${filename}`, err);
  }
  return true;
}

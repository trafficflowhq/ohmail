/**
 * An attachment, on a desktop where `<a download>` is answered "no". Pressing an attachment did
 * NOTHING — no error, no log line. The web client mints a `blob:` URL and clicks a hidden
 * `<a download>` (`attachments.ts#saveObjectUrl`); the `download` attribute asks the webview to
 * turn the navigation into a download, and a webview with no download handler CANCELS it. Not the
 * CSP (downloads consult no policy), not a permission (nothing was invoked), not the link
 * interceptor (the download is cancelled a layer below where the click is judged). The PDF panel
 * was a second dead end: pdf.js needs a worker `worker-src 'none'` forbids, so both desktop
 * bundles alias it away (`no-pdfjs.ts`) — a panel saying "download it" above a dead button.
 */

/**
 * The shape: the computer's own viewer, which is what a mail app has always done. The window sends
 * the bytes it already fetched and the name the message gave them; the shell writes the file into a
 * directory it owns and hands the PATH to the platform opener (`engine.rs#open_attachment` owns
 * every part of the path). Also the safest answer for bytes a stranger sent: they never become a
 * document inside this app's origin. Off everywhere except the one build that needs it:
 * {@link enableDesktopAttachments} is called by the desktop entry point of the engine-bearing build
 * and nothing else — the web app keeps browser semantics; the preview arms nothing (a build-time
 * literal removes the call, and `scripts/scan-artifact.mjs` reads the emitted bytes both ways).
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
 * Whether this build must hand a type to the operating system rather than draw it itself. PDF and
 * PDF only, for a specific reason: the renderer is aliased out of both desktop bundles because it
 * cannot start under this window's `worker-src 'none'` (`apps/desktop/src/no-pdfjs.ts`); images
 * and text are drawn from bytes the app already holds. `MessagePane` reads this to decide which
 * tiles are offered the in-app viewer: a `true` removes the small eye and leaves the tile's own
 * press, which opens the file in the program this computer uses for it. The type test is spelled
 * here rather than imported from `AttachmentPreview` (which imports this module's siblings — a
 * cycle); it is one string, and the suite pins the pair.
 */
export function opensInSystemViewer(mimeType: string): boolean {
  if (!armed) return false;
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase() === "application/pdf";
}

interface TauriInternals {
  invoke(command: string, payload?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Ask the shell to write one attachment and open it, and say so if it will not. The bytes go up as an
 * array of numbers — the bridge's own wire: `offline-guard.ts` refuses the runtime's custom-scheme IPC,
 * so every command travels the JSON message channel, and the same attachment already came DOWN it this
 * way (`bridge-fetch.ts#asBytes`). The bound is the mail service's own single-fetch ceiling, enforced
 * twice: the client never fetches a part over it, and the shell refuses one again. The rejection arm is a
 * `console.error`, not a swallow: this slice exists because a press failed without a trace, and a second
 * silent failure inside the repair would be the same defect wearing the fix. Answers whether the shell
 * was asked at all, so the caller can tell "handed over" from "there is no shell here".
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

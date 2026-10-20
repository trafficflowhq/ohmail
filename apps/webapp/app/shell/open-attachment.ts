/**
 * An attachment, on a desktop where `<a download>` is answered "no". Pressing an attachment did
 * NOTHING — no error, no log line. The web client mints a `blob:` URL and clicks a hidden
 * `<a download>` (`attachments.ts#saveObjectUrl`); the `download` attribute asks the webview to
 * turn the navigation into a download, and a webview with no download handler CANCELS it. Not the
 * CSP (downloads consult no policy), not a permission (nothing was invoked), not the link
 * interceptor (the download is cancelled a layer below where the click is judged).
 */

/**
 * The shape: the window names a part by its id and the shell does the rest — the engine streams it
 * into a staging file the shell names, and the shell saves it into Downloads or stages a picture or
 * a text for the in-app preview. A save moves no byte through this window; a PDF's preview reads
 * its bytes as the browser does (`attachments.ts#ensurePreview`). There is no command that
 * writes bytes the window chose and opens them (the old `open_attachment`, removed). Off everywhere
 * except the one build that needs it: {@link enableDesktopAttachments} is called by the desktop
 * entry point of the engine-bearing build and nothing else — the web app keeps browser semantics;
 * the preview arms nothing (a build-time literal removes the call, and `scripts/scan-artifact.mjs`
 * reads the emitted bytes both ways).
 */

import { MutationRejectedError, type StagedPreview } from "@ohmail/client-engine";

/**
 * The shell command that saves one attachment into the PERSON'S Downloads folder.
 *
 * The download and the open are different acts and this app had only the second: pressing an
 * attachment wrote the file under the app's own directory and handed it to the platform viewer, so
 * an image opened in Preview, nothing arrived in `~/Downloads`, and "Download all" had no desktop
 * meaning. This is the DOWNLOAD — what `<a download>` does in a browser, performed by the shell
 * because a webview with no download handler cancels the navigation. `engine.rs` owns every part
 * of the path, including the `name (2).ext` numbering that keeps a save from overwriting.
 */
export const SAVE_ATTACHMENT_COMMAND = "save_attachment";

/**
 * The shell commands of the in-app PREVIEW, by id. The shell stages the part on disk and answers a
 * token on its own preview scheme for an image, or the text under its cap; the bytes of an image
 * never cross the command channel, which returns every answer through `eval` as JSON
 * (`src-tauri/src/attachment_preview.rs`). The release removes the staged file.
 */
export const STAGE_PREVIEW_COMMAND = "stage_attachment_preview";
export const RELEASE_PREVIEW_COMMAND = "release_attachment_preview";

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

/** Whether the desktop's shell handoffs are armed. Read by the seam and by the suite. */
export function desktopAttachmentsEnabled(): boolean {
  return armed;
}

interface TauriInternals {
  invoke(command: string, payload?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Why the shell would not save, as the one fact the press can say. The shell's own words are a
 * diagnostic (they carry an OS error), so they go to the console and a closed set reaches the
 * screen: this computer names no Downloads folder (a Linux profile with no user-dirs entry), or
 * the file was not saved.
 */
export type SaveRefusal = "no-downloads-folder" | "not-saved";

/** The shell's refusal, read by its one stable phrase (`engine.rs#downloads_root`). */
export function saveRefusalOf(err: unknown): SaveRefusal {
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  return text.includes("named no Downloads folder") ? "no-downloads-folder" : "not-saved";
}

/** The engine's refusal of the part itself, as the shell relays it: `{ status, code, message, retryable }`. */
function engineRefusalOf(err: unknown): MutationRejectedError | null {
  const e = err as { status?: unknown; code?: unknown; message?: unknown; retryable?: unknown } | null;
  if (typeof e !== "object" || e === null || typeof e.status !== "number") return null;
  return new MutationRejectedError(typeof e.message === "string" ? e.message : "this attachment could not be fetched", {
    status: e.status, code: typeof e.code === "string" ? e.code : null, retryable: e.retryable === true,
  });
}

/** Base64 to bytes, without a binary string of the whole text. */
function bytesOf64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Ask the shell to stage one attachment for the preview, BY ITS ID, and answer what the engine
 * holds for it ({@link StagedPreview}). A refusal of the part itself is THROWN as the engine's
 * refusal, so the overlay says what a fetch refusal would; anything else is thrown as it came.
 */
export async function stageAttachmentPreview(attachmentId: string, mimeType: string): Promise<StagedPreview> {
  const host = globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> };
  const internals = host.__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== "function") throw new Error("ohmail: there is no shell to stage this preview");
  const shell = internals as TauriInternals;
  let answer: { url?: unknown; token?: unknown; text64?: unknown; tooLarge?: unknown };
  try {
    answer = (await shell.invoke(STAGE_PREVIEW_COMMAND, { attachmentId, mimeType })) as typeof answer;
  } catch (err) {
    throw engineRefusalOf(err) ?? (err instanceof Error ? err : new Error(String(err)));
  }
  if (typeof answer?.url === "string" && typeof answer.token === "string") {
    const token = answer.token;
    return {
      kind: "url",
      url: answer.url,
      release: () => {
        void shell.invoke(RELEASE_PREVIEW_COMMAND, { token }).catch((err) => console.error("ohmail: a preview was not released", err));
      },
    };
  }
  if (typeof answer?.text64 === "string") {
    return { kind: "text", text: new Blob([bytesOf64(answer.text64) as BlobPart], { type: "application/octet-stream" }) };
  }
  if (answer?.tooLarge === true) return { kind: "too_large" };
  throw new Error("ohmail: the shell's preview answer is not one this window reads");
}

/**
 * Ask the shell to save one attachment into the user's Downloads folder, BY ITS ID: the shell has
 * the engine stream the part into a file and moves it there, so its bytes never enter this window.
 * Answers `true` when it landed, `false` when there is no shell here, and the refusal when the shell
 * would not save — which the press says (`AttachmentsChrome`). A refusal of the part itself (too
 * large, gone, the mail server's answer) is THROWN, for the engine to put on the tile.
 */
export async function saveAttachmentToDownloads(attachmentId: string, filename: string): Promise<true | false | SaveRefusal> {
  const host = globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> };
  const internals = host.__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== "function") return false;
  try {
    await (internals as TauriInternals).invoke(SAVE_ATTACHMENT_COMMAND, { attachmentId, filename });
    return true;
  } catch (err) {
    const refused = engineRefusalOf(err);
    if (refused) throw refused;
    console.error(`ohmail: the shell would not save ${filename}`, err);
    return saveRefusalOf(err);
  }
}

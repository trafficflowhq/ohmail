/**
 * THE TWO DOORS OF A LETTER, as whoever stands under them meets them: its files and its remote pictures. What the
 * file door hands out is declared here; the picture door's is the reader's own seam (`letter-seams.ts`).
 *
 * ONE INSTANCE OF EACH A MOUNTED FRAME. The file door holds lists, fetched bytes and the object addresses the engine
 * minted for them, and lets a letter's go when nobody holds it any more. The picture door holds which letters a
 * person admitted pictures for. Two instances would hold two answers: one pane would show a letter's pictures and
 * another would not, and an address one of them revoked would still be drawn by the other.
 */
import { createContext, useContext, type Context } from "react";
import type { DistinctCalendarEvent, OhmailEngine } from "@ohmail/client-engine";
import type { PictureSeam } from "./letter-seams.js";

/** One file of a letter, as the engine lists it. */
export type AttachmentItem = Extract<
  ReturnType<OhmailEngine["attachmentsOf"]>,
  { state: "ready" }
>["items"][number];

/**
 * One letter's list as this door hands it, a type of its own: whoever draws it (the old strip, the reader's files)
 * declares what it reads, and the door reads no part that draws. Its items are the engine's own, so each says whether
 * it is the body's own picture. A failed list carries the server's own sentence and code, and the press that asks again.
 */
export type DoorAttachmentsView =
  | { state: "unavailable" }
  | { state: "loading"; retrying?: boolean }
  | { state: "ready"; items: AttachmentItem[] }
  | { state: "failed"; error: string; code: string | null; retryable: boolean; onRetry: () => void };

/**
 * What `MessagePane` needs to render one message's strip.
 *
 * Functions of `messageId` rather than resolved values, for the reason every other member of
 * the old shell's message chrome is: the pane is mounted TWICE while the
 * reader is open and the two mounts may hold different messages.
 */
export interface AttachmentsChrome {
  /**
   * The list and what is known about it — the engine's outcome, not a flattened array. This used to
   * read `held.state === "ready" ? held.items : []`: `unavailable`, `loading` and `failed` all became
   * the same empty array, so a failed metadata read drew exactly what an inline-only message draws —
   * nothing, under a paperclip painted from `hasAttachments`. The engine had recorded the failure all
   * along (`AttachmentsOutcome`, with `code` and `retryable`); the seam threw it away, and no longer
   * does. `includeInlineParts`: files only by default; a reader's strip asks with it and gets
   * EVERY part — the body may paint an inline picture, and it stays listed and downloadable
   * beside the real files (marked, and ordered after them — see the `ready` arm below).
   */
  itemsOf(messageId: string, opts?: { includeInlineParts?: boolean }): DoorAttachmentsView;
  /**
   * Fetch (if needed) and SAVE one attachment — the DOWNLOAD path, and the primary one. It
   * backs every tile press in the strip and the overlay's own Download button. The preview
   * path does not go through here; it goes through {@link ensure}.
   */
  open(messageId: string, attachmentId: string): void;
  /**
   * FETCH the bytes and hold them — NO save. This is what the preview overlay presses to bring
   * an `idle` item to `ready` so it can render the image, PDF or text it already declared.
   *
   * `retry` is passed ONLY on a human press of the overlay's own retry over a `failed` item:
   * the engine refuses an automatic re-ask (a re-render must not loop a `cost:"connection"`
   * fetch against a server that already refused — `openAttachment`), so an `ensure` without the
   * flag returns without patching a failed item, and the overlay reads that held `failed` state
   * rather than spinning on it.
   */
  ensure(messageId: string, attachmentId: string, opts?: { retry?: boolean }): void;
  /** The preview overlay closed: the desktop's staged preview files go ({@link ensurePreview}). */
  releasePreviews(messageId: string): void;
  /**
   * The FETCHED BYTES of one ready item, or `undefined` — the typed Blob the engine retained.
   * The preview parses it directly (`arrayBuffer()` for a PDF, `text()` for a text part); it
   * never `fetch`es the object URL, which `connect-src 'self'` refuses on the live host.
   */
  blobOf(messageId: string, attachmentId: string): Blob | undefined;
  /**
   * Fetch every attachment on the message and save them as N DISCRETE FILES, under their own
   * names. Not a zip — see the implementation for why the server's archive route is still
   * mounted and no longer called from here.
   *
   * TAKES THE SAME `includeInlineParts` AS {@link itemsOf}, and must be passed the same value.
   * "Download all" is a promise about the strip standing in front of the reader — the head even
   * counts it — so a press that enumerated a different list than the one on screen would save a
   * different number of files than the sentence beside the button just claimed.
   */
  downloadAll(messageId: string, opts?: { includeInlineParts?: boolean }): void;
  downloadingAll(messageId: string): boolean;
  /**
   * THE EMBEDDED IMAGES ALREADY IN HAND for one message — `contentId → the part's object URL`, straight off
   * the engine (`inlineImagesOf`). Identity-stable between arrivals, so `MessageBody` can hang
   * its sanitize memo on it. Empty until {@link needCidImages} has fetched something.
   */
  cidImagesOf(messageId: string): ReadonlyMap<string, string>;
  /**
   * ASK for the embedded parts a framed rendering is showing as blanked boxes — the Content-IDs
   * come from the renderer's own pass over the sanitized document. Fire-and-forget: arrival is
   * an engine notification, which hands every reader a new door and a grown map through
   * {@link cidImagesOf}. Budgets, single-flight and the no-retry-after-refusal rule all live in
   * the engine (`loadInlineImages`); calling this again with the same ids is a cheap no-op.
   */
  needCidImages(messageId: string, contentIds: string[]): void;
  /**
   * THE EVENTS ONE MESSAGE CARRIES, once each (`calendarEventsOf`): what `MessageEvents` draws
   * above the mail. Filled automatically when the message's list loads (the same effect that
   * loads the list asks; budgets and single-flight live in the engine, `loadCalendarTexts`);
   * empty until then.
   */
  eventsOf(messageId: string): readonly DistinctCalendarEvent[];
  /**
   * HOLD one message's list while a pane shows it; the return releases the hold. A list nobody
   * asked for reads as the silent first-ask state for ever, so every pane that renders a strip
   * holds its own message (`MessageFiles`), whichever surface mounted it. Counted per id: one
   * message can stand in two panes, and only the last release lets its list go, unless the
   * selection above still owns it.
   */
  hold(messageId: string): () => void;
  /**
   * What the lists this door holds show, as one value: it moves when one of them moves (a list, a file's bytes, an
   * embedded picture, an invitation).
   */
  readonly shown?: string;
}

/**
 * The two doors a frame holds, as its one composition answers them. `undefined` is a real answer and never a
 * default: no file door where this host's engine can open no file, no picture door where the host named no picture
 * wire. A reader hands `undefined` on as `none` (no tiles, no pictures, no control); it never builds a door of its
 * own in its place, and never reads a consent or mints an address itself.
 */
export interface Doors {
  readonly files: AttachmentsChrome | undefined;
  readonly pictures: PictureSeam | undefined;
}

/** Filled by what stands above the panes, once per mounted frame. Read it with {@link useDoors}. */
export const DoorsContext: Context<Doors | null> = createContext<Doors | null>(null);

/** The two doors of this frame. Throws where none stand above: a picture is never asked for through a door somebody guessed. */
export function useDoors(): Doors {
  const doors = useContext(DoorsContext);
  if (doors === null) throw new Error("useDoors: no doors stand above (DoorsContext)");
  return doors;
}

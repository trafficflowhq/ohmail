"use client";

/**
 * A press becomes a file. Pressing an attachment saves it, whatever it is
 * ({@link AttachmentsChrome.open}); looking first is a separate control offered only on drawable
 * types, wired in the shared Reader (`packages/app/src/reader`) to `openAttachmentPreview`. The engine holds every attachment's
 * state, mints the Blob URL and retains the typed bytes; this seam is where saving happens.
 * `<a download>` and never `window.open`: a `blob:` URL inherits the app's origin — an
 * `image/svg+xml` attachment executes script as `ohmail.app` with the session cookie in scope, and
 * the route's response headers do not survive into a Blob. The engine already types an SVG
 * `application/octet-stream` (`RENDERABLE_MIME`); `download` is the second ring — save, not render.
 */

/**
 * A separate subscription rather than `useEngineVersion`, because attachment state is in-memory only —
 * ohmail stores no attachment bytes, so nothing is written to the mirror and neither `store.version()`
 * nor the overlay revision moves. `notify()` fires, `useSyncExternalStore` compares an identical
 * snapshot and bails out: the strip would sit on `idle` for ever while the bytes arrived behind it. So
 * the subscription counts notifications rather than reading a version that cannot change.
 */

import type { EngineMessage } from "@ohmail/wire";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  calendarEventsOf, watchWireFailedLists, withoutCalendarBodies, type DistinctCalendarEvent,
  type OhmailEngine, type StagedPreview,
} from "@ohmail/client-engine";
import type { AttachmentItem, AttachmentsChrome, DoorAttachmentsView } from "./doors.js";
import { fileRetryIsOffered, isAuthListFailure, listRetryIsOffered } from "./file-retry.js";
import { fileLookOf } from "./files-model.js";
import { probeSessionNow, subscribeSessionRevival } from "../session/session-truth.js";

/**
 * Why a shell would not save, as the one fact the press can say: this computer names no Downloads folder, or the
 * file was not saved. The shell's own words are a diagnostic and never reach the screen.
 */
export type SaveRefusal = "no-downloads-folder" | "not-saved";

/**
 * A HOST'S SHELL THAT SAVES AND STAGES A FILE BY ITS ID: the desktop's, whose window has no download handler (an
 * anchor's `download` is cancelled there, silently). `save` puts one part into the person's Downloads folder and
 * answers `true` when it landed, `false` when there was no shell to ask, or why it would not save; `stage` brings
 * one part to the in-app preview. A refusal of the part itself is thrown, for the engine to put on the tile.
 *
 * The door takes it from its host, REQUIRED and with no default, and reads no build flag of its own. `"none"` is a
 * browser: it saves from the object address it fetched and previews from the bytes it holds.
 */
export interface FileShell {
  save: (attachmentId: string, filename: string) => Promise<true | false | SaveRefusal>;
  stage: (attachmentId: string, mimeType: string) => Promise<StagedPreview>;
}

export type { AttachmentsChrome, DoorAttachmentsView };

/** The shell a caller handed, or `"none"` for everything that is not one. */
const shellOf = (handed: FileShell | "none" | null | undefined): FileShell | "none" =>
  typeof handed === "object" && handed !== null ? handed : "none";

/**
 * Hand a URL the app already holds to the browser as a download.
 *
 * `rel="noopener"` and an anchor that never enters the layout: this is a synthetic click, not
 * a link somebody can focus, and it is removed in the same tick.
 */
export function saveObjectUrl(url: string, filename: string, doc: Document): void {
  const a = doc.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * How one file reached the person: into their Downloads folder, into the browser's, or not at all —
 * `refused` when there was no shell to ask, `failed` when the part itself was refused (its tile
 * carries why), a {@link SaveRefusal} when the shell would not save, or when a part already on
 * screen was refused (`not-saved`: its tile stays as it was).
 */
export type Delivery = "saved" | "downloaded" | "refused" | "failed" | SaveRefusal;

/** One file to deliver: the desktop saves it by id, a browser tab from the object URL it fetched. */
export interface DeliverableFile {
  messageId: string;
  attachmentId: string;
  filename: string;
  url?: string;
  /** A press over a failed tile, which may ask again (`OhmailEngine.deliverAttachment`). */
  retry?: boolean;
}

/**
 * Deliver one file, by whichever route this window actually has — and the same act on both.
 *
 * A browser tab uses {@link saveObjectUrl}. In the desktop window the `download` attribute is
 * cancelled silently by a webview with no download handler, so the desktop arm asks the shell to
 * SAVE, and never falls back to the anchor — there it is nothing at all. It names the part, not its
 * bytes: the engine streams it to disk, so a 40 MiB file costs this window nothing, and the tile
 * reads busy meanwhile. A part already on screen stays as it is through the save, as it does in a
 * browser, so the part's own refusal of that save is the press's to say: "not saved".
 */
export async function deliverFile(
  engine: Pick<OhmailEngine, "deliverAttachment">,
  shell: FileShell | "none",
  file: DeliverableFile,
  doc: Document,
): Promise<Delivery> {
  if (shell !== "none") {
    const answer = await engine.deliverAttachment(
      file.messageId, file.attachmentId, () => shell.save(file.attachmentId, file.filename),
      {
        ...(file.retry ? { retry: true } : {}),
        refused: (err: unknown) => {
          console.error(`ohmail: ${file.filename} was not saved`, err);
          return "not-saved" as const;
        },
      },
    );
    return answer === undefined ? "failed" : answer === true ? "saved" : answer === false ? "refused" : answer;
  }
  if (file.url === undefined) return "failed";
  saveObjectUrl(file.url, file.filename, doc);
  return "downloaded";
}

/**
 * Bring one item to `ready` for the preview overlay. A browser fetches the bytes (`openAttachment`).
 * The desktop asks the shell to stage the part by id instead: the command channel returns raw bytes
 * as a JSON array through `eval`, which cost the renderer 1.3 GiB for a 40 MiB picture, so an image
 * is loaded from the shell's preview scheme and text arrives only under the shell's cap. A PDF is
 * read as the browser reads it: pdf.js parses bytes, which cross the command scheme raw, and they
 * stay this document's, as the engine's Blob; nothing is staged on disk.
 */
export function ensurePreview(
  engine: Pick<OhmailEngine, "openAttachment" | "stageAttachment" | "attachmentsOf">,
  shell: FileShell | "none",
  messageId: string,
  attachmentId: string,
  opts: { retry?: boolean } = {},
): Promise<void> {
  const retry = opts.retry ? { retry: true } : {};
  if (shell === "none") return engine.openAttachment(messageId, attachmentId, retry);
  const held = engine.attachmentsOf(messageId, { includeInlineParts: true });
  const item = held.state === "ready" ? held.items.find((i) => i.id === attachmentId) : undefined;
  if (!item) return Promise.resolve();
  if (fileLookOf(item.mimeType) === "pdf") return engine.openAttachment(messageId, attachmentId, retry);
  return engine.stageAttachment(messageId, attachmentId, () => shell.stage(attachmentId, item.mimeType), retry);
}

/**
 * Deliver a whole strip, and answer how many landed in the person's Downloads folder.
 *
 * ONE FUNCTION RATHER THAN A LOOP AT THE CALL SITE, because the two routes want opposite things:
 * the BROWSER arm must be one synchronous run with no `await` between the anchor clicks (browsers
 * treat an unbroken run as one act and drop the later downloads when it is spaced across tasks),
 * while the DESKTOP arm must be sequential and awaited, because the collision numbering is decided
 * by the filesystem at the moment of the write and two presses racing for `Invoice.pdf` must not
 * be in flight together. The count is what the notice may claim: files the shell said it wrote.
 */
export async function deliverAll(
  engine: Pick<OhmailEngine, "deliverAttachment">,
  shell: FileShell | "none",
  files: ReadonlyArray<DeliverableFile>,
  doc: Document,
  /** Each file the shell would not save, with why — the press says it (see {@link deliverFile}). */
  onRefused?: (why: SaveRefusal) => void,
): Promise<number> {
  if (shell === "none") {
    for (const file of files) if (file.url !== undefined) saveObjectUrl(file.url, file.filename, doc);
    return 0;
  }
  let saved = 0;
  for (const file of files) {
    const how = await deliverFile(engine, shell, file, doc);
    if (how === "saved") saved += 1;
    else if (how === "no-downloads-folder" || how === "not-saved") onRefused?.(how);
  }
  return saved;
}

/**
 * Save a Blob the caller owns, minting and releasing its URL around the click.
 *
 * The revoke is DEFERRED rather than immediate. Chrome starts the download asynchronously
 * from the synthetic click, and revoking in the same task cancels a large one — the failure
 * is silent and size-dependent, which is the worst way to find it. A zip of somebody's
 * attachments is exactly the large case.
 */
export function saveBlob(blob: Blob, filename: string, doc: Document): void {
  const U = (globalThis as { URL?: typeof URL }).URL;
  if (typeof U?.createObjectURL !== "function") return;
  const url = U.createObjectURL(blob);
  saveObjectUrl(url, filename, doc);
  setTimeout(() => U.revokeObjectURL?.(url), 30_000);
}

/**
 * One item out of the engine's per-message list, or `undefined`.
 *
 * `includeInlineParts` unconditionally, and that is not the same decision the LIST makes. This
 * resolves an id the caller already holds — it came from a tile the strip drew — so the question
 * is "which part is this", not "what should be shown". Asking the filtered way would make a press
 * on an inline picture's tile find nothing and silently do nothing.
 */
function itemOf(engine: OhmailEngine, messageId: string, attachmentId: string): AttachmentItem | undefined {
  const held = engine.attachmentsOf(messageId, { includeInlineParts: true });
  if (held.state !== "ready") return undefined;
  return held.items.find((i) => i.id === attachmentId);
}

/** A map's identity as a number, so a fingerprint string can say "this map was replaced". */
const MAP_SERIALS = new WeakMap<object, number>();
let lastSerial = 0;
function serialOf(map: object): number {
  let n = MAP_SERIALS.get(map);
  if (n === undefined) MAP_SERIALS.set(map, (n = ++lastSerial));
  return n;
}

/**
 * WHAT THIS HOOK CAN SHOW, AS ONE COMPARABLE VALUE.
 *
 * Every field a strip or a body draws that can still MOVE after the list has landed: the outcome's
 * state, the failure's code, each item's byte state, and the embedded-image and calendar maps,
 * whose identity the engine replaces when a picture or an invitation arrives — their bytes land
 * AFTER the item already reads `ready`, so without them the picture waited for an unrelated render.
 * A string because `useSyncExternalStore` compares snapshots with `Object.is`.
 */
function attachmentsFingerprint(engine: OhmailEngine, ids: Iterable<string>): string {
  const parts: string[] = [];
  for (const id of ids) {
    const held = engine.attachmentsOf(id, { includeInlineParts: true });
    if (held.state === "ready") {
      const maps = `img${serialOf(engine.inlineImagesOf(id))}:cal${serialOf(engine.calendarTextsOf(id))}`;
      // A failed item's code too: the sentence names the side, and a re-ask can fail on another.
      // A desktop save of a part on screen moves `saving` alone; an armed re-ask `reasking` alone.
      parts.push(`${id}:ready:${held.items.map((i) => `${i.id}=${i.state}${i.saving === true ? "+saving" : ""}${i.state === "failed" ? `:${i.code ?? ""}${i.reasking === true ? "+reasking" : ""}` : ""}`).join(",")}:${maps}`);
    } else if (held.state === "failed") {
      parts.push(`${id}:failed:${held.code ?? ""}`);
    } else if (held.state === "loading") {
      parts.push(`${id}:loading${held.retrying === true ? ":retrying" : ""}`);
    } else {
      parts.push(`${id}:${held.state}`);
    }
  }
  return parts.join("|");
}

/**
 * Re-render this component when the attachment state IT CAN SHOW moves — version bump or not.
 *
 * See the header for why a version cannot see it. This answered a COUNTER bumped on every engine
 * notification, and its consumer is `ShellInner`: the whole window redrew on every publish for the
 * length of a first import, with nothing selected and nothing to show. The fingerprint is over
 * `held` — the release set, exactly the ids `itemsOf` can be asked about — so it cannot miss a
 * change this hook could render; `watching` is the condition its own effects open with.
 * `shell-rerender-per-publish.test.tsx` holds both halves.
 */
function useEngineNotice(
  engine: OhmailEngine,
  watching: boolean,
  held: () => Iterable<string>,
): string {
  const subscribe = useCallback(
    (onChange: () => void) => (watching ? engine.subscribe(onChange) : () => {}),
    [engine, watching],
  );
  return useSyncExternalStore(
    subscribe,
    () => (watching ? attachmentsFingerprint(engine, held()) : ""),
    () => "",
  );
}

/**
 * Let one message's list go. A failure the strip ANSWERED is kept, so a re-open renders the same
 * answer instead of polling a refusal that cannot change; a failure with a Try again goes, so a
 * fresh open asks once more. One predicate decides both, the same one the row's press reads.
 */
function releaseList(engine: OhmailEngine, id: string): void {
  const held = engine.attachmentsOf(id);
  const answered = held.state === "failed" && !listRetryIsOffered(held.code, held.retryable);
  engine.releaseAttachments(id, answered ? { keepFailure: true } : {});
}

/**
 * `useLayoutEffect` in a browser; `useEffect` where there is nothing to lay out — the same
 * module-scope choice `older-mail.ts` makes, for the same two reasons: hooks must be the same
 * hook on every render, and a bare `useLayoutEffect` in a server render is a `console.error`
 * (Next pre-renders client components). On the server there is no commit and no microtask
 * racing a completion, so the passive fallback loses nothing there; in the browser the layout
 * phase is the point — see the ref publication in `useMessageAttachments`.
 */
const useCommitEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * How many sibling LIST reads may be in the air at once. The same width as the engine's own
 * body-hydration cap (`hydrateThread` departs four bodies at a time), and for the same reason:
 * a thread's length must not translate into a burst the browser queues and the deadline then
 * eats. One indexed read each, so the crew drains a long thread in a few rounds.
 */
const SIBLING_LIST_CONCURRENCY = 4;

/** The at-rest value for the download-all set — one frozen instance, so idle renders share it. */
const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * Wire the selected message's attachments — and its whole conversation's — to the shell. Returns
 * `undefined` when this client cannot open attachments at all (the demo, an adapter without the
 * capability); the pane reads that as a real answer — no strip, rather than a "Download all" button
 * over an archive nothing can build. The cleanup is not optional: `releaseAttachments` revokes every
 * object URL held for a message, and a `blob:` URL pins its bytes until revoked or the document dies —
 * without it a long-lived tab accumulates every opened PDF, the exact cost "ohmail stores no
 * attachment bytes" exists to avoid. The release set is the selection's whole ask.
 */
export function useMessageAttachments(
  engine: OhmailEngine,
  messageId: string | null,
  opts: {
    /**
     * The conversation the panels SHOW (`conversation-on-screen.ts` in the shell) — required, so a
     * caller cannot ask lists over the raw mirror for members no panel draws.
     */
    conversationOf: (messageId: string) => EngineMessage[];
    onDownloadAllFailed: () => void;
    /**
     * N FILES REACHED THE PERSON'S DOWNLOADS FOLDER — the desktop's one sentence, and it is only
     * ever spoken about files the shell said it wrote. Absent on the web, where the browser
     * announces its own downloads and a second sentence from us would be a claim about a folder
     * this app cannot see.
     */
    onSavedToDownloads?: (count: number) => void;
    /** The last pane showing this message let it go; a preview over its bytes must close. */
    onUnshown?: (messageId: string) => void;
    /** N files the desktop shell would not save, and why — said where the press was. */
    onSaveRefused?: (why: SaveRefusal, count: number) => void;
    /** The host's shell that saves and stages by id, or `"none"` (a browser). See {@link FileShell}. */
    shell: FileShell | "none";
  },
): AttachmentsChrome | undefined {
  const available = engine.attachmentsAvailable();
  /**
   * Which messages have a download-all IN FLIGHT — a SET, because sibling panels each carry
   * the group verb now. The scalar this replaces held only the LAST press: starting B while A
   * still ran re-labelled A idle mid-flight, and a second press of A then saved its files
   * twice (review finding).
   */
  const [downloadingAll, setDownloadingAll] = useState<ReadonlySet<string>>(EMPTY_IDS);

  /**
   * The failure callback through a ref: `AppShell` supplies it inline (it closes over
   * `toast` and `t`), so a dependency on it would rebuild every callback below on every
   * render — and `open`/`downloadAll` are handed to a memoized context.
   */
  const onFailed = useRef(opts.onDownloadAllFailed);
  onFailed.current = opts.onDownloadAllFailed;
  const onSaved = useRef(opts.onSavedToDownloads);
  onSaved.current = opts.onSavedToDownloads;
  const onUnshown = useRef(opts.onUnshown);
  onUnshown.current = opts.onUnshown;
  const onRefused = useRef(opts.onSaveRefused);
  onRefused.current = opts.onSaveRefused;
  /** The host's shell, read at the press: the callbacks below keep their identity over it. */
  const shellRef = useRef(shellOf(opts.shell));
  shellRef.current = shellOf(opts.shell);

  /**
   * Every id whose list THIS selection asked for — the RELEASE SET. The selected message and
   * its conversation siblings all land here, and the selected-id effect's cleanup releases the
   * whole set: one owner for the lifecycle, however many panels asked. A ref rather than state
   * because it is bookkeeping the render must never see — reading it in render would make the
   * release set a render input, which it is not.
   */
  const loaded = useRef<Set<string>>(new Set());
  /** Per-id hold counts from the panes on screen ({@link AttachmentsChrome.hold}). */
  const holds = useRef<Map<string, number>>(new Map());
  const wanted = useCallback((id: string): boolean => loaded.current.has(id) || holds.current.has(id), []);
  const wantedIds = useCallback(function* (): Iterable<string> {
    yield* loaded.current;
    for (const id of holds.current.keys()) if (!loaded.current.has(id)) yield id;
  }, []);

  /* THE SUBSCRIPTION, over every id something on screen wants: the selection's release set and
     every pane's hold. Open whenever the capability exists, because a pane can hold a message
     with nothing selected (the reader over History); an empty set fingerprints to "" and so
     re-renders nothing. */
  const shown = useEngineNotice(engine, available, wantedIds);

  /**
   * The engine THIS COMMIT serves — read by completions and by the standing crew, because both
   * can outlive the commit (and the engine) they were minted under. See `ask` and `pump`.
   * Published in an effect below, never during render: a concurrent render can be abandoned
   * after running, and a render-time assignment would point live workers at an engine no
   * commit ever produced — or let an abandoned render's completion release state the
   * committed tree still renders (review finding).
   */
  const engineRef = useRef(engine);

  /**
   * The one ask, with everything an ask entails — the probe escalation and the calendar pass.
   * `fresh` is the bounded re-ask of a failed list (a drain, a revival): `reaskAttachments`.
   */
  const ask = useCallback(
    (id: string, fresh = false): Promise<void> => {
      // Metadata only: `cost: "read"`, one indexed row read, nothing reaches IMAP. The bytes
      // are a separate, deliberate act — never speculative, never per row, because a paid fetch
      // needs a person behind it.
      //
      // An AUTH-shaped failure is escalated to the session probe: the reader is looking at this
      // message right now, and "unauthorized" from our own envelope is exactly the evidence the
      // probe exists to settle — one single-flight `POST /auth/refresh` whose answer either heals
      // the session silently (and the revival below re-asks this list) or confirms the death that
      // puts the real re-auth prompt on screen. A no-op wherever no probe is registered.
      return (fresh ? engine.reaskAttachments(id) : engine.loadAttachments(id)).then((outcome) => {
        /*
         * A completion that outlived its selection is re-released, not acted on: the engine does not
         * cancel a list read on release, so a reader who left the thread before a slow response
         * landed would keep that list (and the calendar pass would fetch bytes) with no cleanup left
         * to sweep it. The release set is the truth about what the current selection wants; an id no
         * longer in it answers to nobody. The within-thread move survives: its cleanup clears the set
         * and the re-run re-adds the id before any completion can land (review finding).
         */
        /*
         * TWO ways a completion can be stale, and both answer with a release against the
         * engine THAT WAS ASKED: the selection moved on (the id left the release set), or the
         * whole ENGINE was replaced under the hook (desktop mailbox switch, live→demo) — in
         * which case even a matching id belongs to a different mirror and acting on it would
         * write the old world's answer into the new one's bookkeeping (review finding).
         */
        if (engineRef.current !== engine || !wanted(id)) {
          engine.releaseAttachments(id);
          return;
        }
        if (outcome.state === "failed" && isAuthListFailure(outcome.code)) probeSessionNow();
        // A meeting invitation should be readable, not merely saveable: fetch the message's
        // calendar parts (tiny, budgeted, single-flight — the engine owns all three bounds) so
        // the strip can draw the event card. Fire-and-forget for the reason needCidImages is.
        // Ready with no file still asks: an embedded calendar part is listed inline only.
        if (outcome.state === "ready") void engine.loadCalendarTexts(id);
      });
    },
    [engine, wanted],
  );

  useEffect(() => {
    if (!available || !messageId) return;
    loaded.current.add(messageId);
    void ask(messageId);
    return () => {
      // The whole selection's worth — the focused message AND every sibling the effect below
      // asked for. `releaseAttachments` itself declines to drop a live sent-copy seed, so
      // sweeping the set is safe against the optimistic-copy lifecycle. A pane still showing an
      // id keeps it, and that pane's last release lets it go (`releaseList` keeps an answered
      // failure either way).
      for (const id of loaded.current) {
        if (!holds.current.has(id)) releaseList(engine, id);
      }
      loaded.current.clear();
    };
  }, [engine, messageId, available, ask]);

  /**
   * The siblings' lists — a thread's panels all show their files, not only the focused one
   * (`MessageCard`; the found case was a reader's own sent reply rendered with no strip). The strip
   * reads `itemsOf(id)`, engine state, so somebody has to ask — and the asker is here, not the card,
   * because the card is mounted twice while the reader is open and an unmount-time release from one
   * mount would revoke URLs the other is showing. One owner, this hook, mounted once in `AppShell`.
   * Keyed on `messageId` AND the conversation's id list: the list alone skips the re-ask after a
   * within-thread move, `messageId` alone misses a sibling arriving mid-read; the `loaded` guard and
   * the engine's single-flight make the overlap one request. The conversation joins to a primitive.
   */
  const conversationKey =
    available && messageId
      ? opts.conversationOf(messageId)
          .map((m) => m.id)
          .join(",")
      : "";
  /**
   * THE ONE QUEUE AND THE ONE CREW — shared across effect generations, and that sharing IS
   * the concurrency bound. A crew spawned per effect run kept its budget only within its own
   * generation: a drain re-keying the sweep mid-load spawned a replacement crew BESIDE the
   * four workers still awaiting their reads, so the exact scenario the requeue exists for ran
   * nine lists at once, and repeated re-keys could stack a whole long thread (review finding).
   * Workers here outlive the effect run that pumped them: they take from whatever array the
   * ref CURRENTLY holds, so replacing the queue retargets the standing crew instead of
   * spawning a second one, and `listWorkers` never exceeds the cap for the hook's lifetime.
   */
  const pendingLists = useRef<string[]>([]);
  /** Held ids waiting for a worker, taken before the sweep's; the sweep never replaces this queue. */
  const pendingHolds = useRef<string[]>([]);
  const listWorkers = useRef(0);
  /**
   * A worker asks through THIS ref, never through a captured `ask`: the crew outlives effect
   * generations by design (that is the concurrency bound), so it also outlives the render —
   * and the ENGINE — its pump ran under. A captured closure kept asking the discarded engine
   * after a mailbox switch or a live→demo swap: the new queue's ids were dequeued, marked
   * owned, and sent to a world that no longer backs any strip — stranded loading forever, and
   * on live→demo an off-limits network request from inside the demo (review finding).
   */
  const askRef = useRef(ask);
  /*
   * THE COMMIT-SCOPE PUBLICATION — a LAYOUT effect, not a passive one, and that is the whole
   * point: passive effects flush after paint, and an already-queued promise continuation can
   * run in the gap between the commit and that flush. A completion landing in the gap under a
   * passive publication read the OLD refs — an obsolete result accepted, a calendar pass
   * started, the crew's next take sent to a live engine from inside the demo (review finding,
   * the round after render-time assignment was ruled out for abandoned-render reasons). The
   * layout phase runs synchronously inside the commit, before any microtask, so by the time
   * ANY continuation or worker can observe these refs they name the committed engine.
   */
  useCommitEffect(() => {
    engineRef.current = engine;
    askRef.current = ask;
    // The old world's QUEUE retires with its engine, in the same synchronous phase: a worker
    // resuming in the commit-to-passive gap must find nothing stale to take. The passive sweep
    // refills it with the committed conversation when the flush arrives.
    pendingLists.current = [];
    pendingHolds.current = [];
  }, [engine, ask]);
  const pump = useCallback((): void => {
    while (
      listWorkers.current < SIBLING_LIST_CONCURRENCY
      && (pendingLists.current.length > 0 || pendingHolds.current.length > 0)
    ) {
      listWorkers.current += 1;
      void (async () => {
        try {
          for (;;) {
            // A PANE ON SCREEN FIRST: a held list is asked before any of the conversation sweep's,
            // so a reader never waits out a long thread. Asked only while still held and unasked.
            const heldId = pendingHolds.current.shift();
            if (heldId !== undefined) {
              if (holds.current.has(heldId) && !loaded.current.has(heldId)) await askRef.current(heldId);
              continue;
            }
            const id = pendingLists.current.shift();
            if (id === undefined) return;
            /*
             * The release set is joined at DEQUEUE, not at enqueue. An unstarted id holds no
             * engine state to release, and membership is also the replacement run's skip test
             * — so an id enqueued-but-never-asked when the conversation changed mid-drain
             * must NOT look already-owned: it would never be asked again and its strip would
             * sit on the silent loading default until the selection moved (review finding).
             * The recheck here keeps overlapping pumps idempotent.
             */
            if (loaded.current.has(id)) continue;
            loaded.current.add(id);
            await askRef.current(id);
          }
        } finally {
          listWorkers.current -= 1;
        }
      })();
    }
  }, []);

  useEffect(() => {
    if (!available || !messageId || conversationKey === "") return;
    /*
     * BOUNDED, NOT A BURST. The engine's single-flight is per message, so a naive loop here
     * would put one deadline-bound GET in the air per thread member at once — a long thread
     * as one volley, repeated on every within-thread selection move, with the queued tail
     * able to age out against `ATTACHMENT_LIST_TIMEOUT_MS` behind browser connection limits
     * (review finding). The queue is REPLACED, never appended: whatever an earlier generation
     * still had waiting either reappears in this conversation's own list or has stopped
     * mattering, and the standing crew drains the new array from its next take.
     */
    const wanted = conversationKey.split(",").filter((id) => !loaded.current.has(id));
    if (wanted.length === 0) return;
    pendingLists.current = wanted;
    pump();
    return () => {
      pendingLists.current = [];
    };
  }, [engine, messageId, available, conversationKey, pump]);

  /**
   * A session failure must not outlive the session it failed in. The engine holds a `failed` list for
   * the engine's life and refuses the automatic re-ask (`loadAttachments`, the render-loop argument) —
   * right for a server that refused the content, wrong for one that refused the session: one 401'd
   * metadata read during an auth outage kept "Couldn't load this message's files." on the message for
   * the whole session while the endpoint answered 200 beside it. So the seam listens for revivals —
   * each a real 204 from `/auth/refresh` — and re-asks then. Bounded twice: at most one revival per
   * successful refresh, and only while the held failure's `code` names the session. The release first
   * makes the re-ask a fresh question rather than the refused answer served from memory.
   */
  useEffect(() => {
    // Open with nothing selected, as the subscription above is: a News card holds its own list.
    if (!available) return;
    return subscribeSessionRevival(() => {
      // The whole release set, not the focused id alone: a sibling panel's list 401s the same
      // way the focused one does, and a revival that healed one strip while its neighbour kept
      // "Your session ended" would be the original defect kept on the panels added since.
      for (const id of [...wantedIds()]) {
        const held = engine.attachmentsOf(id);
        if (held.state !== "failed" || !isAuthListFailure(held.code)) continue;
        void askRef.current(id, true);
      }
    });
  }, [engine, messageId, available, wantedIds]);

  /**
   * AND A LIST THE WIRE FAILED is asked again when the server answers a drain again — the store
   * reads' one classifier (`wireFailed`) and their cap, per id: at most REASK_MAX re-asks while the
   * list stays wire-failed, reset once it answers. "Couldn't reach ohmail" stood over a message
   * for minutes after a short drop while every other request answered 200.
   */
  useEffect(() => {
    if (!available) return;
    return watchWireFailedLists(engine, wantedIds, (id) => void askRef.current(id, true));
  }, [engine, messageId, available, wantedIds]);

  /**
   * The engine's outcome, carried across unchanged but for one addition: the failed variant
   * gets the callback that acts on it.
   *
   * `retry: true` is not optional decoration. `loadAttachments` returns the HELD failure for an
   * ordinary call — deliberately, so a React effect whose identity changes per render cannot
   * hammer a server that already refused — so a "Try again" that omitted the flag would redraw
   * the same failure without asking anybody, which is the same lie the failed TILE's own copy
   * was written to avoid.
   */
  const itemsOf = useCallback(
    (id: string, opts: { includeInlineParts?: boolean } = {}): DoorAttachmentsView => {
      const held = engine.attachmentsOf(id, opts);
      switch (held.state) {
        case "unavailable":
          return { state: "unavailable" };
        case "loading":
          return held.retrying ? { state: "loading", retrying: true } : { state: "loading" };
        case "ready": {
          // FILES FIRST, the body's own pictures after — a stable partition, wire order kept
          // inside each half. The strip marks inline rows; grouping them behind the real files
          // keeps the invoice ahead of fifteen template logos. Download-all enumerates through
          // the ENGINE with the same opts and the same filter, so the saved set matches this list.
          // An invitation's calendar alternative is its body, read by the event card: no tile
          // while a listed calendar file carries the same event (Google), its one tile otherwise.
          const parts = withoutCalendarBodies(engine, id, held.items);
          return {
            state: "ready",
            items: opts.includeInlineParts === true
              ? [...parts.filter((i) => !i.inline), ...parts.filter((i) => i.inline)]
              : parts,
          };
        }
        case "failed":
          return {
            state: "failed",
            error: held.error,
            code: held.code,
            retryable: held.retryable,
            onRetry: () => void engine.loadAttachments(id, { retry: true }),
          };
        default: {
          /* Exhaustive: a state the engine grows must be given an answer here, never dropped
             into a catch-all — dropping states into one answer is what this prevents. */
          const unhandled: never = held;
          return unhandled;
        }
      }
    },
    [engine],
  );

  const open = useCallback(
    (id: string, attachmentId: string): void => {
      void (async () => {
        const before = itemOf(engine, id, attachmentId);
        // `too_large` is permanent, and so is a failure asking again cannot help — the strip renders
        // both as a div rather than a button for exactly this reason, and a programmatic call must
        // agree with the pixels.
        if (!before || before.state === "too_large") return;
        if (before.state === "failed" && !fileRetryIsOffered(before)) return;

        // THE DESKTOP SAVES BY ID: no fetch into this window first, the engine streams the part.
        const shell = shellRef.current;
        if (shell !== "none") {
          const how = await deliverFile(engine, shell, {
            messageId: id, attachmentId, filename: before.filename, retry: before.state === "failed",
          }, document);
          if (how === "saved") onSaved.current?.(1);
          else if (how === "no-downloads-folder" || how === "not-saved") onRefused.current?.(how, 1);
          return;
        }

        if (before.state !== "ready" || !before.objectUrl) {
          // `retry` ONLY on a press over a failed tile. The engine deliberately refuses an
          // automatic re-ask (a React effect whose identity changes per render would loop
          // against a server that already refused, at `cost: "connection"` a time) — and the
          // failed tile's own words end "try again", so a press that did not re-ask would make that
          // sentence a lie.
          await engine.openAttachment(id, attachmentId, before.state === "failed" ? { retry: true } : {});
        }

        const after = itemOf(engine, id, attachmentId);
        // Nothing to save on `failed` or `too_large`: the tile carries the server's own
        // sentence and a silent no-op here is what lets it be read. A browser download is
        // announced by the browser, so nothing is said here.
        if (after?.state === "ready" && after.objectUrl) {
          await deliverFile(engine, shell, { messageId: id, attachmentId, filename: after.filename, url: after.objectUrl }, document);
        }
      })();
    },
    [engine],
  );

  const ensure = useCallback(
    (id: string, attachmentId: string, opts: { retry?: boolean } = {}): void => {
      // FETCH, NEVER SAVE. `openAttachment` is single-flight and returns early when the item is
      // already `ready`, so calling this from the overlay's render effect cannot issue a second
      // `cost:"connection"` fetch — and it refuses to re-ask a `failed` item unless `retry` is
      // set, which the overlay passes only from a human press of its own retry.
      void ensurePreview(engine, shellRef.current, id, attachmentId, opts);
    },
    [engine],
  );

  const releasePreviews = useCallback((id: string): void => engine.releasePreviews(id), [engine]);

  const blobOf = useCallback(
    (id: string, attachmentId: string): Blob | undefined => engine.attachmentBlobOf(id, attachmentId),
    [engine],
  );

  const cidImagesOf = useCallback(
    (id: string): ReadonlyMap<string, string> => engine.inlineImagesOf(id),
    [engine],
  );

  const eventsOf = useCallback(
    (id: string, opts?: { attachmentTiles?: boolean }): readonly DistinctCalendarEvent[] =>
      calendarEventsOf(engine, id, opts?.attachmentTiles),
    [engine],
  );

  const needCidImages = useCallback(
    (id: string, contentIds: string[], opts?: { first?: boolean }): Promise<void> => engine.loadInlineImages(id, contentIds, opts),
    [engine],
  );

  /**
   * Download all — N files, not one archive. The server-assembled zip route still exists
   * (`engine.downloadAllAttachments`); the webapp no longer uses it. A zip is a container somebody now
   * has to deal with, named after a message id, and it hid the archive's one dishonesty: parts the
   * server could not fetch were named in an `_errors.txt` inside it, so the saved file looked complete
   * — per file, a failed part is a `failed` tile in the strip with the server's own sentence. The cost
   * is one IMAP fetch per file, affordable because the prefetch is sequential and an already-`ready`
   * item is skipped. How the files are then delivered is {@link deliverAll}'s: one synchronous run
   * of anchor clicks in a browser, one awaited shell call per file on the desktop.
   */
  const downloadAll = useCallback(
    (id: string, opts: { includeInlineParts?: boolean; omit?: string } = {}): void => {
      void (async () => {
        setDownloadingAll((prev) => {
          const next = new Set(prev);
          next.add(id);
          return next;
        });
        try {
          const held = engine.attachmentsOf(id, opts);
          const listed = held.state === "ready"
            ? withoutCalendarBodies(engine, id, held.items).filter((item) => item.id !== opts.omit)
            : [];
          if (held.state !== "ready" || listed.length === 0) {
            // No metadata means nothing to enumerate. The strip is already saying why — the
            // list carries its own failure state — so this is the one case the toast would only
            // repeat. It is still reported, because the press did nothing, and a press that
            // does nothing without saying so is the failure this callback exists for.
            onFailed.current();
            return;
          }

          // `too_large` is permanent — the server refused at its ceiling — so it is not asked
          // for, nor is a failure the server said asking again cannot help. Any other `failed` IS
          // re-asked: a press of the group verb is a human act, which is the only thing that may
          // re-drive a `cost:"connection"` fetch the server already refused.
          const wanted = listed.filter((i) => i.state !== "too_large" && (i.state !== "failed" || fileRetryIsOffered(i)));
          // ── the delivery half, and the two routes want opposite things ──
          //
          // `deliverAll` owns that split and its header states it: the browser arm stays ONE
          // synchronous run of anchor clicks (spacing them across tasks drops the later
          // downloads), and the desktop arm is sequential and awaited, because each file is a
          // write into a folder shared with everything else this person has downloaded and the
          // collision numbering is settled by the filesystem at the moment of the write. The
          // desktop saves by id, so it fetches nothing into this window first.
          const shell = shellRef.current;
          const desktop = shell !== "none";
          if (!desktop) {
            for (const item of wanted) {
              await engine.openAttachment(id, item.id, item.state === "failed" ? { retry: true } : {});
            }
          }

          // RE-READ, never the pre-fetch snapshot: `wanted` holds the states as they were before
          // any of this ran, and saving from it would mean saving a stale `objectUrl` — or none.
          // Same `opts` as the enumerate above: a re-read that widened the list would save a file
          // this press never fetched, and one that narrowed it would drop one it did.
          const after = engine.attachmentsOf(id, opts);
          const files: DeliverableFile[] = desktop
            ? wanted.map((item) => ({ messageId: id, attachmentId: item.id, filename: item.filename, retry: item.state === "failed" }))
            : (after.state === "ready" ? withoutCalendarBodies(engine, id, after.items).filter((i) => i.state === "ready" && i.objectUrl) : [])
              .map((item) => ({ messageId: id, attachmentId: item.id, filename: item.filename, url: item.objectUrl! }));

          const refusals: SaveRefusal[] = [];
          const intoDownloads = await deliverAll(engine, shell, files, document, (why) => refusals.push(why));
          if (intoDownloads > 0) onSaved.current?.(intoDownloads);
          // A file the shell would not save has no tile to carry it, so the press says it.
          if (refusals.length > 0) {
            onRefused.current?.(refusals.includes("no-downloads-folder") ? "no-downloads-folder" : "not-saved", refusals.length);
          }

          // Reported only when NOTHING could be saved. A partial result needs no toast: every
          // file that could not be fetched is a `failed` tile carrying the server's own sentence,
          // which is more than a toast could say and is attached to the file it is about.
          if (desktop ? intoDownloads === 0 && refusals.length === 0 : files.length === 0) onFailed.current();
        } finally {
          // Remove THIS id alone: another panel's download-all may still be in flight, and its
          // membership — its spinner — is its own.
          setDownloadingAll((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      })();
    },
    [engine],
  );

  const downloadingAllOf = useCallback((id: string): boolean => downloadingAll.has(id), [downloadingAll]);

  /* The release goes to the engine that was HELD, and runs once however often it is called. */
  const hold = useCallback(
    (id: string): (() => void) => {
      const count = holds.current.get(id) ?? 0;
      holds.current.set(id, count + 1);
      if (count === 0 && !loaded.current.has(id)) {
        pendingHolds.current.push(id);
        pump();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (holds.current.get(id) ?? 1) - 1;
        if (left > 0) {
          holds.current.set(id, left);
          return;
        }
        holds.current.delete(id);
        if (!loaded.current.has(id)) releaseList(engine, id);
        onUnshown.current?.(id);
      };
    },
    [engine, pump],
  );

  /**
   * ONE OBJECT, not a fresh literal per render.
   *
   * `AppShell` puts this straight into the `chrome` memo, and a value that changed identity on
   * every render would defeat that memo entirely — every consumer of `MessageChromeContext`
   * re-rendering on every keystroke in the reply editor. It changes exactly when something a
   * consumer can see changes: the engine, whether a zip is in flight, or what the door can show (`shown`).
   */
  const chrome = useMemo(
    (): AttachmentsChrome => ({
      itemsOf, open, ensure, releasePreviews, blobOf, downloadAll, downloadingAll: downloadingAllOf,
      cidImagesOf, needCidImages, eventsOf, hold, shown,
    }),
    // What the door can show moved: a reader under a context renders again only when its value does.
    [itemsOf, open, ensure, releasePreviews, blobOf, downloadAll, downloadingAllOf, cidImagesOf, needCidImages, eventsOf, hold, shown],
  );

  return available ? chrome : undefined;
}

"use client";

/**
 * ═══ THE LAST TEN CENTIMETRES: A PRESS BECOMES A FILE ═════════════════════════════════════
 *
 * Pressing an attachment saves it, whatever it is, through {@link AttachmentsChrome.open}
 * below. Looking at it first is a SEPARATE, smaller control offered only on the types this
 * app can draw — the strip's own eye, wired one layer up in `MessagePane` to
 * `openAttachmentPreview`. That overlay fetches through {@link AttachmentsChrome.ensure} and
 * carries a Download of its own, so both directions cost one press from either surface.
 *
 * The engine holds every attachment's state, mints the Blob URL and RETAINS the typed bytes;
 * `AttachmentStrip` draws it. Neither of them puts a file on somebody's disk, and neither of
 * them can: saving is a DOM act, and the strip is a pure component that takes `onOpen` and asks
 * no questions. This module is that seam, and it exists as its own file for two reasons —
 * `AppShell` is 1 900 lines and does not need more callbacks in it, and every decision below is
 * testable in jsdom without mounting a shell.
 *
 * ── WHY `<a download>` AND NEVER `window.open` ────────────────────────────────────────────
 *
 * A `blob:` URL INHERITS THE APP'S ORIGIN. Navigating to one at top level therefore runs
 * whatever the document contains as `ohmail.app`, with the host-only session cookie in
 * scope — and an `image/svg+xml` attachment is a document that executes script. The route's
 * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` describe the
 * RESPONSE and do not survive into a Blob built from its body, so they do not help here.
 *
 * The engine already closes this at the point the Blob is minted (`RENDERABLE_MIME` — an SVG
 * comes back typed `application/octet-stream`). This is the second ring, and it is a
 * different mechanism rather than the same one twice: `download` makes the browser SAVE
 * whatever it is handed instead of rendering it, so the file never becomes a document in a
 * tab whatever its type says. Both rings are cheap; the attack this forecloses is a stranger
 * mailing you a file.
 *
 * ── WHY A SEPARATE SUBSCRIPTION AND NOT `useEngineVersion` ────────────────────────────────
 *
 * `useEngineVersion` reads `engine.read().version()`, which is `store.version()` composed
 * with the overlay revision. Attachment state is IN-MEMORY ONLY — the whole design is that
 * ohmail stores no attachment bytes, so nothing is written to the mirror and neither of those
 * two numbers moves. `notify()` fires, `useSyncExternalStore` compares the snapshot, finds it
 * identical and BAILS OUT: the strip would sit on `idle` for ever while the bytes arrived
 * behind it, and every test that drives the engine directly would still pass. That is this
 * slice's own failure mode, one layer up, so the subscription counts notifications rather
 * than reading a version that cannot change.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { threadOf, type OhmailEngine } from "@ohmail/client-engine";
import { isAuthListFailure, type AttachmentItem, type AttachmentsView } from "../components/AttachmentStrip";
import { desktopAttachmentsEnabled, openAttachmentWithSystemViewer } from "./open-attachment";
import { probeSessionNow, subscribeSessionRevival } from "./session-truth";

/**
 * What `MessagePane` needs to render one message's strip.
 *
 * Functions of `messageId` rather than resolved values, for the reason every other member of
 * {@link import("./message-chrome").MessageChrome} is: the pane is mounted TWICE while the
 * reader is open and the two mounts may hold different messages.
 */
export interface AttachmentsChrome {
  /**
   * THE LIST AND WHAT IS KNOWN ABOUT IT — the engine's outcome, not a flattened array.
   *
   * ## THE DEFECT, AND THE ONE LINE IT WAS
   *
   * This used to read `held.state === "ready" ? held.items : []`. `unavailable`, `loading` and
   * `failed` all became the same empty array, so a metadata read that FAILED drew exactly what
   * an inline-only message draws — nothing, under a paperclip painted from `hasAttachments`.
   * Two different sentences, one silence, and the failing one invisible.
   *
   * The engine had recorded the failure the whole time (`AttachmentsOutcome`, with the server's
   * `code` and `retryable`), and it already refuses to re-ask automatically so that a
   * React effect cannot loop against a server that refused. What was missing was here: the seam
   * threw the answer away. It no longer does, and {@link AttachmentsView} is the strip's own
   * type, so the wire `MessagePane` already passes carries the state without that file changing.
   *
   * ## `includeInlineImages` — WHAT THE READER CAN SEE DECIDES WHAT THE LIST HOLDS
   *
   * Files only, unless the caller says it is drawing the frameless rendering. The engine's own
   * note on {@link OhmailEngine.attachmentsOf} carries the argument; the reason it is a PARAMETER
   * here rather than a setting is that the answer changes per message and per press — a reader can
   * put any prose message back into its sender's own rendering, and the moment they do, its
   * pictures are on screen again and listing them would name each one twice.
   */
  itemsOf(messageId: string, opts?: { includeInlineImages?: boolean }): AttachmentsView;
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
   * TAKES THE SAME `includeInlineImages` AS {@link itemsOf}, and must be passed the same value.
   * "Download all" is a promise about the strip standing in front of the reader — the head even
   * counts it — so a press that enumerated a different list than the one on screen would save a
   * different number of files than the sentence beside the button just claimed.
   */
  downloadAll(messageId: string, opts?: { includeInlineImages?: boolean }): void;
  downloadingAll(messageId: string): boolean;
  /**
   * THE EMBEDDED IMAGES ALREADY IN HAND for one message — `contentId → data: URI`, straight off
   * the engine (`inlineImagesOf`). Identity-stable between arrivals, so `MessageBody` can hang
   * its sanitize memo on it. Empty until {@link needCidImages} has fetched something.
   */
  cidImagesOf(messageId: string): ReadonlyMap<string, string>;
  /**
   * ASK for the embedded parts a framed rendering is showing as blanked boxes — the Content-IDs
   * come from the renderer's own pass over the sanitized document. Fire-and-forget: arrival is
   * an engine notification, which re-renders the shell and hands a grown map back down through
   * {@link cidImagesOf}. Budgets, single-flight and the no-retry-after-refusal rule all live in
   * the engine (`loadInlineImages`); calling this again with the same ids is a cheap no-op.
   */
  needCidImages(messageId: string, contentIds: string[]): void;
  /**
   * THE CALENDAR TEXTS ALREADY IN HAND for one message — `attachmentId → decoded ics text`,
   * straight off the engine (`calendarTextsOf`). What the strip's event card parses and draws.
   * Filled automatically when the message's list loads (the same effect that loads the list
   * asks — budgets and single-flight live in the engine, `loadCalendarTexts`); empty until
   * then, and empty is the strip's signal to keep the plain tile standing.
   */
  calendarTextsOf(messageId: string): ReadonlyMap<string, string>;
}

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
 * DELIVER ONE FILE, by whichever route this window actually has.
 *
 * ── WHY THIS IS NOT ONE LINE ────────────────────────────────────────────────────────────────
 *
 * In a browser tab {@link saveObjectUrl} is the whole answer. In the desktop window it is answered
 * "no": the `download` attribute asks the webview to turn the navigation into a download, and a
 * webview whose host registered no download handler CANCELS it — silently, with no error anywhere,
 * which is why every attachment press in the app did nothing. `open-attachment.ts` carries the
 * mechanism and the reasoning; this is the one place either route is chosen.
 *
 * The desktop arm NEVER falls back to the anchor. A fallback would be a second silent no-op behind
 * a fix for the first, and the two are not interchangeable: the anchor there is not a slower way to
 * the same file, it is nothing at all.
 *
 * `blob` is the engine's RETAINED typed Blob for the item — the same bytes the object URL points
 * at, minted together so the two cannot diverge ({@link OhmailEngine.attachmentBlobOf}). It is
 * optional because the object URL is the older half of that pair and a caller may hold one without
 * the other; without bytes there is nothing to hand a viewer, so the anchor is all that is left and
 * it is used even on the desktop, where it does what it has always done.
 */
export function deliverFile(
  blob: Blob | undefined,
  url: string,
  filename: string,
  doc: Document,
): void {
  if (desktopAttachmentsEnabled() && blob) {
    void openAttachmentWithSystemViewer(blob, filename);
    return;
  }
  saveObjectUrl(url, filename, doc);
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
 * `includeInlineImages` unconditionally, and that is not the same decision the LIST makes. This
 * resolves an id the caller already holds — it came from a tile the strip drew — so the question
 * is "which part is this", not "what should be shown". Asking the filtered way would make a press
 * on a picture in a frameless rendering find nothing and silently do nothing.
 */
function itemOf(engine: OhmailEngine, messageId: string, attachmentId: string): AttachmentItem | undefined {
  const held = engine.attachmentsOf(messageId, { includeInlineImages: true });
  if (held.state !== "ready") return undefined;
  return held.items.find((i) => i.id === attachmentId);
}

/**
 * Re-render this component on every engine notification, version bump or not.
 *
 * See the header: attachment state moves without the mirror moving, so
 * `useEngineVersion` cannot see it. The counter is a ref because `getSnapshot` must return
 * the same value until something actually changes, and a `useState` setter inside a
 * subscription is one render behind.
 */
function useEngineNotice(engine: OhmailEngine): number {
  const ticks = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) =>
      engine.subscribe(() => {
        ticks.current += 1;
        onChange();
      }),
    [engine],
  );
  return useSyncExternalStore(subscribe, () => ticks.current, () => 0);
}

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
 * Wire the selected message's attachments — and its whole CONVERSATION's — to the shell.
 *
 * Returns `undefined` when this client cannot open attachments at all — the demo (`?demo=1`
 * is fixtures and zero network) and any host whose adapter lacks the capability. `undefined`
 * is a REAL answer and the pane reads it as one: no strip, rather than a "Download all"
 * button over an archive nothing can build.
 *
 * ── THE CLEANUP IS NOT OPTIONAL ───────────────────────────────────────────────────────────
 *
 * `releaseAttachments` revokes every object URL held for a message. A `blob:` URL pins its
 * bytes until it is revoked or the document dies, so without this a session spent opening
 * PDFs in a long-lived tab accumulates every one of them — the exact cost "ohmail stores no
 * attachment bytes" exists to avoid, reintroduced in the browser instead of the database.
 * The release set is the selection's whole ask — focused message and thread siblings alike.
 */
export function useMessageAttachments(
  engine: OhmailEngine,
  messageId: string | null,
  opts: { onDownloadAllFailed: () => void },
): AttachmentsChrome | undefined {
  const available = engine.attachmentsAvailable();
  useEngineNotice(engine);
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

  /**
   * Every id whose list THIS selection asked for — the RELEASE SET. The selected message and
   * its conversation siblings all land here, and the selected-id effect's cleanup releases the
   * whole set: one owner for the lifecycle, however many panels asked. A ref rather than state
   * because it is bookkeeping the render must never see — reading it in render would make the
   * release set a render input, which it is not.
   */
  const loaded = useRef<Set<string>>(new Set());

  /** The one ask, with everything an ask entails — the probe escalation and the calendar pass. */
  const ask = useCallback(
    (id: string): Promise<void> => {
      // Metadata only: `cost: "read"`, one indexed row read, nothing reaches IMAP. The bytes
      // are a separate, deliberate act — never speculative, never per row, because a paid fetch
      // needs a person behind it.
      //
      // An AUTH-shaped failure is escalated to the session probe: the reader is looking at this
      // message right now, and "unauthorized" from our own envelope is exactly the evidence the
      // probe exists to settle — one single-flight `POST /auth/refresh` whose answer either heals
      // the session silently (and the revival below re-asks this list) or confirms the death that
      // puts the real re-auth prompt on screen. A no-op wherever no probe is registered.
      return engine.loadAttachments(id).then((outcome) => {
        /*
         * A COMPLETION THAT OUTLIVED ITS SELECTION IS RE-RELEASED, NOT ACTED ON. The engine
         * does not cancel a list read on release — the late outcome is written back to its
         * held map regardless — so a reader who left the thread before a slow response landed
         * would keep that list (and the calendar pass below would then fetch BYTES) with no
         * cleanup left to sweep it: the release already ran. The release set is the truth
         * about what the CURRENT selection wants; an id no longer in it answers to nobody.
         * The within-thread move survives this exactly: its cleanup clears the set and the
         * re-run re-adds the id before any completion can land, so the (single-flighted,
         * shared) outcome finds the id wanted and stands (review finding).
         */
        if (!loaded.current.has(id)) {
          engine.releaseAttachments(id);
          return;
        }
        if (outcome.state === "failed" && isAuthListFailure(outcome.code)) probeSessionNow();
        // A meeting invitation should be readable, not merely saveable: fetch the message's
        // calendar parts (tiny, budgeted, single-flight — the engine owns all three bounds) so
        // the strip can draw the event card. Fire-and-forget for the reason needCidImages is.
        if (outcome.state === "ready" && outcome.items.length > 0) void engine.loadCalendarTexts(id);
      });
    },
    [engine],
  );

  useEffect(() => {
    if (!available || !messageId) return;
    loaded.current.add(messageId);
    void ask(messageId);
    return () => {
      // The whole selection's worth — the focused message AND every sibling the effect below
      // asked for. `releaseAttachments` itself declines to drop a live sent-copy seed, so
      // sweeping the set is safe against the optimistic-copy lifecycle.
      for (const id of loaded.current) engine.releaseAttachments(id);
      loaded.current.clear();
    };
  }, [engine, messageId, available, ask]);

  /**
   * ── THE SIBLINGS' LISTS — a thread's panels all show their files, not only the focused one ──
   *
   * Every message on an open conversation renders as a full panel with its own attachment strip
   * (`MessageCard` — a reader's own SENT reply inside a thread was the found case: ingested from
   * the Sent folder with two files on the row, rendered as a sibling panel with no strip and no
   * ask). The strip reads `itemsOf(id)`, which is engine STATE — so somebody has to ask, and the
   * asker is here rather than in the card because the card is mounted twice while the reader is
   * open (the mounted-twice rule the whole chrome exists for) and an unmount-time release from
   * one mount would revoke URLs the other mount is still showing. One owner, this hook, mounted
   * once in `AppShell`.
   *
   * Keyed on `messageId` AND the conversation's id list: the id list alone would skip the re-ask
   * after a WITHIN-thread selection move (same conversation, so same key, while the cleanup above
   * has already released everything), and `messageId` alone would miss a sibling ARRIVING on the
   * open thread mid-read (a drain landing the counterpart of a reply). The `loaded` guard makes
   * the overlap of those two triggers idempotent, and the engine's own single-flight makes even a
   * double ask one request.
   *
   * `threadOf` is read per render against the live mirror — fresh by the same argument as
   * `conversationOf` in `AppShell` — and joined to a primitive so the effect compares by value.
   */
  const conversationKey =
    available && messageId
      ? threadOf(engine.read(), messageId)
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
  const listWorkers = useRef(0);
  const pump = useCallback((): void => {
    while (listWorkers.current < SIBLING_LIST_CONCURRENCY && pendingLists.current.length > 0) {
      listWorkers.current += 1;
      void (async () => {
        try {
          for (;;) {
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
            await ask(id);
          }
        } finally {
          listWorkers.current -= 1;
        }
      })();
    }
  }, [ask]);

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
   * ── A SESSION FAILURE MUST NOT OUTLIVE THE SESSION IT FAILED IN ──────────────────────────
   *
   * The engine holds a `failed` list for the life of the engine and deliberately refuses the
   * automatic re-ask (`loadAttachments` — the render-loop argument). Right for a server that
   * REFUSED the content; wrong for one that refused the SESSION, because that refusal expires
   * the moment a refresh mints a new one — and it did not: one 401'd metadata read during an
   * auth outage kept "Couldn't load this message's files." on the message for the whole
   * session, with the same endpoint answering 200 beside it. Observed in live use.
   *
   * So the seam listens for revivals — each one a real 204 from `/auth/refresh`, a
   * server-confirmed new session — and re-asks THEN, exactly when the held failure's cause is
   * known to be gone. Bounded twice over: revivals are at most one per successful refresh, and
   * the re-ask fires only while the held state is a failure whose `code` names the session.
   * The release first is what makes the re-ask a fresh question rather than the refused
   * answer served from memory.
   */
  useEffect(() => {
    if (!available || !messageId) return;
    return subscribeSessionRevival(() => {
      // The whole release set, not the focused id alone: a sibling panel's list 401s the same
      // way the focused one does, and a revival that healed one strip while its neighbour kept
      // "Your session ended" would be the original defect kept on the panels added since.
      for (const id of loaded.current) {
        const held = engine.attachmentsOf(id);
        if (held.state !== "failed" || !isAuthListFailure(held.code)) continue;
        engine.releaseAttachments(id);
        void engine.loadAttachments(id);
      }
    });
  }, [engine, messageId, available]);

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
    (id: string, opts: { includeInlineImages?: boolean } = {}): AttachmentsView => {
      const held = engine.attachmentsOf(id, opts);
      switch (held.state) {
        case "unavailable":
          return { state: "unavailable" };
        case "loading":
          return held.retrying ? { state: "loading", retrying: true } : { state: "loading" };
        case "ready":
          return { state: "ready", items: held.items };
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
        // `too_large` is permanent — the strip renders it as a div rather than a button for
        // exactly this reason, and a programmatic call must agree with the pixels.
        if (!before || before.state === "too_large") return;

        if (before.state !== "ready" || !before.objectUrl) {
          // `retry` ONLY on a press over a failed tile. The engine deliberately refuses an
          // automatic re-ask (a React effect whose identity changes per render would loop
          // against a server that already refused, at `cost: "connection"` a time) — and the
          // failed tile's own words are "Couldn't fetch — try again", so a press that did
          // not re-ask would make that sentence a lie.
          await engine.openAttachment(id, attachmentId, before.state === "failed" ? { retry: true } : {});
        }

        const after = itemOf(engine, id, attachmentId);
        // Nothing to save on `failed` or `too_large`: the tile carries the server's own
        // sentence and a silent no-op here is what lets it be read. `too_large` is also the
        // reason nothing over the fetch ceiling can reach the desktop's file write — such a part
        // never has bytes in the window, and the early return above refuses the press outright.
        if (after?.state === "ready" && after.objectUrl) {
          deliverFile(engine.attachmentBlobOf(id, attachmentId), after.objectUrl, after.filename, document);
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
      void engine.openAttachment(id, attachmentId, opts.retry ? { retry: true } : {});
    },
    [engine],
  );

  const blobOf = useCallback(
    (id: string, attachmentId: string): Blob | undefined => engine.attachmentBlobOf(id, attachmentId),
    [engine],
  );

  const cidImagesOf = useCallback(
    (id: string): ReadonlyMap<string, string> => engine.inlineImagesOf(id),
    [engine],
  );

  const calendarTextsOf = useCallback(
    (id: string): ReadonlyMap<string, string> => engine.calendarTextsOf(id),
    [engine],
  );

  const needCidImages = useCallback(
    (id: string, contentIds: string[]): void => {
      // Fire-and-forget on purpose: the outcome is not a return value but an engine
      // notification, and `loadInlineImages` never rejects — its caller is a render effect.
      void engine.loadInlineImages(id, contentIds);
    },
    [engine],
  );

  /**
   * ── DOWNLOAD ALL — N FILES, NOT ONE ARCHIVE ──────────────────────────────────────────────
   *
   * This used to fetch the server-assembled zip and save it under the server's own name. The
   * route still exists and `engine.downloadAllAttachments` still calls it; what changed is that
   * the webapp no longer uses it, and the reason is what the reader is left holding.
   *
   * A zip is a container somebody now has to deal with. Pressing "Download all" on three PDFs
   * and getting `attachments-<uuid>.zip` means finding it, expanding it, and then dealing with
   * three PDFs anyway — plus a folder named after a message id that means nothing to anybody.
   * What the press asked for was the FILES, so that is what it produces: three downloads, under
   * their own names, in the same place every other download goes.
   *
   * It also removes the archive's one dishonesty. The zip may legitimately be missing parts —
   * the server skips what it cannot fetch and names them in an `_errors.txt` INSIDE the archive
   * — so the saved file looked complete and the explanation was hidden in it. Per file, a part
   * that could not be fetched is a `failed` tile in the strip, in front of the reader, with the
   * server's own sentence on it.
   *
   * ── THE COST, STATED RATHER THAN DISCOVERED ────────────────────────────────────────────
   *
   * One IMAP fetch per file instead of one for the set. `engine.downloadAllAttachments`'s own
   * comment is right that N files can mean N conversations with the user's mail server, and
   * providers throttle exactly that pattern. Two things make it affordable here: the prefetch is
   * SEQUENTIAL, so the server sees one request at a time rather than a burst; and a message
   * carries a handful of attachments, not hundreds. An attachment already fetched is skipped
   * entirely — `openAttachment` returns early on a `ready` item — so pressing this after opening
   * two of three files costs one request.
   *
   * ── THE SAVES ARE ONE SYNCHRONOUS LOOP, AND THAT IS NOT A STYLE CHOICE ─────────────────
   *
   * Every anchor click happens in the same task, with no `await` between them. Browsers treat a
   * run of programmatic downloads as one act and ask about it once; spacing them across tasks
   * turns one "Download multiple files?" prompt into several, or gets the later ones dropped
   * silently. So all the waiting happens first, and then nothing waits.
   */
  const downloadAll = useCallback(
    (id: string, opts: { includeInlineImages?: boolean } = {}): void => {
      void (async () => {
        setDownloadingAll((prev) => {
          const next = new Set(prev);
          next.add(id);
          return next;
        });
        try {
          const held = engine.attachmentsOf(id, opts);
          if (held.state !== "ready" || held.items.length === 0) {
            // No metadata means nothing to enumerate. The strip is already saying why — the
            // list carries its own failure state — so this is the one case the toast would only
            // repeat. It is still reported, because the press did nothing, and a press that
            // does nothing without saying so is the failure this callback exists for.
            onFailed.current();
            return;
          }

          // `too_large` is permanent — the server refused at its ceiling — so it is not asked
          // for. `failed` IS re-asked: a press of the group verb is a human act, which is the
          // only thing that may re-drive a `cost:"connection"` fetch the server already refused.
          const wanted = held.items.filter((i) => i.state !== "too_large");
          for (const item of wanted) {
            await engine.openAttachment(id, item.id, item.state === "failed" ? { retry: true } : {});
          }

          // RE-READ, never the pre-fetch snapshot: `wanted` holds the states as they were before
          // any of this ran, and saving from it would mean saving a stale `objectUrl` — or none.
          // Same `opts` as the enumerate above: a re-read that widened the list would save a file
          // this press never fetched, and one that narrowed it would drop one it did.
          const after = engine.attachmentsOf(id, opts);
          const saved = after.state === "ready"
            ? after.items.filter((i) => i.state === "ready" && i.objectUrl)
            : [];

          // ── the synchronous half. No `await` may appear inside this loop. ──
          //
          // `deliverFile` keeps that property on both routes: the browser arm is the same
          // synthetic click it always was, and the desktop arm hands each file to the shell
          // without waiting for it — the shell answers each on its own thread, and a loop that
          // awaited them would open the viewers one at a time over the length of the slowest.
          for (const item of saved) {
            deliverFile(engine.attachmentBlobOf(id, item.id), item.objectUrl!, item.filename, document);
          }

          // Reported only when NOTHING could be saved. A partial result needs no toast: every
          // file that could not be fetched is a `failed` tile carrying the server's own sentence,
          // which is more than a toast could say and is attached to the file it is about.
          if (saved.length === 0) onFailed.current();
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

  /**
   * ONE OBJECT, not a fresh literal per render.
   *
   * `AppShell` puts this straight into the `chrome` memo, and a value that changed identity on
   * every render would defeat that memo entirely — every consumer of `MessageChromeContext`
   * re-rendering on every keystroke in the reply editor. It changes exactly when something a
   * consumer can see changes: the engine, or whether a zip is in flight.
   */
  const chrome = useMemo(
    (): AttachmentsChrome => ({
      itemsOf, open, ensure, blobOf, downloadAll, downloadingAll: downloadingAllOf,
      cidImagesOf, needCidImages, calendarTextsOf,
    }),
    [itemsOf, open, ensure, blobOf, downloadAll, downloadingAllOf, cidImagesOf, needCidImages, calendarTextsOf],
  );

  return available ? chrome : undefined;
}

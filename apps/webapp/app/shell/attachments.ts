"use client";

/**
 * A press becomes a file. Pressing an attachment saves it, whatever it is
 * ({@link AttachmentsChrome.open}); looking first is a separate control offered only on drawable
 * types, wired in `MessagePane` to `openAttachmentPreview`. The engine holds every attachment's
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
   * The list and what is known about it — the engine's outcome, not a flattened array. This used to
   * read `held.state === "ready" ? held.items : []`: `unavailable`, `loading` and `failed` all became
   * the same empty array, so a failed metadata read drew exactly what an inline-only message draws —
   * nothing, under a paperclip painted from `hasAttachments`. The engine had recorded the failure all
   * along (`AttachmentsOutcome`, with `code` and `retryable`); the seam threw it away, and no longer
   * does. `includeInlineImages`: files only, unless the caller says it is drawing the frameless
   * rendering — a parameter, not a setting, because the answer changes per message and per press
   * (restored sender rendering puts pictures back on screen, and listing them would name each twice).
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
 * Deliver one file, by whichever route this window actually has. In a browser tab
 * {@link saveObjectUrl} is the whole answer; in the desktop window the `download` attribute asks the
 * webview to turn the navigation into a download, and a webview whose host registered no handler
 * cancels it silently — every attachment press did nothing. `open-attachment.ts` carries the
 * mechanism; this is the one place either route is chosen, and the desktop arm never falls back to
 * the anchor (there it is not a slower route, it is nothing at all). `blob` is the engine's retained
 * typed Blob, minted with the object URL so the two cannot diverge
 * ({@link OhmailEngine.attachmentBlobOf}); without bytes the anchor is all that is left.
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

  /**
   * The engine THIS COMMIT serves — read by completions and by the standing crew, because both
   * can outlive the commit (and the engine) they were minted under. See `ask` and `pump`.
   * Published in an effect below, never during render: a concurrent render can be abandoned
   * after running, and a render-time assignment would point live workers at an engine no
   * commit ever produced — or let an abandoned render's completion release state the
   * committed tree still renders (review finding).
   */
  const engineRef = useRef(engine);

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
        if (engineRef.current !== engine || !loaded.current.has(id)) {
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
   * The siblings' lists — a thread's panels all show their files, not only the focused one
   * (`MessageCard`; the found case was a reader's own sent reply rendered with no strip). The strip
   * reads `itemsOf(id)`, engine state, so somebody has to ask — and the asker is here, not the card,
   * because the card is mounted twice while the reader is open and an unmount-time release from one
   * mount would revoke URLs the other is showing. One owner, this hook, mounted once in `AppShell`.
   * Keyed on `messageId` AND the conversation's id list: the list alone skips the re-ask after a
   * within-thread move, `messageId` alone misses a sibling arriving mid-read; the `loaded` guard and
   * the engine's single-flight make the overlap one request. `threadOf` joins to a primitive.
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
  }, [engine, ask]);
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
   * Download all — N files, not one archive. The server-assembled zip route still exists
   * (`engine.downloadAllAttachments`); the webapp no longer uses it. A zip is a container somebody now
   * has to deal with, named after a message id, and it hid the archive's one dishonesty: parts the
   * server could not fetch were named in an `_errors.txt` inside it, so the saved file looked complete
   * — per file, a failed part is a `failed` tile in the strip with the server's own sentence. The cost
   * is one IMAP fetch per file, affordable because the prefetch is sequential and an already-`ready`
   * item is skipped. The saves are one synchronous loop, no `await` between anchor clicks: browsers
   * treat the run as one act and ask once — spacing it across tasks drops the later downloads.
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

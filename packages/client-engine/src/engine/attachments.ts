import { calendarPartRank } from "@trafficflow/core/ics";
import type { ScheduleFilesAnswer } from "../adapters/adapter.js";
import { attachmentFaultClass } from "../attachment-fault.js";
import { retypedBlob } from "../bytes-blob.js";
import { LANE_DROPPED } from "../part-lane.js";
import { type EngineMessage, MutationRejectedError } from "../types.js";
import { REASK_MAX, wireFailed } from "../wire-reask.js";
import {
  type AttachmentItem, type AttachmentsOutcome, CALENDAR_TEXT_MAX_BYTES, CALENDAR_TEXT_MAX_PARTS,
  INLINE_IMAGE_MAX_BYTES, INLINE_IMAGE_MAX_PARTS, INLINE_IMAGE_MAX_TOTAL_BYTES, INLINE_IMAGE_MIME,
  inlineImageBytesAdmitted, isCalendarItem, mintInlineDataUrl, NO_CALENDAR_TEXTS, NO_INLINE_IMAGES, NO_RETRY,
  PART_REASK_DELAYS_MS, RENDERABLE_MIME, STAGED_PREVIEWS_KEPT, type StagedPreview, toAttachmentItem,
} from "./attachment-items.js";
import { EngineHydration } from "./hydration.js";

export abstract class EngineAttachments extends EngineHydration {
  // ── attachments ──────────────────────────────────────────────────────────

  /**
   * Can this client open attachments at all?
   *
   * `false` for the demo (`?demo=1` is fixtures and zero network), where the
   * paperclip must not offer a control that cannot work. Resolved from the adapter's own optional
   * capability, so it cannot disagree with what the methods below will do.
   */
  /** Does the sending server honour a forward's kept files? `null`: no answer, or an adapter that cannot ask. */
  async forwardPartsAnnounced(): Promise<boolean | null> {
    const ask = this.adapter.forwardPartsAnnounced;
    if (typeof ask !== "function") return null;
    try {
      return await ask.call(this.adapter);
    } catch {
      return null;
    }
  }

  /** Does the scheduling server keep a letter's files for a later send, and how far ahead? `null`: no answer, or an adapter that cannot ask. */
  async scheduleFilesAnnounced(): Promise<ScheduleFilesAnswer | null> {
    const ask = this.adapter.scheduleFilesAnnounced;
    if (typeof ask !== "function") return null;
    try {
      return await ask.call(this.adapter);
    } catch {
      return null;
    }
  }

  attachmentsAvailable(): boolean {
    return typeof this.adapter.listAttachments === "function"
      && typeof this.adapter.fetchAttachment === "function";
  }

  /**
   * What the surface renders RIGHT NOW for one message. Synchronous, no side effects — separate from {@link
   * OhmailEngine.loadAttachments} because React renders far more often than it should fetch: the render path reads
   * state, the effect path asks. `includeInlineParts`: the default is FILES ONLY, what a caller asking "does this
   * message carry an attachment" has always got. A reader's strip asks WITH the flag and gets EVERY part — inline
   * pictures the body paints, and the residue a `cid:` promotion can hide (a PDF the html references is `inline`
   * and would otherwise be listed nowhere, which is the data-loss direction `mime.ts` refuses). Same fetch, size
   * ceiling, preview gate and download; the flag widens what is LISTED and nothing else.
   */

  /**
   * Filtering here rather than at ingest keeps both answers available at once.
   */
  attachmentsOf(messageId: string, opts: { includeInlineParts?: boolean } = {}): AttachmentsOutcome {
    if (!this.attachmentsAvailable()) return { state: "unavailable" };
    const held = this.attachmentLists.get(messageId) ?? { state: "loading" as const };
    if (held.state !== "ready") return held;
    const shown = held.items.filter((item) => !item.inline || opts.includeInlineParts === true);
    // Identity preserved when nothing is withheld — the common case is a message with no inline
    // parts at all, and a fresh object per render for it would be churn with no reader.
    return shown.length === held.items.length ? held : { state: "ready", items: shown };
  }

  /**
   * The FETCHED BYTES of one ready attachment — the type-downgraded Blob the object URL was
   * minted from — or `undefined` when it has not been fetched yet.
   *
   * A preview surface reads this to parse a PDF (`blob.arrayBuffer()`) or a text part
   * (`blob.text()`) WITHOUT re-fetching the object URL. See {@link AttachmentItem.blob} for why
   * a re-fetch is not an option and why this is the post-downgrade blob, not the wire one.
   */
  attachmentBlobOf(messageId: string, attachmentId: string): Blob | undefined {
    return this.itemOf(messageId, attachmentId)?.blob;
  }

  /**
   * Read one message's attachment METADATA — filenames, types, sizes; no bytes, no IMAP (`cost: "read"`, an indexed
   * row read, which is what makes it acceptable on open). Inline parts are kept here and withheld at the read: `cid:`
   * images the html references used to be dropped in this method — right about what a FILE is, wrong about what a
   * picture is, because the frameless rendering draws no images at all and the drop made a sent picture unreachable
   * from anywhere in the product. The list keeps every part and {@link OhmailEngine.attachmentsOf} decides. The
   * paperclip agrees: `hasAttachments` derives from REAL FILES at ingest (`mime.ts` `isRealFile`), the backfill
   * corrected old rows, and the residual is a pre-signal row whose signature logo sits under `multipart/mixed` — a
   * fact about stored rows, not this method.
   */

  /**
   * Every return goes through `attachmentsOf` with no options, so an untaught caller gets exactly the old list. Never
   * rejects: single-flight per message, the failure a value the UI renders.
   */
  async loadAttachments(messageId: string, opts: { retry?: boolean } = {}): Promise<AttachmentsOutcome> {
    const list = this.adapter.listAttachments;
    if (!list || !this.attachmentsAvailable()) return { state: "unavailable" };

    /*
     * A FORWARD'S SENT COPY DELEGATES TO ITS PARENT. The copy's id was minted client-side and
     * exists on no server — a wire read against it can only 404 — while the parent's id is real
     * and its list names the exact parts the forward streamed. So the copy's read (the pane's
     * mount effect, and its strip's own Retry) is answered by reading the PARENT and composing:
     * a held-ready copy answers directly, a retry re-asks the parent under the same human-press
     * rule every retry obeys, and the composed outcome — including a carried failure — is what
     * the copy's surface renders. See {@link recomposeForwardSeed}.
     */
    const seed = this.sentAttachmentSeeds.get(messageId);
    if (seed?.forwardOf) {
      const held = this.attachmentLists.get(messageId);
      if (held?.state !== "ready") {
        await this.loadAttachments(seed.forwardOf, opts);
        if (this.recomposeForwardSeed(messageId)) this.notify();
      }
      return this.attachmentsOf(messageId);
    }

    const inFlight = this.attachmentListRequests.get(messageId);
    if (inFlight) return inFlight.then(() => this.attachmentsOf(messageId));

    const held = this.attachmentLists.get(messageId);
    // Already answered. Re-reading would discard the per-item byte state (`ready` object URLs and
    // all) for a list that cannot have changed — attachments are immutable parts of a stored message.
    if (held && held.state === "ready") return this.attachmentsOf(messageId);
    // See `hydrateBody`'s `retry` note: an automatic trigger must not re-ask a server that refused,
    // or a React effect whose identity changes per render loops against it for as long as the view
    // is open. A human pressing Retry passes `retry`.
    if (held && held.state === "failed" && !opts.retry) return held;

    // `retrying` marks a HUMAN re-ask over a failure, and nothing else: the first ask of a
    // message must stay `{ state: "loading" }` with the field absent, because that is the state
    // the surface renders as silence.
    const retrying = opts.retry === true && held?.state === "failed";
    this.attachmentLists.set(messageId, retrying ? { state: "loading", retrying: true } : { state: "loading" });
    this.notify();

    const request = list.call(this.adapter, messageId)
      .then((wire): AttachmentsOutcome => {
        return { state: "ready", items: wire.map(toAttachmentItem) };
      })
      // The adapter's own classification, kept. `MutationRejectedError` is the one thing `HttpAdapter` throws, and it
      // throws it for THREE reasons: a non-2xx (`rejectionOf`: the server's code, and `retryable` defaulted from the
      // status), a fetch that rejected outright (`code: "network"`), and — since the read was given a deadline — a
      // request that answered nothing at all inside `ATTACHMENT_LIST_TIMEOUT_MS` (`code: "timeout"`, `retryable:
      // true`, raised by `HttpAdapter.withDeadline`, which aborts the request as it throws). That third one is why
      // this catch exists at all now: before it, a hung read never reached here, the outcome stayed `loading`, and
      // the surface drew nothing for ever. Anything else reaching here is unclassified, and unclassified means we
      // never established that the server refused, so asking again is honest. See {@link AttachmentsOutcome}.
      .catch((err: unknown): AttachmentsOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof MutationRejectedError ? err.code : null,
        retryable: err instanceof MutationRejectedError ? err.retryable : true,
      }))
      .then((outcome) => {
        this.attachmentLists.set(messageId, outcome);
        this.notify();
        // A list that answers after the letter's pictures were asked for (a re-ask, a Retry) draws them.
        if (outcome.state === "ready") this.healInlineImages(messageId, true);
        return outcome;
      })
      .finally(() => {
        this.attachmentListRequests.delete(messageId);
      });

    this.attachmentListRequests.set(messageId, request);
    // The RECORD keeps every part (`request` resolves to it); what this returns is the files view.
    return request.then(() => this.attachmentsOf(messageId));
  }

  /**
   * FETCH ONE ATTACHMENT'S BYTES from the user's IMAP mailbox and mint a Blob URL for it. `cost: "connection"` — this
   * opens a real IMAP connection to somebody's mail server, which is the most expensive read in the product. So it
   * fires on an explicit human act only: a click on that file. Never on render, never on selection, never
   * speculatively for a strip. Never rejects (the caller is a click handler). The outcome is the item's `state`:
   * · `too_large` — the server refused at its size ceiling (`payload_too_large`). A distinct state, not a failure,
   *   because the answer is permanent and a Retry button would be a lie.
   * · `failed`    — anything else, carrying the server's own sentence.
   * Single-flight per message and attachment: a double-click is one fetch, not two IMAP connections.
   */

  /**
   * (Per MESSAGE, because a forward's copy lists its parent's parts under the same ids — see the note at the flight
   * key.)
   */
  async openAttachment(messageId: string, attachmentId: string, opts: { retry?: boolean } = {}): Promise<void> {
    return this.fetchPartBytes(messageId, attachmentId, { retry: opts.retry });
  }

  /** The mailbox a letter's byte asks wait in line for. */
  protected laneKeyOf(messageId: string): string {
    return this.store.get<EngineMessage>("message", messageId)?.mailboxId ?? "*";
  }

  /** {@link openAttachment}'s work; `auto` for an embedded picture or an invitation nobody pressed. */
  protected async fetchPartBytes(
    messageId: string, attachmentId: string, opts: { retry?: boolean; auto?: boolean },
  ): Promise<void> {
    const fetchOne = this.adapter.fetchAttachment;
    if (!fetchOne) return;

    // PER MESSAGE, not per attachment id alone: a forward's sent copy lists the parent's parts
    // under their own ids, so the same id legitimately stands in two message lists at once. A
    // flight keyed by the bare id would hand the second list the FIRST list's promise — whose
    // completion patches only the first list — and the press on the copy would silently move
    // nothing out of `idle`. The cost is one possible duplicate fetch of the same part across
    // two messages, which is the rare case; the double-click on one message stays one fetch.
    const flightKey = `${messageId}:${attachmentId}`;
    const inFlight = this.attachmentRequests.get(flightKey);
    if (inFlight) {
      if (!opts.auto) this.partLane.promote(flightKey);
      return inFlight;
    }

    const current = this.itemOf(messageId, attachmentId);
    if (!current) return;
    // Already fetched — the bytes are in hand, nothing to ask for. The blob is the carrier;
    // the URL alone also satisfies (the compose seed holds a URL wherever it holds bytes) unless
    // it is a desktop preview's staged URL, which carries no bytes into this document.
    if (current.state === "ready"
      && (current.blob !== undefined || (current.objectUrl && !this.objectUrls.isAdopted(current.objectUrl)))) return;
    // A refusal at the ceiling cannot become a success by asking again.
    if (current.state === "too_large") return;
    if (current.state === "failed" && !opts.retry) return;

    this.patchAttachment(messageId, attachmentId, {
      state: "loading", error: undefined, code: undefined, retryable: undefined, status: undefined,
    });

    const task = { key: this.laneKeyOf(messageId), messageId, flight: flightKey, kind: opts.auto ? "auto" as const : "press" as const };
    const request = this.partLane.run(task, () => fetchOne.call(this.adapter, attachmentId))
      .then((blob) => {
        // Released while it waited in line: nothing was asked, and nothing is left to patch.
        if (blob === LANE_DROPPED) return;
        // REVOKE BEFORE RE-MINTING. A retry over a `failed` item that had somehow minted a URL,
        // or any second pass, would otherwise leak the old one for the life of the document.
        this.revokeItem(messageId, attachmentId);
        const minted = this.mintObjectUrl(messageId, blob, current.mimeType);
        // The typed Blob is stored UNCONDITIONALLY — it is the byte carrier a preview parses
        // and a phone shares; the URL is the browser convenience, present only where the
        // runtime can mint one. Both are dropped by `releaseAttachments` at once.
        this.patchAttachment(messageId, attachmentId, {
          state: "ready",
          blob: minted.blob,
          ...(minted.url !== undefined ? { objectUrl: minted.url } : {}),
        });
        // THE READER MOVED ON WHILE THE BYTES WERE ON THE WIRE. The release already dropped the
        // list, so the patch above wrote nothing and no entry carries this URL. The ledger still
        // names it — revoke now rather than hold the whole file until the document dies.
        if (minted.url !== undefined && this.itemOf(messageId, attachmentId)?.objectUrl !== minted.url) {
          this.revokeUrl(minted.url);
        }
        // A picture the open letter's document asked for: bytes a press fetched draw in the
        // text too, not on the card alone.
        const asked = current.contentId !== null ? this.inlineImageAsks.get(messageId) : undefined;
        if (asked?.cids.includes(current.contentId!) && !this.inlinePassParts.has(flightKey)) {
          this.healInlineImages(messageId, false);
        }
      })
      .catch((err: unknown) => this.refuseAttachment(messageId, attachmentId, err))
      .finally(() => {
        this.attachmentRequests.delete(flightKey);
      });

    this.attachmentRequests.set(flightKey, request);
    return request;
  }

  /** A fetch's refusal onto its item: `too_large` at the ceiling, else `failed` with the adapter's facts. */
  protected refuseAttachment(messageId: string, attachmentId: string, err: unknown): void {
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "payload_too_large") {
      this.patchAttachment(messageId, attachmentId, { state: "too_large", error: message });
      return;
    }
    // The adapter's classification, kept as the list keeps it: a throw nobody classified never
    // established a refusal, so asking again is honest.
    const rejected = err instanceof MutationRejectedError ? err : null;
    this.patchAttachment(messageId, attachmentId, {
      state: "failed",
      error: message,
      code: rejected ? rejected.code : null,
      retryable: rejected ? rejected.retryable : true,
      status: rejected ? rejected.status : null,
    });
  }

  /**
   * A SAVE THAT NEVER HOLDS THE BYTES: the desktop's, where the shell has the engine stream the part
   * to disk. Same guards and single flight as {@link openAttachment}. An item not yet fetched reads
   * `loading` while `deliver` runs and goes back to `idle`, and a throw lands on it as a fetch refusal
   * would. A `ready` item is one this window shows (a preview, a drawn picture): the save leaves it
   * as it is, as a browser's download leaves the page, and marks it `saving` meanwhile; a throw then
   * answers `opts.refused`, for the press to say. Answers `deliver`'s value, or `undefined` when
   * nothing was asked or it threw.
   */
  async deliverAttachment<T>(
    messageId: string, attachmentId: string, deliver: () => Promise<T>,
    opts: { retry?: boolean; refused?: (err: unknown) => T } = {},
  ): Promise<T | undefined> {
    const flightKey = `${messageId}:${attachmentId}`;
    // A second press during a save is not a second save; a press during a preview's fetch waits for it.
    if (this.attachmentDeliveries.has(flightKey)) return undefined;
    if (this.attachmentRequests.has(flightKey)) this.partLane.promote(flightKey);
    await this.attachmentRequests.get(flightKey);
    if (this.attachmentRequests.has(flightKey) || this.attachmentDeliveries.has(flightKey)) return undefined;
    const current = this.itemOf(messageId, attachmentId);
    if (!current || current.state === "too_large") return undefined;
    if (current.state === "failed" && !opts.retry) return undefined;
    if (current.state === "ready") return this.deliverShown(messageId, attachmentId, deliver, opts.refused);
    this.patchAttachment(messageId, attachmentId, {
      state: "loading", error: undefined, code: undefined, retryable: undefined, status: undefined,
    });
    let answer: T | undefined;
    const request = this.partLane.run(this.pressOn(messageId, flightKey), deliver).then(
      (got) => {
        if (got === LANE_DROPPED) return;
        answer = got;
        this.patchAttachment(messageId, attachmentId, { state: "idle" });
      },
      (err: unknown) => this.refuseAttachment(messageId, attachmentId, err),
    ).finally(() => { this.attachmentRequests.delete(flightKey); this.attachmentDeliveries.delete(flightKey); });
    this.attachmentRequests.set(flightKey, request);
    this.attachmentDeliveries.add(flightKey);
    await request;
    return answer;
  }

  /**
   * {@link deliverAttachment} for a part this window shows. Not a flight of
   * {@link attachmentRequests}: a preview opened again meanwhile (its staged file released) must
   * stage the part, not wait on a save that stages nothing.
   */
  protected async deliverShown<T>(
    messageId: string, attachmentId: string, deliver: () => Promise<T>, refused?: (err: unknown) => T,
  ): Promise<T | undefined> {
    const flightKey = `${messageId}:${attachmentId}`;
    this.attachmentDeliveries.add(flightKey);
    this.patchAttachment(messageId, attachmentId, { saving: true });
    try {
      const got = await this.partLane.run(this.pressOn(messageId, flightKey), deliver);
      return got === LANE_DROPPED ? undefined : got;
    } catch (err) {
      return refused?.(err);
    } finally {
      this.attachmentDeliveries.delete(flightKey);
      this.patchAttachment(messageId, attachmentId, { saving: undefined });
    }
  }

  /**
   * THE DESKTOP'S PREVIEW, WITH NO IMAGE BYTE IN THIS DOCUMENT: `stage` has the shell stream the part
   * to disk and answers a {@link StagedPreview}. Same guards and single flight as
   * {@link openAttachment}. An image item becomes `ready` with the shell's URL as its `objectUrl`
   * (adopted by the ledger, so every release path removes the staged file); a text item with the
   * capped text as its `blob`; an over-cap text with `previewTooLarge`. Never rejects.
   */
  async stageAttachment(
    messageId: string, attachmentId: string, stage: () => Promise<StagedPreview>, opts: { retry?: boolean } = {},
  ): Promise<void> {
    const flightKey = `${messageId}:${attachmentId}`;
    const inFlight = this.attachmentRequests.get(flightKey);
    if (inFlight) {
      this.partLane.promote(flightKey);
      return inFlight;
    }
    const current = this.itemOf(messageId, attachmentId);
    if (!current || current.state === "too_large") return;
    if (current.state === "ready" && (current.blob !== undefined || current.objectUrl || current.previewTooLarge)) return;
    if (current.state === "failed" && !opts.retry) return;
    this.patchAttachment(messageId, attachmentId, {
      state: "loading", error: undefined, code: undefined, retryable: undefined, status: undefined,
    });
    const request = this.partLane.run(this.pressOn(messageId, flightKey), stage)
      .then((staged) => {
        if (staged === LANE_DROPPED) return;
        this.revokeItem(messageId, attachmentId);
        if (staged.kind === "url") {
          this.objectUrls.adopt(messageId, staged.url, staged.release);
          this.patchAttachment(messageId, attachmentId, { state: "ready", objectUrl: staged.url });
          // Released while the shell staged it: nothing carries the URL, so let its file go now.
          if (this.itemOf(messageId, attachmentId)?.objectUrl !== staged.url) this.revokeUrl(staged.url);
          else this.keepStagedPreview(messageId, attachmentId, staged.url);
        } else if (staged.kind === "text") {
          this.patchAttachment(messageId, attachmentId, { state: "ready", blob: staged.text });
        } else {
          this.patchAttachment(messageId, attachmentId, { state: "ready", previewTooLarge: true });
        }
      })
      .catch((err: unknown) => this.refuseAttachment(messageId, attachmentId, err))
      .finally(() => {
        this.attachmentRequests.delete(flightKey);
      });
    this.attachmentRequests.set(flightKey, request);
    return request;
  }

  /**
   * THE WINDOW OWNS THE EVICTION. Past {@link STAGED_PREVIEWS_KEPT} the oldest
   * staged preview is released here and its item put back to `idle`, so a revisit stages it again;
   * the shell's own bound is a larger backstop and never evicts what this list still holds.
   */
  protected keepStagedPreview(messageId: string, attachmentId: string, url: string): void {
    this.stagedPreviews = this.stagedPreviews.filter((p) => this.objectUrls.isAdopted(p.url));
    this.stagedPreviews.push({ messageId, attachmentId, url });
    while (this.stagedPreviews.length > STAGED_PREVIEWS_KEPT) {
      const oldest = this.stagedPreviews.shift()!;
      this.revokeUrl(oldest.url);
      if (this.itemOf(oldest.messageId, oldest.attachmentId)?.objectUrl === oldest.url) {
        this.patchAttachment(oldest.messageId, oldest.attachmentId, { state: "idle", objectUrl: undefined });
      }
    }
  }

  /**
   * The preview overlay closed: release every staged preview this message holds (the shell removes
   * its files) and put those items back to `idle`, so a re-open stages again. Bytes this document
   * holds itself are untouched; they go with the message's release as before. A picture the open
   * letter asked for, which the inline pass left to the overlay, is fetched and drawn now.
   */
  releasePreviews(messageId: string): void {
    const adopted = new Set(this.objectUrls.adoptedOf(messageId));
    const held = this.attachmentLists.get(messageId);
    for (const url of adopted) this.revokeUrl(url);
    if (adopted.size === 0 || held?.state !== "ready") return;
    const asked = this.inlineImageAsks.get(messageId);
    let owed = false;
    for (const item of held.items) {
      if (item.objectUrl !== undefined && adopted.has(item.objectUrl)) {
        this.patchAttachment(messageId, item.id, { state: "idle", objectUrl: undefined });
        if (item.contentId !== null && asked?.cids.includes(item.contentId)) owed = true;
      }
    }
    if (owed) this.healInlineImages(messageId, false);
  }

  /**
   * Fetch every non-inline attachment on a message as ONE zip, assembled server-side: one request and one IMAP
   * connection for the whole set — N `openAttachment` calls would be N logins, the pattern providers throttle.
   * Returns the Blob for the caller to save, or `null`. The failure is the CALLER's to report and the list is left
   * alone: a failed zip says nothing about the metadata — a list-level failure row here would claim the files are
   * unknown while they are on screen (an earlier shape wrote `{state: "failed"}` over the list, blanking a strip the
   * user was looking at). The zip may legitimately be missing files — the server skips a part it cannot fetch and
   * names it in `_errors.txt` inside the archive — so a non-null answer is not a promise that every file is present.
   */
  async downloadAllAttachments(messageId: string): Promise<Blob | null> {
    const fetchAll = this.adapter.fetchAllAttachments;
    if (!fetchAll) return null;
    try {
      const got = await this.partLane.run(this.pressOn(messageId, `${messageId}:*`), () => fetchAll.call(this.adapter, messageId));
      return got === LANE_DROPPED ? null : got;
    } catch {
      return null;
    }
  }

  /**
   * The embedded images ready for one message: `contentId → URL` ({@link inlineImages}), the map a
   * renderer resolves the html body's `cid:` references against. Synchronous, no side effects —
   * the render path reads, {@link OhmailEngine.loadInlineImages} is what asks.
   *
   * The identity is stable between mints and changes exactly when an image arrives, so it is
   * safe to use as a memo dependency around an expensive sanitize pass.
   */
  inlineImagesOf(messageId: string): ReadonlyMap<string, string> {
    return this.inlineImages.get(messageId) ?? NO_INLINE_IMAGES;
  }

  /**
   * Fetch the embedded images a message's html actually references, for the mail frame: each part's own object URL
   * (`inlineImageUrls: "object"`) or its bytes as a `data:` URI. `contentIds` comes from the renderer's own pass over
   * the sanitized document — parts nothing references are never fetched. What this spends: one `cost: "connection"`
   * fetch per part through {@link
   * OhmailEngine.openAttachment} (single-flight, never re-asked after a refusal); the reader OPENED this message and
   * the document names these parts — a signature logo as a grey box in every mail from a colleague is the defect, not
   * thrift. Bounds: only `Content-ID`-referenced parts; only declared raster images within {@link
   * INLINE_IMAGE_MAX_BYTES}, at most {@link INLINE_IMAGE_MAX_PARTS} parts / {@link INLINE_IMAGE_MAX_TOTAL_BYTES} per
   * message; fetched SEQUENTIALLY; a failed part stays failed, so a re-render cannot loop a connection-cost fetch.
   */

  /**
   * Never rejects; single-flight per message — the pane is mounted twice and both mounts ask for the same document.
   */
  async loadInlineImages(messageId: string, contentIds: readonly string[]): Promise<void> {
    if (!this.attachmentsAvailable() || contentIds.length === 0) return;
    const asked = this.inlineImageAsks.get(messageId);
    this.inlineImageAsks.set(messageId, { cids: [...contentIds], reasks: asked?.reasks ?? new Map(), again: asked?.again ?? false });
    return this.runInlineImages(messageId, contentIds, NO_RETRY);
  }

  /** The single-flight gate. `retry` names the parts a drain re-asks; a pass owed meanwhile runs after. */
  protected runInlineImages(messageId: string, contentIds: readonly string[], retry: ReadonlySet<string>): Promise<void> {
    const inFlight = this.inlineImageRequests.get(messageId);
    if (inFlight) return inFlight;

    const request = this.fetchInlineImages(messageId, contentIds, retry)
      .catch(() => {})
      .finally(() => {
        this.inlineImageRequests.delete(messageId);
        const asked = this.inlineImageAsks.get(messageId);
        if (asked?.again) {
          asked.again = false;
          void this.runInlineImages(messageId, asked.cids, NO_RETRY);
        } else {
          this.armPartReask(messageId);
        }
      });
    this.inlineImageRequests.set(messageId, request);
    return request;
  }

  /**
   * A LIST OR A PART ANSWERED AFTER THE PASS GAVE UP ON IT — a surface's re-ask, a press on the
   * card: draw what the open letter's document asked for, in place. A pass in flight is either
   * waiting on this very answer (`waiting`, its own list) or owes one more pass when it ends.
   */
  protected healInlineImages(messageId: string, waiting: boolean): void {
    const asked = this.inlineImageAsks.get(messageId);
    if (!asked) return;
    if (!this.inlineImageRequests.has(messageId)) void this.runInlineImages(messageId, asked.cids, NO_RETRY);
    else if (!waiting) asked.again = true;
  }

  /**
   * A DRAIN COMPLETED: the server answers again. A picture part the WIRE failed for an open letter
   * is asked again on the file list's terms — {@link wireFailed}, at most {@link REASK_MAX} per
   * episode — and nothing else is: a cid no part carries, a refusal the server answered, a part the
   * gates below refuse.
   */
  protected reaskInlineParts(): void {
    for (const [messageId, asked] of this.inlineImageAsks) {
      if (this.inlineImageRequests.has(messageId)) continue;
      const held = this.attachmentLists.get(messageId);
      if (held?.state !== "ready") continue;
      const have = this.inlineImages.get(messageId);
      const retry = new Set<string>();
      for (const cid of new Set(asked.cids)) {
        if (have?.has(cid)) continue;
        const item = held.items.find((i) => i.contentId === cid);
        if (item?.state !== "failed" || !wireFailed(item.code ?? null)) continue;
        const spent = asked.reasks.get(item.id) ?? 0;
        if (spent >= REASK_MAX) continue;
        asked.reasks.set(item.id, spent + 1);
        retry.add(item.id);
      }
      if (retry.size > 0) void this.runInlineImages(messageId, asked.cids, retry);
    }
  }

  /**
   * A PICTURE THE MAIL SERVER COULD NOT SERVE IS ASKED AGAIN, once due: busy past the lane's wait,
   * or no answer. Never a refusal the server answered, and at most {@link REASK_MAX} per part,
   * shared with the drain's re-ask; the item says `reasking` while the re-ask is due. The engine
   * owns no timer: {@link OhmailEngine.reaskDueParts} on the surface's cadence asks.
   */
  protected armPartReask(messageId: string): void {
    if (this.disposed) return;
    const asked = this.inlineImageAsks.get(messageId);
    const held = this.attachmentLists.get(messageId);
    if (!asked || held?.state !== "ready" || this.partReasksDue.has(messageId)) return;
    const parts: string[] = [];
    let step = 0;
    for (const cid of new Set(asked.cids)) {
      const item = held.items.find((i) => i.contentId === cid);
      if (item?.state !== "failed" || item.retryable === false) continue;
      const side = attachmentFaultClass(item.code, item.status);
      if (side !== "busy" && side !== "unreachable" && side !== "server_busy") continue;
      const spent = asked.reasks.get(item.id) ?? 0;
      if (spent >= REASK_MAX) continue;
      asked.reasks.set(item.id, spent + 1);
      step = Math.max(step, spent);
      parts.push(item.id);
    }
    if (parts.length === 0) return;
    for (const id of parts) this.patchAttachment(messageId, id, { reasking: true });
    const delay = PART_REASK_DELAYS_MS[Math.min(step, PART_REASK_DELAYS_MS.length - 1)]!;
    this.partReasksDue.set(messageId, { at: this.now().getTime() + delay, parts });
  }

  /**
   * THE SURFACE'S CADENCE ASKS the embedded pictures whose re-ask is due: the web scheduler's tick
   * and the phone's drain round call this after their sync, beside {@link OhmailEngine.pollWaitingOnOrganizer}.
   */
  reaskDueParts(): void {
    if (this.disposed || this.partReasksDue.size === 0) return;
    const now = this.now().getTime();
    for (const [messageId, due] of [...this.partReasksDue]) {
      if (due.at > now) continue;
      this.partReasksDue.delete(messageId);
      for (const id of due.parts) this.patchAttachment(messageId, id, { reasking: undefined });
      const asked = this.inlineImageAsks.get(messageId);
      if (asked) void this.runInlineImages(messageId, asked.cids, new Set(due.parts));
    }
  }

  /** A letter's due re-ask and its asks still in line go with the letter. */
  protected stopPartAsks(messageId: string): void {
    this.partReasksDue.delete(messageId);
    this.partLane.drop(messageId);
  }

  protected pressOn(messageId: string, flight: string) {
    return { key: this.laneKeyOf(messageId), messageId, flight, kind: "press" as const };
  }

  /** The working half of {@link OhmailEngine.loadInlineImages}, behind its single-flight gate. */
  protected async fetchInlineImages(messageId: string, contentIds: readonly string[], retry: ReadonlySet<string>): Promise<void> {
    await this.loadAttachments(messageId);
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return;

    const have = this.inlineImages.get(messageId);
    const wanted: AttachmentItem[] = [];
    const seen = new Set<string>();
    let budget = INLINE_IMAGE_MAX_TOTAL_BYTES;
    // Reference order — the order the reader meets the images — so the budget is spent on what
    // is nearest the top of the document, not on whatever sorts first.
    for (const cid of contentIds) {
      if (wanted.length >= INLINE_IMAGE_MAX_PARTS) break;
      if (seen.has(cid) || have?.has(cid)) continue;
      seen.add(cid);
      // EXACT match, FIRST wins: `contentId` is stored bracket-stripped and case-preserved
      // (RFC 5322 id-left is case-significant), so the comparison is `===` and two parts
      // sharing one Content-ID resolve to the earlier part in wire order — stated, tested,
      // and the same answer on every open.
      const item = held.items.find((i) => i.contentId === cid);
      if (!item) continue;
      // The declared-type/size gate: don't pay a connection for a part the mint below would
      // refuse anyway. The declaration is the sender's claim; the REAL gates are post-fetch.
      if (!INLINE_IMAGE_MIME.has(item.mimeType.toLowerCase())) continue;
      if (item.sizeBytes > INLINE_IMAGE_MAX_BYTES || item.sizeBytes > budget) continue;
      budget -= item.sizeBytes;
      wanted.push(item);
    }

    const minted: Array<[string, string]> = [];
    for (const item of wanted) {
      // A STAGED PREVIEW STANDS: the overlay shows it, and `openAttachment` would fetch over it and
      // release it. The picture is drawn when the overlay closes ({@link releasePreviews}).
      if (this.objectUrls.isAdopted(this.itemOf(messageId, item.id)?.objectUrl)) continue;
      const part = `${messageId}:${item.id}`;
      this.inlinePassParts.add(part);
      try {
        await this.fetchPartBytes(messageId, item.id, { retry: retry.has(item.id), auto: true });
      } finally {
        this.inlinePassParts.delete(part);
      }
      const now = this.itemOf(messageId, item.id);
      if (!now?.blob) continue;
      if (this.inlineImageUrls === "object") {
        // THE PART'S OWN URL, over these very bytes: no second carrier, the frame loads it by
        // reference. Which URLs may be drawn from is decided once, after the walk.
        if (now.objectUrl !== undefined && inlineImageBytesAdmitted(now.blob)) {
          minted.push([item.contentId!, now.objectUrl]);
        }
        continue;
      }
      // PER PART: a byte read that throws (a device FileReader refusal) costs that image its
      // blank box and nothing else — unguarded, one bad part killed the whole pass and every
      // image already minted in this walk was lost with it.
      try {
        const url = await mintInlineDataUrl(now.blob);
        if (url) minted.push([item.contentId!, url]);
      } catch {
        /* this part stays the blank box it already was; the others still land below */
      }
    }
    // ONLY A URL THE LEDGER MINTED FOR THIS MESSAGE AND STILL HOLDS: never an adopted preview, and
    // never one revoked while the pass walked on (a fetch over its part).
    const live = minted.filter(
      ([, url]) => this.inlineImageUrls === "data" || this.objectUrls.mintedFor(messageId, url),
    );
    if (live.length === 0) return;

    // Re-checked AFTER the awaits: a message released mid-pass (the reader moved on) must not
    // have its map re-created to outlive the byte state it belongs with.
    if (this.attachmentLists.get(messageId)?.state !== "ready") return;
    const next = new Map(this.inlineImages.get(messageId) ?? NO_INLINE_IMAGES);
    for (const [cid, url] of live) next.set(cid, url);
    // ONE replacement and ONE notification for the whole pass, not one per image: every map
    // identity change re-sanitizes and re-measures the mail document downstream.
    this.inlineImages.set(messageId, next);
    this.notify();
  }

  /**
   * The decoded text of a message's calendar parts already in hand: `attachmentId → ics text`,
   * what an event-preview surface parses ({@link import("@trafficflow/core/ics").parseIcsEvent})
   * and renders. Synchronous, no side effects — the render path reads,
   * {@link OhmailEngine.loadCalendarTexts} is what asks. Identity-stable between fills, so a
   * memoized parse can key on the map.
   */
  calendarTextsOf(messageId: string): ReadonlyMap<string, string> {
    return this.calendarTexts.get(messageId) ?? NO_CALENDAR_TEXTS;
  }

  /**
   * FETCH THE CALENDAR PARTS a message carries and hold their decoded text for the event preview. The third
   * legitimate automatic act on the `cost: "connection"` path, and it stands on {@link
   * OhmailEngine.loadInlineImages}'s argument verbatim: the reader OPENED this message, a meeting invitation drawn as
   * an opaque tile named `invite.ics` is the defect rather than thrift, and what keeps an automatic trigger bounded
   * where a press is bounded by the pressing:
   * · only parts DECLARED as calendar data ({@link isCalendarItem}) within {@link CALENDAR_TEXT_MAX_BYTES}, at most
   *   {@link CALENDAR_TEXT_MAX_PARTS} per message — real meeting mail carries exactly one, 1–4 KB;
   * · the real byte count is re-checked post-fetch — the declaration is the sender's claim;
   */

  /**
   * · SEQUENTIALLY, through {@link OhmailEngine.openAttachment} — single-flight per part, and a part that failed
   *   stays failed (no automatic re-ask against a server that refused);
   * · the bytes were being fetched for the tile anyway on the first press — this pass just spends them on a card
   *   the reader can read instead of a name they can only save.
   * Never rejects; the caller is a render effect. Single-flight per message (the pane is mounted twice while the
   * reader is open, and both mounts ask).
   */
  async loadCalendarTexts(messageId: string): Promise<void> {
    if (!this.attachmentsAvailable()) return;

    const inFlight = this.calendarTextRequests.get(messageId);
    if (inFlight) return inFlight;

    const request = this.fetchCalendarTexts(messageId)
      .catch(() => {})
      .finally(() => {
        this.calendarTextRequests.delete(messageId);
      });
    this.calendarTextRequests.set(messageId, request);
    return request;
  }

  /** The working half of {@link OhmailEngine.loadCalendarTexts}, behind its single-flight gate. */
  protected async fetchCalendarTexts(messageId: string): Promise<void> {
    await this.loadAttachments(messageId);
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return;

    const have = this.calendarTexts.get(messageId);
    // The iTIP part first (stable sort), so a message over the budget still shows its invitation.
    const wanted = held.items
      .filter((i) => isCalendarItem(i) && !have?.has(i.id) && i.sizeBytes <= CALENDAR_TEXT_MAX_BYTES)
      .sort((a, b) => calendarPartRank(a.mimeType) - calendarPartRank(b.mimeType))
      .slice(0, CALENDAR_TEXT_MAX_PARTS);
    if (wanted.length === 0) return;

    const decoded: Array<[string, string]> = [];
    for (const item of wanted) {
      await this.fetchPartBytes(messageId, item.id, { auto: true });
      const blob = this.attachmentBlobOf(messageId, item.id);
      // The REAL byte gate — `sizeBytes` above was only the sender's claim.
      if (!blob || blob.size === 0 || blob.size > CALENDAR_TEXT_MAX_BYTES) continue;
      try {
        decoded.push([item.id, await blob.text()]);
      } catch {
        // Undecodable bytes: the tile stands, the card simply never appears.
      }
    }
    if (decoded.length === 0) return;

    // Re-checked AFTER the awaits: a message released mid-pass (the reader moved on) must not
    // have its map re-created to outlive the byte state it belongs with.
    if (this.attachmentLists.get(messageId)?.state !== "ready") return;
    const next = new Map(this.calendarTexts.get(messageId) ?? NO_CALENDAR_TEXTS);
    for (const [id, text] of decoded) next.set(id, text);
    // ONE replacement and ONE notification for the whole pass — a map identity change re-parses
    // and re-renders the card downstream.
    this.calendarTexts.set(messageId, next);
    this.notify();
  }

  /**
   * Revoke every object URL held for a message and forget its byte state. MUST be called when the surface stops
   * rendering the message (a pane unmount, a different message selected). A `blob:` URL pins its bytes in memory
   * until it is revoked or the document dies, so a session spent opening PDFs in a long-lived tab would otherwise
   * accumulate every one of them — the exact cost the "nothing is stored" design exists to avoid, reintroduced in the
   * browser instead of the database. The minted `data:` URIs go with it — they pin the same bytes as base64 in a
   * string instead of behind a URL. The calendar texts too: they are decodings of the same released bytes.
   */
  /**
   * `keepFailure` KEEPS A HELD FAILURE across the release, so the next open of this message reads
   * the refusal it already has instead of asking again.
   *
   * The ENGINE cannot tell an answered refusal from one that expires with whatever caused it —
   * that reading belongs to the surface deciding whether to offer a Retry at all. So the caller
   * passes its verdict, exactly as {@link OhmailEngine.loadAttachments}'s `retry` carries "a
   * person pressed it". Without the flag the failure goes with the byte state, which is what
   * makes a fresh open ask again.
   */
  releaseAttachments(messageId: string, opts: { keepFailure?: boolean } = {}): void {
    if (opts.keepFailure === true && this.attachmentLists.get(messageId)?.state === "failed") {
      this.keepListFailure(messageId);
      return;
    }
    this.keptListFailures.delete(messageId);
    // A LIVE sent-copy seed declines the release: the optimistic Sent copy is still standing in
    // the mirror, its id exists on no server, and dropping the seed would turn the next open of
    // that copy back into the 404 the seed exists to answer. The seed's own lifecycle frees it —
    // `reconcileOptimisticSent` clears `live` when the copy retires (after which this release
    // works normally) and sweeps it at the copy's TTL. See {@link sentAttachmentSeeds}.
    const seed = this.sentAttachmentSeeds.get(messageId);
    if (seed?.live) {
      // …but a CARRIED FAILURE must not survive the release. A release followed by a re-load is
      // the one gesture surfaces use to mean "the refusal's cause is gone — ask again" (the
      // session-revival seam re-asks an auth-failed list exactly this way), and a forward copy's
      // failure is the PARENT read's, which expires with whatever refused it there. So the
      // failed states are dropped on both ids — the seeded bytes stay, and the next delegated
      // read recomposes from the parent's fresh answer.
      const held = this.attachmentLists.get(messageId);
      if (held?.state === "failed") {
        this.attachmentLists.delete(messageId);
        if (seed.forwardOf && this.attachmentLists.get(seed.forwardOf)?.state === "failed") {
          this.attachmentLists.delete(seed.forwardOf);
        }
        this.notify();
      }
      return;
    }
    this.forceReleaseAttachments(messageId);
  }

  /**
   * ASK A FAILED LIST AGAIN AS A FRESH QUESTION — the surfaces' bounded re-ask after a drop or a
   * revived session. The release a reader's leaving makes, but the reader is still here: what its
   * document asked to draw is kept, so the answer draws the pictures in place.
   */
  reaskAttachments(messageId: string): Promise<AttachmentsOutcome> {
    const asked = this.inlineImageAsks.get(messageId);
    this.releaseAttachments(messageId);
    if (asked) this.inlineImageAsks.set(messageId, asked);
    return this.loadAttachments(messageId);
  }

  /** Revoke everything, for a teardown that is losing the whole engine. Live seeds included —
   *  and seeds whose copy list was never published (a forward still waiting on its parent hold
   *  minted compose URLs with no `attachmentLists` entry to find them under). */
  releaseAllAttachments(): void {
    this.keptListFailures.clear();
    const ids = new Set([...this.attachmentLists.keys(), ...this.sentAttachmentSeeds.keys()]);
    for (const messageId of ids) this.forceReleaseAttachments(messageId);
    for (const messageId of [...this.partReasksDue.keys()]) this.stopPartAsks(messageId);
    this.partLane.dropAll();
    // Whatever the per-message passes could not name: a URL whose fetch is still in flight, and
    // one minted for a message whose entry and seed are both already gone.
    this.objectUrls.releaseAll();
  }

  /**
   * HOW MANY ANSWERED LIST REFUSALS ONE ENGINE REMEMBERS PAST A RELEASE.
   *
   * A kept failure is the only attachment state that outlives the message being closed, so it is
   * the only one that can grow with a long session — every other entry goes with the release. Two
   * hundred is a bound, not a measurement: a 404 or a "not yours" on an attachment list is rare
   * enough that a reader will not reach it, and the cost of the oldest being forgotten is one
   * extra request on one re-open.
   */
  protected static readonly ANSWERED_LIST_FAILURES_KEPT = 200;

  /**
   * Drop the message's byte state but LEAVE its failed list standing, under the bound above.
   * The object URLs, inline images and calendar texts still go — a failed list minted none of
   * them, and a live sent-copy seed may have, so the drain is unconditional.
   */
  protected keepListFailure(messageId: string): void {
    const held = this.attachmentLists.get(messageId);
    this.stopPartAsks(messageId);
    this.objectUrls.releaseOwner(messageId);
    this.inlineImages.delete(messageId);
    this.inlineImageAsks.delete(messageId);
    this.calendarTexts.delete(messageId);
    if (held) this.attachmentLists.set(messageId, held);
    this.keptListFailures.delete(messageId);
    this.keptListFailures.add(messageId);
    while (this.keptListFailures.size > OhmailEngine.ANSWERED_LIST_FAILURES_KEPT) {
      const oldest = this.keptListFailures.values().next();
      if (oldest.done) break;
      this.keptListFailures.delete(oldest.value);
      this.attachmentLists.delete(oldest.value);
    }
    this.notify();
  }

  /** The unconditional half of {@link OhmailEngine.releaseAttachments}. */
  protected forceReleaseAttachments(messageId: string): void {
    this.keptListFailures.delete(messageId);
    this.stopPartAsks(messageId);
    // ONE drain of the ledger, not a walk of the entries: it holds the seed's compose URLs (a
    // forward still waiting on its parent publishes no list to find them under), the ready items'
    // URLs, and any minted for this message while its entry was already gone. Each is revoked
    // exactly once — the two walks this replaces revoked a seeded item's URL twice.
    this.objectUrls.releaseOwner(messageId);
    this.sentAttachmentSeeds.delete(messageId);
    this.attachmentLists.delete(messageId);
    this.inlineImages.delete(messageId);
    this.inlineImageAsks.delete(messageId);
    this.calendarTexts.delete(messageId);
    this.notify();
  }

  protected itemOf(messageId: string, attachmentId: string): AttachmentItem | undefined {
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return undefined;
    return held.items.find((i) => i.id === attachmentId);
  }

  /** Replace one item in a message's list and re-render. */
  protected patchAttachment(messageId: string, attachmentId: string, patch: Partial<AttachmentItem>): void {
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return;
    this.attachmentLists.set(messageId, {
      state: "ready",
      items: held.items.map((i) => (i.id === attachmentId ? { ...i, ...patch } : i)),
    });
    this.notify();
  }

  protected revokeItem(messageId: string, attachmentId: string): void {
    this.revokeUrl(this.itemOf(messageId, attachmentId)?.objectUrl);
  }

  /**
   * Through the ledger, so a URL already revoked is not revoked a second time. An embedded picture
   * drawn from it leaves its message's map with it: the map never names a dead URL, and the
   * renderer asks for that part again.
   */
  protected revokeUrl(url: string | undefined): void {
    const owner = url === undefined ? undefined : this.objectUrls.heldFor(url);
    this.objectUrls.revoke(url);
    const held = owner === undefined ? undefined : this.inlineImages.get(owner);
    if (!held || ![...held.values()].includes(url!)) return;
    this.inlineImages.set(owner!, new Map([...held].filter(([, drawn]) => drawn !== url)));
    this.notify();
  }

  /**
   * Mint a Blob URL, DOWNGRADING the content type of anything a browser would render as a document. See {@link
   * RENDERABLE_MIME}. The re-typing happens at construction because that is the only point that governs every
   * consumer: a call site can forget to check a type, and the two the server sets (`Content-Disposition`, `nosniff`)
   * describe the RESPONSE and do not survive into a Blob made from its body. The TYPED BLOB is returned ALWAYS;
   * the URL only where `URL.createObjectURL` exists AND can answer (SSR and node lack it; a phone carries a
   * runtime-installed one that may throw, which the ledger reads as absence): the URL is a browser convenience,
   * never the byte carrier — dropping the blob with it left every phone's `ready` item byte-less while HTTP
   * answered 200, measured on a paired device. The typed Blob rides at the same downgraded type.
   */
  protected mintObjectUrl(owner: string, blob: Blob, declaredMime: string): { url: string | undefined; blob: Blob } {
    const safeType = RENDERABLE_MIME.has(declaredMime.toLowerCase()) ? declaredMime : "application/octet-stream";
    const typed = retypedBlob(blob, safeType);
    const url = this.objectUrls.mint(owner, typed);
    return { url, blob: typed };
  }

  // Written in a later file of the engine; named here because this one calls them.
  protected abstract recomposeForwardSeed(messageId: string): boolean;
}

/** The engine's class as this file's bodies name it: the statics they read are declared here. */
const OhmailEngine = EngineAttachments;

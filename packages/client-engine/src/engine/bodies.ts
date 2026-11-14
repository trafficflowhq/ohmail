import type {
  AutoFiledUndoWire, AutoFiledWire, EngineAdapter, ScreenerWaitingWire, StayedWhy, UnscreenedPileWire,
} from "../adapters/adapter.js";
import { consentIndex, decidedDestination, namedByBodyTerm } from "../consent-cutline.js";
import { relistedBy } from "../kept-decisions.js";
import { isOwnSent, rulesList, senderKey } from "../selectors.js";
import {
  type EngineMessage, FOLDER_OF_VIEW, HELD_RELEASE_TYPE, type HeldReleaseGroupDTO, isProtectedMessage,
  isWithheldMarker, MAILBOX_TYPE, type MessageBodyBatchWire, type MessageBodyRecord, MutationRejectedError,
  type RuleDTO, SCREENER_WAITING_PAGE_ID, SCREENER_WAITING_TYPE, type ScreenerWaitingDTO,
  type ScreenerWaitingPageDTO, type ScreenerWaitingSenderDTO, type SyncChange, UNSCREENED_TYPE,
  type UnscreenedGroupDTO, type UnsubscribeResult, type WithheldMarker,
} from "../types.js";
import {
  BODY_CACHE_MAX, FAILED_BODY_HOLD_MS, HELD_ARRIVALS_MAX, MAX_CONCURRENT_BODIES, PAGE_IS_NOT_CONTENT, sameGone,
  sameStoredEntities, SCREENER_PAGE_REPS_MAX, SCREENER_WAITING_PAGE, SCREENER_WALK_LISTED_MAX, waitingRow,
} from "./ceilings.js";
import { OHBOX_FOLDER, UNSCREENED_REASK_MS, WHY_STAYED_PAGE } from "./mutation-views.js";
import { BODIES_IDS_MAX, type FetchBodiesFn, messageTime, olderFirst } from "./server-wire.js";
import { EngineWindowed } from "./windowed.js";

/**
 * The wire's withheld marker, narrowed to the CLOSED set the mirror understands — every member
 * hydrates as itself, and anything else (an older/newer server) narrows to `null`, which is
 * ANSWERED-ordinary. See `WithheldMarker` for why dropping a real member here would be a
 * permanent lie in the record. One helper for both hydration sites so they cannot disagree.
 */
const withheldMarkerOf = (w: unknown): WithheldMarker | null => (isWithheldMarker(w) ? w : null);

export abstract class EngineBodies extends EngineWindowed {
  // ── message bodies ───────────────────────────────────────────────────────

  /**
   * Fetch one message's body, on explicit intent — the capability behind every reading surface (before it, the wire
   * carried `snippet` only, so every stream card measured "short" and the Expand pill never appeared). The result
   * goes into a client-local `message_body` record ({@link MessageBodyRecord}), never onto the message row.
   * Idempotent, single-flight: two surfaces render the same message at once, so concurrent callers join one request,
   * and a `ready` body is never re-fetched. A `loading` record with no promise behind it (a tab died mid-request; the
   * record persists, the promise does not) IS re-fetched — that cannot loop, because a `loading` record this engine
   * writes always has an in-flight entry above it; the map is the dedup, and deciding from the record alone would
   * make a zombie `loading` a permanent spinner.
   */

  /**
   * `retry` — why a failure is not retried by default: most callers are React effects that re-run
   * whenever inputs change, and a failed fetch writes a record, bumps the version, re-renders — a
   * `failed` state that re-fetched on the default path is a billed request loop against a server
   * already refusing (found by exactly that: a 500-ing adapter under a per-render callback spun
   * until the test timed out). The rule is about WHO asks: an automatic trigger asks once per
   * {@link FAILED_BODY_HOLD_MS}; a HUMAN act passes `retry` and asks at once. It never rejects: the outcome is the RECORD (`ready` or `failed`), a thing the UI
   * renders — reported on screen, not thrown at the DOM.
   */

  /**
   * `urgent` — a message somebody is looking at does not wait behind a backlog. {@link bodySlot}
   * runs four fetches and queues the rest, FIFO with no notion of what is on screen, so the
   * message just SELECTED could queue behind a Screener preview nobody is watching. `urgent`
   * jumps that queue, passed by the shell's two selection effects and nothing else — "this is the
   * message being opened" is knowledge only the selection has. A separate flag from `retry`,
   * deliberately: `retry` also jumps the queue, but it ALSO bypasses the failed-guard, so a
   * selection effect carrying it would re-ask a refusing server on every render — exactly the
   * billed poll the guard prevents. Two facts, two flags.
   */
  async hydrateBody(messageId: string, opts: { retry?: boolean; urgent?: boolean } = {}): Promise<void> {
    /**
     * ── AND IT DOUBLES AS "A SURFACE IS RENDERING THIS MESSAGE" ─────────────────────────────
     *
     * Recorded FIRST, above every early return, because the statement is true whatever the
     * answer turns out to be — a protected message and a body already `ready` are both on
     * screen. {@link OhmailEngine.pinnedMessageIds} reads it so the windowed prune cannot evict
     * the message a reader is looking at; see there for why this call is the signal.
     */
    this.noteRendered(messageId);
    // JOINED, and then re-prioritised: the request may have been created by the background pass
    // (or by a thread open) and be waiting in the non-urgent queue, or already out as a background
    // read. See {@link hurryBody} — without this the claim "an open always jumps" is false for
    // precisely the messages the prefetch has asked for.
    const joined = this.joinBody(messageId, opts.urgent === true || opts.retry === true ? "urgent" : null);
    if (joined !== null) return joined;

    const plan = this.bodyPlan(messageId, opts.retry === true, true);
    if (plan.kind === "skip") return;
    if (plan.kind === "purge") return this.putBody(messageId, null);

    /**
     * ── EVERYTHING UP TO THIS `set` IS SYNCHRONOUS, AND IT HAS TO BE ────────────────────────
     *
     * The single-flight is the map, and a map written after an `await` is not one: two effects
     * firing in the same tick — which is what React does, twice over in StrictMode — would both
     * see an empty entry and both issue a request. `bodyPlan` is therefore a pure, synchronous
     * decision, and the first thing that may suspend is the marker write inside `startBody`,
     * which happens AFTER the promise is already registered here.
     */
    const urgent = opts.urgent === true || opts.retry === true;
    const request = this.startBody(messageId, plan.held, urgent);
    this.trackBodies([messageId], request, urgent);
    return request;
  }

  /**
   * IS THERE A BODY TO ASK FOR, AND WHAT IS HELD NOW — the whole admission decision, in one synchronous place because
   * two callers need exactly the same answer. {@link OhmailEngine.hydrateBody} asks about one message and {@link
   * OhmailEngine.hydrateThread} about a conversation's worth at once. Re-deriving these rules in the second caller
   * would put "does the demo issue requests", "is a protected body purged" and "is a failed body re-asked" in two
   * places that are only ever tested through one of them. `purge` is separated from `skip` because it is a WRITE, and
   * this function performs none — see the note in `hydrateBody` about why nothing here may suspend.
   */
  protected bodyPlan(
    messageId: string,
    retry: boolean,
    rendered = false,
  ): { kind: "skip" } | { kind: "purge" } | { kind: "fetch"; held: MessageBodyRecord | undefined } {
    const msg = this.read().get<EngineMessage>("message", messageId);
    // Not in the mirror at all — a fixture `screener_sender`'s held id, or a row that has
    // since been drained away. Nothing to ask about.
    if (!msg) return { kind: "skip" };
    /**
     * ALREADY WHOLE. The demo's message rows carry `body` (`fixtures-adapter.ts` →
     * `toMessage`), and `bodyOf` answers `full` from exactly this field — so the two agree
     * by construction rather than by both being remembered. This is also what keeps the
     * demo at zero requests without the demo being a special case here.
     */
    if (msg.body !== undefined) return { kind: "skip" };
    /**
     * A PROTECTED MESSAGE HAS NO BODY TO ASK FOR — AND MUST HOLD NONE AT REST. Its surface renders `ProtectedBlock`
     * and no text whatever the mirror holds (`MessagePane` is where that decision lives), so a fetch here could only
     * ever produce a record nothing reads. Skipping it also keeps the demo's one body-less fixture from churning a
     * loading record every time it is selected. The second clause is the at-rest half. A message that cached a body
     * while it was ORDINARY and then became protected is the raw secret sensitive mail is redacted to avoid, sitting
     * in IndexedDB (and, via {@link SearchIndex}, the local search index). The delta cascade in {@link MirrorStore}
     * purges on the transition; this is the belt-and-braces for a body cached by an older engine, or one the
     * transition missed — purge any held record before returning.
     */

    /**
     * `isProtectedMessage` keys on `sensitivity.sensitive` (the Cloud signal) as well as the fixture `protected`
     * extra, so the real reclassification case is covered, not only the demo.
     */
    if (isProtectedMessage(msg)) {
      const held = this.read().get<MessageBodyRecord>("message_body", messageId);
      return held === undefined ? { kind: "skip" } : { kind: "purge" };
    }
    const held = this.read().get<MessageBodyRecord>("message_body", messageId);
    /**
     * Already ready — AND from a build that knew about `html`. The html renderer shipped, and a message already
     * opened was still a text dump: `message_body` records persist, one written by an older build has no `html` key
     * at all, `ready` suppressed the fetch, and every message the reader had already opened stayed frozen in the
     * pre-fix shape — while new mail rendered correctly, which is why the product looked unfixed only to the people
     * already using it. `html !== undefined` and NOT `!= null`, and the difference is the whole of it: `undefined` —
     * no build ever answered; ask now. `null` — a build asked and the answer was "no html" (a plain-text mail, or a
     * sensitive one whose html is deliberately not stored); re-asking is a permanent billed poll.
     */

    /**
     * A re-read, not a migration ({@link MessageBodyRecord} says why inventing `html: null` is forbidden) and not a
     * sweep — one extra request per message the reader opens again. It terminates because `fetchBodyInto` always
     * writes the key; `body-hydration.test.ts` asserts the COUNT, not just the outcome.
     */
    if (held?.state === "ready" && held.html !== undefined) {
      /**
       * The one ready record still worth asking about: a record from a build predating the storage-cap marker cannot
       * be told from a genuinely empty message — `{state: "ready", text: "", html: null}` is exactly what a pre-slice
       * client persists for a body the server has begun WITHHOLDING. Left alone, `bodyOf` reports `full` over nothing
       * for ever. `withheld === undefined` is the discriminator, and it works only because both write sites now
       * ALWAYS set the key — one re-ask heals the record and it can never match this branch again. Narrow on purpose:
       * only `text === ""` AND `html === null` qualifies (the withheld shape); a plain-text mail with real text must
       * never become a request, and `bodyHealed` bounds it to once per engine even if the mirror write is refused.
       */
      const preCapEmpty = held.text === "" && held.html === null && held.withheld === undefined;
      // The same once, for a `storage_cap` record an older build kept through the refill's change.
      const preRefillCap = held.withheld === "storage_cap" && held.capRefill !== true;
      if (!(preCapEmpty || preRefillCap) || this.bodyHealed.has(messageId)) return { kind: "skip" };
      this.bodyHealed.add(messageId);
      return { kind: "fetch", held };
    }
    /**
     * A FAILURE IS ONE ATTEMPT'S. An automatic trigger must not re-ask a server that just refused — the effects
     * behind this call re-run on every mirror bump, and a failed record IS one — so a failure stands for
     * {@link FAILED_BODY_HOLD_MS}. Past it, a surface RENDERING the message asks again (`rendered`: `hydrateBody`, a
     * thread open): the desktop's held preview read "Couldn't load" for a whole session over a body its store held,
     * from one deadline an hour earlier (2026-09-24). The background pass keeps the session rule, since nobody is
     * looking and a refusing route would be re-asked for a thousand ids per drain.
     */

    /**
     * A record stamped before {@link OhmailEngine.bootedAt} — or carrying no stamp, which by construction means a
     * build that predates the field and therefore an earlier session ({@link MessageBodyRecord.failedAt}, read
     * exactly as `html !== undefined` above is) — is re-asked ONCE on either path, and `bodyHealed` is what makes
     * that "once" a property of the engine rather than of a mirror write that can itself be refused.
     */
    if (held?.state === "failed" && !retry) {
      const at = held.failedAt;
      if (at === undefined || at < this.bootedAt) {
        if (this.bodyHealed.has(messageId)) return { kind: "skip" };
        this.bodyHealed.add(messageId);
      } else if (!rendered || this.now().getTime() - at < FAILED_BODY_HOLD_MS) {
        return { kind: "skip" };
      }
    }
    return { kind: "fetch", held };
  }

  /**
   * THE `loading` MARKER IS WRITTEN AT ENQUEUE, NOT AT DEPARTURE: This used to live at the top of `fetchBodyInto`,
   * which runs inside {@link bodySlot} — i.e. only once a slot is free. Four fetches may be in the air, so the fifth
   * message a reader opened had NO `message_body` record at all for as long as the queue held it, and a message with
   * no record is exactly what `bodyOf` answers `snippet` for. The surfaces then rendered that snippet as though it
   * were the mail: 200 characters cut mid-word, inside full message anatomy, with nothing on screen saying anything
   * was still coming. Silent, and worst precisely when the app is busiest. Writing it here closes the window
   * structurally: from the moment a fetch is DECIDED there is a record saying so, whether it departs now or in four
   * round trips.
   */

  /**
   * The surfaces' snippet branch becomes unreachable for a message being hydrated, which is why they may now treat a
   * resting `snippet` as the defect it is. The `.finally` clears the single-flight entry on both arms, rejection
   * included (once no other read of the body is out, {@link settleBodies}) — a leaked entry would make every later
   * call join a promise that is never coming back, which is the failure {@link BODY_FETCH_TIMEOUT_MS} exists for,
   * reached from the other side.
   */
  protected startBody(
    messageId: string,
    held: MessageBodyRecord | undefined,
    urgent: boolean,
  ): Promise<void> {
    return this.markLoading(messageId, held)
      .then(() => this.bodySlot(urgent || this.bodiesUrged([messageId]), (asked) => this.fetchBodyInto(messageId, asked), [messageId]))
      .finally(() => this.settleBodies([messageId]));
  }

  /**
   * `held` is here so a re-read does not take the message off the screen. The write used to be unconditional, and
   * that is destructive: `bodyOf` answers a `loading` record with the SNIPPET, so a message being read collapsed to
   * one line the instant anything asked again — and the legacy re-read fires on exactly the message the reader just
   * opened; if the fetch then failed, they had LOST a body they already had. A `ready` record is left alone until
   * there is something better to put in its place. The refusal is swallowed, and that is not a tidy-up: this write
   * sits outside `fetchBodyInto`'s try, so an unguarded IndexedDB rejection (full quota, private window, a
   * version-changed connection) would propagate out of `hydrateBody` and break its never-rejects contract in a React
   * effect. The fetch still goes ahead: a mirror that cannot hold a marker can very well hold the answer.
   */
  protected async markLoading(messageId: string, held: MessageBodyRecord | undefined): Promise<void> {
    if (held?.state === "ready") return;
    try {
      await this.putBody(messageId, {
        messageId, state: "loading", text: "", html: null, loadedRemoteContent: false,
      });
    } catch {
      /* the mirror refused the marker; ask anyway — see above, never rethrow */
    }
  }

  /**
   * ONE MARKER FOR A WHOLE BATCH — the chunk twin of {@link markLoading}.
   *
   * A body used to be written twice per id (this marker, then the answer), so a 20-id chunk cost
   * 40 whole-mirror derivations; a batch now costs two, whatever its size. A `ready` body is
   * skipped exactly as it is above, and a chunk in which every id is already ready commits nothing
   * and bumps nothing. Swallowed for `markLoading`'s reason: a mirror that cannot hold a marker
   * can still hold the answer, so the fetch goes ahead either way.
   */
  protected async markLoadingBatch(
    chunk: ReadonlyArray<{ id: string; held: MessageBodyRecord | undefined }>,
  ): Promise<void> {
    const markers = chunk
      .filter((c) => c.held?.state !== "ready")
      .map((c) => ({
        id: c.id,
        record: {
          messageId: c.id, state: "loading" as const, text: "", html: null, loadedRemoteContent: false,
        },
      }));
    try {
      await this.putBodies(markers);
    } catch {
      /* the mirror refused the markers; ask anyway — see above, never rethrow */
    }
  }

  /**
   * One request for a whole conversation. Opening a thread needs every sibling's body, and the surface used to ask
   * one at a time through a four-wide limiter — eight siblings were eight requests, the last two not even STARTING
   * until a round trip finished, and the reader watched the conversation assemble in steps; the batch route answers
   * all in one. It changes nothing else: admission is `hydrateBody`'s own through {@link bodyPlan} (a demo row is not
   * asked, a protected sibling is PURGED rather than fetched — why the ids are passed in, not filtered by the caller
   * — a `ready` body with an `html` key is left alone, a failure re-asks only across a session boundary); markers are
   * written for the whole set BEFORE anything leaves, and the single-flight entries register synchronously so a
   * double-invoked effect produces one request.
   */

  /**
   * Not required to exist: an adapter with no batch route falls back to per-message, and a server that ignores the
   * parameter is merely slower — unanswered ids are fetched singly below.
   */
  hydrateThread(messageIds: string[]): Promise<void> {
    return this.hydrateMany(messageIds, { rendered: true });
  }

  /**
   * THE SCREENER'S HELD PREVIEW: every held body of the selected sender in ONE request, `urgent`
   * so it takes one slot ahead of background work (a person is reading it). One request, not one
   * per message, so urgency is not the burst the limiter exists to stop. An adapter with no batch
   * route asks per message, the newest {@link MAX_CONCURRENT_BODIES} urgent (`ids` oldest first).
   */
  hydrateBodies(messageIds: string[], opts: { urgent?: boolean } = {}): Promise<void> {
    return this.hydrateMany(messageIds, { rendered: true, urgent: opts.urgent === true });
  }

  /**
   * THE DRAFT'S TEXT, ASKED FOR ONCE, FOR A MIRROR ROW THAT ARRIVED WITHOUT ONE. Returns the text, or `null` when
   * this client cannot get it — an adapter without the capability (the demo world, whose rows always carry a body), a
   * refusal, or a server that named no text. `null` is what compose must not seed an editor from and what autosave
   * must not write back; a caller that treated it as "" would replace the person's message with the blank this client
   * happens to be holding. Nothing is written to the mirror. The row is the server's DTO and the next page carrying a
   * body is what repairs it; a local patch would put text at a seq the store did not observe.
   */
  async readDraftBody(draftId: string): Promise<string | null> {
    const fetchDraftBody = this.adapter.fetchDraftBody?.bind(this.adapter);
    if (!fetchDraftBody) return null;
    try {
      return await fetchDraftBody(draftId);
    } catch {
      return null;
    }
  }

  /**
   * DOES THE SERVER STILL HOLD THIS DRAFT? Asked by a composer whose bound row left the mirror with
   * no tombstone — a 410 re-bootstrap's snapshot simply lacks a row deleted meanwhile. `gone` only
   * on the server's own 404; a refusal of any other kind, or no route, is `unknown`.
   */
  async draftOnServer(draftId: string): Promise<"held" | "gone" | "unknown"> {
    const fetchDraftBody = this.adapter.fetchDraftBody?.bind(this.adapter);
    if (!fetchDraftBody) return "unknown";
    try {
      await fetchDraftBody(draftId);
      return "held";
    } catch (err) {
      return err instanceof MutationRejectedError && err.status === 404 ? "gone" : "unknown";
    }
  }

  /**
   * The shared batch core behind {@link hydrateThread} and the eager pass. `rendered` is the
   * one difference between the two callers, and it is a fact only the caller knows: a thread
   * open means every one of these ids is ON SCREEN and must be pinned against the windowed
   * prune; a background prefetch means none of them is, and pinning them would flush the
   * {@link RENDERED_PINS} LRU of the ids that genuinely are.
   */
  protected hydrateMany(
    messageIds: string[],
    opts: { rendered: boolean; stopped?: () => boolean; urgent?: boolean },
  ): Promise<void> {
    const fetchBodies = this.fetchBodiesFn;
    const ids = [...new Set(messageIds)];
    const urgent = opts.urgent === true;
    if (!fetchBodies) {
      if (opts.rendered) {
        const from = urgent ? ids.length - MAX_CONCURRENT_BODIES : ids.length;
        return Promise.all(ids.map((id, i) => {
          if (i >= from) return this.hydrateBody(id, { urgent: true });
          // On screen: a read already out as a background one is hurried as an open's is.
          if (this.bodyRequests.has(id)) { this.noteRendered(id); return this.joinBody(id, "shown")!; }
          return this.hydrateBody(id);
        })).then(() => undefined);
      }
      // The per-id fallback WITHOUT the pin write `hydrateBody` opens with — same admission,
      // same single-flight registration, no claim that a surface is rendering anything. A caller
      // that can be torn down (the eager pass) is asked before each id, for the reason
      // `runEagerBodies` gives: this loop is as long as the slice.
      const runs = ids.map((id) => {
        if (opts.stopped?.() === true) return Promise.resolve();
        const inFlight = this.bodyRequests.get(id);
        if (inFlight) return inFlight;
        const plan = this.bodyPlan(id, false, false);
        if (plan.kind === "purge") return this.putBody(id, null);
        if (plan.kind === "skip") return Promise.resolve();
        const request = this.startBody(id, plan.held, false);
        this.trackBodies([id], request, false);
        return request;
      });
      return Promise.all(runs).then(() => undefined);
    }

    const take: Array<{ id: string; held: MessageBodyRecord | undefined }> = [];
    /** On screen, and already out as a background read: the person's own read goes beside it. */
    const race: string[] = [];
    const writes: Array<Promise<void>> = [];
    for (const id of ids) {
      if (opts.rendered) this.noteRendered(id);
      // Already in the air, alone or in another batch — join it rather than ask twice. On screen it
      // is hurried as an open's is: a queued one an urgent ask lets go now (`promoteBodyRequest`),
      // one out as a background read gets the person's own beside it (`hurryBody`).
      if (this.bodyRequests.has(id)) { if (opts.rendered && this.hurryBody(id, urgent)) race.push(id); continue; }
      const plan = this.bodyPlan(id, false, opts.rendered);
      if (plan.kind === "purge") { writes.push(this.putBody(id, null)); continue; }
      if (plan.kind === "skip") continue;
      take.push({ id, held: plan.held });
    }
    for (let i = 0; i < race.length; i += BODIES_IDS_MAX) writes.push(this.raceBodies(race.slice(i, i + BODIES_IDS_MAX), true));

    // Split rather than refuse: the server caps an id list at {@link BODIES_IDS_MAX} because a
    // truncated answer is indistinguishable from "those messages have no body", so a conversation
    // longer than the cap becomes two requests here and never a 400 the reader would see.
    for (let i = 0; i < take.length; i += BODIES_IDS_MAX) {
      const chunk = take.slice(i, i + BODIES_IDS_MAX);
      const chunkIds = chunk.map((c) => c.id);
      const run = this.markLoadingBatch(chunk)
        .then(() => this.bodySlot(
          urgent || this.bodiesUrged(chunkIds),
          (asked) => this.fetchBodiesInto(chunkIds, fetchBodies, opts.stopped, asked || opts.rendered),
          chunkIds,
        ))
        .finally(() => this.settleBodies(chunkIds));
      this.trackBodies(chunkIds, run, urgent || opts.rendered);
      writes.push(run);
    }
    return Promise.all(writes).then(() => undefined);
  }

  /**
   * Distribute one batch answer into `message_body` records. THE ROWS ARE MATCHED BY ID, NEVER BY POSITION. The
   * server answers only the ids the caller's own account owns and omits the rest — silently, so the response cannot
   * be read as an existence oracle for somebody else's ids — and it may also stop early on its byte budget. So
   * "shorter than asked" is a normal answer, and an id the batch did not carry is asked for on its own rather than
   * left as a marker nothing will ever replace. That per-id tail is also what makes a server which does not
   * understand the parameter degrade to the old behaviour instead of to a thread of empty messages. A THROW IS THE
   * WHOLE BATCH'S. One request carried all of these, so its refusal is each of their refusals — every id gets the
   * `failed` record it would have got asking alone, which is a state the surfaces render with a Retry beside it.
   */
  protected async fetchBodiesInto(
    ids: string[],
    fetchBodies: FetchBodiesFn,
    stopped?: () => boolean,
    /** On screen: the person is waiting (`ReadIntent`). */
    urgent = false,
  ): Promise<void> {
    this.bodiesLeft(ids, urgent);
    let rows: MessageBodyBatchWire[] | null;
    try {
      rows = await (urgent ? fetchBodies(ids, { urgent: true }) : fetchBodies(ids));
    } catch (err) {
      // Not for a body another read of it may still answer (`bodyFailed`).
      const failing = ids.filter((id) => this.bodyFailed(id, err));
      await this.failBodies(failing, err);
      this.bodiesDecided(failing);
      return;
    }
    // `null` ⇒ this adapter serves no bodies. Same meaning and same handling as `fetchBody`'s
    // `null`: tombstone the markers rather than leave a surface saying "loading…" for ever.
    if (rows === null) {
      const mine = ids.filter((id) => this.bodyAnswered(id));
      // One bump for the whole batch — see `putBodies`. Swallowed as the per-id write was.
      try { await this.putBodies(mine.map((id) => ({ id, record: null }))); } catch { /* the mirror refused; nothing to report */ }
      this.bodiesDecided(mine);
      return;
    }
    const byId = new Map(rows.map((r) => [r.messageId, r]));
    const missing: string[] = [];
    // COLLECTED, THEN COMMITTED ONCE. This loop used to `await putBody` per id, which bumped the
    // mirror version and re-derived the whole mailbox once per body.
    const answered: Array<{ id: string; record: MessageBodyRecord | null }> = [];
    for (const id of ids) {
      const wire = byId.get(id);
      if (wire === undefined) { missing.push(id); continue; }
      // Another read of this body landed first (an open's, beside this one): its record stands.
      if (!this.bodyAnswered(id)) continue;
      // The same record `fetchBodyInto` writes, field for field — including the `?? null`
      // normalisations, which are about the KEY existing rather than about the value. See
      // there: a record that could leave `html` absent lands back in the re-read branch and
      // polls for ever.
      answered.push({
        id,
        record: {
          messageId: id,
          state: "ready",
          text: wire.text,
          html: wire.html ?? null,
          loadedRemoteContent: wire.loadedRemoteContent === true,
          unsubscribe: wire.unsubscribe ?? "no_header",
          unsubscribeUrl: wire.unsubscribeUrl ?? null,
          // ALWAYS written, never spread conditionally — `null` is "a withheld-aware build
          // answered, and this body is ordinarily stored". Absence is reserved for records no
          // such build ever touched, which is what makes the pre-slice heal terminate. The batch
          // path and the single path must agree; see `MessageBodyRecord.withheld`.
          withheld: withheldMarkerOf(wire.withheld),
          ...(wire.withheld === "storage_cap" ? { capRefill: true as const } : {}),
        },
      });
    }
    try {
      await this.putBodies(answered);
    } catch (err) {
      // The commit is all-or-nothing, so a refusal leaves NONE of them written — every id the
      // batch answered gets the `failed` record it would have got asking alone.
      await this.failBodies(answered.map((a) => a.id), err);
    }
    this.bodiesDecided(answered.map((a) => a.id));
    /*
     * THE PER-ID TAIL, AND IT IS INTERRUPTIBLE. "Shorter than asked" is a normal answer — the
     * server omits ids the account does not own and stops early on its byte budget — so this loop
     * can be as long as the batch was, one request at a time. A background pass that has been
     * torn down must not walk it: the generation was checked before the batch left, and the answer
     * arrives arbitrarily later. Bodies already in the air still land in the store; nothing new
     * leaves. A body another read of it may still answer is left to that one, and one another read
     * failed gets that failure rather than a second ask of a refusing route (`bodyOmitted`).
     */
    const alone: string[] = [];
    for (const id of missing) {
      const next = this.bodyOmitted(id);
      if (next === "ask") { alone.push(id); continue; }
      if (next === "wait") continue;
      await this.failBody(id, next.err);
      this.bodiesDecided([id]);
    }
    for (const id of alone) {
      if (stopped?.() === true) return;
      const a = this.bodyAsks.get(id);
      if (a?.landed === true) continue;   // an open's read answered it meanwhile
      await this.fetchBodyInto(id, urgent || a?.asked === true);
    }
  }

  /**
   * How many bodies may be in the air at once. `bodyRequests` single-flights per MESSAGE — the wrong axis for the
   * caller that matters: the Screener preview hydrates every held message of a sender in one effect, so forty held
   * messages opened forty requests in one tick, none of them duplicates. On screen that was the reported defect: a
   * burst overrunning the connection limit turns into plain-text dumps beside one or two rendered frames — it looks
   * like the viewer failing on threads; it is the fan-out.
   */

  /**
   * A human jumps the queue on either fact that means somebody is waiting for THIS message: `retry: true` (a person
   * pressing "try again") and `urgent: true` (the shell saying a message was just OPENED — the body that is the whole
   * screen must not queue behind a preview backlog); both arrive as one `urgent` parameter, two flags at the call
   * site because only one may also re-ask a server that refused (`hydrateBody`). The slot is released in `finally`,
   * including on rejection — a leaked slot starves every later hydration, silently.
   */
  protected bodySlot<T>(urgent: boolean, run: (urgent: boolean) => Promise<T>, ids: readonly string[] = []): Promise<T> {
    if (urgent || this.bodyActive < MAX_CONCURRENT_BODIES) {
      this.bodyActive++;
      return run(urgent).finally(() => {
        this.bodyActive--;
        this.bodyQueue.shift()?.start();
      });
    }
    return new Promise<T>((resolve, reject) => {
      this.bodyQueue.push({
        ids,
        // `promoted`: an open let it go now, so its read is the person's.
        start: (promoted = false) => {
          this.bodyActive++;
          run(promoted).then(resolve, reject).finally(() => {
            this.bodyActive--;
            this.bodyQueue.shift()?.start();
          });
        },
      });
    });
  }

  /**
   * Let a waiting request for this message go NOW — the other half of "an open always jumps". `hydrateBody`
   * single-flights per message, and the eager pass registers hundreds of ids queued NON-urgently — so opening one of
   * those found the existing promise and waited behind slots of work nobody was watching: urgency was decided at
   * creation and never revisited, making "urgent opens jump the queue" false in exactly the case the prefetch
   * created. So urgency is re-decided on demand: the entry is pulled out of the queue and started immediately,
   * including exceeding {@link MAX_CONCURRENT_BODIES} by one, which is what "urgent" has always meant here. A no-op
   * when the id is not waiting (running already, or done). A BATCH entry is promoted whole — its ids travel in one
   * request, the same shape a thread open has always had.
   */
  protected promoteBodyRequest(messageId: string): void {
    const at = this.bodyQueue.findIndex((e) => e.ids.includes(messageId));
    if (at < 0) return;
    const [entry] = this.bodyQueue.splice(at, 1);
    entry!.start(true);
  }

  /** Register a read of `ids` in the single-flight map and in {@link bodyAsks}; `asked`: it is the person's. */
  protected trackBodies(ids: readonly string[], request: Promise<void>, asked: boolean): void {
    for (const id of ids) {
      this.bodyRequests.set(id, request);
      this.bodyAsks.set(id, {
        asked, left: false, urged: false, reads: 1, pending: 1, landed: false, failure: null, decided: null,
      });
    }
  }

  /** Did an open arrive for any of `ids` before its read left? Then it leaves as the person's. */
  protected bodiesUrged(ids: readonly string[]): boolean {
    return ids.some((id) => this.bodyAsks.get(id)?.urged === true);
  }

  /** The reads of `ids` left the engine's queue; `urgent`: as the person's. */
  protected bodiesLeft(ids: readonly string[], urgent: boolean): void {
    for (const id of ids) {
      const a = this.bodyAsks.get(id);
      if (a === undefined) continue;
      a.left = true;
      if (urgent) a.asked = true;
    }
  }

  /**
   * An in-flight read of this body, JOINED — and hurried first when the person waits for it (`urgent`:
   * an open or a retry; `shown`: a sibling on screen), see {@link hurryBody}. `null` when none is out.
   * An open that raced a background read waits for the record, not for that read.
   */
  protected joinBody(id: string, hurry: "urgent" | "shown" | null): Promise<void> | null {
    const inFlight = this.bodyRequests.get(id);
    if (inFlight === undefined) return null;
    if (hurry !== null && this.hurryBody(id, hurry === "urgent")) return this.raceBodies([id], false);
    return this.bodyAsks.get(id)?.decided?.promise ?? inFlight;
  }

  /**
   * MAKE THE READ OF A BODY SOMEBODY IS WAITING FOR THE PERSON'S, wherever it is. Still in the engine's
   * queue: an urgent ask lets it go now ({@link promoteBodyRequest}); a thread sibling keeps its turn, as it
   * always has. Not left yet (its marker is being written): it leaves as the person's. Already out as a
   * background read: `true`, and the caller sends the person's own read beside it ({@link raceBodies}).
   * The engine cannot tell a read on the wire from one held where it cannot see: the web's resume lane
   * holds background reads behind its cap after a return, so joining one made an open wait for a slot or
   * the lane's three-second bound. Nothing when the read already is the person's, when an answer has
   * landed, or when the body on screen is already whole (a re-read).
   */
  protected hurryBody(id: string, urgent: boolean): boolean {
    if (this.bodyQueue.some((e) => e.ids.includes(id))) {
      if (urgent) this.promoteBodyRequest(id);
      return false;
    }
    const a = this.bodyAsks.get(id);
    if (a === undefined || a.asked || a.landed) return false;
    if (this.read().get<MessageBodyRecord>("message_body", id)?.state === "ready") return false;
    if (!a.left) { a.urged = true; return false; }
    a.asked = true;
    return true;
  }

  /**
   * THE PERSON'S OWN READ, beside a background read of the same bodies already out ({@link hurryBody}):
   * sent at once and marked (`{ urgent: true }`, `priority: "high"` on the web's wire), one request for a
   * thread's siblings (`batch`). Whichever answer lands first writes each record and the other is dropped
   * ({@link bodyAnswered}): one write, no flicker. Resolves once every record is decided.
   */
  protected raceBodies(ids: string[], batch: boolean): Promise<void> {
    const decided: Array<Promise<void>> = [];
    for (const id of ids) {
      const a = this.bodyAsks.get(id)!;
      a.reads += 1;
      a.pending += 1;
      if (a.decided === null) {
        let resolve: () => void = () => {};
        const promise = new Promise<void>((r) => { resolve = r; });
        a.decided = { promise, resolve };
      }
      decided.push(a.decided.promise);
    }
    const fetchBodies = this.fetchBodiesFn;
    const read = batch && fetchBodies !== null
      ? this.bodySlot(true, () => this.fetchBodiesInto(ids, fetchBodies, undefined, true))
      : Promise.all(ids.map((id) => this.bodySlot(true, () => this.fetchBodyInto(id, true)))).then(() => undefined);
    void read.finally(() => this.settleBodies(ids));
    return Promise.all(decided).then(() => undefined);
  }

  /** A body answered `id`: write it (`true`), unless another read's answer landed first. */
  protected bodyAnswered(id: string): boolean {
    const a = this.bodyAsks.get(id);
    if (a === undefined) return true;
    a.pending -= 1;
    if (a.landed) return false;
    a.landed = true;
    return true;
  }

  /**
   * A read of `id` failed: write the failure (`true`) only when no other answer can still bring the body.
   * One still to come keeps the marker, and the failure waits for it ({@link settleBodies}): a failed open
   * beside a background read must not read "couldn't load" over a body that is on its way.
   */
  protected bodyFailed(id: string, err: unknown): boolean {
    const a = this.bodyAsks.get(id);
    if (a === undefined) return true;
    a.pending -= 1;
    if (a.landed) return false;
    if (a.pending > 0) {
      a.failure = { err };
      return false;
    }
    a.landed = true;
    return true;
  }

  /**
   * A batch answer left `id` out: `"ask"` it alone (the per-id tail), `"wait"` for the other read of it
   * still out or already answered, or the failure another read of it heard — written rather than asking a
   * refusing route again.
   */
  protected bodyOmitted(id: string): "ask" | "wait" | { err: unknown } {
    const a = this.bodyAsks.get(id);
    if (a === undefined) return "ask";
    a.pending -= 1;
    if (a.landed || a.pending > 0) return "wait";
    if (a.failure !== null) {
      a.landed = true;
      return a.failure;
    }
    a.pending += 1;   // the read about to leave
    return "ask";
  }

  /** The records of `ids` an answer wrote: an open that raced for them waits no longer. */
  protected bodiesDecided(ids: readonly string[]): void {
    for (const id of ids) {
      const a = this.bodyAsks.get(id);
      if (a?.landed === true) a.decided?.resolve();
    }
  }

  /**
   * A read of `ids` settled. With the last read of a body its entries go: a failure that waited for another
   * answer and got none is written first, then the single-flight entry is cleared and a raced open settles.
   */
  protected async settleBodies(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const a = this.bodyAsks.get(id);
      if (a !== undefined) {
        a.reads -= 1;
        if (a.reads > 0) continue;
        if (!a.landed && a.failure !== null) {
          a.landed = true;
          await this.failBody(id, a.failure.err);
        }
        this.bodyAsks.delete(id);
        a.decided?.resolve();
      }
      this.bodyRequests.delete(id);
    }
  }

  /**
   * Unsubscribe this message's sender (RFC 8058 one-click, performed server-side). A passthrough
   * to the adapter, because there is nothing to reconcile into the mirror — the effect lives at a
   * third party, and the record of "we already asked" is the SERVER's `unsubscribe_records`
   * table, not a client entity. Returns `null` when the adapter serves no unsubscribe (the
   * FixturesAdapter — the demo, a test with no API), so a surface offers no control rather than a
   * dead one. A refusal REJECTS with the server's own sentence (`MutationRejectedError`), which
   * is the string the surface renders.
   */
  async unsubscribe(messageId: string): Promise<UnsubscribeResult | null> {
    if (!this.adapter.unsubscribe) return null;
    return this.adapter.unsubscribe(messageId);
  }

  /**
   * THE WRITE IS INSIDE THE TRY, WHICH IS NOT A TIDY-UP: `putBody` reaches IndexedDB, and IndexedDB refuses: a quota
   * that is full, a private window, a connection closed by a version change, an `IdbMirrorStore` whose owner moved. A
   * write outside the `try` propagates that refusal out of `hydrateBody` — breaking the "WHY IT NEVER REJECTS"
   * contract stated above it, in a React effect, where the outcome is an unhandled rejection over somebody's mailbox.
   * Everything that can throw is inside, and the failure arm has its own guard: see {@link OhmailEngine.failBody}.
   * The `loading` marker is NO LONGER WRITTEN HERE. It moved up to {@link markLoading}, which runs at enqueue rather
   * than at departure — see there for the window that closed.
   */
  protected async fetchBodyInto(messageId: string, urgent = false): Promise<void> {
    this.bodiesLeft([messageId], urgent);
    let wire: Awaited<ReturnType<EngineAdapter["fetchBody"]>>;
    try {
      wire = await (urgent ? this.adapter.fetchBody(messageId, { urgent: true }) : this.adapter.fetchBody(messageId));
    } catch (err) {
      // Not while another read of this body may still answer it (`bodyFailed`).
      if (this.bodyFailed(messageId, err)) {
        await this.failBody(messageId, err);
        this.bodiesDecided([messageId]);
      }
      return;
    }
    // Another read of this body landed first (an open's, beside a background one): its record stands,
    // and this answer is dropped — never a second write.
    if (!this.bodyAnswered(messageId)) return;
    try {
      // `null` ⇒ this adapter serves no bodies (the fixtures world): tombstone the loading marker rather than leaving
      // a surface saying "loading…" for ever — `bodyOf` falls back to the snippet, the honest answer for an adapter
      // with no endpoint. `html` rides along UNTOUCHED: this is the one hop between the wire and the renderer and it
      // must stay a carry — sanitizing here would put attacker markup through a transform no surface can see, written
      // into the mirror. `?? null` is about the KEY existing, not the value: it maps `undefined` (a field this
      // adapter did not answer) onto the `null` that MEANS "no html", so a record this engine wrote always carries
      // the key — `hydrateBody` decides a record predates the html part from `html === undefined`, and a write that
      // left the field absent would poll for ever.

      // `EngineAdapter.fetchBody` is a seam with four implementations and no compiler check, so loop termination must
      // be the engine's property, not one adapter's manners — proven: this file's own double answers `{ text }`
      // alone, and two "a READY body is not re-fetched" tests went red the moment `hydrateBody` learned to distrust
      // an absent key.
      await this.putBody(
        messageId,
        wire === null
          ? null
          : {
              messageId,
              state: "ready",
              text: wire.text,
              html: wire.html ?? null,
              loadedRemoteContent: wire.loadedRemoteContent === true,
              // The unsubscribe posture rides the same ready record. `HttpAdapter.fetchBody`
              // already normalised the wire (default `"no_header"` / `null`); `?? …` here keeps
              // a bare test double or the FixturesAdapter — which answer `{ text }` — honest.
              unsubscribe: wire.unsubscribe ?? "no_header",
              unsubscribeUrl: wire.unsubscribeUrl ?? null,
              // The server's withheld marker, ALWAYS written — `null` when the body is
              // ordinarily stored, never omitted. The record stays `ready` (the server ANSWERED,
              // so the single-flight ledger and every "a READY body is not re-fetched" rule
              // apply unchanged) and `bodyOf` derives the terminal `withheld` surface state from
              // the marker, never from emptiness. Writing the key unconditionally is what lets
              // the guard below distinguish "not withheld" from "never asked by a build that
              // could tell", and so what makes the pre-slice heal happen ONCE and stop.
              withheld: withheldMarkerOf(wire.withheld),
              // A build that sheds this husk on its message's change says so (`MessageBodyRecord.capRefill`).
              ...(wire.withheld === "storage_cap" ? { capRefill: true as const } : {}),
            },
      );
    } catch (err) {
      await this.failBody(messageId, err);
    }
    this.bodiesDecided([messageId]);
  }

  /**
   * Record that this body could not be read — the state the surfaces render as "couldn't load the full message" with
   * a Retry beside it. ITS OWN WRITE IS GUARDED, AND THAT IS THE POINT OF SPLITTING IT OUT. This runs on the arm that
   * already knows something has gone wrong, and it reaches the same IndexedDB that may be the thing going wrong. A
   * throw from here would escape `fetchBodyInto`'s `catch` — there is no outer one — and reject `hydrateBody`, so the
   * mirror refusing a write would turn a reportable failure into an unhandled rejection. Swallowed deliberately: the
   * record keeps whatever it held, `hydrateBody` still resolves, the single-flight entry is still cleared by the
   * `.finally` above it, and the reader can ask again.
   */
  protected async failBody(messageId: string, err: unknown): Promise<void> {
    try {
      await this.putBody(messageId, this.failedBodyRecord(messageId, err));
    } catch {
      /* the mirror refused the failure record too; see above — never rethrow */
    }
  }

  /**
   * A WHOLE BATCH'S REFUSAL, UNDER ONE BUMP. One request carried every id, so its throw is each
   * of their refusals — and writing them one at a time would re-derive the mailbox once per id on
   * the arm that is already going badly. Swallowed for {@link failBody}'s reason: this reaches the
   * same mirror that may be the thing failing, and a throw here would escape into an unhandled
   * rejection over somebody's mailbox.
   */
  protected async failBodies(ids: ReadonlyArray<string>, err: unknown): Promise<void> {
    try {
      await this.putBodies(ids.map((id) => ({ id, record: this.failedBodyRecord(id, err) })));
    } catch {
      /* the mirror refused the failure records too; see above — never rethrow */
    }
  }


  /**
   * MAIL HELD AT THE GATE BEHIND A RULE ITS OWNER ALREADY WROTE — ask the door, put the answer in
   * the mirror.
   *
   * The groups are a SERVER derivation over rules and folder state, not something a client can work
   * out: the mirror knows a message is at the gate and knows the rules, but not who placed it there
   * — the very fact that decides this. So a shell that derived the number itself would show one
   * figure and release another. The whole set is replaced under ONE version bump ({@link
   * MirrorStore.commitLocal}), because a half-old list is a wrong number on screen.
   *
   * A door that cannot answer leaves the mirror EMPTY, which every surface reads as "no release row
   * here" — never as zero held mail, which is a different sentence.
   */
  /**
   * WHY THESE STAYED — the server's reading of the rule pass's leave-alone set for named messages,
   * asked when the sender sheet shows a finished rule with mail left elsewhere. Not mirrored. A door
   * that cannot answer, or fails, answers nothing: the sheet then names no reason, never a wrong one.
   */
  /**
   * WHAT OHMAIL FILED OUT OF THE SCREENER ON ITS OWN, still where it put it — asked, never mirrored.
   * A door that cannot answer, or fails, answers `null`: the surface then says nothing.
   */
  async autoFiled(): Promise<AutoFiledWire | null> {
    const ask = this.adapter.autoFiled;
    if (!ask) return null;
    try {
      return await ask.call(this.adapter);
    } catch {
      return null;
    }
  }

  /** PUT BACK: the named filings go back to the Screener for good. A refusal throws, for the surface to say. */
  async putBackAutoFiled(ids: readonly string[]): Promise<AutoFiledUndoWire> {
    const press = this.adapter.undoAutoFiled;
    if (!press || ids.length === 0) return { putBack: [], requested: [] };
    return press.call(this.adapter, ids);
  }

  async whyStayed(ids: readonly string[]): Promise<Map<string, StayedWhy>> {
    const ask = this.adapter.whyStayed;
    if (!ask || ids.length === 0) return new Map();
    // EVERY ROW IS ASKED, a page of the route's ceiling at a time: a line counting only the first
    // page would read "100 stay" over 150. One page failing answers nothing, never a partial count.
    const out = new Map<string, StayedWhy>();
    try {
      for (let at = 0; at < ids.length; at += WHY_STAYED_PAGE) {
        for (const r of await ask.call(this.adapter, ids.slice(at, at + WHY_STAYED_PAGE))) out.set(r.id, r.why);
      }
    } catch {
      return new Map();
    }
    return out;
  }

  async refreshHeldReleases(): Promise<void> {
    const ask = this.adapter.heldReleases;
    if (!ask) return;
    const h = this.heldRelease;
    h.armed = true;
    const seq = ++h.seq;
    const stamp = this.settingsStamp();
    const rang = h.rang;
    const wire = await ask.call(this.adapter);
    // A later ask went out while this one was in the air, and its answer is the newer statement:
    // an older one landing last would bring back an offer the account already dismissed.
    if (seq !== h.seq) return;
    // The stamp this answer was asked UNDER, never the one at arrival: a doorbell that rang while
    // the read was in the air may not be reflected in it, so the next settle asks again.
    h.stamp = stamp;
    h.answered = rang;
    h.owed = false;
    const before = this.read().list<HeldReleaseGroupDTO>(HELD_RELEASE_TYPE);
    const senders = wire.senders ?? [];
    // Contact-only mail is claimed by no rule, so it is disjoint from the groups' distinct total.
    const total = wire.total + senders.reduce((n, s) => n + s.count, 0);
    // An older door sends neither: "" reads "not dismissable here", false "not dismissed".
    const set = { total, fingerprint: wire.fingerprint ?? "", dismissed: wire.dismissed === true };
    const rows = [
      ...wire.groups.map((g): HeldReleaseGroupDTO => ({
        id: g.ruleId, kind: g.kind, match: g.match,
        destination: g.destination as HeldReleaseGroupDTO["destination"], count: g.count, ...set,
      })),
      ...senders.map((s): HeldReleaseGroupDTO => ({
        id: `sender:${s.sender}`, sender: s.sender, kind: "sender", match: s.sender,
        destination: "INBOX", count: s.count, ...set,
      })),
    ];
    const keep = new Set(rows.map((g) => g.id));
    await this.store.commitLocal(
      rows.map((g) => ({ type: HELD_RELEASE_TYPE, id: g.id, entity: g })),
      before.filter((g) => !keep.has(g.id)).map((g) => ({ type: HELD_RELEASE_TYPE, id: g.id })),
    );
    this.notify();
  }

  /**
   * MAIL THAT LANDED AT THE GATE IN THIS PAGE, by sender — collected only once a surface asked, and
   * judged at the settle ({@link ringHeldReleaseBell}) against the rules the mirror holds then, so
   * a rule arriving in the same pull as its sender's mail counts. Past the cap the settle asks
   * without judging: one read, however large the pull.
   */
  protected noteGateArrivals(changes: SyncChange[]): void {
    const h = this.heldRelease;
    if (!h.armed) return;
    for (const ch of changes) {
      if (ch.type !== "message" || ch.op === "delete" || h.arrivals.size >= HELD_ARRIVALS_MAX) continue;
      const m = ch.entity as EngineMessage | undefined;
      const address = m?.from?.address;
      if ((ch.move?.to ?? m?.folder) === FOLDER_OF_VIEW.screener && address) h.arrivals.add(address);
    }
  }

  /**
   * Does a decision in the mirror name one of these senders — held mail, as far as a client can
   * tell. THE LOCAL RULES ONLY, deliberately: the held-release offer is served for mailboxes this
   * install organizes (`held-release-service.ts`), and their decisions are the local rule entities.
   */
  protected heldArrivalDecided(senders: ReadonlySet<string>): boolean {
    const index = consentIndex(rulesList(this.read()));
    for (const address of senders) if (decidedDestination(index, address) !== null) return true;
    return false;
  }

  /** The settings entity's stamp off the mirror, or null before the first one lands. */
  protected settingsStamp(): string | null {
    const [row] = this.store.entries<{ updatedAt?: string }>("settings");
    return row ? String(row.entity?.updatedAt ?? "") : null;
  }

  /**
   * THE DOORBELL FOR THE OFFER — called at every drain's settle. A dismissal (or any settings write)
   * on another device moves the settings stamp, and held mail arriving grows the set, so the pull
   * that carried either re-asks the one door; the server answers `dismissed` by its own rule and
   * every device reads the same answer. Only once a surface asked, so a pull with nothing to say
   * costs nothing. Never awaited: reads are never hostage to an offer. A failed ask leaves the
   * stamp and the ring behind, and the next settle asks again.
   */
  protected ringHeldReleaseBell(): void {
    const h = this.heldRelease;
    if (h.arrivals.size > 0) {
      if (h.arrivals.size >= HELD_ARRIVALS_MAX || this.heldArrivalDecided(h.arrivals)) h.rang++;
      h.arrivals.clear();
    }
    if (!h.armed || h.bell !== null) return;
    if (!h.owed && h.rang === h.answered && this.settingsStamp() === h.stamp) return;
    h.bell = this.refreshHeldReleases()
      .catch(() => { /* an offer: the next settle asks again */ })
      .finally(() => { h.bell = null; });
  }

  /**
   * DID THIS PAGE CHANGE WHAT THE TWO OFFERS COUNT? Both count rules whose past-mail walk has
   * ended or that asked for none (`held-release-service.ts#decidedRule`), and every mailbox. A
   * rule entering or leaving that state, or a mailbox delete, owes both a re-ask at the settle.
   * A rule arriving with its walk still running is not one: it is counted when the walk ends.
   * The undecided-sender offer also follows any mailbox or settings change, and Ohbox mail
   * coming or going (a first import fills it page by page), the last throttled.
   */
  protected noteOfferChanges(changes: SyncChange[]): void {
    const settled = (r: RuleDTO | null | undefined): boolean =>
      r != null && r.enabled !== false && (r.retro === undefined || r.retro.requestedAt === null || r.retro.doneAt !== null);
    const u = this.unscreenedAsk;
    for (const ch of changes) {
      if (ch.type === "message") {
        if (!u.ohboxDue && this.touchesOhbox(ch)) u.ohboxDue = true;
        continue;
      }
      if (ch.type === "settings" || (ch.type === MAILBOX_TYPE && ch.op !== "delete")) {
        u.owed = true;
        continue;
      }
      const removed = ch.type === MAILBOX_TYPE && ch.op === "delete";
      const walked = ch.type === "rule" && settled(this.store.record("rule", ch.id)?.entity as RuleDTO | undefined)
        !== settled(ch.op === "delete" ? null : ch.entity as RuleDTO | undefined);
      if (!removed && !walked) continue;
      this.heldRelease.owed = true;
      u.owed = true;
    }
  }

  /** Is the Ohbox this message's folder before the change or after it? Read before the apply. */
  protected touchesOhbox(ch: SyncChange): boolean {
    const folderOf = (e: unknown): unknown => (e as { folder?: unknown } | null | undefined)?.folder;
    return folderOf(this.store.record("message", ch.id)?.entity) === OHBOX_FOLDER
      || (ch.op !== "delete" && folderOf(ch.entity) === OHBOX_FOLDER)
      || ch.move?.from === OHBOX_FOLDER || ch.move?.to === OHBOX_FOLDER;
  }

  /**
   * The undecided-sender offer's bell, rung at the settle like the held-release one; never awaited.
   * An owed ask goes at once; Ohbox mail waits out {@link UNSCREENED_REASK_MS} since the last ask and
   * is made at the first settle after it — the surfaces' poll, empty or not (the engine owns no
   * timer). A failed ask stays owed.
   */
  protected ringUnscreenedBell(): void {
    const u = this.unscreenedAsk;
    if (!u.armed || u.bell !== null || (!u.owed && !u.ohboxDue)) return;
    if (!u.owed && (u.askedAt ?? -Infinity) + UNSCREENED_REASK_MS > this.now().getTime()) return;
    const owed = u.owed;
    const due = u.ohboxDue;
    u.bell = this.refreshUnscreened()
      .catch(() => { u.owed ||= owed; u.ohboxDue ||= due; })
      .finally(() => { u.bell = null; });
  }

  /**
   * "NOT NOW" — dismiss the offer AS READ. The fingerprint is taken off the mirror rows this
   * surface showed, never re-derived, so a set that changed since the read stays offered. The
   * re-read afterwards is what removes the row from every surface of this device; other devices
   * drop it on their next pull, because the dismissal rings the settings doorbell ({@link
   * ringHeldReleaseBell}). A door with no dismiss verb, or a mirror with no fingerprint
   * (an older server), is a no-op — the button that calls this is not offered there.
   */
  async dismissHeldRelease(): Promise<void> {
    const press = this.adapter.dismissHeldRelease;
    if (!press) return;
    const [first] = this.read().list<HeldReleaseGroupDTO>(HELD_RELEASE_TYPE);
    const fingerprint = first?.fingerprint ?? "";
    if (fingerprint === "") return;
    await press.call(this.adapter, fingerprint);
    await this.refreshHeldReleases();
  }

  /**
   * THE PRESS. Releases the named groups — or every group when `ruleIds` is omitted — and decides
   * the named contact-only `senders` into the Ohbox (none when omitted), then re-reads.
   *
   * The re-read is not a courtesy: the server files nothing synchronously (it records the consent
   * and re-opens the rule's backlog; the rule engine moves the mail on its own pass), so the only
   * honest thing the screen can do straight afterwards is say what is left to release. Returns the
   * distinct message count the press released, which is what a surface reports.
   */
  async releaseHeldMail(ruleIds?: readonly string[], senders?: readonly string[]): Promise<number> {
    const press = this.adapter.releaseHeld;
    if (!press) return 0;
    const out = await press.call(this.adapter, ruleIds, senders);
    await this.refreshHeldReleases();
    return out.total;
  }

  /**
   * OHBOX MAIL FROM SENDERS NOBODY EVER DECIDED ABOUT — ask the door, put the answer in the mirror.
   * The deciding fact is what the ARRIVAL GATE would answer, over rules and contacts the mirror
   * holds only part of, so a shell deriving the number itself would show one figure and move
   * another. The whole set is replaced under ONE version bump, because a half-old list is a wrong
   * number on screen. A door that cannot answer leaves the mirror EMPTY, which every surface reads
   * as "no such row here" — never as "nothing undecided", a different sentence.
   */
  async refreshUnscreened(): Promise<void> {
    const ask = this.adapter.unscreened;
    if (!ask) return;
    this.unscreenedAsk.armed = true;
    this.unscreenedAsk.owed = false;
    this.unscreenedAsk.ohboxDue = false;
    this.unscreenedAsk.askedAt = this.now().getTime();
    const wire = await ask.call(this.adapter);
    const before = this.read().list<UnscreenedGroupDTO>(UNSCREENED_TYPE);
    const keep = new Set(wire.groups.map((g) => g.address));
    const puts = wire.groups.map((g) => ({
      type: UNSCREENED_TYPE,
      id: g.address,
      entity: {
        id: g.address, count: g.count, newestAt: g.newestAt, total: wire.total,
        complete: wire.complete !== false,
      } satisfies UnscreenedGroupDTO,
    }));
    const gone = before.filter((g) => !keep.has(g.id)).map((g) => ({ type: UNSCREENED_TYPE, id: g.id }));
    // An answer equal to the stored rows moves nothing: no write, no version, no notify.
    if (gone.length === 0 && sameStoredEntities(this.store.entries(UNSCREENED_TYPE), puts)) return;
    await this.store.commitLocal(puts, gone);
    this.notify();
  }

  /**
   * THE PRESS. Screens the named sender groups — or every group shown when `addresses` is omitted
   * — and re-reads.
   *
   * The re-read is not a courtesy: the server moves nothing synchronously (it writes the intent
   * and the organizer's reconciler carries it out), so the only honest thing the screen can say
   * straight afterwards is what is left. Returns the message count the press screened, which is
   * what a surface reports. The press writes each message's move into the log, so one drain
   * after the answer shows the moved mail; never awaited, so the sentence is not held behind it.
   */
  async screenUnscreenedSenders(addresses?: readonly string[]): Promise<number> {
    const press = this.adapter.screenUnscreened;
    if (!press) return 0;
    const out = await press.call(this.adapter, addresses);
    void this.syncFresh().catch(() => { /* the press landed; the next poll catches up */ });
    await this.refreshUnscreened();
    return out.total;
  }

  /**
   * LETTERS IN NEWS OR RECEIPTS FROM SENDERS NOBODY LET IN — the pile's note, asked of the door each
   * time the pile is shown and never kept in the mirror, for the Ohbox offer's reason: the deciding
   * fact is the arrival gate's answer. `null` when this door has no such read, a server from before
   * piles included: its answer is the Ohbox's offer and does not say the pile back.
   */
  async pileUnscreened(pile: UnscreenedPileWire): Promise<{ total: number; atLeast: boolean } | null> {
    const ask = this.adapter.unscreened;
    if (!ask) return null;
    const wire = await ask.call(this.adapter, pile);
    if (wire.pile !== pile) return null;
    return { total: wire.total, atLeast: wire.complete === false };
  }

  /**
   * THE NOTE'S PRESS: screens the pile's letters from senders nobody let in, as the note counted
   * them. The server writes the intents and the organizer moves the mail, so the answer is what was
   * screened; one drain after it shows the moved letters, never awaited.
   */
  async screenPileUnscreened(pile: UnscreenedPileWire): Promise<number> {
    const press = this.adapter.screenUnscreened;
    if (!press) return 0;
    const out = await press.call(this.adapter, undefined, pile);
    void this.syncFresh().catch(() => { /* the press landed; the next poll catches up */ });
    return out.total;
  }

  /** Can this door read the waiting queue from the store at all? */
  screenerWaitingAvailable(): boolean {
    return typeof this.adapter.screenerWaiting === "function";
  }

  /**
   * HAS THE STORE SPOKEN FOR THE QUEUE YET? A mirror rebuilt at launch (the desktop window) holds no
   * page until the first answer, and its own derivation lists senders the store does not, so a
   * surface withholds the queue until this is true. Also true once the newest ask was refused (the
   * device's own derivation then stands) and on a door with no store queue at all.
   */
  screenerWaitingSettled(): boolean {
    return !this.screenerWaitingAvailable() || this.screenerWait.settled;
  }

  /** The first answer or refusal of the newest ask: published, since an empty answer writes nothing. */
  protected settleScreenerWaiting(): void {
    if (this.screenerWait.settled) return;
    this.screenerWait.settled = true;
    this.notify();
  }

  /**
   * THE SCREENER'S WAITING QUEUE, FROM THE STORE — ask the door for the first page and replace the
   * mirror's copy under ONE version bump. The mirror is windowed and the queue is not, so the set
   * and its count are the store's. An answer that states no count and is not the whole queue (an
   * older server) clears the copy, so the surface falls back to this device's own derivation.
   */
  async refreshScreenerWaiting(): Promise<void> {
    const ask = this.adapter.screenerWaiting;
    if (!ask) return;
    const w = this.screenerWait;
    w.armed = true;
    w.dirty = false;
    const seq = ++w.seq;
    let wire;
    w.asking += 1;
    try {
      wire = await ask.call(this.adapter, { limit: SCREENER_WAITING_PAGE });
    } catch (err) {
      if (seq === w.seq) {
        w.dirty = true;
        this.settleScreenerWaiting();
      }
      throw err;
    } finally {
      w.asking -= 1;
    }
    if (seq !== w.seq) return;
    // An answer asked after a decision's confirm that lists its subject reopens the question.
    let forgot = false;
    for (const [id, d] of this.kept) {
      if (!relistedBy(d, seq, wire.items.map((i) => i.address))) continue;
      this.kept.delete(id);
      forgot = true;
    }
    if (forgot) this.overlayRev++;
    const total = wire.total ?? (wire.nextCursor === null ? wire.items.length : null);
    const puts: Array<{ type: string; id: string; entity: ScreenerWaitingDTO }> = [];
    if (total !== null) {
      const seen = new Set<string>();
      for (const item of wire.items) {
        const key = senderKey(item.address);
        if (seen.has(key)) continue;
        seen.add(key);
        puts.push({ type: SCREENER_WAITING_TYPE, id: `sender:${key}`, entity: waitingRow(item, seen.size - 1, total) });
      }
      const page: ScreenerWaitingPageDTO = {
        id: SCREENER_WAITING_PAGE_ID, kind: "page", total, nextCursor: wire.nextCursor,
        inFlight: wire.inFlight, ask: seq, rows: puts.length,
        ...(this.queueStaysBehind(wire) ? { copyBehind: true as const } : {}),
        ...(wire.gone !== undefined ? { gone: wire.gone } : {}),
      };
      puts.push({ type: SCREENER_WAITING_TYPE, id: SCREENER_WAITING_PAGE_ID, entity: page });
    }
    // The complement is read off the STORE, never the overlaid view: a row an overlay hides is
    // still on disk and would come back when the overlay retires.
    const keep = new Set(puts.map((p) => p.id));
    const stored = this.store.entries(SCREENER_WAITING_TYPE);
    const gone = stored.filter((e) => !keep.has(e.id))
      .map((e) => ({ type: SCREENER_WAITING_TYPE, id: e.id }));
    // An answer equal to the stored queue moves nothing. The page row's `ask` and `walked` are left
    // out of the comparison: the web's onward walk keys on the ask, and an unchanged page keeps
    // both it was written under.
    if (gone.length === 0 && sameStoredEntities(stored, puts, PAGE_IS_NOT_CONTENT)) {
      if (forgot || !w.settled) {
        w.settled = true;
        this.notify();
      }
      return;
    }
    await this.store.commitLocal(puts, gone);
    w.settled = true;
    this.notify();
  }

  /**
   * ONE PAGE OF THE QUEUE FOR A SURFACE THAT WALKS IT — the web past the page the mirror holds, the
   * phone every page (`cursor` null is the first). Never written to the mirror (a sender row here
   * is a REST row, not mirror state). `null` from a door that cannot read the queue. Each
   * representative is remembered so a decision on it is sent even though the mirror has no row.
   */
  async screenerWaitingPage(cursor: string | null): Promise<{
    senders: ScreenerWaitingSenderDTO[]; nextCursor: string | null; pendingDecisions?: unknown[];
  } | null> {
    const ask = this.adapter.screenerWaiting;
    if (!ask) return null;
    const wire = await ask.call(this.adapter, cursor === null ? { limit: SCREENER_WAITING_PAGE } : { cursor, limit: SCREENER_WAITING_PAGE });
    const [page] = this.store.entries<ScreenerWaitingDTO>(SCREENER_WAITING_TYPE)
      .filter((e) => e.id === SCREENER_WAITING_PAGE_ID);
    const total = page?.entity?.kind === "page" ? page.entity.total : 0;
    for (const item of wire.items) {
      this.screenerPageReps.delete(item.messageId);
      this.screenerPageReps.add(item.messageId);
    }
    for (const id of this.screenerPageReps) {
      if (this.screenerPageReps.size <= SCREENER_PAGE_REPS_MAX) break;
      this.screenerPageReps.delete(id);
    }
    /* A PAGE LEAVING OUT OTHER MAILBOXES THAN THE STORED ONE (a removal since it was asked): the stored
       page's silence about them reads as "let in", so it is asked again and this page records no walk. */
    const stored = page?.entity?.kind === "page" ? page.entity : undefined;
    if (stored !== undefined && !sameGone(stored.gone, wire.gone)) {
      await this.refreshScreenerWaiting().catch(() => { /* marked dirty: the next settle asks again */ });
    } else if (cursor !== null) await this.noteQueueWalk(cursor, wire);
    return {
      senders: wire.items.map((item, i) => waitingRow(item, i, total)), nextCursor: wire.nextCursor,
      ...(wire.pendingDecisions ? { pendingDecisions: wire.pendingDecisions } : {}),
    };
  }

  /**
   * A PAGE THAT CONTINUES THE MIRROR'S PAGE IS THE STORE SPEAKING PAST IT: record how far the walk
   * has read on the page row, so the partition and the segments stop holding an unlisted sender
   * the pages have passed ({@link queueCoverage}). Only the next page of this walk counts, and a
   * walk past {@link SCREENER_WALK_LISTED_MAX} senders stops recording rather than forget any.
   */
  protected async noteQueueWalk(cursor: string, wire: ScreenerWaitingWire): Promise<void> {
    const row = this.store.entries<ScreenerWaitingDTO>(SCREENER_WAITING_TYPE)
      .find((e) => e.id === SCREENER_WAITING_PAGE_ID)?.entity;
    if (row?.kind !== "page") return;
    if ((row.walked ? row.walked.nextCursor : row.nextCursor) !== cursor) return;
    const listed = new Set(row.walked?.listed ?? []);
    for (const item of wire.items) listed.add(senderKey(item.address));
    if (listed.size > SCREENER_WALK_LISTED_MAX) return;
    const last = wire.items[wire.items.length - 1];
    const walked = { edge: last?.receivedAt ?? row.walked?.edge ?? "", listed: [...listed], nextCursor: wire.nextCursor };
    await this.store.commitLocal([{ type: SCREENER_WAITING_TYPE, id: SCREENER_WAITING_PAGE_ID, entity: { ...row, walked } }], []);
    this.notify();
  }

  /** Does the stored queue page say the door's copy is behind ({@link ScreenerWaitingPageDTO.copyBehind})? */
  protected queueBehind(): boolean {
    const row = this.store.record(SCREENER_WAITING_TYPE, SCREENER_WAITING_PAGE_ID)?.entity as ScreenerWaitingDTO | null | undefined;
    return row?.kind === "page" && row.copyBehind === true;
  }

  /**
   * DOES THIS ANSWER'S PAGE KEEP THE HOLD ({@link heldAheadOfTheCopy})? While the door says its copy
   * is behind, yes. The first answer that stops saying so keeps it too, until a drain that BEGAN after
   * that answer has settled: only then does this window's copy hold everything the door's copy held
   * when it caught up, so a sender decided elsewhere is not released ahead of the rule that files them.
   */
  protected queueStaysBehind(wire: ScreenerWaitingWire): boolean {
    const w = this.screenerWait;
    if (wire.copyBehind === true || !this.queueBehind()) {
      w.caughtUpAt = null;
      return wire.copyBehind === true;
    }
    w.caughtUpAt ??= this.drainEpoch;
    if (this.settledEpoch <= w.caughtUpAt) return true;
    w.caughtUpAt = null;
    return false;
  }

  /** A new ask, superseding any in the air; never awaited, and a failure waits for the next settle. */
  protected reaskScreenerWaiting(): void {
    void this.refreshScreenerWaiting().catch(() => { /* the next settle asks again */ });
  }

  /** Did this page touch what the queue is derived from? Read BEFORE the write, like the others. */
  protected noteQueueChanges(changes: SyncChange[]): void {
    const w = this.screenerWait;
    if (!w.armed || w.dirty) return;
    const gate = FOLDER_OF_VIEW.screener;
    for (const ch of changes) {
      // A mailbox_profile change can move an organizer's window (RULING-026), which the store's queue reads.
      if (ch.type === "rule" || ch.type === "settings" || ch.type === "mailbox" || ch.type === "mailbox_profile") {
        w.dirty = true;
        return;
      }
      if (ch.type !== "message") continue;
      const now = ch.entity as EngineMessage | undefined;
      const was = this.store.record("message", ch.id)?.entity as EngineMessage | null | undefined;
      // Own sent mail makes its recipient a correspondent, whom the queue stops asking about.
      if (ch.move?.to === gate || ch.move?.from === gate || now?.folder === gate || was?.folder === gate
          || (now !== undefined && isOwnSent(now))) {
        w.dirty = true;
        return;
      }
    }
  }

  protected async putBody(messageId: string, record: MessageBodyRecord | null): Promise<void> {
    await this.store.putLocal("message_body", messageId, record);
    this.holdBody(messageId, record?.state === "ready");
    this.notePlacementBodies([{ id: messageId, record }]);
    this.notify();
    await this.trimBodyCache();
  }

  /**
   * A BODY THAT CAN RE-PLACE ITS MESSAGE MOVES {@link placementStamp}: the partition reads the
   * text of a message whose sender a body-term rule names (`messagePlacement`), and the window's
   * whole-mirror derivations key on a stamp that ignores bodies. Any other body leaves it alone.
   */
  protected notePlacementBodies(entries: ReadonlyArray<{ id: string; record: MessageBodyRecord | null }>): void {
    const read = this.read();
    for (const e of entries) {
      const m = read.get<EngineMessage>("message", e.id);
      if (m !== undefined && namedByBodyTerm(read, m.from.address)) {
        this.placementBodyVersion = read.version();
        return;
      }
    }
  }

  /**
   * MANY BODIES, ONE VERSION BUMP — the batch twin of {@link putBody}.
   *
   * Every `putLocal` bumps the mirror version and every `notify` re-runs the shell's whole-mirror
   * derivations, so a per-body write makes the eager pass a derivation storm: measured on a large
   * mailbox, every body was written twice and every write cost a whole-mirror pass — minutes of one
   * core, and resident memory from 177 MB to 1.5 GB. `commitLocal` already writes an
   * array under one `ver++`, so a batch costs one pass whatever its size. An empty batch writes
   * nothing and bumps nothing — `commitLocal` returns early, which is what keeps a chunk whose
   * every id was skipped from re-deriving the mailbox.
   */
  protected async putBodies(
    entries: ReadonlyArray<{ id: string; record: MessageBodyRecord | null }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.store.commitLocal(
      entries.map((e) => ({ type: "message_body", id: e.id, entity: e.record })),
      [],
    );
    for (const e of entries) this.holdBody(e.id, e.record?.state === "ready");
    this.notePlacementBodies(entries);
    this.notify();
    await this.trimBodyCache();
  }

  /**
   * WHAT THIS SESSION HOLDS, after one write. Membership and not an order — the order that
   * decides an eviction is the message date. Only a `ready` record occupies a slot: a purge or a
   * failure writes no mail, so it must GIVE ONE BACK, or the bound would be paid by bodies that
   * are still there while records holding nothing were counted as if they were.
   */
  protected holdBody(messageId: string, ready: boolean): void {
    if (ready) this.heldBodies.add(messageId);
    else this.heldBodies.delete(messageId);
  }

  /**
   * COUNT WHAT THE LOAD RESTORED — {@link holdBody} for the bodies this session did not fetch.
   *
   * `store.load()` brings every persisted `message_body` back into the mirror and nothing used to
   * add their ids to {@link heldBodies}, so the trim saw only this session's own fetches: one
   * session persisted up to {@link BODY_CACHE_MAX}, the next restored them uncounted and filled
   * the bound again, and the persisted set grew by a bound per restart. A read of the ids already
   * in memory, never of the mail; only a `ready` record occupies a slot, as after any write.
   */
  protected countRestoredBodies(): void {
    for (const { id, entity } of this.store.entries<MessageBodyRecord>("message_body")) {
      this.holdBody(id, entity.state === "ready");
    }
  }

  /**
   * DROP THE OLDEST MAIL'S BODIES BACK TO {@link BODY_CACHE_MAX} — oldest by MESSAGE DATE.
   *
   * The order is the invariant. The eager window is "the newest {@link EAGER_BODIES_MAX}", so a
   * cache that keeps anything else is a cache the pass disagrees with, and the two then trade the
   * same ids every drain — which is what write recency did here, for ever, on an idle mailbox.
   * Date, through the {@link olderFirst} order the pass itself takes, makes the keep-set and the
   * want-set the same set.
   *
   * A DELETE and not a tombstone: an absent record is "never asked", so the next open re-fetches
   * the body from the store on this machine, while a tombstone would read as "asked, and there is
   * nothing" and the mail would render empty for ever. One `commitLocal` for the lot, so a trim
   * costs one derivation rather than one per body.
   */
  protected async trimBodyCache(): Promise<void> {
    if (this.trimmingBodies) return; // a concurrent batch is already trimming — see the latch
    if (this.heldBodies.size <= BODY_CACHE_MAX) return;
    /**
     * COUNTED FROM THE HELD SET AND DATED BY KEYED READS, NEVER BY A STORE SCAN.
     * `entries("message")` goes through `bucketsOf`, which rebuilds every type bucket whenever the
     * version has moved — and the write that brought us here just moved it. `get` is a map lookup
     * against the same records and rebuilds nothing, so dating the held set costs one lookup per
     * held body rather than the O(mailbox) pass batching the writes removed.
     */
    const owed = this.heldBodies.size - BODY_CACHE_MAX;
    const view = this.read();
    const dated: Array<{ id: string; t: number }> = [];
    for (const id of this.heldBodies) {
      // Never the mail under the reader's eyes: the same hold that keeps the windowed prune off
      // those rows (`renderedIds`). A pinned id stays and an older one is evicted in its place.
      if (this.renderedIds.has(id)) continue;
      const msg = view.get<EngineMessage>("message", id);
      // No row at all — the mirror dropped the message and this body is holding nothing anybody
      // can open. 0 is the oldest there is, so it goes first.
      dated.push({ id, t: msg === undefined ? 0 : messageTime(msg) });
    }
    dated.sort(olderFirst);
    const victims = dated.slice(0, owed).map((d) => d.id);
    if (victims.length === 0) return;
    this.trimmingBodies = true;
    try {
      await this.store.commitLocal([], victims.map((id) => ({ type: "message_body", id })));
      for (const id of victims) this.heldBodies.delete(id);
      // An evicted text that placed its message leaves it undecided again: that moves the stamp.
      this.notePlacementBodies(victims.map((id) => ({ id, record: null })));
      this.notify();
    } finally {
      this.trimmingBodies = false;
    }
  }

  /**
   * The `failed` record, without writing it — so the batch arm can commit many under one bump and
   * the single arm can keep its own guarded write. See {@link failBody} for why that write is
   * swallowed.
   */
  protected failedBodyRecord(messageId: string, err: unknown): MessageBodyRecord {
    return {
      messageId,
      state: "failed",
      text: "",
      html: null,
      loadedRemoteContent: false,
      error: err instanceof Error ? err.message : String(err),
      // WHEN, so a reload can tell this failure apart from one this session already made and
      // refused to repeat. See {@link MessageBodyRecord.failedAt} and `bodyPlan`'s failed arm.
      failedAt: this.now().getTime(),
    };
  }
}

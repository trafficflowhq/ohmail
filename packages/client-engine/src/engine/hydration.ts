import { mirrorStale } from "@trafficflow/core/drain-policy";
import { canonicalDestination, isSentFolderPath } from "@trafficflow/core/folder-name";
import { ruleMatchKey } from "@trafficflow/core/rule-order";
import { heldRuleKey } from "../rule-twins.js";
import { rulesList } from "../selectors.js";
import { replaceRecordedSentFolders } from "../sent-folders.js";
import {
  encodeSeqCursor, type EngineDraft, type EngineMessage, type EngineMutation, MAILBOX_TYPE, MutationRejectedError,
  type RuleDTO, type RuleKeyAddress, type SyncChange, type SyncSnapshotPage,
} from "../types.js";
import { WIRE_KIND } from "./ceilings.js";
import type {
  AppliedRuleRequest, OrganizerRequestView, UnsettledRulePress, WaitingOnOrganizerView,
} from "./mutation-views.js";
import {
  EAGER_BODIES_MAX, EAGER_BODIES_SLICE, LAST_DRAIN_AT_META, ORGANIZER_REQUEST_SLOW_MS, ORGANIZER_REQUESTS_REREAD_MS,
  RECEIVED_MESSAGES_META, SENT_FOLDERS_META, SNAPSHOT_PREFIX_SEQ_META, STORE_POLICY_GENERATION,
  STORE_POLICY_GENERATION_META, WINDOW_REFILL_OWED_META,
} from "./options.js";
import { EnginePastEnd } from "./past-end.js";
import { messageTime, olderFirst } from "./server-wire.js";

export abstract class EngineHydration extends EnginePastEnd {
  // ── eager recent-window hydration ──────────────────────────────────────────

  /**
   * Start (or queue) one eager pass — see {@link EngineOptions.eagerBodies} and the {@link EAGER_BODIES_MAX}/{@link
   * EAGER_BODIES_SLICE} bounds. Called by the SHELL's scheduler after a settled drain, deliberately not by `drain()`
   * itself: the engine owns the mechanism, the driver owns WHEN background work is welcome — the first wiring had
   * `drain()` fire it, and every bare `syncOnce()` in a test (and every discarded engine whose drain settled after
   * teardown) issued body fetches from behind the caller's back, the "requests on behalf of nobody" shape the gate
   * refuses; the opt-in flag makes even the ask a no-op until the embedder means it.
   */

  /**
   * Single-flight with ONE queued re-run: a kick during a pass must not stack passes, and must not be lost either —
   * the drain that kicked may have applied mail the running pass's snapshot predates; one boolean is exactly "run
   * once more with fresh eyes", and a settled mailbox's re-run costs nothing (every id plans to `skip`). Never
   * rejects: failures land as per-id `failed` records exactly as an explicit open's would.
   */
  prefetchRecentBodies(): Promise<void> {
    if (!this.eagerBodiesOn) return Promise.resolve();
    /*
     * NOT WHILE THE MIRROR IS STILL CATCHING UP. The pass asks for the newest EAGER_BODIES_MAX
     * after every settled drain; during an import the newest N keeps MOVING, so each pass fetches
     * a thousand bodies the next one evicts — the pass and the BODY_CACHE_MAX evictor chasing each
     * other, the condition that bound was chosen to prevent. Measured over a large first import
     * arriving as polls: 3 549 of 3 770 whole-mirror derivations and 320 MB of a 525 MB peak, still
     * held after two full collects. A drain that needed more than one page was a catch-up; the
     * next poll that settles in one page runs the pass, so this defers the work rather than
     * dropping it, and a mailbox that is merely busy loses nothing.
     */
    if (!this.caughtUpInOnePage) return Promise.resolve();
    if (this.eagerRun) {
      this.eagerAgain = true;
      return this.eagerRun;
    }
    const gen = this.eagerGen;
    this.eagerRun = this.runEagerBodies(gen)
      .catch(() => {
        /* per-id failures are records the surfaces render; the pass has nothing to throw AT */
      })
      .finally(() => {
        this.eagerRun = null;
        const again = this.eagerAgain;
        this.eagerAgain = false;
        /*
         * THE QUEUED RE-RUN IS ALSO CANCELLED BY TEARDOWN, and it was not. `stopEagerBodies()`
         * bumps the generation, which the running pass checks between slices — but the re-run was
         * started from here unconditionally and then read the CURRENT generation, so a discarded
         * engine (a live→demo navigation swaps it) resumed fetching hundreds of bodies on behalf
         * of nobody, which is the exact shape the opt-in and the driver-owned kick exist to
         * prevent. The flag is consumed either way: it is a request for another pass in THIS
         * engine's life, not a standing order.
         */
        if (again && gen === this.eagerGen) void this.prefetchRecentBodies();
      });
    return this.eagerRun;
  }

  /**
   * ABORT the background pass between steps — a teardown's call (a live→demo navigation swaps
   * the engine; the discarded one must not keep fetching on behalf of nobody). Bodies already
   * in the air complete into the store; no new step starts. The next drain's kick resumes from
   * whatever is still missing, because the pass re-derives its want-list from the mirror.
   */
  stopEagerBodies(): void {
    this.eagerGen++;
  }

  /** Settles when no eager pass is in flight — the deterministic seam a test (or teardown) awaits. */
  async eagerBodiesIdle(): Promise<void> {
    while (this.eagerRun) await this.eagerRun;
  }

  /**
   * One pass: the mirror's newest {@link EAGER_BODIES_MAX} messages, offered to the SAME
   * admission and transport every explicit hydration uses ({@link bodyPlan} through
   * {@link hydrateMany}) — a ready body is never re-fetched, a failed one is never re-asked
   * within the session, protected and fixture-bodied rows issue nothing, and the four-wide
   * non-urgent slot queue is shared so an OPEN always jumps ahead. `rendered: false` is the one
   * divergence from a thread open, and it is load-bearing: a thousand prefetched ids must not
   * flush the {@link RENDERED_PINS} LRU that keeps the windowed prune off a message someone is
   * actually reading.
   */
  protected async runEagerBodies(gen: number): Promise<void> {
    /* AND ONLY WHEN THE MIRROR HAS MOVED SINCE THE LAST PASS. The ranking below reads every
       message in the mirror and SORTS it, and the shell kicks the pass after every settled drain —
       so a client nobody is writing to ranked its whole mailbox once per poll to pick the same
       window, offer the same ids and have every one of them refused by the admission as already
       held. {@link StoreReader.version} moves for any record write, bodies included, which is
       exactly the breadth this wants: a body that landed is one the pass no longer owes.
       Recorded only on a pass that RAN TO THE END — a teardown between slices leaves the want
       list unfinished, and latching there would drop the rest for the life of the engine. */
    const rankedAt = this.store.version();
    if (rankedAt === this.eagerRankedAt) return;
    const ranked = this.read()
      .entries<EngineMessage>("message")
      .map((e) => ({ id: e.id, t: messageTime(e.entity) }));
    // The SAME order {@link trimBodyCache} evicts by, read backwards — see {@link olderFirst}.
    ranked.sort((a, b) => olderFirst(b, a));
    const newest = ranked.slice(0, EAGER_BODIES_MAX);
    /**
     * ASK FOR WHAT THE CACHE CAN ACTUALLY HOLD. The trim never evicts a body the reader has open,
     * so every pinned message OLDER than this window is holding one of the {@link BODY_CACHE_MAX}
     * slots the pass would fill; asking for the full window anyway would have the pass and the
     * trim trade its oldest ranks on every drain, which is the loop this order exists to close.
     */
    const inWindow = new Set(newest.map((w) => w.id));
    let reserved = 0;
    for (const id of this.renderedIds) if (!inWindow.has(id) && this.heldBodies.has(id)) reserved += 1;
    const ids = newest.slice(0, Math.max(0, EAGER_BODIES_MAX - reserved)).map((w) => w.id);
    // The stop check is BETWEEN slices here and INSIDE the slice via `stopped` — a batch answer
    // the server truncated on its byte budget leaves a per-id tail of up to
    // {@link EAGER_BODIES_SLICE} single requests, and without a check in there a teardown between
    // the batch response and its tail let a discarded engine issue every one of them.
    const stopped = (): boolean => gen !== this.eagerGen;
    for (let i = 0; i < ids.length; i += EAGER_BODIES_SLICE) {
      if (stopped()) return;
      await this.hydrateMany(ids.slice(i, i + EAGER_BODIES_SLICE), { rendered: false, stopped });
    }
    // The pass reached the end of its own want list — see the note at the top.
    this.eagerRankedAt = this.store.version();
  }

  /**
   * A stale resume fetches the newest page before it replays its backlog. The delta feed is ascending-seq, so a
   * mirror resuming days stale replays oldest-first: the mail a returning user is looking for is in the LAST page.
   * Measured in production (2026-08-10): a full-log replay took 4 pages and 28.5 s, the newest message applying at
   * the very end, while `GET /sync/snapshot` page 1 (the newest messages plus ALL small state) answered in 509 ms —
   * on a real mailbox that reads as "the app takes minutes to show what I did on the other machine". So when {@link
   * LAST_DRAIN_AT_META} says no drain completed within {@link STALE_RESUME_MS}, snapshot page 1 is applied ROWS-ONLY
   * before the delta loop: Ohbox, counts and Screener are current after one round trip, and the backlog replays
   * behind content that is already right.
   */

  /**
   * Applying a snapshot page over a warm mirror is sound: snapshot rows carry `seq === asOfSeq`, ≥ every seq in the
   * backlog, so the backlog's replay of the same rows is refused by the older-or-equal guard; anything after the
   * snapshot read has a higher seq and wins; a row deleted while away is absent from the snapshot and the delta's
   * tombstone removes it. The CURSOR is never touched — committing `asOfSeq` here would skip every tombstone in the
   * backlog and keep ghosts for ever; the delta replay from the OLD cursor stays the mechanism of record, and
   * mutations are untouched (this is a READ overlay). Failure is swallowed and must not latch {@link
   * snapshotUnavailable} — that latch is the BOOTSTRAP probe's, and latching here on a transient would push a later
   * 410 re-bootstrap onto the full `since=0` replay for the life of the tab.
   */

  /**
   * A missing stamp on a warm cursor is stale: every pre-upgrade mirror, exactly the mailboxes that reported the
   * symptom; the arm fires at most once per such mirror.
   */
  /**
   * IS THIS DRAIN A STALE RESUME — a warm cursor whose last completed drain is older than
   * {@link STALE_RESUME_MS} (or was never stamped, the pre-upgrade-mirror arm the freshen
   * documents)? ONE predicate, two consumers with one condition by construction:
   * {@link OhmailEngine.freshenStaleResume} decides whether to fetch the newest page first,
   * and {@link OhmailEngine.drain} decides whether to ask for {@link BACKLOG_PAGE_LIMIT} pages
   * — a freshen without the dense drain leaves the convergence tail, a dense drain without the
   * freshen labels nothing, so the two firing on different verdicts would be a defect.
   */
  protected isStaleResume(): boolean {
    if (this.store.getCursor() === "0") return false; // a cold mirror is the bootstrap's, not ours
    // The COLD GATE above is this engine's own — "am I bootstrapping" is a fact about this
    // store's cursor, not about the policy — and the stamp comparison below is the shared one
    // the sidecar's mirror makes (`@trafficflow/core/drain-policy`), absent-is-stale arm and all.
    return mirrorStale(this.store.getMeta<string>(LAST_DRAIN_AT_META), this.now(), this.staleResumeMs);
  }

  protected async freshenStaleResume(): Promise<void> {
    if (!this.snapshotFn || this.snapshotUnavailable) return;
    if (!this.isStaleResume()) return;
    let page: SyncSnapshotPage;
    try {
      page = await this.readCeiling(this.snapshotFn({}));
    } catch {
      return; // the delta drain that follows is the source of truth, and of error reporting
    }
    this.noteApplied(page.changes);
    await this.store.applyChanges(page.changes); // rows only — the cursor is the delta's
    await this.persistReceived();
    this.notify();
  }

  /**
   * THE ONE-TIME RE-HYDRATION A WIDENED POLICY OWES A MIRROR IT ALREADY PRUNED. Pinning tagged
   * mail stops the next eviction and brings nothing back, and no delta will: the `message_tags`
   * change sits below this mirror's cursor. So a mirror stamped behind {@link
   * STORE_POLICY_GENERATION} walks the snapshot's LABELED TAIL once — `phase=tail`, bounded by
   * what somebody tagged by hand rather than by the mailbox.
   *
   * ROWS ONLY, on {@link OhmailEngine.freshenStaleResume}'s argument and for its reasons: the
   * cursor stays the delta's (committing `asOfSeq` would skip every tombstone below it), and
   * {@link SNAPSHOT_PREFIX_SEQ_META} is not claimed — that marker names a BOOTSTRAP's abandoned
   * prefix, and writing it here would make the next cold start sweep what this walk wrote.
   */
  protected async rehydrateForPolicy(): Promise<void> {
    if (this.store.getMeta<number>(STORE_POLICY_GENERATION_META) === STORE_POLICY_GENERATION) return;
    // A COLD MIRROR OWES NOTHING: the bootstrap below runs the whole snapshot, tail included.
    // Read as a fact about the cursor, like {@link isStaleResume}'s own cold gate.
    if (this.store.getCursor() === "0") return;
    // A `full` mirror evicted nothing to get back, and an adapter with no snapshot route has
    // nowhere to ask; both are stamped at the settle rather than walked.
    if (this.storePolicy.mode !== "windowed") return;
    if (!this.snapshotFn || this.snapshotUnavailable) return;

    const snapshot = this.snapshotFn;
    let cursor: string | undefined;
    let wrote = false;
    for (;;) {
      let page: SyncSnapshotPage;
      try {
        page = await this.readCeiling(snapshot({ phase: "tail", ...(cursor !== undefined ? { cursor } : {}) }));
      } catch {
        // NOT STAMPED. The delta drain that follows is the source of truth and of error
        // reporting; this mirror is owed the walk again on the next drain, which is the safe
        // direction — a stamp on a half-finished walk is the defect this method exists to end.
        this.policyWalkFailed = true;
        return;
      }
      if (page.changes.length > 0) {
        await this.store.applyChanges(page.changes);
        wrote = true;
      }
      if (page.nextCursor == null || page.nextCursor === "") break;
      cursor = page.nextCursor;
    }
    if (wrote) this.notify();
  }

  /** A `mailbox` receipt this mirror has not applied yet owes a windowed mirror its refill. */
  protected async noteRemovalOwesRefill(changes: SyncChange[]): Promise<void> {
    if (this.storePolicy.mode !== "windowed" || !this.snapshotFn) return;
    const news = changes.some((ch) => ch.type === MAILBOX_TYPE && ch.op === "delete"
      && !this.store.isTombstoned(MAILBOX_TYPE, ch.id));
    if (news) await this.store.setMeta(WINDOW_REFILL_OWED_META, true);
  }

  /**
   * THE REFILL a removal owes ({@link WINDOW_REFILL_OWED_META}): the snapshot walked ROWS ONLY,
   * applying what the mirror holds neither live nor as a tombstone — the rows the removed
   * mailbox's mail displaced. The cursor stays the delta's ({@link freshenStaleResume}'s
   * argument); a tombstone is never overwritten, so nothing the delta deleted comes back; the
   * settle prune then trims to the policy. Not counted as received: these rows were taken in
   * once already. A failed page leaves it owed. Answers whether it wrote anything.
   */
  protected async refillWindow(): Promise<boolean> {
    if (this.store.getMeta<boolean>(WINDOW_REFILL_OWED_META) !== true) return false;
    const snapshot = this.snapshotFn;
    if (this.storePolicy.mode !== "windowed" || !snapshot || this.snapshotUnavailable) {
      await this.store.setMeta(WINDOW_REFILL_OWED_META, false);
      return false;
    }
    let cursor: string | undefined;
    let wrote = false;
    for (;;) {
      let page: SyncSnapshotPage;
      try {
        page = await this.readCeiling(snapshot(cursor !== undefined ? { cursor } : {}));
      } catch {
        return wrote;
      }
      const missing = OhmailEngine.withoutSentDraftText(page.changes).filter((ch) =>
        this.store.get(ch.type, ch.id) === undefined && !this.store.isTombstoned(ch.type, ch.id));
      if (missing.length > 0) {
        await this.store.applyChanges(missing);
        wrote = true;
      }
      if (page.nextCursor == null || page.nextCursor === "") break;
      cursor = page.nextCursor;
    }
    await this.store.setMeta(WINDOW_REFILL_OWED_META, false);
    return wrote;
  }

  /**
   * THE ACCOUNT'S SCREENING CUTLINE, so the window can cover it. Dormancy is measured over the
   * WHOLE account on the server and over the MIRROR here, and those agree only while the mirror
   * holds every message the cutline reads — the dial offers 90, 180 and 365 days against a
   * 90-day window, so two of its three rungs put the cutline past it by a click, and a sender
   * whose only mail the window evicted is then retired into History while the Screener on
   * another device still asks about them.
   *
   * So {@link pruneToPolicy}'s age term keeps the WIDER of the two. `maxRows` is untouched and
   * still decides the size — the reason the ceiling exists. `all_time` retires nobody by age.
   * A host that never calls this gets today's window exactly.
   */
  setCutline(cutline: { dormancyDays?: number | null; scope?: string | null } | null): void {
    const days = cutline?.dormancyDays;
    // `Number.isFinite` and nothing else: it is the one part with a reachable contrary state.
    // A cutline NARROWER than the window (zero, negative, anything under `days`) is already
    // inert — `ageFloor` takes the wider of the two — so a bound on the low side would be a
    // condition nothing could ever be watched fail. `Infinity` and `NaN` are not inert: one
    // makes the age term keep the whole mailbox, the other makes every comparison against the
    // floor false and evicts it.
    const resolved = typeof days === "number" && Number.isFinite(days) ? days : null;
    // Anything not exactly `all_time` reads as the window — the client cutline's own rule, and
    // the safe failure direction here too (a narrower window, never a wider one, by accident).
    const allTime = cutline?.scope === "all_time";
    /* A NEW ANSWER IS A NEW AGE TERM, and no record moves to say so — see {@link cutlineGen}. Only
       a DIFFERENT answer, though: every caller re-states the cutline whenever its own consent read
       settles, and a shell that re-states the same answer per poll would bump this per poll and
       put the windowed prune back on a tick. */
    if (resolved !== this.cutlineDays || allTime !== this.cutlineAllTime) this.cutlineGen += 1;
    this.cutlineDays = resolved;
    this.cutlineAllTime = allTime;
  }

  /**
   * EACH MAILBOX'S RECORDED SENT FOLDER, from one whole `GET /mailboxes` read (never a failed
   * one): `isOwnSent` then knows a Sent folder by the server's own name ('Envoyés'). Kept only
   * when it is a non-empty path that is not INBOX and not already Sent-shaped; a mailbox left out
   * or stating `null` is cleared. A different statement bumps the overlay and notifies in one
   * turn, so every derivation re-runs; the same one returns false and changes nothing. Written
   * beside the mirror ({@link SENT_FOLDERS_META}) for the next start's first frame.
   */
  setSentFolders(mailboxes: Iterable<{ id: string; sentFolder?: string | null }>): boolean {
    const next = new Map<string, string>();
    for (const m of mailboxes) {
      if (OhmailEngine.keepsAsSent(m.sentFolder)) next.set(m.id, m.sentFolder);
    }
    this.sentFoldersLive = true;
    const changed = this.stateSentFolders(next);
    if (changed) this.notify();
    return changed;
  }

  protected static keepsAsSent(p: unknown): p is string {
    return typeof p === "string" && p !== "" && p.toUpperCase() !== "INBOX" && !isSentFolderPath(p);
  }

  /** Install a statement and write it beside the mirror; answers whether it differed. The caller notifies. */
  protected stateSentFolders(next: ReadonlyMap<string, string>, force = false): boolean {
    const pairs = [...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const stated = JSON.stringify(pairs);
    // Also when unchanged: a 410 wipe empties meta, and the next read writes it back.
    if (this.storeLoaded && JSON.stringify(this.store.getMeta(SENT_FOLDERS_META) ?? []) !== stated) {
      // A refused write costs the next start the round trip it had before; nothing else.
      this.store.setMeta(SENT_FOLDERS_META, pairs).catch(() => undefined);
    }
    if (!force && stated === this.sentFoldersStated) return false;
    this.sentFoldersStated = stated;
    replaceRecordedSentFolders(next);
    this.overlayRev++;
    return true;
  }

  /**
   * At hydration, before the publish: the mirror's stored statement becomes the module's — an empty
   * one too, so an engine over a wiped mirror never reads the previous account's. A statement made
   * before the load is written instead.
   */
  protected restoreSentFolders(): void {
    if (this.sentFoldersLive) {
      this.stateSentFolders(this.statedSentFolders());
      return;
    }
    const next = new Map<string, string>();
    const stored = this.store.getMeta<unknown>(SENT_FOLDERS_META);
    for (const pair of Array.isArray(stored) ? stored : []) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && OhmailEngine.keepsAsSent(pair[1])) next.set(pair[0], pair[1]);
    }
    this.stateSentFolders(next, true);
  }

  protected statedSentFolders(): Map<string, string> {
    return new Map(JSON.parse(this.sentFoldersStated) as Array<[string, string]>);
  }

  /** A `mailbox` removal receipt drops that mailbox's recorded Sent folder, in memory and on disk. */
  protected dropRemovedSentFolders(changes: SyncChange[]): void {
    const gone = new Set(changes.filter((ch) => ch.type === MAILBOX_TYPE && ch.op === "delete").map((ch) => ch.id));
    const stated = this.statedSentFolders();
    let dropped = false;
    for (const id of gone) dropped = stated.delete(id) || dropped;
    if (!dropped) return;
    this.sentFoldersLive = true;
    this.stateSentFolders(stated);
  }

  /**
   * The instant the windowed prune's AGE term measures back from: the wider of the policy's own
   * `days` and the cutline the account screens by. `-Infinity` under `all_time` — no age retires
   * anything, and the ceiling is the only bound left.
   */
  protected ageFloor(policyDays: number): number {
    if (this.cutlineAllTime) return Number.NEGATIVE_INFINITY;
    const windowCutoff = this.now().getTime() - policyDays * 86_400_000;
    if (this.cutlineDays === null) return windowCutoff;
    return Math.min(windowCutoff, this.now().getTime() - this.cutlineDays * 86_400_000);
  }

  /**
   * Fetch `GET /sync/snapshot` to completion, committing the cursor with the LAST page and not one page earlier.
   * Every page but the last goes through `applyChanges` (writes rows, never the cursor); only the last goes through
   * `applyResponse`, whose single flush carries the rows and the cursor together (contract §3.3 step 3). A restart
   * can observe two states only: cursor "0" — a prefix of the snapshot present, and the next drain re-snapshots (rows
   * carry `seq === asOfSeq`, so a re-read skips or overwrites them; it converges) — or cursor `asOfSeq`, the whole
   * snapshot landed. The fatal third state — a cursor past rows that never arrived — is unreachable, because nothing
   * but the final page can write the cursor at all.
   */

  /**
   * Resuming at `asOfSeq` misses nothing: it is the point the snapshot was READ at, identical on every page; changes
   * committed while paging have seqs above it and the delta drain picks them up.
   */

  /**
   * The paging token is never the cursor (`nextCursor` is opaque server state, passed straight
   * back), and the cursor is not a decimal: it is {@link encodeSeqCursor}'s base64url, NOT
   * `String(seq)` — measured, not assumed: the first version committed `String(asOfSeq)` and eight
   * `contract.test.ts` tests went red with `CursorExpiredError`, because `SyncService.decodeCursor`
   * base64url-decodes what it is given and a bare "900" decodes to non-digits, so every drain
   * after a snapshot 410'd. The two encoders are the same function on both sides of the wire and
   * must stay that way.
   */

  /**
   * A first-page failure falls back; a later one does not. Page 1 failing latches {@link snapshotUnavailable} and the
   * caller takes the `since=0` path every client used before — an engine whose cold start hard-fails on a missing
   * route is a mailbox rendering empty in silence (`http-adapter-binding.test.ts` exists because that shipped once).
   * The swallow cannot hide an outage: the very next call is `/sync` on the same origin, which still rejects through
   * the path that has always reported it. A LATER page's failure is rethrown, different in kind: rows carrying `seq
   * === asOfSeq` are already in the mirror, and `since=0` over them would be silently wrong — the seq guard drops
   * every replayed change at or below `asOfSeq`, so the unreached pages would never be delivered by either path and
   * the mirror would settle into a permanently truncated state that looks healthy.
   */

  /**
   * Rethrowing leaves the cursor at "0", so the next drain re-snapshots from page 1. An abandoned attempt's rows do
   * not survive into the next one — see {@link OhmailEngine.claimSnapshotPrefix}.
   */
  /**
   * Claim this snapshot's seq, and sweep an earlier attempt's rows before writing over them. A
   * snapshot says nothing about what it OMITS: attempt A (asOfSeq 100) applies pages 1–3 holding
   * message M, page 4 fails, cursor stays "0"; M is deleted at seq 150; attempt B (asOfSeq 200)
   * never mentions M — a snapshot states LIVE state — completes, and commits the cursor at 200. M
   * is now in the mirror for ever: its delete sits at 150, below the adopted cursor, and `/sync`
   * sends a delta once. Deleted mail comes back and stays — the store.ts persistence class, the
   * falsified fact being "the rows on disk belong to the snapshot the cursor names".
   */

  /**
   * The predicate is the seq: every row a snapshot emits carries that snapshot's `asOfSeq`, so one seq names one
   * attempt's output exactly. The seq of the on-disk prefix is written to {@link SNAPSHOT_PREFIX_SEQ_META} BEFORE the
   * first row is applied, and an attempt finding a DIFFERENT seq sweeps those records first ({@link
   * MirrorStore.pruneBySeq}, a hard delete — anything the new snapshot still carries is re-materialized by its own
   * pages). The alternative, remembering applied ids in a field, is the defect in another shape: the failure is a
   * process that stopped, and a list in that process's memory stops with it. `pruneBySeq` refuses seq 0, which
   * protects the durable outbox and hydrated bodies (client-local by construction); an empty log answers `asOfSeq: 0`
   * and is a no-op on both halves.
   */

  /**
   * The marker is NOT cleared on completion, deliberately: after the last page it is a true statement, its only
   * reader is this method at cursor "0", and `resetForBootstrap` clears meta anyway.
   */
  protected async claimSnapshotPrefix(asOfSeq: number): Promise<void> {
    const prior = this.store.getMeta<number>(SNAPSHOT_PREFIX_SEQ_META);
    if (typeof prior === "number" && prior !== asOfSeq) {
      // The prefix belongs to a snapshot taken at another point. It cannot be reconciled with
      // this one — a snapshot says nothing about what it omits — so it goes before this attempt
      // writes a single row over it.
      if (await this.store.pruneBySeq(prior)) this.notify();
    }
    // DURABLE BEFORE THE FIRST ROW, for the reason the whole class exists: a kill between this
    // write and the page's must leave a marker that names an attempt with no rows (harmless — the
    // sweep finds nothing), never rows with no marker (the defect above, unrecoverable). It goes
    // FIRST for that reason: every other write this method makes queues behind it.
    await this.store.setMeta(SNAPSHOT_PREFIX_SEQ_META, asOfSeq);
    // A BOOTSTRAP THE OLD MARKER DID NOT NAME HOLDS NONE OF THE MAIL THE COUNT STANDS FOR. Three
    // ways here: the prefix just swept above; a first-ever mirror, already zero; and a baseline
    // another tab wiped under this one, where meta went too and a written count would be the last
    // survivor of a mirror that is gone. A resumed attempt at the SAME seq keeps prefix and count.
    // Reachable only at cursor "0", where no delta rows stand above the prefix.
    if (prior !== asOfSeq) await this.resetReceived();
  }

  /**
   * A SENT DRAFT'S TEXT NEVER ENTERS THE COLD MIRROR — the client's half of a bound both sides
   * keep. An older server or a page replayed across a deploy can still hand this walk a sent
   * draft carrying its body, and no eviction pass takes a `draft` row back.
   */
  /**
   * `sent` ONLY: a `draft`, a `scheduled`, a `sending` and an `unverified` row are messages
   * somebody still owns, and compose seeds its editor from exactly that body.
   */
  protected static withoutSentDraftText(changes: SyncChange[]): SyncChange[] {
    return changes.map((ch) => {
      if (ch.type !== "draft" || ch.entity === undefined) return ch;
      /**
       * `html` is read STRUCTURALLY and not off {@link EngineDraft}, which does not declare it:
       * `applyToRecords` stores the server's DTO verbatim, so the rich half of every draft has
       * always been in the mirror under a key no client type names. A strip written against the
       * declared type would have taken the plain body and left the same words beside it.
       */
      const d = ch.entity as EngineDraft & { html?: string | null };
      if (d.status !== "sent") return ch;
      if (d.body === null && (d.html ?? null) === null) return ch;
      // The rest of the row is untouched: the sent list renders from it and the address book
      // learns its recipients from it. `html` goes with `body` — one message, two encodings.
      return { ...ch, entity: { ...d, body: null, html: null, bodyOmitted: "sent" } };
    });
  }

  /**
   * A PRUNE PER PAGE HERE TOO, once the drafts are in: every page carries the next drafts until
   * none are left, and a draft pins the message it answers — which may have landed pages earlier.
   * Before, the walk landed everything the door served and pruned once at the settle, so a door
   * serving past the window put its whole reach in the mirror at the peak.
   */
  /** True when the last page committed the cursor; false when the route is absent or latched off. */
  protected async runSnapshot(): Promise<boolean> {
    const snapshot = this.snapshotFn;
    if (!snapshot || this.snapshotUnavailable) return false;
    let cursor: string | undefined;
    let applied = false;
    let draftsIn = false;
    for (;;) {
      let page: SyncSnapshotPage;
      try {
        page = await this.readCeiling(snapshot(cursor !== undefined ? { cursor } : {}));
      } catch (err) {
        if (applied) throw err; // unsound to fall back — see the note above
        // A TIMEOUT SAYS NOTHING ABOUT THE ROUTE: latched, a dead connection would put this tab on
        // the `since=0` replay for its life. The drive fails as a drain, and the next one asks again.
        if (err instanceof MutationRejectedError && err.code === "timeout") throw err;
        this.snapshotUnavailable = true;
        return false; // nothing was written; `since=0` takes over
      }
      if (!applied) await this.claimSnapshotPrefix(page.asOfSeq);
      // Before the count and before the apply, so neither the received count nor the store ever
      // sees the bytes. See {@link OhmailEngine.withoutSentDraftText}.
      page = { ...page, changes: OhmailEngine.withoutSentDraftText(page.changes) };
      const last = page.nextCursor == null || page.nextCursor === "";
      if (last) {
        // Rows + cursor in ONE flush. The buckets are a formality: `flattenResponse` concatenates
        // all four and `applyToRecords` dispatches on each change's own `op`, so which bucket a
        // change sits in cannot affect the result. Snapshot changes are all `op:"create"`.
        this.noteApplied(page.changes);
        await this.store.applyResponse({
          changes: { creates: page.changes, updates: [], moves: [], deletes: [] },
          /* The run of the server's store goes into the cursor with the seq, from the LAST page
             — the one whose cursor is committed. A server that states none mints the cursor this
             client has always minted. See `SyncSnapshotPage.storeGeneration`. */
          cursor: encodeSeqCursor(page.asOfSeq, page.storeGeneration),
          hasMore: false,
          serverTime: this.now().toISOString(),
        });
        await this.persistReceived();
      } else {
        this.noteApplied(page.changes);
        await this.store.applyChanges(page.changes); // rows only — the cursor stays "0"
        await this.persistReceived();
        draftsIn ||= !page.changes.some((c) => c.type === "draft");
        // Every snapshot row carries `asOfSeq`, so no row is graced: a message's children ride
        // its own page, and the drafts gate above covers the one pin that does not.
        if (draftsIn) await this.pruneToPolicy(page.asOfSeq);
      }
      applied = true;
      this.notify();
      if (last) return true;
      cursor = page.nextCursor as string;
    }
  }

  /**
   * COUNT THE LIVE MESSAGE ROWS THIS PAGE BRINGS OR TAKES AWAY. Read against the mirror BEFORE the
   * apply, so a row it already holds adds nothing and a replayed page and a message's later updates
   * are free. A DELETE subtracts, and only for a row that was live: mail the server no longer holds
   * was not delivered, and without this the number would drift above the account's own count.
   * Together that makes it the mirror's row count wherever nothing is evicted — see
   * {@link receivedMessages} — and one change per id per page, resolved at the highest seq exactly
   * as `applyToRecords` resolves it.
   */
  /**
   * ONE ROAD FOR EVERY PAGE THIS ENGINE APPLIES — the row count and the organizer-request
   * settlement both hang off it, so a new apply site cannot bring changes in past one of them.
   * Called BEFORE the write, which is right for both: the count reads the mirror as it stood, and
   * the settlement only needs to know the confirming change has arrived.
   */
  protected noteApplied(changes: SyncChange[]): void {
    this.countReceived(changes);
    this.settleOrganizerRequests(changes);
    // While anything waits, each page asks the list again: the organizer's act arrives as a page.
    if (changes.length > 0) this.waitingRefused = false;
    if (changes.length > 0 && this.somethingWaits()) this.refreshWaitingOnOrganizer();
    this.noteMessagesRemoved(changes);
    this.noteGateArrivals(changes);
    this.noteStoreChanges(changes);
    this.noteQueueChanges(changes);
    this.noteOfferChanges(changes);
    this.storePages.adopt(changes);
  }

  /**
   * DID THIS PAGE CHANGE THE STORE'S LIST — read before the apply, like the count. Mail the mirror
   * has no record of (a new message, or one a coalesced page carries as its latest update), or a
   * message taken away that was not already a tombstone here. A row the mirror holds changing in
   * place is a page cache adoption, not a change of list. An open History re-reads on it.
   */
  protected noteStoreChanges(changes: SyncChange[]): void {
    if (changes.some((ch) => ch.type === "message" && (ch.op === "delete"
      ? this.store.record("message", ch.id)?.entity !== null
      : this.store.record("message", ch.id) === undefined))) {
      this.storeChangesRev += 1;
    }
  }

  /**
   * WHICH MESSAGES THIS PAGE TAKES AWAY — told to whoever asked, BEFORE the write, which is the
   * whole of why this hangs off {@link noteApplied}: a listener's business is with what the row
   * still lets it derive (its mailbox, a reply's audience, the subject), and after the apply the
   * row is a tombstone carrying none of it. The webapp's reply-lane promotion is the consumer.
   *
   * Deduped, and NOT gated on the row being live: the lane is keyed on the id, so a message this
   * device had already evicted is still one somebody may be answering.
   */
  protected noteMessagesRemoved(changes: SyncChange[]): void {
    if (this.removalListeners.size === 0) return;
    const ids = [...new Set(
      changes.filter((ch) => ch.type === "message" && ch.op === "delete").map((ch) => ch.id),
    )];
    if (ids.length === 0) return;
    for (const l of this.removalListeners) {
      // A listener that throws is a listener's defect, never a reason to abandon a drain
      // mid-page — the apply below it is what keeps this mirror convergent.
      try { l(ids); } catch { /* the consumer's own problem */ }
    }
  }

  /**
   * SETTLE EVERY QUEUED REQUEST THIS PAGE CONFIRMS, and nothing else. A request whose confirming
   * change is not in this page stays exactly where it was — absence of news is not confirmation.
   */
  protected settleOrganizerRequests(changes: SyncChange[]): void {
    if (this.organizerQueue.size === 0 || changes.length === 0) return;
    let settled = false;
    for (const [id, r] of this.organizerQueue) {
      if (!changes.some((ch) => OhmailEngine.confirmsOrganizerRequest(r.mutation, ch))) continue;
      this.organizerQueue.delete(id);
      settled = true;
    }
    if (settled) {
      this.overlayRev++;
      this.notify();
    }
  }

  /**
   * DOES THIS CHANGE SAY THE ORGANIZER CARRIED THAT REQUEST OUT? Per verb, and deliberately
   * narrow: a move is confirmed by the message arriving IN the folder that was asked for (a move
   * elsewhere is somebody else's act, not this request's), a delete by its tombstone, a screener
   * decision by its sender's own row. Any other kind answers `false` and the request keeps
   * waiting — a guess here would be the settling-on-nothing this path exists to end.
   */
  protected static confirmsOrganizerRequest(m: EngineMutation, ch: SyncChange): boolean {
    switch (m.kind) {
      case "move": {
        if (ch.type !== "message" || ch.id !== m.messageId || ch.op === "delete") return false;
        const to = ch.move?.to ?? (ch.entity as EngineMessage | undefined)?.folder;
        return to === m.folder;
      }
      case "message_delete":
        return ch.type === "message" && ch.id === m.messageId && ch.op === "delete";
      case "screener_decide":
        return ch.type === "screener_sender" && ch.id === m.senderId;
      // A rule request is confirmed by the rule's own change saying what was asked: the row gone,
      // the row filing where the change asked (an edit by somebody else is not this request's), or
      // a row under the created key (the organizer applies a create of an existing key as an edit).
      case "rule_delete":
        return ch.type === "rule" && ch.id === m.ruleId && ch.op === "delete";
      case "rule_update": {
        if (ch.type !== "rule" || ch.id !== m.ruleId || ch.op !== "update") return false;
        const r = ch.entity as RuleDTO | undefined;
        return r !== undefined && canonicalDestination(r.destination) === canonicalDestination(m.destination);
      }
      case "rule_create": {
        if (ch.type !== "rule" || ch.op === "delete") return false;
        const r = ch.entity as RuleDTO | undefined;
        return r !== undefined && r.kind === m.ruleKind && ruleMatchKey(r.match) === ruleMatchKey(m.match)
          && (r.subjectContains ?? null) === (m.subjectContains ?? null)
          && (r.bodyContains ?? null) === (m.bodyContains ?? null);
      }
      default:
        return false;
    }
  }

  /**
   * WHAT IS WAITING ON THE ORGANIZER, oldest first — the surface's read. `slow` is the only thing
   * time decides here: past {@link ORGANIZER_REQUEST_SLOW_MS} the sentence changes and the
   * request does not.
   */
  organizerRequests(): OrganizerRequestView[] {
    const now = this.now().getTime();
    return [...this.organizerQueue.values()]
      .sort((a, b) => a.at - b.at)
      .map((r) => ({
        id: r.id,
        key: r.key,
        kind: r.mutation.kind,
        messageId: "messageId" in r.mutation ? r.mutation.messageId : null,
        queuedWith: r.queuedWith,
        requestId: r.requestId,
        at: new Date(r.at).toISOString(),
        slow: now - r.at >= ORGANIZER_REQUEST_SLOW_MS,
      }));
  }

  /**
   * WHAT WAITS ON THE ORGANIZER, as every surface lists it — the server's list (`GET
   * /organizer-requests`, the record that outlives this session) merged with the requests this
   * session sent and the server has not listed yet, keyed by request id; the server's state wins.
   * Newest first. A request the server lists as over is not in it; a refusal is, for a day. The
   * first read asks the server; an answer settles the in-session queue.
   */
  waitingOnOrganizer(): WaitingOnOrganizerView[] {
    if (!this.waitingAsked) this.refreshWaitingOnOrganizer();
    const now = this.now().getTime();
    const rules = rulesList(this.read());
    const ruleIdOf = (k: { kind: string; match: string; subjectContains: string | null; bodyContains: string | null }): string | null =>
      rules.find((r) => r.kind === k.kind && ruleMatchKey(r.match) === ruleMatchKey(k.match)
        && (r.subjectContains ?? null) === k.subjectContains && (r.bodyContains ?? null) === k.bodyContains)?.id ?? null;
    const out: WaitingOnOrganizerView[] = [];
    const listed = new Set<string>();
    for (const w of this.waitingServer ?? []) {
      listed.add(w.id);
      if (w.state === "applied" || w.state === "expired") continue;
      // Refused behind a newer decision on the organizer: that decision owns the sentence. A
      // `stale` refusal (the request outlived the window) is still listed, as it always was.
      if (w.state === "refused" && w.refusedReason === "superseded") continue;
      const t = w.target as Record<string, unknown>;
      const rule = (t.rule ?? null) as { kind: string; match: string; subjectContains: string | null; bodyContains: string | null } | null;
      out.push({
        requestId: w.id, kind: w.kind, state: w.state, holder: w.holder, mailboxId: w.mailboxId, decidedAt: w.decidedAt,
        refusedReason: w.refusedReason, target: w.target,
        ruleId: rule ? ruleIdOf(rule) : null,
        messageId: typeof t.messageId === "string" ? t.messageId : null,
        slow: w.state !== "refused" && now - Date.parse(w.decidedAt) >= ORGANIZER_REQUEST_SLOW_MS,
      });
    }
    for (const r of this.organizerQueue.values()) {
      // Listed by the server under any of its ids: the server's rows speak for this press.
      if (r.requestIds.some((id) => listed.has(id))) continue;
      const m = r.mutation;
      out.push({
        requestId: r.requestId, kind: WIRE_KIND[m.kind] ?? m.kind, state: "pending", holder: r.queuedWith, mailboxId: null,
        decidedAt: new Date(r.at).toISOString(), refusedReason: null, target: { unknown: true },
        ruleId: "ruleId" in m ? m.ruleId : null,
        messageId: "messageId" in m ? m.messageId : null,
        slow: now - r.at >= ORGANIZER_REQUEST_SLOW_MS,
      });
    }
    return out.sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt));
  }

  /**
   * THE RULE REQUESTS THE LAST `GET /organizer-requests` READ ANSWERED `applied` — what a reader-only
   * Rules page lays over a published copy that may not include them yet. The first call asks, as
   * {@link waitingOnOrganizer} does; no timer of its own.
   */
  appliedRuleRequests(): AppliedRuleRequest[] {
    if (!this.waitingAsked) this.refreshWaitingOnOrganizer();
    return (this.waitingServer ?? [])
      .filter((w) => w.state === "applied" && w.kind.startsWith("rule."))
      .map((w) => ({
        requestId: w.id, kind: w.kind, mailboxId: w.mailboxId, decidedAt: w.decidedAt, resolvedAt: w.resolvedAt, target: w.target,
      }));
  }

  /**
   * THIS INSTALL'S RULE PRESSES NOT APPLIED YET, newest first: the outbox and the wire (pressed
   * last), then the requests this session holds, then the server's pending and sent ones. A press
   * planned over a published copy reads these, which the copy cannot show yet.
   */
  unsettledRulePresses(): UnsettledRulePress[] {
    const out: UnsettledRulePress[] = [];
    const ofMutation = (m: EngineMutation): UnsettledRulePress | null => {
      if (m.kind === "rule_create") {
        return { kind: "rule.create", destination: m.destination, key: {
          kind: m.ruleKind, match: m.match, subjectContains: m.subjectContains ?? null, bodyContains: m.bodyContains ?? null,
        } };
      }
      if (m.kind !== "rule_update" && m.kind !== "rule_delete") return null;
      const row = m.key ?? heldRuleKey(m.ruleId) ?? this.storeTruth.get<RuleDTO>("rule", m.ruleId);
      if (!row) return null;
      const key = { kind: row.kind, match: row.match, subjectContains: row.subjectContains ?? null, bodyContains: row.bodyContains ?? null };
      return m.kind === "rule_delete"
        ? { kind: "rule.delete", key, destination: null }
        : { kind: "rule.update", key, destination: m.destination };
    };
    const local = [...this.queue, ...this.inFlight.values()].sort((a, b) => b.at - a.at || b.n - a.n);
    for (const p of local) { const u = ofMutation(p.mutation); if (u) out.push(u); }
    const held = [...this.organizerQueue.values()].sort((a, b) => b.at - a.at);
    const heldIds = new Set(held.flatMap((r) => r.requestIds));
    for (const r of held) { const u = ofMutation(r.mutation); if (u) out.push(u); }
    const server = (this.waitingServer ?? [])
      .filter((w) => (w.state === "pending" || w.state === "sent") && !heldIds.has(w.id))
      .sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt));
    for (const w of server) {
      const t = w.target as { rule?: RuleKeyAddress; destination?: string };
      if (!t.rule || (w.kind !== "rule.create" && w.kind !== "rule.update" && w.kind !== "rule.delete")) continue;
      out.push({ kind: w.kind, key: t.rule, destination: w.kind === "rule.delete" ? null : t.destination ?? null });
    }
    return out;
  }

  /**
   * ASK THE SERVER WHAT WAITS, coalesced: one read in flight at a time, a second ask during it runs
   * once more after it. A request the answer lists as over (applied, expired or refused) leaves the
   * in-session queue: the server row is the settle of record when no change says so. Never throws.
   */
  refreshWaitingOnOrganizer(): void {
    const ask = this.adapter.organizerRequests?.bind(this.adapter);
    if (!ask) return;
    this.waitingAsked = true;
    if (this.waitingAsk) { this.waitingAgain = true; return; }
    this.lastWaitingReadAt = this.now().getTime();
    this.waitingAsk = (async () => {
      try {
        const rows = await ask();
        this.waitingRefused = false;
        this.waitingServer = rows;
        // A press the server lists, under every id it made, is the server's to say from now on:
        // its rows carry the state, so the session's entry leaves rather than speak twice.
        const listed = new Set(rows.map((w) => w.id));
        for (const [id, r] of this.organizerQueue) {
          if (r.requestIds.length > 0 && r.requestIds.every((rid) => listed.has(rid))) this.organizerQueue.delete(id);
        }
        this.overlayRev++;
        this.notify();
      } catch {
        // A refused read is not retried on a clock: a page with changes or a queued press asks again.
        this.waitingRefused = true;
      } finally {
        this.waitingAsk = null;
        if (this.waitingAgain) { this.waitingAgain = false; this.refreshWaitingOnOrganizer(); }
      }
    })();
  }

  /**
   * THE SURFACE'S CADENCE ASKS, the engine owns no timer: the web scheduler's tick and the phone's
   * drain round call this after their sync. It reads only while something waits, not under
   * {@link ORGANIZER_REQUESTS_REREAD_MS} since the last read, and never after a refused read until
   * a page with changes or a queued press clears it. A no-op where the adapter lists nothing.
   */
  pollWaitingOnOrganizer(): void {
    if (!this.adapter.organizerRequests || !this.somethingWaits() || this.waitingRefused) return;
    if (this.now().getTime() - this.lastWaitingReadAt < ORGANIZER_REQUESTS_REREAD_MS) return;
    this.refreshWaitingOnOrganizer();
  }

  /** Is anything listed or queued as waiting — what keeps the drain asking again. */
  protected somethingWaits(): boolean {
    return this.organizerQueue.size > 0
      || (this.waitingServer ?? []).some((w) => w.state === "pending" || w.state === "sent");
  }

  protected countReceived(changes: SyncChange[]): void {
    this.restoreReceivedCount();
    /* A MAILBOX RECEIPT IS READ FIRST AND IT IS AUTHORITATIVE. One `mailbox` delete stands for
       every message that mailbox had (`store.ts#cascadeMailboxRemoval`), so this number has to
       move by all of them — left out, the window went on reporting the removed mailbox's mail as
       received. Its own arm rather than a case in the loop below, because the loop counts per
       CHANGE and this counts per ROW: the page names the mailbox, the mirror names the mail. */
    const removedMailboxes = new Set<string>();
    for (const ch of changes) {
      if (ch.type === MAILBOX_TYPE && ch.op === "delete") removedMailboxes.add(ch.id);
    }
    const inRemoved = (id: string, ch: SyncChange): boolean => {
      if (removedMailboxes.size === 0) return false;
      const named = (ch.entity as { mailboxId?: unknown } | undefined)?.mailboxId;
      const owner = typeof named === "string"
        ? named
        : this.store.get<EngineMessage>("message", id)?.mailboxId;
      return typeof owner === "string" && removedMailboxes.has(owner);
    };
    const last = new Map<string, SyncChange>();
    for (const ch of changes) {
      if (ch.type !== "message") continue;
      const prev = last.get(ch.id);
      if (prev === undefined || ch.seq >= prev.seq) last.set(ch.id, ch);
    }
    for (const [id, ch] of last) {
      // A message of a mailbox this very page removes is neither added nor subtracted here: the
      // arm below answers for every row it had, and counting the change too would double it.
      if (inRemoved(id, ch)) continue;
      const live = this.store.get("message", id) !== undefined;
      if (ch.op === "delete") {
        if (live) this.receivedMessageRows -= 1;
      } else if (!live) this.receivedMessageRows += 1;
    }
    if (removedMailboxes.size === 0) return;
    for (const m of this.store.list<EngineMessage>("message")) {
      if (!removedMailboxes.has(m.mailboxId)) continue;
      this.receivedMessageRows -= 1;
      /* AND THE BODY SLOT GOES BACK, through the door that owns that statement: the cascade
         tombstones the `message_body` records, so this id holds no mail and must not be counted
         against {@link BODY_CACHE_MAX} — `holdBody`'s own argument for why a purge gives its slot
         back, reached here by the one act that empties a whole mailbox at once. `trimBodyCache`
         would also date a message-less body 0 and evict it first; this makes the removal say so
         rather than leaving the bound to be corrected by the next trim. */
      this.holdBody(m.id, false);
    }
  }

  /**
   * READ THE COUNT BACK AT BOOT, ONCE. Every write comes through {@link countReceived} and every
   * read through {@link receivedMessages}, and both come here first, so no construction order can
   * miss it. Gated on the store being LOADED, {@link restoreOutbox}'s rule — a restore over an
   * unread store latches a zero over the real answer. A mirror written before this key existed has
   * nothing to read back: its live message rows are the honest start, and they are also what keeps
   * the arithmetic sound, since `countReceived` subtracts for a row that was LIVE and from a fresh
   * zero one backfill would walk the count below it.
   */
  protected restoreReceivedCount(): void {
    if (this.receivedRestored || !this.storeLoaded) return;
    this.receivedRestored = true;
    const written = this.store.getMeta<number>(RECEIVED_MESSAGES_META);
    this.receivedMessageRows = typeof written === "number" && Number.isFinite(written)
      ? Math.max(0, Math.trunc(written))
      : this.store.list("message").length;
    this.persistedMessageRows = this.receivedMessageRows;
  }

  /**
   * Write the count down beside the page that moved it. A page that moved nothing writes nothing —
   * the ordinary poll, the rules pass and every replayed page leave the value exactly where it is.
   */
  protected async persistReceived(): Promise<void> {
    if (this.receivedMessageRows === this.persistedMessageRows) return;
    this.persistedMessageRows = this.receivedMessageRows;
    await this.store.setMeta(RECEIVED_MESSAGES_META, this.receivedMessageRows);
  }

  /**
   * Nothing has been received any more, and the DISK must not hold a count whose mirror is gone.
   * The write is skipped exactly where there is no survivor to clear — a first-ever bootstrap, and
   * the 410 wipe, which empties meta itself — so a reset costs a durable write only when it is
   * undoing one.
   */
  protected async resetReceived(): Promise<void> {
    const written = this.store.getMeta<number>(RECEIVED_MESSAGES_META);
    this.receivedMessageRows = 0;
    this.persistedMessageRows = 0;
    this.receivedRestored = true;
    if (written === undefined || written === 0) return;
    await this.store.setMeta(RECEIVED_MESSAGES_META, 0);
  }

  // Written in a later file of the engine; named here because this one calls them.
  protected abstract readCeiling<T>(read: Promise<T>): Promise<T>;
}

/** The engine's class as this file's bodies name it: the statics they read are declared here. */
const OhmailEngine = EngineHydration;

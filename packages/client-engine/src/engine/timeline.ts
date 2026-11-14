import {
  HISTORY_PAGE_ROWS, type StorePage, storePageKey, type StorePageOpts, type StorePageOutcome, type StoreSearchKey,
  storeSearchList, storeSearchPageKey, type StoreTimelineOutcome,
} from "../store-pages.js";
import type { EngineDraft, EngineMessage, SyncChange } from "../types.js";
import { EngineArchive } from "./archive.js";
import {
  errorClassOf, type ServerSearchOpts, type ServerSearchOutcome, type ServerSearchSort,
} from "./server-wire.js";

export abstract class EngineTimeline extends EngineArchive {
  // ── the store's timeline: History, paged ─────────────────────────────────

  /** Can History read the store — both doors, the pages and the month rail. `false` for the demo. */
  storePagesAvailable(): boolean {
    return this.listOlderFn !== null && this.timelineFn !== null;
  }

  /** `GET /messages/timeline` — the total and the months. Single-flight; never rejects. */
  async timeline(): Promise<StoreTimelineOutcome> {
    const fn = this.timelineFn;
    if (fn === null) return { state: "unavailable" };
    if (this.timelineCall !== null) return this.timelineCall;
    const call = Promise.resolve()
      .then(() => fn())
      .then((wire): StoreTimelineOutcome => (wire === null ? { state: "unavailable" } : { state: "ready", timeline: wire }))
      .catch((err: unknown): StoreTimelineOutcome => ({ state: "failed", errorClass: errorClassOf(err) }))
      .finally(() => {
        this.timelineCall = null;
      });
    this.timelineCall = call;
    return call;
  }

  /**
   * ONE PAGE OF THE STORE'S TIMELINE — `GET /messages?view=all`, strictly below `before` or after
   * `cursor`. The rows are held in the bounded page cache and NEVER written into the mirror (the
   * rule `searchServer` states for hits). A cached page answers without a request; single-flight
   * per page; never rejects.
   */
  async pageStore(view: "all", opts: StorePageOpts = {}): Promise<StorePageOutcome> {
    const fn = this.listOlderFn;
    if (fn === null) return { state: "unavailable" };
    const limit = Math.max(1, Math.min(HISTORY_PAGE_ROWS, opts.limit ?? HISTORY_PAGE_ROWS));
    const key = storePageKey(view, opts, limit);
    const held = opts.fresh ? undefined : this.storePages.get(key);
    if (held !== undefined) return { state: "ready", items: held.items, nextCursor: held.nextCursor };
    const flightKey = opts.fresh ? `${key}!` : opts.transient ? `${key}~` : key;
    const inFlight = this.storePageCalls.get(flightKey);
    if (inFlight) return inFlight;
    const call = Promise.resolve()
      .then(() => fn(view, {
        limit,
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
        ...(!opts.cursor && opts.before ? { startBelow: opts.before } : {}),
      }))
      .then((wire): StorePageOutcome => {
        if (wire === null) return { state: "unavailable" };
        const page = { items: Array.isArray(wire.items) ? wire.items : [], nextCursor: wire.nextCursor };
        if (!opts.transient && !opts.fresh) this.storePages.put(key, page, opts.at, "all");
        return { state: "ready", ...page };
      })
      .catch((err: unknown): StorePageOutcome => ({ state: "failed", errorClass: errorClassOf(err) }))
      .finally(() => {
        this.storePageCalls.delete(flightKey);
      });
    this.storePageCalls.set(flightKey, call);
    return call;
  }

  /** The cached page for this request, or `undefined` — a render's synchronous read. */
  peekStorePage(view: "all", opts: StorePageOpts = {}): EngineMessage[] | undefined {
    const limit = Math.max(1, Math.min(HISTORY_PAGE_ROWS, opts.limit ?? HISTORY_PAGE_ROWS));
    return this.storePages.get(storePageKey(view, opts, limit))?.items;
  }

  /**
   * A page row as it stands NOW: a verb's overlay first (moved, tagged, or gone at the press), the
   * mirror's own row where it holds one (read state, tags and triage stay live), `null` where the
   * mirror records it gone, else the cache's newest copy of the row — a later delta's, if one came.
   */
  storePageRow(item: EngineMessage): EngineMessage | null {
    const pending = this.readerView.overlaid("message", item.id);
    if (pending !== undefined) return (pending.entity as EngineMessage | null) ?? null;
    const live = this.readerView.get<EngineMessage>("message", item.id);
    if (live !== undefined) return live;
    return this.store.record("message", item.id) !== undefined ? null : this.storePages.find(item.id) ?? item;
  }

  /** The cached page row with this id, if a page holding it is still cached. */
  storePageRowById(id: string): EngineMessage | undefined {
    return this.storePages.find(id);
  }

  /**
   * A BODY FOR A ROW THE MIRROR DOES NOT HOLD — a store page's, a search hit's. Read on open and
   * RETURNED, never written: a body record without its message row is exactly what the mirror's
   * bounds forbid. A mirror row takes `hydrateBody` instead. Never rejects.
   */
  async readBodyOffMirror(messageId: string): Promise<
    { state: "ready"; text: string; html: string | null } | { state: "unavailable" } | { state: "failed"; errorClass: string }
  > {
    try {
      const wire = await this.adapter.fetchBody(messageId, { urgent: true });
      if (wire === null) return { state: "unavailable" };
      return { state: "ready", text: typeof wire.text === "string" ? wire.text : "", html: typeof wire.html === "string" ? wire.html : null };
    } catch (err) {
      return { state: "failed", errorClass: errorClassOf(err) };
    }
  }

  /** Rows the page cache holds — what the bounds census reads. */
  storePageCacheRows(): number {
    return this.storePages.rows();
  }

  /** Moves with every page put, evicted, cleared or updated by a delta — a walker's memo key. */
  storePagesRevision(): number {
    return this.storePages.revision();
  }

  /**
   * HOLD A FRESH PAGE where the page it was asked as is cached — History's refresh places page one
   * only once the positions below it have moved, so no render reads the new rows at the old slots.
   */
  holdStorePage(view: "all", opts: StorePageOpts, page: StorePage, at: number): void {
    const limit = Math.max(1, Math.min(HISTORY_PAGE_ROWS, opts.limit ?? HISTORY_PAGE_ROWS));
    this.storePages.put(storePageKey(view, opts, limit), page, at, "all");
  }

  /** Moves when an applied page changed the store's list (an arrival, or a message taken away) — an open History's cue. */
  storeChanges(): number {
    return this.storeChangesRev;
  }

  /**
   * DRAINS THAT COMPLETED — bumped only at the settle, after the freshness stamp and before its one
   * publish, so a subscriber reading it sees a server that answered a whole drain. A drain that
   * throws never reaches it. A read that failed for want of the network is asked again on it.
   */
  drainsCompleted(): number {
    return this.drainsDone;
  }

  /**
   * THE ROW A CONFIRMED `draft_save` CREATE MADE, by its key — on every road it confirmed by, the
   * reconnect flush and a boot's replay included, where no surface holds the result. An editor
   * whose create waited offline takes its row from here. Bounded, oldest dropped.
   */
  createdDraftOf(key: string): { id: string; revision: string | null } | null {
    return this.createdDrafts.get(key) ?? null;
  }

  /**
   * THE KEY OF THE `draft_save` CREATE STILL WAITING THAT PAINTS `draftId`, or `null` for a row the
   * server holds. That id is local until the create confirms: a door binds the create, never the id.
   */
  pendingCreateOf(draftId: string): string | null {
    const painted = this.read().get<EngineDraft>("draft", draftId)?.pendingCreate;
    return typeof painted === "string" ? painted : null;
  }

  protected noteCreatedDraft(key: string, id: string, said: string | undefined, changes: readonly SyncChange[]): void {
    const echo = changes.find((c) => c.type === "draft" && c.id === id)?.entity as { contentRevision?: unknown } | null | undefined;
    const revision = said ? said
      : typeof echo?.contentRevision === "string" && echo.contentRevision !== "" ? echo.contentRevision : null;
    this.createdDrafts.delete(key);
    this.createdDrafts.set(key, { id, revision });
    while (this.createdDrafts.size > 64) this.createdDrafts.delete(this.createdDrafts.keys().next().value!);
  }

  /** Drop the cached pages — a History visit starts from the store's present; `list` narrows it. */
  resetStorePages(list?: string): void {
    this.storePages.clear(list);
  }

  /**
   * ONE PAGE OF A SEARCH — {@link searchServer}'s first-page read, its rows held in the same
   * bounded page cache as History's, under the question's own list and the cursor that asked it.
   * A cached page answers without a request; a `transient` step is answered, never cached.
   */
  async pageSearch(
    key: StoreSearchKey,
    opts: { cursor?: string | null; at?: number; transient?: boolean; lane?: ServerSearchOpts["lane"] } = {},
  ): Promise<ServerSearchOutcome> {
    const cursor = opts.cursor ?? null;
    const pageKey = storeSearchPageKey(key, cursor, HISTORY_PAGE_ROWS);
    const held = this.storePages.get(pageKey);
    if (held !== undefined) {
      return {
        state: "ready", items: held.items, total: held.items.length, tier: "exact", totalExact: false, ms: null,
        nextCursor: held.nextCursor, bounded: false, indexed: null, facets: null,
      };
    }
    const out = await this.searchServer(key.query, {
      limit: HISTORY_PAGE_ROWS, parts: "page",
      ...(key.sort ? { sort: key.sort as ServerSearchSort } : {}),
      ...(cursor !== null ? { cursor } : {}),
      ...(key.filters ? { filters: key.filters } : {}),
      ...(opts.lane ? { lane: opts.lane } : {}),
    });
    if (out.state === "ready" && !opts.transient) {
      this.storePages.put(pageKey, { items: out.items, nextCursor: out.nextCursor }, opts.at, storeSearchList(key));
    }
    return out;
  }

  /** The cached Search page for this cursor, or `undefined` — a render's synchronous read. */
  peekSearchPage(key: StoreSearchKey, cursor: string | null): EngineMessage[] | undefined {
    return this.storePages.get(storeSearchPageKey(key, cursor, HISTORY_PAGE_ROWS))?.items;
  }
}

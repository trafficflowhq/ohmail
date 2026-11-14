import {
  type AddressDirection, type AddressResult, indexingAddressResult, indexingResult, type LocalSearchResult,
  SearchIndex,
} from "../search.js";
import { EngineBodies } from "./bodies.js";
import { SEARCH_INDEX_SYNC_MAX } from "./ceilings.js";

export abstract class EngineLocalSearch extends EngineBodies {
  // ── local search ─────────────────────────────────────────────────────────

  /**
   * THE FAST PATH, and it stays the fast path.
   *
   * Synchronous, no round trip, answers from the mirror on every keystroke. It reads
   * subject, sender, the ≤200-character snippet and whatever body text this device holds —
   * `LocalSearchResult.coverage` says how much of the corpus that was, and the surface is
   * required to say so rather than let the count of hits imply completeness.
   */
  search(query: string, opts: { limit?: number } = {}): LocalSearchResult {
    const index = this.searchIndex();
    if (index === null) return indexingResult();
    return { ...index.search(query, opts), indexing: this.searchBuild !== null };
  }

  /**
   * EVERY MESSAGE ON THIS DEVICE INVOLVING ONE ADDRESS — the address view's device half. The same cached {@link
   * SearchIndex} {@link OhmailEngine.search} uses, and sharing it is not merely thrift: the index is rebuilt when the
   * mirror's version moves, so two caches would mean the address view and the search box could disagree about what
   * the mirror holds — one of them showing a message the other says is gone. Synchronous and total, like `search`:
   * the answer is a map lookup over the mirror already in memory. The ARCHIVE half is a separate, later pass — see
   * {@link OhmailEngine.searchServer} and, for the address query, `apps/webapp/app/shell/address-view.ts`, which is
   * where the two halves are composed and where the device's answer is labelled as the device's.
   */
  messagesWith(address: string, direction: AddressDirection = "any"): AddressResult {
    const index = this.searchIndex();
    if (index === null) return indexingAddressResult();
    return { ...index.messagesWith(address, direction), indexing: this.searchBuild !== null };
  }

  /**
   * THE INDEX TO ANSWER FROM, AND THE WORK THAT IS OWED — one place, because `search` and
   * `messagesWith` must never hold two opinions about what this device knows.
   *
   * IT IS UPDATED, NOT REBUILT. The mirror's version moves on every drain, so "the version
   * moved, so rebuild" was a whole-mirror walk per keystroke — the freeze. A version bump now
   * costs the messages that actually moved ({@link SearchIndex.refresh}), which on an ordinary
   * drain is a page of mail and usually none at all.
   */
  protected searchIndex(): SearchIndex | null {
    const cache = this.searchCache;
    const version = this.readerView.version();
    if (cache !== null && cache.version === version) return cache.index;
    if (cache !== null) {
      /*
       * The catch-up, bounded at the top: past `SEARCH_INDEX_SYNC_MAX` changed messages `refresh`
       * refuses rather than spending the keystroke, and the sliced rebuild below takes it — a
       * re-bootstrap replacing every row must not arrive as one synchronous walk.
       */
      if (cache.index.refresh(this.readerView, SEARCH_INDEX_SYNC_MAX) !== null) {
        cache.version = version;
        return cache.index;
      }
      this.searchCache = null;
    }
    /*
     * NOTHING TO ANSWER FROM. A mirror small enough to index inside a frame is indexed here, so a
     * demo world and a fixture mount answer the first keystroke rather than the second.
     *
     * Deliberately no `searchIndexRev++` on this path: the index is installed and its answer
     * returned inside one call, so there is nobody to tell — and this runs inside a render, where
     * moving a value a `useSyncExternalStore` snapshot reads makes that snapshot unstable.
     */
    const quick = SearchIndex.buildWithin(this.readerView, SEARCH_INDEX_SYNC_MAX);
    if (quick !== null) {
      this.searchCache = { version, index: quick };
      return quick;
    }
    this.startSearchBuild();
    return null;
  }

  /**
   * START THE FIRST BUILD IF ONE IS OWED — one at a time, and never restarted by a newer version.
   *
   * Reached only when there is no index to update: the first search on a large mirror, and a
   * catch-up too large to spend on a keystroke. A build that is allowed to finish leaves an
   * index; one restarted at every version bump on a mirror that moves every few seconds leaves
   * none, which is why a newer version does not cancel this.
   */
  protected startSearchBuild(): void {
    if (this.searchBuild !== null) return;
    // Read BEFORE the walk and with no await in between: `buildSliced`'s first act is the
    // reader pass, so this is the version the finished index is an index of.
    const version = this.readerView.version();
    const token: { version: number; cancelled: boolean; done: Promise<void> } = {
      version,
      cancelled: false,
      done: Promise.resolve(),
    };
    this.searchBuild = token;
    token.done = SearchIndex.buildSliced(this.readerView, { cancelled: () => token.cancelled })
      .then((index) => {
        if (this.searchBuild !== token) return;
        this.searchBuild = null;
        if (index === null) return; // abandoned — see `invalidateSearchIndex`
        this.searchCache = { version, index };
        // The view keys on this, not on the mirror's version: a build settling changes what
        // search can answer without a record moving.
        this.searchIndexRev++;
        this.notify();
      })
      .catch(() => {
        // A build that threw leaves the previous index standing and lets the next search ask
        // again. There is nothing to tell a reader: the answer they are looking at is the older
        // one, which is what `indexing` already says.
        if (this.searchBuild === token) this.searchBuild = null;
      });
  }

  /**
   * WHICH INDEX THE ANSWER CAME FROM — a counter, bumped whenever a build settles.
   *
   * The search view cannot key on the mirror's version alone: the index now lags it deliberately,
   * so an index finishing is a change to what search can answer with no record having moved. This
   * is the other half of that dependency (`SearchViewLive`).
   */
  searchIndexRevision(): number {
    return this.searchIndexRev;
  }

  /**
   * THE MIRROR VERSION OF THE LAST BODY THAT CAN RE-PLACE ITS MESSAGE, 0 before one — the window
   * takes the larger of this and its body-blind stamp (`useDerivedVersion`), so a text that
   * decides a placement reaches the partition and the eager pass's bodies do not.
   */
  placementStamp(): number {
    return this.placementBodyVersion;
  }

  /**
   * BUILD THE INSTANT INDEX NOW, OFF THE KEYSTROKE PATH — what a surface calls when the search
   * box takes focus, so the first characters meet an index that is already there. Resolves when
   * nothing is in flight; it never rejects and never blocks the caller's frame.
   */
  async warmSearchIndex(): Promise<void> {
    this.startSearchBuild();
    await this.searchBuild?.done;
  }

  /**
   * THE INDEX IS ABOUT A MIRROR THAT NO LONGER EXISTS — drop it, and abandon any build reading
   * it. The re-bootstrap's own step: `resetForBootstrap` empties the store, and a build walking
   * the old rows would otherwise install an index of deleted mail over the new one, where every
   * hit opens nothing. This is what the cancellation token is for.
   */
  protected invalidateSearchIndex(): void {
    if (this.searchBuild !== null) {
      this.searchBuild.cancelled = true;
      this.searchBuild = null;
    }
    this.searchCache = null;
    this.searchIndexRev++;
  }
}

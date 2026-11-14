import { EngineLocalSearch } from "./local-search.js";
import { SEARCH_WARM_IDLE_MS } from "./options.js";
import {
  DIRECTION_UNSUPPORTED, errorClassOf, estimateFrom, indexedOf, type ReadySearch, SERVER_ADDRESS_DIRECTIONS,
  type ServerAddressDirection, type ServerAddressOpts, type ServerAddressOutcome, type ServerEstimateOutcome,
  type ServerSearchOpts, type ServerSearchOutcome, type ServerSearchPart,
} from "./server-wire.js";

export abstract class EngineArchive extends EngineLocalSearch {
  // ── the archive pass ─────────────────────────────────────────────────────

  /**
   * Is there a server archive behind this client at all?
   *
   * `false` for the demo (`?demo=1` is fixtures and zero network) and for
   * the desktop tier, whose master is the IMAP mailbox and which has no Cloud API. Both are
   * states the UI must be able to STATE, not states it should hide: "there is no archive
   * here" and "the archive has not answered yet" are different sentences.
   */
  serverSearchAvailable(): boolean {
    return this.serverSearchFn !== null;
  }


  /**
   * THE FIRST KEY OF A SEARCH WARMS THE WAY TO THE STORE. A paired desktop's hop to the account
   * drops an idle connection after 4 s, so the page after a pause dialled TCP and TLS again (72-182
   * ms over the server's time against 46-86 for the estimate right behind it). A blank search costs
   * no lookup and passes the same doors, so sent while the typing debounce runs, the page finds the
   * connection open. Only after {@link SEARCH_WARM_IDLE_MS} without a search; never awaited.
   */
  warmSearch(): void {
    const fn = this.serverSearchFn;
    if (!this.searchWarms || fn === null || performance.now() - this.lastSearchSentAt < SEARCH_WARM_IDLE_MS) return;
    this.lastSearchSentAt = performance.now();
    void Promise.resolve().then(() => fn("", { parts: "page", limit: 1 })).catch(() => undefined);
  }

  /**
   * Search the whole corpus — `GET /search`, the RRF-ranked hybrid that had zero callers. The SECOND answer, never
   * the first: {@link OhmailEngine.search} has already painted, and a surface that awaited this before rendering
   * would trade an instant local result for a round trip. The result does not go in the mirror: a search hit has no
   * seq, and a written row would outlive its own deletion in a store whose contract is convergence — items are
   * RETURNED and gone when the query changes; the caller should prefer its own mirror entity by id (it carries the
   * overlay) and fall back to the wire item. Single-flight per query, never rejects: the caller is a debounced React
   * effect, so the outcome is a value (`unavailable` / `ready` / `failed` with the server's sentence) — a 402 arrives
   * as its message.
   */

  /**
   * `cost: "read"` on the server; one request per settled query, never per keystroke — a paid request needs somebody
   * behind it.
   */
  searchServer(query: string, opts: ServerSearchOpts & { parts: "estimate" }): Promise<ServerEstimateOutcome>;
  searchServer(query: string, opts?: ServerSearchOpts & { parts?: Exclude<ServerSearchPart, "estimate"> }): Promise<ServerSearchOutcome>;
  async searchServer(query: string, asked: ServerSearchOpts = {}): Promise<ServerSearchOutcome | ServerEstimateOutcome> {
    // The lane only where the option is on: elsewhere the request stays byte for byte what it was.
    const { lane: askedLane, ...unlaned } = asked;
    const lane = this.searchSupersede ? askedLane : undefined;
    const opts: ServerSearchOpts = lane ? { ...unlaned, lane } : unlaned;
    const fn = this.serverSearchFn;
    if (fn === null) return { state: "unavailable" };
    const q = query.trim();
    if (q === "") {
      const none: ReadySearch = {
        state: "ready", items: [], total: 0, tier: "exact", totalExact: true, ms: null,
        nextCursor: null, bounded: false, indexed: null, facets: null,
      };
      return opts.parts === "estimate" ? estimateFrom(none, undefined) : none;
    }

    /**
     * THE SORT IS PART OF THE KEY, and omitting it would be a defect rather than a missed
     * optimisation. Single-flight joins concurrent callers onto ONE request, so a `date_desc`
     * pass issued while a `relevance` pass for the same query is still open would be handed the
     * relevance answer and render it under the newly-chosen control. Changing the order would
     * appear to do nothing — but only inside the debounce window, which is the shape that gets
     * filed as flakiness and never reproduced.
     */
    const f = opts.filters;
    const key = JSON.stringify([
      opts.limit ?? null, opts.sort ?? null, opts.parts ?? null, opts.cursor ?? null,
      f ? [f.folder ?? null, f.sender ?? null, f.hasAttachments ?? null] : null, q,
      // A retyped question never joins an older one's request, which a newer one may have dropped.
      ...(lane ? [`${lane.id}.${lane.generation}`] : []),
    ]);
    const inFlight = this.serverSearches.get(key);
    if (inFlight) return inFlight;
    this.lastSearchSentAt = performance.now();

    // Through a resolved promise, so a transport that throws SYNCHRONOUSLY lands in the `catch`
    // below as a failed outcome — called bare, the throw rejected this method, which never rejects.
    const request = Promise.resolve()
      .then(() => fn(q, opts))
      .then((wire): ServerSearchOutcome | ServerEstimateOutcome => {
        // `null` ⇒ this transport serves no archive. Same shape as `fetchBody`'s `null`, and
        // it must not become an empty `ready`: "we searched everything and found nothing" is
        // a claim, and this is the case where we searched nothing at all.
        if (wire === null) return { state: "unavailable" };
        const ready: ReadySearch = {
          state: "ready",
          items: Array.isArray(wire.items) ? wire.items : [],
          total: typeof wire.total === "number" ? wire.total : (wire.items?.length ?? 0),
          // Absent ⇒ `exact`, and anything the wire says that is not one of the two tiers is
          // treated the same way. See {@link ServerSearchWire.tier}: the unknown case must not
          // file a real hit under a "Similar" heading.
          tier: wire.tier === "similar" ? "similar" : "exact",
          totalExact: wire.totalExact !== false,
          ms: typeof wire.ms === "number" ? wire.ms : null,
          nextCursor: typeof wire.nextCursor === "string" && wire.nextCursor !== "" ? wire.nextCursor : null,
          bounded: wire.bounded === true,
          indexed: indexedOf(wire.indexed),
          facets: wire.facets ?? null,
          ...(wire.importing === true ? { importing: true as const } : {}),
          ...(wire.answeredFrom === "mirror" ? { fromMirror: true as const } : {}),
        };
        return opts.parts === "estimate" ? estimateFrom(ready, wire.totalEstimate) : ready;
      })
      .catch((err: unknown): ServerSearchOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        errorClass: errorClassOf(err),
      }))
      .finally(() => {
        this.serverSearches.delete(key);
      });

    this.serverSearches.set(key, request);
    return request;
  }

  /**
   * Is there an archive behind this client that can be asked about an ADDRESS?
   *
   * Separate from {@link OhmailEngine.serverSearchAvailable} because the two capabilities are
   * resolved separately — see the constructor. `false` for the demo and the desktop tier, and
   * for a client whose adapter wrapper forwards the text search and not this one; all three are
   * "there is no archive here", which the view states rather than hides.
   */
  serverAddressSearchAvailable(): boolean {
    return this.serverAddressSearchFn !== null;
  }

  /**
   * ASK THE ARCHIVE ABOUT ONE ADDRESS — `GET /search?address=&direction=`. The SECOND answer, never the first,
   * exactly as {@link OhmailEngine.searchServer} is: {@link OhmailEngine.messagesWith} has already painted from the
   * mirror and this extends it. The direction is the view's (default `from`). A server before mail 0154 refuses
   * `to`/`any` with `search_direction_unsupported`: that refusal is asked `from` once, and the outcome says `from`,
   * so the view keeps its by-sender caveat there instead of a failure.
   */

  /**
   * Single-flight on the address, so a view that re-renders while a pass is open joins it instead of issuing a
   * second. THE RESULT DOES NOT GO IN THE MIRROR — `/sync` owns that, and a row from this route has no seq; the
   * reasoning is written out in full at `searchServer`.
   */
  async searchAddressServer(
    address: string, opts: ServerAddressOpts = {},
  ): Promise<ServerAddressOutcome> {
    const fn = this.serverAddressSearchFn;
    if (fn === null) return { state: "unavailable" };
    // An empty address is not a question. The server answers it empty too, so this is a saved
    // round trip rather than a divergence — and `ready` with no items is the honest shape: this
    // client did ask and there is nothing, which is what the count line reports.
    const direction = opts.direction ?? "from";
    if (address.trim() === "") {
      return { state: "ready", items: [], total: 0, direction };
    }
    // `JSON.stringify` over a tuple, not a `\u0000`-joined string: it is unambiguous for any
    // address a header can carry, and this repository has twice paid for a control byte used
    // as a separator (a raw NUL in a source file makes every `grep` skip the whole file in
    // silence). The text arm one method up still joins on the escape; this is the form to copy.
    const key = JSON.stringify([opts.limit ?? null, address, direction]);
    const inFlight = this.serverAddressSearches.get(key);
    if (inFlight) return inFlight;

    const ask = { ...opts, direction };
    const request = fn(address, ask)
      .catch((err: unknown) => {
        // A server before mail 0154: asked by sender instead, once, and labelled `from`.
        if (direction === "from" || (err as { code?: unknown } | null)?.code !== DIRECTION_UNSUPPORTED) throw err;
        return fn(address, { ...ask, direction: "from" })
          .then((wire) => (wire === null ? null : { ...wire, direction: "from" as const }));
      })
      .then((wire): ServerAddressOutcome => {
        // `null` ⇒ this transport serves no archive, and it must not become an empty `ready`:
        // "we searched the archive and there is nothing" is a claim, and this is the case where
        // nothing was searched. Same rule as `searchServer`'s and `fetchBody`'s `null`.
        if (wire === null) return { state: "unavailable" };
        return {
          state: "ready",
          items: Array.isArray(wire.items) ? wire.items : [],
          total: typeof wire.total === "number" ? wire.total : (wire.items?.length ?? 0),
          // Absent ⇒ `from`: a server that predates the field answered `from` whatever it was
          // asked. Anything the wire says that is
          // not a known direction takes the same reading rather than being carried through — a
          // view labelling its list with a word it does not understand is worse than the
          // conservative one.
          direction: (SERVER_ADDRESS_DIRECTIONS as readonly string[]).includes(wire.direction ?? "")
            ? (wire.direction as ServerAddressDirection)
            : "from",
          ...(wire.importing === true ? { importing: true as const } : {}),
          ...(wire.totalExact === false ? { totalExact: false as const } : {}),
        };
      })
      .catch((err: unknown): ServerAddressOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        errorClass: errorClassOf(err),
      }))
      .finally(() => {
        this.serverAddressSearches.delete(key);
      });

    this.serverAddressSearches.set(key, request);
    return request;
  }
}

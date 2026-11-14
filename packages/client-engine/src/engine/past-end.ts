import { mirrorCoverage } from "../store-pages.js";
import { type EngineMessage, MutationRejectedError, type OhmailView } from "../types.js";
import { errorClassOf, type FetchMessageOutcome, type ListOlderOutcome, type StoreCoverage } from "./server-wire.js";
import { EngineTimeline } from "./timeline.js";

export abstract class EnginePastEnd extends EngineTimeline {
  // ── reading past the end of the window ───────────────────────────────────

  /**
   * Is there anything BEHIND the end of this client's lists?
   *
   * `false` for the demo (`?demo=1` is fixtures and zero network) and for the
   * desktop tier, whose master is the IMAP mailbox and which keeps the whole of it on the device.
   * Both are states a list must be able to STATE: "you have reached the end of your mail" and "you
   * have reached the end of what this device keeps" are different sentences, and only one of them
   * has a control under it.
   */
  /**
   * How much of the mailbox this client's mirror is CONFIGURED to keep — the window itself, or
   * `null` where the mirror is the mailbox (`{ mode: "full" }`, and the absent-config default).
   *
   * The POLICY and not a measurement: a latch recording that a prune has happened is lost on every
   * reload, and "the mirror holds at least `minRows`" is false at exactly that many recent rows. A
   * list derived from the whole mirror — History, which no wire partition serves — is bounded
   * whenever this is non-null, whatever the mailbox happens to hold today, and that is the only
   * form of the fact a surface can state without ever being wrong.
   */
  storeWindow(): { days: number; minRows: number } | null {
    const policy = this.storePolicy;
    return policy.mode === "windowed" ? { days: policy.days, minRows: policy.minRows } : null;
  }

  /**
   * HOW MUCH MAIL THIS CLIENT HAS TAKEN IN — the import's numerator on a windowed mirror, where
   * `list("message").length` is not: `pruneToPolicy` evicts as the pages land, so the row count
   * pins at the window's floor while the import runs on (measured: 5,000 held of 15,000 received
   * under the browser's window). Counted at the reader's door instead, where eviction cannot reach
   * it — and EQUAL to the row count wherever nothing is evicted, which is what makes this narrow.
   *
   * Written down beside the cursor ({@link RECEIVED_MESSAGES_META}) and read back at boot, so a
   * reload starts where the import stands. The consumer still floors it at the row count.
   */
  receivedMessages(): number {
    this.restoreReceivedCount();
    return this.receivedMessageRows;
  }

  listOlderAvailable(): boolean {
    return this.listOlderFn !== null;
  }

  /**
   * DOES THE STORE HOLD MAIL THIS MIRROR DOES NOT — the mirror's rows per month against the store's
   * own timeline ({@link mirrorCoverage}), never the window policy: a windowed mirror over a small
   * mailbox holds all of it. `unread` until the store has answered, and again when the mirror
   * stops matching an answer that said `whole` (a delete, an eviction): the caller re-asks.
   */
  storeCoverage(): StoreCoverage {
    if (this.listOlderFn === null || this.timelineFn === null) return { state: "unknown" };
    const read = this.coverageRead;
    if (read === null) return this.coverageUnknown ? { state: "unknown" } : { state: "unread" };
    const stamp = this.store.stampOf("message");
    const memo = this.coverageMemo;
    if (memo !== null && memo.stamp === stamp && memo.read === read) return memo.value;
    const live = mirrorCoverage(read.timeline, this.store.list<EngineMessage>("message"));
    const value: StoreCoverage = live.whole
      ? { state: "whole" }
      : read.wasWhole ? { state: "unread" } : { state: "partial", below: live.below };
    this.coverageMemo = { stamp, read, value };
    return value;
  }

  /**
   * ONE MESSAGE BY ID FROM THE STORE, for an id a surface was handed that the mirror no longer
   * holds — a link to mail the window evicted. RETURNED and never written, for `listOlder`'s
   * reason: a row with no seq is one no delta could update or remove. Single-flight per id and
   * never rejects; a tombstoned id is not asked (`messageIsGone` is the mirror's answer).
   */
  async fetchMessage(id: string): Promise<FetchMessageOutcome> {
    const fn = this.messageByIdFn;
    if (fn === null) return { state: "unavailable" };
    const inFlight = this.messageCalls.get(id);
    if (inFlight) return inFlight;
    const call = Promise.resolve()
      .then(() => fn(id))
      .then((m): FetchMessageOutcome => (m === null ? { state: "missing" } : { state: "ready", message: m }))
      .catch((err: unknown): FetchMessageOutcome => ({ state: "failed", errorClass: errorClassOf(err) }))
      .finally(() => { this.messageCalls.delete(id); });
    this.messageCalls.set(id, call);
    return call;
  }

  /** Ask the store's timeline (single-flight with History's) and answer {@link storeCoverage}. */
  async readStoreCoverage(): Promise<StoreCoverage> {
    if (this.listOlderFn === null || this.timelineFn === null) return { state: "unknown" };
    const out = await this.timeline();
    if (out.state === "ready") {
      const whole = mirrorCoverage(out.timeline, this.store.list<EngineMessage>("message")).whole;
      this.coverageRead = { timeline: out.timeline, wasWhole: whole };
      this.coverageUnknown = false;
    } else {
      this.coverageRead = null;
      this.coverageUnknown = true;
    }
    return this.storeCoverage();
  }

  /**
   * One page of mail older than this device kept — `GET /messages?view=&cursor=`, the companion to {@link
   * StorePolicy}'s `windowed` mode: the rest of the mailbox is on the Cloud, reached a keyset page at a time, on an
   * explicit act, never speculatively. The result does not go in the mirror ({@link OhmailEngine.searchServer}'s
   * rule, sharper here): a row from this route has no seq, so writing it in creates a record no delta can update or
   * remove — and the next prune pass would evict it anyway. Items are RETURNED and gone when the view changes; the
   * caller should prefer its own mirror row by id (it carries the overlay and this device's triage). Single- flight
   * per view+cursor, so a bottom-effect firing twice issues one request; never rejects — the outcome is a value the
   * UI renders, a 402 arriving as its sentence. `cost: "read"`: no cost class changes.
   */
  async listOlder(
    view: OhmailView | "folder",
    opts: { cursor?: string; limit?: number; folderId?: string; startBelow?: { date: string | null; id: string } } = {},
  ): Promise<ListOlderOutcome> {
    const fn = this.listOlderFn;
    if (fn === null) return { state: "unavailable" };

    // JSON rather than a joined string: the three parts have no shared alphabet to separate them
    // with, and a hand-picked delimiter is how two different pages come to share one key. It also
    // keeps the separator out of the SOURCE. A single invisible control character here is a
    // file-wide hazard: it makes tooling classify this whole file as binary and skip it.
    const key = JSON.stringify([
      view, opts.cursor ?? null, opts.limit ?? null, opts.folderId ?? null,
      opts.startBelow ? [opts.startBelow.date, opts.startBelow.id] : null,
    ]);
    const inFlight = this.olderPages.get(key);
    if (inFlight) return inFlight;

    const request = fn(view, opts)
      .then((wire): ListOlderOutcome => {
        // `null` ⇒ this transport serves no older mail. Same shape as `fetchBody`'s and
        // `searchServer`'s `null`, and it must not become an empty `ready`: "the server answered
        // and there is nothing older" is a claim, and this is the case where nothing was asked.
        if (wire === null) return { state: "unavailable" };
        const items = Array.isArray(wire.items) ? wire.items : [];
        const nextCursor = typeof wire.nextCursor === "string" && wire.nextCursor !== "" ? wire.nextCursor : null;
        /* HELD IN THE PAGE CACHE, never the mirror: a verb pressed on one of these rows computes
           its effects like any other (`verbRead`), and the store's later word on it — a delta
           the window then prunes again — reaches the row (`storePageRow`). */
        this.storePages.put(`older:${key}`, { items, nextCursor }, undefined, `older:${view}:${opts.folderId ?? ""}`);
        return { state: "ready", items, nextCursor };
      })
      .catch((err: unknown): ListOlderOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        // The code travels with the sentence so the surface can decide whether the sentence is
        // one a person should be shown. `null` for anything that never reached a server.
        code: err instanceof MutationRejectedError ? err.code : null,
      }))
      .finally(() => {
        this.olderPages.delete(key);
      });

    this.olderPages.set(key, request);
    return request;
  }

  // Written in a later file of the engine; named here because this one calls them.
  protected abstract restoreReceivedCount(): void;
}

import { MutationRejectedError } from "../types.js";
import type { MutationResult } from "./mutation-views.js";
import { EngineOptimisticMutations } from "./optimistic-mutations.js";
import type { ListTrashOutcome, RestoreOutcome } from "./server-wire.js";

export abstract class EngineTrash extends EngineOptimisticMutations {
  // ── Trash: mail this account deleted, and putting one back ───────────────

  /**
   * Can this client see and restore deleted mail at all? BOTH capabilities, deliberately. A Trash view whose Restore
   * button cannot work is not the feature — it is a list of mail with one dead control on every row — so the palette
   * row, the chord and the rail entry are gated on the pair. `false` for the demo (`?demo=1` is fixtures and zero
   * network), which must read as "Trash is not available here" and not as an empty Trash. Resolved from the adapter's
   * own optional capabilities, so it cannot disagree with what the two methods below will do.
   */
  trashAvailable(): boolean {
    return this.listTrashFn !== null && this.restoreFromTrashFn !== null;
  }

  /**
   * One page of mail this account deleted — `GET /messages?view=trash&cursor=`. The result does not
   * go in the mirror, and here that is structural: a delete TOMBSTONES the row (`apply.ts` rule 4),
   * so writing these rows in would resurrect them into every pile — deleted mail back in somebody's
   * Ohbox while the mail server has it in Trash. The items are RETURNED, the view holds them, and
   * they are gone when the view changes; there is no "prefer your own mirror row" advice, unlike
   * `listOlder` — the mirror has no row to prefer. Single-flight per page, never rejects (the
   * caller is a React effect; the outcome is a value the UI renders). `cost: "read"` on the
   * server, so this caller changes no cost class.
   */
  async listTrash(opts: { cursor?: string; limit?: number } = {}): Promise<ListTrashOutcome> {
    const fn = this.listTrashFn;
    if (fn === null) return { state: "unavailable" };

    // JSON rather than a joined string, for `listOlder`'s reason: no hand-picked delimiter, and
    // no control character in this file (a single one makes tooling classify the whole file as
    // binary and skip it).
    const key = JSON.stringify([opts.cursor ?? null, opts.limit ?? null]);
    const inFlight = this.trashPages.get(key);
    if (inFlight) return inFlight;

    const request = fn(opts)
      .then((wire): ListTrashOutcome => {
        // `null` ⇒ this transport serves no Trash. It must NOT become an empty `ready`: "there
        // is nothing in Trash" is a claim, and this is the case where nothing was asked.
        if (wire === null) return { state: "unavailable" };
        return {
          state: "ready",
          items: Array.isArray(wire.items) ? wire.items : [],
          nextCursor: typeof wire.nextCursor === "string" && wire.nextCursor !== "" ? wire.nextCursor : null,
        };
      })
      .catch((err: unknown): ListTrashOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof MutationRejectedError ? err.code : null,
      }))
      .finally(() => {
        this.trashPages.delete(key);
      });

    this.trashPages.set(key, request);
    return request;
  }

  /**
   * Put one deleted message back where it was — `POST /messages/:id/restore`. Not an `EngineMutation`, and it could
   * not be: {@link OhmailEngine.mutate} rejects a mutation whose local effects are empty, and a mutation over a
   * tombstoned message has none — so this is a plain call with no overlay and no outbox entry; the durable record of
   * a pressed restore is the SURFACE's journal (`delete-intents.ts`), whose entries carry which verb they are. It
   * does not claim the mail is back: `pending` comes back true — the mail server performs the move on the organizer's
   * next turn, the tombstone clears when the message is OBSERVED in the target folder, and a surface that read the
   * 200 as "restored" would show mail in a place the server does not have it. `restoreTo` is the server's answer and
   * may differ from the row's rendered one, so the toast names THIS value.
   */

  /**
   * Single-flight per message id: a double press is one request.
   */
  async restoreFromTrash(
    messageId: string,
    /**
     * WHICH PRESS THIS IS, from the surface's own durable journal — the one thing that tells a
     * REPLAY from a second press. The key is composed here rather than by the surface so one
     * place owns what goes in the header; a caller without a journal passes nothing and the
     * request carries no key, exactly as before.
     */
    opts: { intentId?: string } = {},
  ): Promise<RestoreOutcome> {
    const fn = this.restoreFromTrashFn;
    if (fn === null) return { state: "unavailable" };
    const inFlight = this.restoreCalls.get(messageId);
    if (inFlight) return inFlight;

    const key = opts.intentId === undefined || opts.intentId === ""
      ? undefined
      : `restore:${opts.intentId}:${messageId}`;
    const request = fn(messageId, key === undefined ? {} : { idempotencyKey: key })
      .then((wire): RestoreOutcome => {
        // `null` ⇒ no restore route behind this transport. Same rule as the page above: it is
        // not a refusal and must not be reported as one.
        if (wire === null) return { state: "unavailable" };
        return {
          state: "restored",
          restoreTo: typeof wire.restoreTo === "string" && wire.restoreTo !== "" ? wire.restoreTo : "INBOX",
          pending: wire.pending !== false,
        };
      })
      .catch((err: unknown): RestoreOutcome => ({
        state: "rolled_back",
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof MutationRejectedError ? err.code : null,
      }))
      .finally(() => {
        this.restoreCalls.delete(messageId);
      });

    this.restoreCalls.set(messageId, request);
    return request;
  }

  /**
   * FINISH A DELETE A KILLED TAB LEFT BEHIND — the one road that may not read an absent row as
   * agreement. The mirror is a WINDOW and a stranded intent lives a day, so by the next launch
   * the row may be gone for a reason the person had nothing to do with; the mailbox is master.
   *
   *   · a TOMBSTONE this device holds — the delete converged; settled, no round trip;
   *   · anything else — the one door, under the press's own key: {@link mutate} sends a row it
   *     does not hold as well, and the mailbox's 404 is the outcome that was asked for.
   */
  async replayDelete(
    messageId: string,
    /** The press this replay belongs to, from the surface's journal — see {@link restoreFromTrash}. */
    opts: { intentId?: string } = {},
  ): Promise<MutationResult> {
    const key = opts.intentId === undefined || opts.intentId === ""
      ? this.uuid()
      : `delete-replay:${opts.intentId}:${messageId}`;
    if (this.store.isTombstoned("message", messageId)) {
      return { id: this.uuid(), key, status: "confirmed", seq: null };
    }
    const res = await this.mutate({ kind: "message_delete", messageId }, { key });
    const gone = res.status === "rolled_back" && (res.error?.status === 404 || res.error?.code === "not_found");
    return gone ? { id: res.id, key, status: "confirmed", seq: null } : res;
  }
}

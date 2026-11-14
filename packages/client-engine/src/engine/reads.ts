import { type MirrorFreshness, mirrorFreshness } from "@trafficflow/core/drain-policy";
import { countNotify } from "../client-vitals.js";
import { warmBodyTermNames } from "../consent-cutline.js";
import type { MutationEffect } from "../mutations.js";
import { OHBOX_VISIT_ID, ohboxVisitMark, type OhboxVisitMeta } from "../ohbox-where.js";
import { ohboxView } from "../selectors.js";
import type { EntityReader } from "../store.js";
import type { EngineMessage, EngineMutation } from "../types.js";
import { LAST_DRAIN_AT_META } from "./options.js";
import { EngineState } from "./state.js";

export abstract class EngineReads extends EngineState {
  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * The overlay-merged reader — what selectors and the UI consume — with the park fact resolved
   * onto its one carrier ({@link oneSourceReader}). Applied HERE and not at each surface: a seam
   * a client can forget is how the chip and the list came to read different copies of one fact.
   */
  read(): EntityReader {
    return this.resolvedView;
  }

  /**
   * THE PERSON LEFT THE OHBOX: record where its "since you were here" count starts
   * ({@link ohboxVisitMark}). A device-local `view_meta` row, never a mutation: no outbox row, no
   * adapter call, nothing on the wire. An unchanged mark writes nothing, so the mirror's version
   * stands. Answers whether it wrote.
   */
  async markOhboxVisit(): Promise<boolean> {
    const at = ohboxVisitMark(this.read(), this.now().getTime());
    if (this.store.get<OhboxVisitMeta>("view_meta", OHBOX_VISIT_ID)?.at === at) return false;
    await this.store.putLocal("view_meta", OHBOX_VISIT_ID, { at } satisfies OhboxVisitMeta);
    return true;
  }

  /**
   * WHAT A VERB IS ASKED OVER — {@link read}, and for a message the mirror has no record of, the
   * row a History or Search page holds. The one reader `mutate` computes its effects from, so a
   * surface gating a verb or building its Undo reads the same rows the door acts on.
   */
  verbRead(): EntityReader {
    return this.verbView;
  }

  /**
   * THE ROW BEING READ KEEPS ITS PLACE until the reader moves on (owner 2026-09-18, narrowed
   * 2026-10-07). A surface names the message it opens out of "New for you" here BEFORE it saves the
   * read, and `ohboxView(read(), openRowHeld())` keeps it in New at its slot while held; a read of
   * its conversation taken meanwhile is an OPEN READ ({@link enrich}), so leaving it files it at the
   * top of "Earlier". Held only if it stands in New now: a read row, or a resurfaced one, holds
   * nothing and ends the previous hold. The hold is the engine's own state, so the read's paint and
   * the hold reach every subscriber in one snapshot — a React state beside the paint lost that race
   * to the notify.
   */
  holdOpenRow(id: string): boolean {
    this.actedAwayRow = null;
    if (id === this.openRow) return true;
    const next = ohboxView(this.read()).newForYou.some((m) => m.id === id) ? id : null;
    if (next !== this.openRow) this.setOpenRow(next);
    return next !== null;
  }

  /** The reader left `id` (any row when omitted): the row takes the top of Earlier when it holds an open read, else its arrival slot. */
  releaseOpenRow(id?: string): void {
    this.actedAwayRow = null;
    if (this.openRow === null || (id !== undefined && id !== this.openRow)) return;
    this.setOpenRow(null);
  }

  /**
   * AN UNDONE ACT PUTS THE HOLD BACK. Only the row whose hold an act ended ({@link endHoldActedAway})
   * may be held again without standing in New: it stood there when the act was pressed, so Undo
   * returns it to that place rather than to Earlier. EVERY {@link holdOpenRow} or {@link releaseOpenRow}
   * call since then spends it, a no-op one included: the reader moved. Safe before the inverse lands:
   * a held row outside the Ohbox files nothing.
   */
  restoreOpenRow(id: string): boolean {
    if (id === this.openRow) return true;
    if (id !== this.actedAwayRow) return false;
    this.actedAwayRow = null;
    this.overlayRev++;
    this.setOpenRow(id);
    return true;
  }

  /** The row {@link holdOpenRow} holds, or `null`. */
  openRowHeld(): string | null {
    return this.openRow;
  }

  /**
   * A HOLD FROM NOTHING CHANGES NO LIST: {@link holdOpenRow} holds only a row already in "New for
   * you" at this version, so every view reads the same with it or without it and the version stays —
   * a derivation keyed on it keeps its answer (a large mailbox re-derived every list on each open).
   * The hold counts from the next change, which every reader of `openRowHeld()` keys on. Ending or
   * switching a hold can move a row, so that moves the overlay revision.
   */
  protected setOpenRow(id: string | null): void {
    const ends = this.openRow !== null;
    this.openRow = id;
    if (ends) this.overlayRev++;
    this.notify();
  }

  /**
   * An act that takes the held row out of New — a pin, a pile, a move, a delete, or a confirmed
   * answer ({@link endHoldAnswered}) — ends the hold: explicit acts alone move a row, and this
   * one did, so a later release (Done on the pin) files it in Earlier rather than back in New. An
   * act that leaves it in New (its read, a tag) keeps it.
   */
  protected endHoldActedAway(effects: readonly MutationEffect[]): void {
    const held = this.openRow;
    if (held === null || !effects.some((e) => e.id === held)) return;
    if (!ohboxView(this.read(), held).newForYou.some((m) => m.id === held)) {
      this.openRow = null;
      this.actedAwayRow = held;
    }
  }

  /**
   * A CONFIRMED answer into the held row's conversation (a reply, reply all or forward) files it
   * with its Sent copy: an explicit act (owner defect 2026-09-28). A Send later has sent nothing;
   * a 202 and a refusal never reach the confirm point. Answers whether the hold ended.
   */
  protected endHoldAnswered(m: EngineMutation): boolean {
    const held = this.openRow;
    if (held === null || m.kind !== "mail_send" || m.sendAt) return false;
    const thread = this.read().get<EngineMessage>("message", held)?.threadId ?? null;
    const answers = m.inReplyTo === held || m.forwardOf === held
      || (thread !== null && m.threadId === thread);
    if (!answers) return false;
    this.openRow = null;
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * TELL ME WHICH MESSAGES A PAGE REMOVES, as it removes them — {@link subscribe} says only that
   * something moved, which is no use to anything that has to read the row one last time. Fired
   * synchronously from {@link noteMessagesRemoved}, before the apply; see there for why.
   */
  onMessagesRemoved(listener: (ids: readonly string[]) => void): () => void {
    this.removalListeners.add(listener);
    return () => this.removalListeners.delete(listener);
  }

  /**
   * IS THIS MESSAGE GONE — as opposed to merely not here. `true` only for a TOMBSTONE: a record
   * the mirror holds with `entity: null`, written by the deleting change at its own seq. An
   * absent record answers `false`, because the window is bounded and {@link MirrorStore.prune}
   * removes rather than tombstones, so absence is "outside this device's window" and a surface
   * that read it as "deleted" would say "gone" about ordinary mail on every small mirror.
   */
  messageIsGone(id: string): boolean {
    const rec = this.store.record("message", id);
    return rec !== undefined && rec.entity === null;
  }

  protected notify(): void {
    /* COUNTED. Every one of these makes the shell re-derive over the whole mirror, and the
       incident's eager pass produced two thousand in one session — the `ui_vitals` line reports
       how many arrived in the last five minutes beside what the derivation cost. */
    countNotify();
    // The body-term keys follow the rules here, so the next body write reads them warm.
    warmBodyTermNames(this.read());
    for (const l of this.listeners) l();
  }

  /**
   * WHAT A SURFACE MAY SAY ABOUT THIS MIRROR'S AGE — the one derivation of the Freshness Contract's three states (see
   * {@link FreshnessState}), computed from the drain's own completion stamp on the engine's own clock. Every surface
   * reads THIS; none re-derives it from meta, which is how three surfaces stay one contract. The comparison is the
   * same one {@link OhmailEngine.freshenStaleResume} makes — same stamp, same threshold, same clock — so "the label
   * is showing" and "the resume freshens newest-first" are a single fact observed twice, never two opinions that can
   * drift. CACHED BY VALUE for `useSyncExternalStore`: `getSnapshot` must return a stable identity while nothing
   * changed, or React loops on a fresh object per render.
   */

  /**
   * The value changes when a drain settles (which {@link OhmailEngine.drain} announces with a notify after stamping)
   * or when the clock crosses the threshold between two notifies — re-read at the next render either way.
   */
  freshness(): MirrorFreshness {
    // The DERIVATION is `@trafficflow/core/drain-policy`'s, shared with the sidecar's
    // `CloudMirror`; what stays here is the identity cache below, which is a React concern and
    // not a policy one.
    const next = mirrorFreshness(
      this.store.getMeta<string>(LAST_DRAIN_AT_META), this.now(), this.staleResumeMs,
    );
    if (next.state !== this.freshnessCache.state || next.asOf !== this.freshnessCache.asOf) {
      this.freshnessCache = next;
    }
    return this.freshnessCache;
  }
}

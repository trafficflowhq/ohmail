"use client";

/**
 * A DRAFT'S FIRST SAVE IS NAMED BY ITS IDEMPOTENCY-KEY until it settles. Offline, at the outbox gate or
 * behind a hold, the create's row is painted under a local id the server never held; the engine writes
 * the key on that row (`EngineDraft.pendingCreate`). Every editor and door binds the key, never the
 * local id, and decides what a landed create is by one table ({@link landingOf}). Both editors, the
 * composer and the inline reply, keep their creates here as claims.
 */

import type { EngineDraft, OhmailEngine } from "@ohmail/client-engine";
import { sendRecordNames } from "./send-lock";

/** A create an editor made or bound, waiting to land. */
export interface CreateClaim {
  /** What it carries, as the editor's own signature; `""` when not known (restored after a reload). */
  sig: string;
  /** The editor's binding (the message on screen) it was made under. */
  binding: number;
  /** The editor's Send count when it was made. */
  sends: number;
  /** A Send took it back while it was on the wire: that send's ending decides. */
  held: boolean;
  /** The editor's write count when it was made: a later write that reached the row makes it a copy. */
  seq: number;
}

/** What the editor holds as a claimed create lands. */
export interface EditorNow {
  binding: number;
  /** Bindings a Discard or a confirmed send ended. */
  ended: ReadonlySet<number>;
  sends: number;
  /** The server row the editor holds, or `null`. */
  row: string | null;
}

/**
 * WHAT A LANDED CREATE IS. `drop`: its message ended (Discard, a confirmed send) or a Send since
 * carried its words. `wait`: a Send on the wire took it back, and its ending decides. `keep`: made under an
 * earlier binding, it is another draft of its own. `take`: the editor's row. `carry`: the editor holds
 * a row already; the row gets the newest words, and the copy goes only per {@link copyGoes}.
 */
export type Landing = "wait" | "keep" | "drop" | "take" | "carry";

export function landingOf(c: CreateClaim, e: EditorNow): Landing {
  // A message a Discard or a confirmed send ended has no row to keep, whatever its Send's ending.
  if (e.ended.has(c.binding)) return "drop";
  if (c.held) return "wait";
  if (c.binding !== e.binding) return "keep";
  if (c.sends !== e.sends) return "drop";
  return e.row === null ? "take" : "carry";
}

/**
 * A copy beside the editor's row goes only once a write of the editor's later than the create reached
 * that row, or the row is known to hold the very words the copy carries (`holds`, a confirmed write's).
 */
export function copyGoes(c: CreateClaim, reached: number | null, holds: string | null): boolean {
  return (reached !== null && reached > c.seq) || (c.sig !== "" && c.sig === holds);
}

/** Two rows are twins when the server holds the same known words in both (`null`: not known). */
export function twins(a: string | null, b: string | null): boolean {
  return a !== null && a === b;
}

/** What a door binds for a listed row: the server row, or a create still on its way. */
export type DraftHandle = { kind: "row"; id: string; revision: string | null } | { kind: "create"; key: string };

export function handleOf(engine: OhmailEngine, d: EngineDraft): DraftHandle {
  const key = typeof d.pendingCreate === "string" ? d.pendingCreate
    : typeof engine.pendingCreateOf === "function" ? engine.pendingCreateOf(d.id) : null;
  if (key === null) return { kind: "row", id: d.id, revision: d.contentRevision ?? null };
  const made = landedOf(engine, key);
  return made !== null ? { kind: "row", id: made.id, revision: made.revision } : { kind: "create", key };
}

/** The row a create made, once the server answered it. */
export function landedOf(engine: OhmailEngine, key: string): { id: string; revision: string | null } | null {
  return typeof engine.createdDraftOf === "function" ? engine.createdDraftOf(key) : null;
}

/**
 * Whether this engine still carries the create: painted, waiting or on the wire, or landed. A key
 * another live window wrote is none of these here, and is never waited on or taken back.
 */
export function createLive(engine: OhmailEngine, key: string): boolean {
  if (landedOf(engine, key) !== null) return true;
  if (engine.pendingMutations().some((p) => p.key === key)) return true;
  if (typeof engine.inFlightMutations === "function" && engine.inFlightMutations().some((p) => p.key === key)) return true;
  return engine.read().list<EngineDraft>("draft").some((d) => d.pendingCreate === key);
}

/**
 * THE COPY A LANDED CREATE LEFT beside its editor's row, or of a message a Discard or a confirmed send
 * ended. No sentence rides it, and it never deletes a row a send record names nor the row a send went
 * from (S(2)). A refused delete leaves one more draft, never a lost one.
 */
export function dropCopy(engine: OhmailEngine, lane: string, row: string, sentRow: string | null): void {
  if (row === sentRow || sendRecordNames(lane, row, null)) return;
  void engine.mutate({ kind: "draft_discard", draftId: row });
}

/** At most this many keys are stored per editor: keys only, never words. */
export const STORED_CREATES = 8;

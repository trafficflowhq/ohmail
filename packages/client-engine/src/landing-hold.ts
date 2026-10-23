import { canonicalDestination } from "@trafficflow/core/destinations";
import type { EntityReader } from "./store.js";
import type { MutationStatus } from "./engine.js";
import type { EngineMessage, Folder, RuleDTO } from "./types.js";

/**
 * HOW LONG A COMMITTED PRESS MAY HOLD ITS ROWS AT THE PLACE without the walk saying it is done.
 * Above the server's measured retro cadence (~5.5 min on Cloud), so a press is never undone on
 * screen by the timer before the walk could have filed what it promised.
 */
export const LANDING_HOLD_MS = 10 * 60_000;

export interface LandingHoldRow {
  id: string;
  /** The row's filed folder at the press. A row whose folder changed since is no longer held. */
  from: string;
}

export interface LandingHoldEntry {
  pressId: string;
  /** The routing subject (`routingSubject`): a newer press on it replaces this one. */
  subject: string;
  place: Folder;
  rows: readonly LandingHoldRow[];
  /** Epoch ms of the press. */
  at: number;
}

export interface LandingSettle {
  worst: MutationStatus | null;
  /** The rules the commit wrote; `null` where a create's id is not known (the TTL bounds it). */
  ruleIds: readonly string[] | null;
}

export interface LandingPlaces {
  places: Map<string, Folder>;
  /** Each held row's folder at the press: `presentAt` never re-places a row that moved since. */
  from: Map<string, string>;
}

export interface LandingHold {
  hold: (entry: LandingHoldEntry) => void;
  settle: (pressId: string, outcome: LandingSettle) => void;
  drop: (subject: string) => void;
  /** Where the live entries show their rows, over the mirror at filed folders; retires what is done. */
  placesFor: (reader: EntityReader, now: number) => LandingPlaces;
  size: () => number;
}

/**
 * A COMMITTED PRESS'S ROWS STAY AT THE PLACE UNTIL THE WALK HAS FILED THEM. The routing window
 * shows a sheet press's landing at the place while it is open; once it closes, the rows the rule's
 * walk will file would otherwise snap back to the Ohbox until the walk reaches them. This holds
 * them, in memory only, until each row's folder changes (filed, or moved by anyone), the written
 * rules read their walk done, the write is refused, undone or replaced, a rule no longer names the
 * place, or {@link LANDING_HOLD_MS} runs out. A reload drops it.
 */
export function createLandingHold(): LandingHold {
  const entries = new Map<string, LandingHoldEntry & { settled?: LandingSettle }>();
  const bySubject = (subject: string): string | undefined => {
    for (const [id, e] of entries) if (e.subject === subject) return id;
    return undefined;
  };
  const done = (reader: EntityReader, e: LandingHoldEntry & { settled?: LandingSettle }): boolean => {
    const s = e.settled;
    if (!s || s.ruleIds === null) return false;
    for (const id of s.ruleIds) {
      const r = reader.get<RuleDTO>("rule", id);
      // The rule went, or no longer files here: nothing promises these rows the place.
      if (!r || !r.enabled || canonicalDestination(r.destination) !== canonicalDestination(e.place)) return true;
    }
    for (const id of s.ruleIds) {
      const retro = reader.get<RuleDTO>("rule", id)!.retro;
      // An older server says nothing about its walk: only the TTL ends the hold.
      if (!retro) return false;
      if (retro.requestedAt !== null && retro.doneAt === null) return false;
    }
    return true;
  };
  return {
    hold(entry) {
      const prior = bySubject(entry.subject);
      if (prior !== undefined) entries.delete(prior);
      if (entry.rows.length > 0) entries.set(entry.pressId, { ...entry });
    },
    settle(pressId, outcome) {
      const e = entries.get(pressId);
      if (!e) return;
      if (outcome.worst === "rolled_back" || outcome.worst === "awaiting_organizer" || outcome.worst === "superseded") {
        entries.delete(pressId);
        return;
      }
      e.settled = outcome;
    },
    drop(subject) {
      const id = bySubject(subject);
      if (id !== undefined) entries.delete(id);
    },
    placesFor(reader, now) {
      const places = new Map<string, Folder>();
      const from = new Map<string, string>();
      for (const [id, e] of entries) {
        if (now - e.at > LANDING_HOLD_MS || done(reader, e)) { entries.delete(id); continue; }
        const rows = e.rows.filter((r) => {
          const m = reader.get<EngineMessage>("message", r.id);
          return m !== undefined && (m.physicalFolder ?? m.folder) === r.from;
        });
        if (rows.length === 0) { entries.delete(id); continue; }
        if (rows.length < e.rows.length) entries.set(id, { ...e, rows });
        for (const r of rows) { places.set(r.id, e.place); from.set(r.id, r.from); }
      }
      return { places, from };
    },
    size: () => entries.size,
  };
}

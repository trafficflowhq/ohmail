import type {
  ProfileImportAppliedWire,
  ProfileImportCandidateWire,
  ProfileImportCountsWire,
  ProfileImportPendingWire,
  ProfileImportStatusWire,
} from "./wire.js";

/** How often an unanswered mailbox is re-asked, at most. The connect case rides the first beat. */
export const PROFILE_IMPORT_RECHECK_MS = 5 * 60 * 1000;

/**
 * How often a press the organizer is finishing is asked about when no doorbell rings — the
 * doorbell is the fast path (the organizer's answer rings it); this beat is for a server that
 * rings nothing. The status read is a primary-key read and never dials.
 */
export const PROFILE_IMPORT_STATUS_BEAT_MS = 15 * 1000;

/**
 * THE DOORBELL A FIND RINGS — the mirror's `settings` record's seq, or null before one lands. An
 * organizer that finds or lapses a settings document appends a `settings` change row with its
 * marker (`packages/organizer/src/profile.ts#writeMarker`); the row re-materializes unchanged settings, so
 * the consent stamp stays put and only this seq moves. The card is asked for on the drain that
 * carries it, never at the beat.
 */
export function settingsDoorbell(reader: {
  entries(type: string): ReadonlyArray<{ seq: number }>;
}): number | null {
  const [row] = reader.entries("settings");
  return row ? row.seq : null;
}

/**
 * The two shapes worth a card.
 *
 * `none` never leaves the hook. `too_large` is excluded for the same reason and by the same
 * mechanism: `asOffer` is a tolerant reader that returns `null` for any state it does not
 * recognise, so a document the server will not apply is simply not offered — which is already
 * the right behaviour. Excluding it from this type is what keeps that true at compile time
 * rather than by the reader happening to fall through.
 */
type OfferCandidate = Exclude<
  ProfileImportCandidateWire,
  { state: "none" } | { state: "too_large" } | { state: "declined" }
>;

export interface ProfileImportOffer {
  mailboxId: string;
  /** The mailbox the settings travelled with — named on the card, because accounts have several. */
  address: string;
  candidate: OfferCandidate;
}

/**
 * The card's lifecycle around ONE offer. `failed` keeps the offer and the buttons — the person's
 * answer survives a refused request, exactly as the seed review keeps its curation.
 */
export type ProfileImportPhase =
  | { kind: "offer" }
  | { kind: "applying" }
  /** Handed to the organizer (202): the card says so and asks {@link ProfileImportTransport.status}. */
  | { kind: "importing"; fingerprint: string; reason: "slow" | "unreachable" | null }
  | { kind: "failed"; message: string | null }
  | { kind: "done"; applied: ProfileImportAppliedWire };

/** A 202 from the confirm: the read did not fit the request and the organizer finishes it. */
export function isPending(
  r: ProfileImportAppliedWire | ProfileImportPendingWire,
): r is ProfileImportPendingWire {
  return (r as { state?: unknown }).state === "importing";
}

const NO_COUNTS: ProfileImportCountsWire = {
  screener: 0,
  rules: 0,
  notifyRules: 0,
  tags: 0,
  awayResponder: false,
};

/**
 * What a status answer means for the card: still importing (null), done, or the server's
 * refusal sentence. The tolerant reader again — a shape this build does not know keeps waiting.
 */
export function settledPhase(st: ProfileImportStatusWire): ProfileImportPhase | null {
  if (st.state === "imported") {
    return {
      kind: "done",
      applied: {
        imported: st.imported ?? NO_COUNTS,
        skippedRules: st.skippedRules ?? 0,
        retiredRules: countOf(st.retiredRules),
        seq: null,
      },
    };
  }
  if (st.state === "refused")
    return { kind: "failed", message: typeof st.message === "string" ? st.message : null };
  return null;
}

/** A count read leniently: a whole number above 0, else 0. */
export const countOf = (v: unknown): number =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0;

/**
 * THE QUEUE OF OFFERS, ONE ANSWER AT A TIME. The card shows the head until it is answered or dismissed:
 * a mailbox's new answer replaces its offer where it stands (the same question keeps its identity), and a
 * mailbox not queued yet waits behind the head, the waiting ones in the listed mailbox order. The head
 * itself is replaced only while `headLocked` is false, so a press in flight keeps its card.
 */
export function queueOffer(
  prev: readonly ProfileImportOffer[],
  next: ProfileImportOffer,
  order: readonly string[],
  headLocked = false,
): ProfileImportOffer[] {
  const at = prev.findIndex((o) => o.mailboxId === next.mailboxId);
  if (at >= 0) {
    const was = prev[at]!;
    if (was.address === next.address && JSON.stringify(was.candidate) === JSON.stringify(next.candidate))
      return prev as ProfileImportOffer[];
    if (at === 0 && headLocked) return prev as ProfileImportOffer[];
    return prev.map((o, i) => (i === at ? next : o));
  }
  if (prev.length === 0) return [next];
  const rank = (id: string): number => {
    const i = order.indexOf(id);
    return i === -1 ? order.length : i;
  };
  const [head, ...rest] = prev;
  return [head!, ...[...rest, next].sort((a, b) => rank(a.mailboxId) - rank(b.mailboxId))];
}

/** A row per mailbox, updated where it stands; a new one goes last, and `null` removes it. */
export function placeRow<R extends { mailboxId: string }>(prev: R[], mailboxId: string, row: R | null): R[] {
  const at = prev.findIndex((r) => r.mailboxId === mailboxId);
  if (row === null) return at === -1 ? prev : prev.filter((r) => r.mailboxId !== mailboxId);
  if (at === -1) return [...prev, row];
  return JSON.stringify(prev[at]) === JSON.stringify(row) ? prev : prev.map((r, i) => (i === at ? row : r));
}

export interface ProfileImportState {
  /** The offer on screen — the first to arrive, until answered; the next queues behind it ({@link queueOffer}). */
  offer: ProfileImportOffer | null;
  phase: ProfileImportPhase;
  importNow: () => void;
  notNow: () => void;
  /** Leave the `done` confirmation. */
  acknowledge: () => void;
  /**
   * The documents answered "Not now" that still stand — the SAME answers the card's check reads,
   * no second request — held by the shell so a surface with no Mailboxes node of its own still
   * shows the pane while one stands. A "Not now" here adds its row at once.
   */
  declined: SavedRow[];
  /** The mailboxes whose organizer cannot keep its settings copy there, from the same answers. */
  unkept: UnkeptRow[];
}

/** A mailbox whose organizer recorded that it cannot keep its settings copy there. */
export interface UnkeptRow {
  mailboxId: string;
  address: string;
}

/** The tolerant reader: only an answer that says the copy is not kept names the mailbox. */
export function copyUnkept(dto: unknown): boolean {
  if (typeof dto !== "object" || dto === null) return false;
  const copy = (dto as { copy?: unknown }).copy;
  return typeof copy === "object" && copy !== null && (copy as { kept?: unknown }).kept === false;
}

/**
 * THE TOLERANT READER over the candidate wire — an answer this build does not RECOGNISE is not
 * an offer. The claim "your settings are waiting" may only be made from a fully-formed `found`
 * (fingerprint and every count present) or a well-formed `newer`; anything else — an older or
 * different server build, a proxy answering 200 `{}`, a test harness's catch-all — reads as
 * `none`. Measured, not hypothetical: a catch-all mock's `{}` reached the card as a "found"
 * offer with no counts and the render crash took the whole shell down with it.
 */
export function asOffer(dto: unknown): OfferCandidate | null {
  if (typeof dto !== "object" || dto === null) return null;
  const d = dto as Record<string, unknown>;
  if (d.state === "newer" && typeof d.v === "number" && Number.isInteger(d.v)) {
    return { state: "newer", v: d.v };
  }
  if (d.state !== "found") return null;
  if (typeof d.fingerprint !== "string" || d.fingerprint.length === 0) return null;
  if (typeof d.updatedAt !== "string") return null;
  const producer = d.producer as Record<string, unknown> | null | undefined;
  if (typeof producer !== "object" || producer === null) return null;
  const counts = d.counts as Record<string, unknown> | null | undefined;
  if (typeof counts !== "object" || counts === null) return null;
  for (const k of ["screener", "rules", "notifyRules", "tags"] as const) {
    if (typeof counts[k] !== "number") return null;
  }
  if (typeof counts.awayResponder !== "boolean") return null;
  // A receipt that is no string is not one: the card neither says "replacing" nor sends it back.
  const { signatureReplaces, removedRules, ...rest } = counts;
  return {
    state: "found",
    fingerprint: d.fingerprint,
    updatedAt: d.updatedAt,
    producer: {
      kind: typeof producer.kind === "string" ? producer.kind : "unknown",
      version: typeof producer.version === "string" ? producer.version : "",
    },
    counts: {
      ...(rest as unknown as ProfileImportCountsWire),
      ...(typeof signatureReplaces === "string" && signatureReplaces.length > 0 ? { signatureReplaces } : {}),
      ...(countOf(removedRules) > 0 ? { removedRules: countOf(removedRules) } : {}),
    },
  };
}

/**
 * THE MAILBOXES A SETTINGS CHECK ASKS: not a removed one (`isRemovedMailbox`'s rule). A removal
 * deletes the credentials, and a check on it was the 502 every five minutes for as long as the
 * window stayed open. A stand-down an older engine reports as `disabled` is still the person's
 * mailbox and keeps its card.
 */
export function askableMailboxes<M extends { id: string; status?: string | null; legacyStandDown?: boolean }>(
  mailboxes: ReadonlyArray<M> | null,
): ReadonlyArray<M> | null {
  return mailboxes === null
    ? null
    : mailboxes.filter((m) => !(m.status === "disabled" && m.legacyStandDown !== true));
}

/**
 * The counts, in plain words, joined the way the locale joins a list. Zero-count parts vanish. The
 * signature says it replaces this mailbox's when the offer names one, and the copy's rule removals are
 * said, except where `replacing` is false (the Replace note speaks of the copy's settings alone).
 */
export function detailsOf(
  t: (key: string, values?: Record<string, string | number | Date>) => string,
  locale: string,
  counts: ProfileImportCountsWire,
  replacing = true,
): string {
  const parts: string[] = [];
  if (counts.screener > 0) parts.push(t("screenerPart", { count: counts.screener }));
  if (counts.rules > 0) parts.push(t("rulesPart", { count: counts.rules }));
  if (counts.notifyRules > 0) parts.push(t("notifyPart", { count: counts.notifyRules }));
  if (counts.tags > 0) parts.push(t("tagsPart", { count: counts.tags }));
  if (counts.awayResponder) parts.push(t("awayPart"));
  if (counts.signature === true) {
    parts.push(
      replacing && typeof counts.signatureReplaces === "string"
        ? t("signatureReplacingPart")
        : t("signaturePart"),
    );
  }
  if (replacing && countOf(counts.removedRules) > 0)
    parts.push(t("removedPart", { count: countOf(counts.removedRules) }));
  if (parts.length === 0) return "";
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
  } catch {
    return parts.join(", ");
  }
}

/** A "Not now" answer whose document still stands in the mailbox. */
type DeclinedCandidate = Extract<ProfileImportCandidateWire, { state: "declined" }>;

/** The tolerant reader again: a `declined` row is shown only when fully formed, as for `found`. */
export function asDeclined(dto: unknown): DeclinedCandidate | null {
  if (typeof dto !== "object" || dto === null || (dto as { state?: unknown }).state !== "declined")
    return null;
  const found = asOffer({ ...(dto as Record<string, unknown>), state: "found" });
  return found !== null && found.state === "found" ? { ...found, state: "declined" } : null;
}

export interface SavedRow {
  mailboxId: string;
  address: string;
  candidate: DeclinedCandidate;
}

import type { StreamHand, StreamItemBox, StreamLook, StreamReadRule } from "./stream-read-types.js";
export type { StreamHand, StreamItemBox, StreamLook, StreamReadRule } from "./stream-read-types.js";
import { previewEvidence } from "./preview-evidence.js";
import { createStreamBand } from "./stream-band.js";

/**
 * The News and Receipts visit's read evidence. A mounted stream measures the visible sender and
 * first lines for the same dwell as a conversation. Hand scrolling reads cards carried past
 * the reading line and the card it rests on. An unfinished body can earn a deferred read. Only the bounded leave writes the waterline. Passive addresses cancel reading permission,
 * flights cannot read cards they pass, and an explicit Mark unread holds for the whole visit.
 */

/** How long a hand scroll or a chosen letter must rest. */
export const STREAM_REST_MS = 600;
/** A folded snippet at the cursor needs a longer, deliberate rest. */
export const STREAM_SNIPPET_REST_MS = 2000;
/** The first lines of an item that must stand wholly in view for it to count as shown. */
export const STREAM_FIRST_LINES_PX = 96;
/** How far past the top (going down) or the foot (going up) an item must be carried. */
export const STREAM_READING_LINE_PX = 90;
/** How near an end the stream must stand to be at it, and how much overflow a stream that fits whole may have. */
export const STREAM_END_SLACK_PX = 2;
/** How long after the last wheel step or key a scroll is still the hand's; a finger's momentum runs longer. */
export const STREAM_HAND_MS = 450;
export const STREAM_TOUCH_HAND_MS = 1500;

/** Its first lines stand wholly in the view from `top` to `foot`. */
const firstLinesIn = (item: StreamItemBox, top: number, foot: number): boolean =>
  item.height > 0 &&
  item.top >= top - 4 &&
  Math.max(item.top + Math.min(item.height, STREAM_FIRST_LINES_PX), item.lines?.lead?.bottom ?? item.top) <=
    foot;
/** The look stands at the end the stream is going to. */
const atTheEnd = (l: StreamLook, up: boolean): boolean =>
  up
    ? l.scrollTop <= STREAM_END_SLACK_PX
    : l.scrollTop >= l.scrollHeight - l.viewHeight - STREAM_END_SLACK_PX;
/** A look from `top` to `foot` has carried it past the reading line, going up or down. */
const carriedPast = (item: StreamItemBox, up: boolean, top: number, foot: number): boolean =>
  up ? item.top >= foot - STREAM_READING_LINE_PX : item.top + item.height <= top + STREAM_READING_LINE_PX;

function rememberShown(look: StreamLook, shownIds: Set<string>, previews: Set<string>): void {
  const top = look.scrollTop;
  const foot = top + look.viewHeight;
  for (const item of look.items) {
    if (!firstLinesIn(item, top, foot)) continue;
    shownIds.add(item.id);
    if (item.lines) previews.add(item.id);
  }
}

/** Use the same reading line when the hand rests. */
function restingAt(look: StreamLook): string | null {
  const line = look.scrollTop + Math.min(look.viewHeight, STREAM_READING_LINE_PX);
  let resting: string | null = null;
  for (const item of look.items) {
    if (item.height <= 0 || item.top + item.height <= look.scrollTop || item.top > line) continue;
    resting = item.id;
  }
  return resting;
}

function readPast(
  l: StreamLook,
  previous: number,
  up: boolean,
  readable: (item: StreamItemBox) => boolean,
): string[] {
  const top = l.scrollTop;
  const foot = top + l.viewHeight;
  const atEnd = atTheEnd(l, up);
  const past: string[] = [];
  for (const item of l.items) {
    const pastLine = carriedPast(item, up, top, foot);
    const wasInView = item.top + item.height > previous && item.top < previous + l.viewHeight;
    const restsAtEnd = atEnd && firstLinesIn(item, top, foot);
    if (((wasInView && (atEnd || pastLine)) || restsAtEnd) && readable(item)) past.push(item.id);
  }
  return past;
}

/** Keep emitted glances and the unread holds when another screen starts. */
function trackReads(shownIds: Set<string>, kept: Set<string>, owed: Set<string>, receipts: boolean) {
  const said = new Set<string>();
  const canGlance = (item: StreamItemBox): boolean => item.unread && !kept.has(item.id) && !said.has(item.id);
  return {
    unread: (item: StreamItemBox) => canGlance(item) && !owed.has(item.id),
    readable(item: StreamItemBox, canReadPreview = false): boolean {
      if (!shownIds.has(item.id) || !canGlance(item)) return false;
      if (item.ready || canReadPreview) return true;
      if (!receipts) owed.add(item.id);
      return false;
    },
    write(ids: string[]): readonly string[] {
      for (const id of ids) said.add(id);
      return ids;
    },
    read: (id: string) => !kept.has(id) && (said.has(id) || owed.has(id)),
  };
}

interface Visit {
  driven: boolean;
  textDriven: boolean;
  bandDriven: boolean;
  enteredLetter: string | null;
  enteredViewport: boolean;
  handDrove: boolean;
  handRest: boolean;
  lastTop: number | null;
  lastHeight: number | null;
}

export function createStreamReadRule(receipts = false): StreamReadRule {
  const visit: Visit = {
    driven: false,
    textDriven: false,
    bandDriven: false,
    enteredLetter: null,
    enteredViewport: false,
    handDrove: false,
    handRest: false,
    lastTop: null,
    lastHeight: null,
  };
  let handAt = Number.NEGATIVE_INFINITY;
  let handKind: StreamHand = "wheel";
  let touching = false;
  const shownIds = new Set<string>();
  const shownPreviews = new Set<string>();
  const kept = new Set<string>();
  /** Read by the rule while its body was not in: never written live, flipped by the leave. */
  const owed = new Set<string>();
  const reads = trackReads(shownIds, kept, owed, receipts);
  const evidence = previewEvidence(reads.unread, owed);
  const band = createStreamBand();

  const byHand = (at: number): boolean =>
    touching || at - handAt < (handKind === "touch" ? STREAM_TOUCH_HAND_MS : STREAM_HAND_MS);
  /** A hand of `kind` on the stream: driven, and what it scrolls is the hand's (a finger's while `down`). */
  const handOn = (kind: StreamHand, at: number, down: boolean): void => {
    visit.driven = true;
    visit.enteredLetter = null;
    handKind = kind;
    handAt = at;
    if (kind === "touch") touching = down;
  };
  return {
    get driven() {
      return visit.driven;
    },
    get handDrove() {
      return visit.handDrove;
    },
    enter(_at, letter, viewport = false) {
      evidence.dwell(null);
      band.clear();
      visit.handRest = false;
      visit.enteredLetter = letter ?? null;
      visit.enteredViewport = viewport || (letter !== undefined && visit.handDrove);
      visit.driven = true;
      visit.textDriven = true;
      /* What a press scrolls to is the press's landing, not the hand's. */
      handAt = Number.NEGATIVE_INFINITY;
      touching = false;
    },
    selectionChanged(openId) {
      if (visit.enteredLetter !== null && visit.enteredLetter !== openId) {
        visit.enteredLetter = null;
        visit.driven = false;
        visit.textDriven = false;
      }
    },
    preview() {
      visit.driven = false;
      visit.textDriven = false;
      visit.enteredLetter = null;
      visit.handDrove = false;
      visit.bandDriven = false;
      visit.handRest = false;
      handAt = Number.NEGATIVE_INFINITY;
      touching = false;
      visit.lastTop = null;
      shownIds.clear();
      shownPreviews.clear();
      band.clear();
      evidence.reset();
      owed.clear();
    },
    holdsEntered: (id) => visit.enteredLetter === id,
    scrollKey() {
      band.clear();
      evidence.dwell(null);
      shownIds.clear();
      shownPreviews.clear();
      visit.lastTop = null;
      visit.handRest = false;
      visit.enteredLetter = null;
      visit.driven = true;
      visit.textDriven = true;
      visit.bandDriven = true;
      visit.handDrove = true;
      /* What the jump flies past is its flight's, not the hand's. */
      handAt = Number.NEGATIVE_INFINITY;
      touching = false;
    },
    appMoved() {
      band.clear();
      visit.bandDriven = false;
      evidence.dwell(null);
      shownIds.clear();
      shownPreviews.clear();
      visit.lastTop = null;
      visit.handRest = false;
      handAt = Number.NEGATIVE_INFINITY;
      touching = false;
    },
    hand(kind, at, isTouching) {
      if (!byHand(at)) band.clear();
      visit.bandDriven = true;
      visit.handDrove = true;
      handOn(kind, at, isTouching === true);
    },
    touchDown: (at) => handOn("touch", at, true),
    touchUp: (at) => handOn("touch", at, false),
    ...streamObservation(visit, { shownIds, shownPreviews, kept, reads, evidence, receipts, byHand, band }),
    get previewDue() {
      return evidence.due;
    },
  };
}

type StreamObservation = Pick<
  StreamReadRule,
  | "look"
  | "still"
  | "band"
  | "settled"
  | "rest"
  | "previewDwell"
  | "keepUnread"
  | "keptUnread"
  | "shown"
  | "read"
>;

interface ObservationInputs {
  shownIds: Set<string>;
  shownPreviews: Set<string>;
  kept: Set<string>;
  reads: ReturnType<typeof trackReads>;
  evidence: ReturnType<typeof previewEvidence>;
  receipts: boolean;
  byHand: (at: number) => boolean;
  band: ReturnType<typeof createStreamBand>;
}

function streamObservation(
  visit: Visit,
  { shownIds, shownPreviews, kept, reads, evidence, receipts, byHand, band }: ObservationInputs,
): StreamObservation {
  return {
    look(l, attended, flight, receiptAttended) {
      const previous = visit.lastTop ?? l.scrollTop;
      const height = l.physicalHeight ?? l.viewHeight;
      const resized = visit.lastHeight !== null && visit.lastHeight !== height;
      const delta = l.scrollTop - previous;
      visit.lastTop = l.scrollTop;
      visit.lastHeight = height;
      if (!attended || flight || resized) {
        visit.handRest = false;
        band.clear();
        if (!attended) evidence.dwell(null);
        return [];
      }
      rememberShown(l, shownIds, shownPreviews);
      if (delta === 0) return [];
      visit.handRest = visit.driven && byHand(l.at);
      const discontinuous = Math.abs(delta) >= height;
      band.scroll(l, !discontinuous && delta > 0 && visit.handRest);
      if (discontinuous) evidence.dwell(null);
      if (!visit.handRest) return [];
      visit.textDriven = true;
      if (discontinuous) return [];
      const up = delta < 0;
      return reads.write(
        readPast(l, previous, up, (item) => {
          // An unfinished receipt can pass its preview at the top. Upward movement still needs its displayed-text dwell.
          const preview =
            shownPreviews.has(item.id) && (receipts ? !up && receiptAttended : item.lines !== undefined);
          return reads.readable(item, preview);
        }),
      );
    },
    still(l, _by) {
      band.sample(l);
      rememberShown(l, shownIds, shownPreviews);
      if (l.viewHeight <= 0 || l.scrollHeight - (l.physicalHeight ?? l.viewHeight) > STREAM_END_SLACK_PX)
        return [];
      visit.driven = true;
      visit.textDriven = true;
      visit.bandDriven = true;
      visit.handDrove = true;
      const foot = l.scrollTop + l.viewHeight;
      const past: string[] = [];
      for (const item of l.items) {
        if (!firstLinesIn(item, l.scrollTop, foot)) continue;
        if (reads.readable(item)) past.push(item.id);
      }
      return reads.write(past);
    },
    band(l) {
      if (!visit.bandDriven || l.viewHeight <= 0) return [];
      rememberShown(l, shownIds, shownPreviews);
      return reads.write(band.read(l, (item) => reads.readable(item, true)));
    },
    settled(l) {
      visit.lastTop = l.scrollTop;
      visit.lastHeight = l.physicalHeight ?? l.viewHeight;
      rememberShown(l, shownIds, shownPreviews);
    },
    rest(l, restingId, openId, snippetRested) {
      rememberShown(l, shownIds, shownPreviews);
      const target = visit.enteredLetter ?? restingId ?? (visit.handRest ? restingAt(l) : null);
      if (!visit.driven || target === null) return [];
      if (visit.enteredLetter !== null && openId !== undefined && openId !== visit.enteredLetter) return [];
      const item = l.items.find((i) => i.id === target);
      const foot = l.scrollTop + l.viewHeight;
      if (!item || item.top >= foot || item.top + item.height <= l.scrollTop) return [];
      if (visit.enteredLetter !== null && visit.enteredViewport && item.lines) return [];
      if (visit.enteredLetter !== null && !firstLinesIn(item, l.scrollTop, foot)) return [];
      const lead = item.lines?.lead;
      const previewVisible = lead != null && lead.top >= l.scrollTop && lead.bottom <= foot;
      const preview = visit.handRest && visit.enteredLetter === null && previewVisible && !receipts;
      if (!item.ready && preview && !snippetRested) return [];
      return reads.readable(item, preview) ? reads.write([item.id]) : [];
    },
    previewDwell(l, judged) {
      if (l && judged) return reads.write(evidence.judgedDwell(l, judged !== "settled"));
      if (!l || !visit.textDriven) return evidence.dwell(null);
      const observed =
        visit.enteredLetter === null || visit.enteredViewport
          ? l
          : { ...l, items: l.items.filter((item) => item.id === visit.enteredLetter) };
      return reads.write(evidence.dwell(observed));
    },
    keepUnread(id) {
      evidence.keepUnread(id);
      kept.add(id);
    },
    keptUnread: (id) => kept.has(id),
    shown(id) {
      return shownIds.has(id);
    },
    read: reads.read,
  };
}

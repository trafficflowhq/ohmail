/**
 * Which of two versions of an event is the newer, and whether an answer still answers the event as
 * it stands (RFC 5546 section 2.1.5, "Message Sequencing"). Messages arrive in any order; these
 * questions are how a calendar keeps from going backwards.
 */
import type { CalEvent } from "../ical/event.js";

const sequenceOf = (e: CalEvent): number => e.sequence ?? 0;

/**
 * 1 when `a` is the newer version of the same event, -1 when `b` is, 0 when neither can be told
 * apart. The higher SEQUENCE "obsoletes all other revisions"; where they match, "the DTSTAMP
 * property is used as the tie-breaker", and a version with no stamp is older than one with.
 */
export function compareVersions(a: CalEvent, b: CalEvent): -1 | 0 | 1 {
  const bySequence = sequenceOf(a) - sequenceOf(b);
  if (bySequence !== 0) return bySequence > 0 ? 1 : -1;
  const [stampA, stampB] = [a.dtstamp?.epochMs ?? -Infinity, b.dtstamp?.epochMs ?? -Infinity];
  return stampA === stampB ? 0 : stampA > stampB ? 1 : -1;
}

/** `current`: the answer is to the version held, and is not older than the invitee's last. `stale`: it is to an older version, or older than an answer already taken in. `ahead`: it is to a newer version than is held. */
export type ReplyStanding = "current" | "stale" | "ahead";

/**
 * An answer names, by its SEQUENCE, "the revision of the component to which the Attendee is
 * replying" (an absent one is 0). The organizer raises the number when the time, the repeat or the
 * status changes, so an answer to an older number is an answer to another meeting. This asks about
 * the version alone.
 */
export function versionStanding(reply: CalEvent, held: CalEvent): ReplyStanding {
  const difference = sequenceOf(reply) - sequenceOf(held);
  return difference === 0 ? "current" : difference < 0 ? "stale" : "ahead";
}

/**
 * Whether an answer still stands against the component held for what it answers: it must be to the
 * version held, and no older than the last answer taken in from the same invitee. Two answers to
 * one version are ordered by their stamps, so that one written earlier and delivered later is not
 * the invitee's last word; an answer with no stamp is older than any with one. The last answer is
 * read from the invitee's own line of the held component, where `applyReply` noted it; where
 * nothing is noted the version decides alone.
 */
export function replyStanding(reply: CalEvent, held: CalEvent): ReplyStanding {
  const byVersion = versionStanding(reply, held);
  if (byVersion !== "current") return byVersion;
  const who = reply.attendees[0]?.email ?? null;
  const last = who === null ? null : (held.attendees.find((a) => a.email === who)?.answered ?? null);
  if (last === null) return "current";
  if (sequenceOf(reply) !== last.sequence) return sequenceOf(reply) < last.sequence ? "stale" : "current";
  return (reply.dtstamp?.epochMs ?? -Infinity) < (last.dtstamp?.epochMs ?? -Infinity) ? "stale" : "current";
}

export const isStaleReply = (reply: CalEvent, held: CalEvent): boolean => replyStanding(reply, held) === "stale";

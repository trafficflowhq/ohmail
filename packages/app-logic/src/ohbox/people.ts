import { arrivalMs, isOwnOutbound, type OhboxRow as OhboxRowGroup } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";

/** One person of a row's conversation: the newest letter they wrote, and whether it is the account's own. */
export interface OhboxPerson {
  letter: EngineMessage;
  you: boolean;
}

/**
 * THE VOICES A GROUPED ROW SPEAKS FOR — one message per distinct sender, newest first. The unread members while the
 * conversation is waiting (what is unanswered is what the row is for), else the newest member alone once it has all
 * been read. Returns the MESSAGES rather than their names because two things are derived from this list and they
 * must not drift: the sender line ({@link groupSenders}) and the row's lead circles. A row whose text reads "Ada
 * Lund, Bo Ek" and whose faces are somebody else's would be two answers to one question.
 */
export const groupVoices = (g: OhboxRowGroup): EngineMessage[] => {
  const ms = (m: EngineMessage): number => arrivalMs(m) ?? Number.NEGATIVE_INFINITY;
  const pool = (g.unreadCount > 0 ? g.members.filter((m) => m.unread) : [g.face])
    .slice()
    .sort((a, b) => (ms(a) === ms(b) ? 0 : ms(b) - ms(a)));
  const seen = new Set<string>();
  const out: EngineMessage[] = [];
  for (const m of pool) {
    const key = m.from.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
};

/** A grouped row's sender summary: the distinct unread voices, newest first. */
export const groupSenders = (g: OhboxRowGroup, senderName: (m: EngineMessage) => string): string =>
  groupVoices(g).map(senderName).join(", ");

/**
 * THE ROW'S PEOPLE: everybody in the conversation as it stands (`conversationOf`, the whole history and not only the
 * members this group holds), one entry a sender: the row's voices first, then everybody else newest first, the
 * account's own letters as one person (`you`) in their place. A letter with no conversation is its sender alone.
 */
export const groupPeople = (
  g: OhboxRowGroup,
  conversationOf: ((messageId: string) => readonly EngineMessage[]) | undefined,
): OhboxPerson[] => {
  const ms = (m: EngineMessage): number => arrivalMs(m) ?? Number.NEGATIVE_INFINITY;
  const threaded = g.members.length > 1 || g.face.threadId != null;
  const convo = threaded ? (conversationOf?.(g.openTarget.id) ?? []) : [];
  const pool = (convo.length > 0 ? convo : g.members)
    .slice()
    .sort((a, b) => (ms(a) === ms(b) ? 0 : ms(b) - ms(a)));
  const out: OhboxPerson[] = [];
  const seen = new Set<string>();
  const add = (m: EngineMessage): void => {
    const you = isOwnOutbound(m);
    const key = you ? "\u0000you" : m.from.address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ letter: m, you });
  };
  for (const m of groupVoices(g)) add(m);
  for (const m of pool) add(m);
  return out;
};

/** The first word of a name. A name with no space, or one written "Last, First", stays whole. */
export function firstNameOf(name: string): string {
  const n = name.trim();
  if (n.includes(",") || !/\s/.test(n)) return n;
  return n.split(/\s+/)[0]!;
}

export interface RowWho {
  /** Line one: the voices by first name, or the one voice whole. */
  who: string;
  /** The one voice's address; none for several. */
  address: string | undefined;
  /** Every voice whole, for the row's name a screen reader hears. */
  names: string;
  byline: readonly { letter: EngineMessage; name: string; text: string }[];
}

/**
 * Who a row speaks for. Two or more voices: their first names, no address. One: the whole name and its address.
 * An own reply leading a read conversation speaks for its recipient (`sentTo`), in the words `to` makes.
 */
export function whoOf(
  voices: readonly EngineMessage[],
  name: (m: EngineMessage) => string,
  address: (m: EngineMessage) => string | undefined,
  sentTo: { label: string } | null,
): RowWho {
  if (sentTo !== null) return { who: sentTo.label, address: undefined, names: sentTo.label, byline: [] };
  const byline = voices.map((letter) => {
    const whole = name(letter);
    return { letter, name: whole, text: voices.length > 1 ? firstNameOf(whole) : whole };
  });
  const one = voices.length === 1 ? voices[0] : undefined;
  return {
    who: byline.map(({ text }) => text).join(", "),
    address: one ? address(one) : undefined,
    names: byline.map(({ name }) => name).join(", "),
    byline,
  };
}

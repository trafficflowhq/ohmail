/**
 * THE ORDER A MAIL ROW'S FACTS ARE SPOKEN IN — one list, and now two surfaces read it.
 *
 * `MessageRow` assembled this inline, which made the order unreadable from anywhere else: the
 * phone's row spoke sender, subject, stamp and read state and NONE of its badges, and nothing
 * could notice. The order lives here so the phone's twin (`apps/mobile/src/ui/row-spoken.ts`)
 * is held against it by a test rather than by somebody remembering. `tracker` has its place
 * although this surface emits it nowhere: a kind with no slot is a kind whose place gets
 * invented twice.
 */
export type RowSpokenKind =
  | "arrived"
  | "readState"
  | "thread"
  | "attachment"
  | "protected"
  | "held"
  | "newSince"
  | "stateNote"
  | "aiReason"
  | "tracker"
  | "place"
  | "mailbox"
  | "destination"
  | "detection"
  | "amount"
  | "tag";

/** The one order. A surface speaks a subset of it; none of them reorders it. */
export const ROW_SPOKEN_ORDER: readonly RowSpokenKind[] = [
  "arrived",
  "readState",
  "thread",
  "attachment",
  "protected",
  "held",
  "newSince",
  "stateNote",
  "aiReason",
  "tracker",
  "place",
  "mailbox",
  "destination",
  "detection",
  "amount",
  "tag",
];

/** One fact, in the words the surface's own catalogue gave it. */
export interface RowSpokenFact {
  kind: RowSpokenKind;
  text: string;
}

/**
 * THE WORDS A ROW IS READ OUT WITH — the two facts it draws as colour and shape and therefore
 * says nothing about. `packages/ui` holds no catalogue, so they arrive from the host; the object
 * is memoized there, because a fresh one per render is a prop that defeats any comparator.
 */
export interface MessageRowSpoken {
  /** The dot and the heavy ink, in a word. */
  unread: string;
  /** The quiet ink, in a word — a read row states its readness rather than merely lacking a dot. */
  read: string;
  /** The clip badge, which is an icon with no text at all. */
  attachment: string;
}

/**
 * What a row hands over to be spoken — strings only, taken from the props it DRAWS from, so the
 * spoken row and the drawn row cannot come apart. `protectedLabel` and `heldLabel` are `ReactNode`
 * at the row's own door and arrive here only when the host handed words rather than markup.
 */
export interface MessageRowFacts {
  time?: string;
  timeSpoken?: string;
  unread?: boolean;
  spoken?: MessageRowSpoken;
  hasAttachment?: boolean;
  threadCount?: number;
  /**
   * The conversation's length IN WORDS, from the host's catalogue — the badge draws `N` and a
   * number read out in a list of capsules has no referent. Same contract as `protectedLabel`:
   * this package holds no catalogue, so the fact is spoken only where the host handed a sentence.
   */
  threadLabel?: string;
  protectedLabel?: string;
  heldCount?: number;
  heldLabel?: string;
  newSinceLabel?: string;
  newSinceTitle?: string;
  stateNote?: string;
  aiReason?: string;
  place?: string;
  mailbox?: string;
  mailboxTitle?: string;
  destination?: string;
  detection?: string;
  amount?: string;
  tags?: readonly { name: string }[];
}

/** The facts this surface's row has to say, in no particular order — {@link orderRowSpoken} owns that. */
export function messageRowFacts(p: MessageRowFacts): RowSpokenFact[] {
  const said: RowSpokenFact[] = [];
  const arrived = p.timeSpoken ?? p.time;
  if (arrived) said.push({ kind: "arrived", text: arrived });
  if (p.spoken) said.push({ kind: "readState", text: p.unread ? p.spoken.unread : p.spoken.read });
  /* A conversation of one is not a conversation — the row draws no badge for it either. */
  if (p.threadCount !== undefined && p.threadCount > 1 && p.threadLabel !== undefined) {
    said.push({ kind: "thread", text: p.threadLabel });
  }
  if (p.hasAttachment && p.spoken) said.push({ kind: "attachment", text: p.spoken.attachment });
  if (p.protectedLabel !== undefined) said.push({ kind: "protected", text: p.protectedLabel });
  if (p.heldCount !== undefined && p.heldCount > 1 && p.heldLabel !== undefined) {
    said.push({ kind: "held", text: p.heldLabel });
  }
  /* The SENTENCE where there is one: "2 new" read aloud in a list is a number and a word with
     no referent, and the badge's own title is the phrase the host already wrote. */
  if (p.newSinceLabel) said.push({ kind: "newSince", text: p.newSinceTitle ?? p.newSinceLabel });
  if (p.stateNote) said.push({ kind: "stateNote", text: p.stateNote });
  // The row SAYS what ohmail checked, not only draws it: a chip nobody can hear is a fact
  // withheld from the reader who most needs it.
  if (p.aiReason) said.push({ kind: "aiReason", text: p.aiReason });
  if (p.place) said.push({ kind: "place", text: p.place });
  /* The SENTENCE, not the face: "Work" alone in a list of capsules says nothing about what is
     being claimed, and the badge's own title is the phrase the host already wrote. */
  if (p.mailbox) said.push({ kind: "mailbox", text: p.mailboxTitle ?? p.mailbox });
  if (p.destination) said.push({ kind: "destination", text: p.destination });
  if (p.detection) said.push({ kind: "detection", text: p.detection });
  if (p.amount) said.push({ kind: "amount", text: p.amount });
  for (const t of p.tags ?? []) said.push({ kind: "tag", text: t.name });
  return said;
}

/** The facts in {@link ROW_SPOKEN_ORDER}; facts of one kind keep the order they were given in. */
export function orderRowSpoken(facts: readonly RowSpokenFact[]): RowSpokenFact[] {
  const out: RowSpokenFact[] = [];
  for (const kind of ROW_SPOKEN_ORDER) {
    for (const f of facts) if (f.kind === kind) out.push(f);
  }
  return out;
}

/** This surface's join. The phone speaks in sentences and owns its own — see the twin. */
export const ROW_SPOKEN_JOIN = " · ";

/** A row's whole description, or nothing where it has no fact beyond its name. */
export function messageRowDescription(p: MessageRowFacts): string | undefined {
  const said = orderRowSpoken(messageRowFacts(p)).map((f) => f.text);
  return said.length > 0 ? said.join(ROW_SPOKEN_JOIN) : undefined;
}

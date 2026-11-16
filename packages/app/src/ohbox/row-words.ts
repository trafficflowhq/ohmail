/**
 * WHAT A ROW SAYS, from its letters: who it speaks for, their circles, and what a screen reader hears. Pure: the
 * names come through the shell's words, the voices from the model.
 */
import type { EngineMessage } from "@ohmail/client-engine";
import type { RowPerson } from "@ohmail/ui/mail";

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
  if (sentTo !== null) return { who: sentTo.label, address: undefined, names: sentTo.label };
  if (voices.length > 1) {
    const whole = voices.map(name);
    return { who: whole.map(firstNameOf).join(", "), address: undefined, names: whole.join(", ") };
  }
  const one = voices[0];
  if (!one) return { who: "", address: undefined, names: "" };
  const whole = name(one);
  return { who: whole, address: address(one), names: whole };
}

/**
 * The row's circles: everybody in the conversation, its voices first, the account's own in its place; the lead and one
 * other, and from three the lead and a small circle counting everybody after it ("+2"). `names` is everybody whole for the circles' name, `you`
 * standing for the account's own ("3 people: Giulia Rossi, Ben Arnold and you"); null where there is one person.
 */
/* One list format a language, made on first use: a row's draw made one a row before. */
const LISTS = new Map<string, Intl.ListFormat>();
const listIn = (locale: string): Intl.ListFormat => {
  let list = LISTS.get(locale);
  if (list === undefined) {
    list = new Intl.ListFormat(locale, { type: "conjunction" });
    LISTS.set(locale, list);
  }
  return list;
};

export function peopleOf(
  all: readonly { letter: EngineMessage; you: boolean }[],
  name: (m: EngineMessage) => string,
  you: string,
  locale: string,
): { people: RowPerson[]; more: number; count: number; names: string | null } {
  const people = all.slice(0, 2).map((p) => ({ name: name(p.letter), address: p.letter.from.address }));
  const said = all.map((p) => (p.you ? you : name(p.letter)));
  /* The product's English joins a list without a comma before "and", as its sentences do. */
  const list = listIn(locale === "en" ? "en-GB" : locale);
  const names = all.length > 1 ? list.format(said) : null;
  /* From three people on, the small circle counts everybody after the lead. */
  return { people, more: all.length >= 3 ? all.length - 1 : 0, count: all.length, names };
}

/** What follows the row's name, as the shipped row says it: when it arrived, unread or read, the marks, the file. */
export function spokenOf(parts: {
  when?: string | null;
  unread: string | null;
  marks: string | null;
  file: string | null;
}): string {
  return [parts.when ?? null, parts.unread, parts.marks, parts.file]
    .filter((p): p is string => p !== null && p !== "")
    .join(" · ");
}

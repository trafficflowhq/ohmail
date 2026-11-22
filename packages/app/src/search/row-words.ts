/**
 * WHAT A RESULT SAYS, from its letter and its matches: who, the address under the name, the subject with the word it
 * was found by marked. Pure: the shell's words name, print and place it.
 */
import type { SearchHit } from "@ohmail/client-engine";
import type { RowPerson } from "@ohmail/ui/mail";
import type { SearchWords } from "./beside.js";

/** The subject cut around the first matched word that appears in it; null where none stands in it. */
export interface MarkedSubject {
  readonly before: string;
  readonly marked: string;
  readonly after: string;
}

export function markedSubject(subject: string, hit: Pick<SearchHit, "matches">): MarkedSubject | null {
  const lower = subject.toLowerCase();
  const match = hit.matches.find(({ term }) => term !== "" && lower.includes(term.toLowerCase()));
  if (!match) return null;
  const at = lower.indexOf(match.term.toLowerCase());
  if (at < 0) return null;
  const end = at + match.term.length;
  return { before: subject.slice(0, at), marked: subject.slice(at, end), after: subject.slice(end) };
}

export interface HitWho {
  /** Line one: the sender's whole name, or the address where there is none. */
  readonly who: string;
  /** The address after a name; none where the address already leads. */
  readonly address: string | undefined;
  readonly people: readonly RowPerson[];
}

export function hitWho(hit: SearchHit, words: Pick<SearchWords, "name" | "address">): HitWho {
  const m = hit.message;
  const name = words.name(m);
  const address = words.address(m);
  return {
    who: name ?? address,
    address: name === null ? undefined : address,
    people: [{ name: name ?? address, address: m.from.address }],
  };
}

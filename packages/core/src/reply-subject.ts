/**
 * The reply subject — `Re: ` exactly once, in ONE implementation for every surface that composes
 * a reply: the client engine, and the away responder in `packages/services` on hosts that may
 * not import the browser engine. A second copy is how `Re: RE: Re:` ships on the one reply no
 * human reads before it leaves. A LEAF on its own source subpath, dependency-free, imported by
 * two graphs that share nothing else. `forwardSubject` stays in `mutations.ts`: nothing outside
 * the compose window forwards. The localized PREFIX TABLE lives here for the same reason: the
 * server names threads with it, the client faces its own forwards with it, and a second copy is
 * how "WG:" once survived where "AW:" was stripped.
 */

/**
 * The reply subject for a parent subject — `Re: ` exactly once.
 *
 * CASE-INSENSITIVE, because the prefix arrives in whatever case the sender's client used
 * and a case-sensitive test yields `Re: RE: …` on the second exchange with an Outlook
 * correspondent. Only the leading prefix is stripped: `Re: Re: x` collapses to one, and a
 * subject that merely CONTAINS "re:" is untouched.
 */
export function replySubject(parentSubject: string): string {
  const bare = parentSubject.replace(/^(?:\s*re\s*:\s*)+/i, "").trim();
  return bare ? `Re: ${bare}` : "Re:";
}

/**
 * The reply and forward subject prefixes localized mail clients emit — ONE table for every
 * reader: the server names a thread with them stripped ({@link baseSubject}), the worker's heal
 * pre-filters rows in SQL built from the same anatomy, and a conversation panel reads the leading
 * token to tell the account's own forward from its own reply. The documented Outlook/Thunderbird
 * localization table, longest token first so the alternation never stops at a prefix of a longer
 * token. The short entries ("R:", "I:", "PD:") are safe because the token must be the ENTIRE word
 * before the colon — "Item:" and "Password:" survive. "WG:" is ambiguous in German and the
 * forward reading still wins: this NAMES, never merges, so the worst case is two letters lost.
 */
export const SUBJECT_PREFIXES: ReadonlyArray<{
  readonly token: string;
  /** `either` — a reply in one language and a forward in another ("VS:"); never a forward face. */
  readonly kind: "reply" | "forward" | "either";
}> = [
  { token: "doorst", kind: "forward" }, // nl
  { token: "antw", kind: "reply" },     // nl ("Antw.:")
  { token: "fwd", kind: "forward" },    // en
  { token: "fw", kind: "forward" },     // en
  { token: "res", kind: "reply" },      // pt
  { token: "enc", kind: "forward" },    // pt
  { token: "odp", kind: "reply" },      // pl
  { token: "ynt", kind: "reply" },      // tr
  { token: "ilt", kind: "forward" },    // tr ("İlt:" with the dotted İ does not case-fold to this;
                                        //     the ASCII form is what crosses locale boundaries)
  { token: "atb", kind: "reply" },      // cy
  { token: "yml", kind: "forward" },    // cy
  { token: "bls", kind: "reply" },      // id
  { token: "re", kind: "reply" },       // international
  { token: "aw", kind: "reply" },       // de
  { token: "wg", kind: "forward" },     // de
  { token: "sv", kind: "reply" },       // sv/da/no/is
  { token: "vb", kind: "forward" },     // sv
  { token: "vs", kind: "either" },      // fi reply; no/da forward
  { token: "vl", kind: "forward" },     // fi
  { token: "fs", kind: "forward" },     // is
  { token: "tr", kind: "forward" },     // fr
  { token: "rv", kind: "forward" },     // es
  { token: "pd", kind: "forward" },     // pl
  { token: "vá", kind: "reply" },       // hu
  { token: "r", kind: "reply" },        // it
  { token: "i", kind: "forward" },      // it
  { token: "回复", kind: "reply" },     // zh-Hans
  { token: "回覆", kind: "reply" },     // zh-Hant
  { token: "转发", kind: "forward" },   // zh-Hans
  { token: "轉寄", kind: "forward" },   // zh-Hant
];

/** The tokens alone, in the table's order. */
export const SUBJECT_PREFIX_TOKENS: readonly string[] = SUBJECT_PREFIXES.map((p) => p.token);

/**
 * One prefix occurrence: the token, an optional abbreviating dot ("Antw.:"), an optional
 * bracketed count ("RE[2]:"), optional space before the colon ("RE :" — fr Outlook), and
 * either the ASCII or the fullwidth colon (zh clients emit "："). EXPORTED AS A STRING because
 * the anatomy has a second, non-JS consumer: the thread-name heal pre-filters candidate rows in
 * SQL (`subject ~* …`), and Postgres AREs understand this exact syntax — `(?:…)`, `\s`, `\d`
 * and the bracket expression included. One definition, two engines; they cannot drift apart.
 */
export const SUBJECT_PREFIX_PATTERN =
  `^(?:${SUBJECT_PREFIX_TOKENS.join("|")})\\.?\\s*(?:\\[\\d+\\])?\\s*[:：]`;

const SUBJECT_PREFIX_RE = new RegExp(`${SUBJECT_PREFIX_PATTERN}\\s*`, "i");

/**
 * A conversation's subject without the reply/forward prefixes, for NAMING a thread whose first
 * ingested message happens to be a reply or a forward — which out-of-order arrival makes
 * ordinary. Naming only: thread identity is the header chain and nothing else (`threading.ts`),
 * so an over- or under-stripped subject can never merge or split a conversation, and a thread's
 * subject is never overwritten afterwards (a user rename must survive ingest). Iterated rather
 * than one greedy regex: real mail carries stacks like "Re: AW: AW: …", and the languages MIX —
 * a Gmail "Re:" lands on top of Outlook's "AW:".
 */
export function baseSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(SUBJECT_PREFIX_RE, "");
    if (next === s) return s;
    s = next;
  }
}

const LEADING_PREFIX_RE = new RegExp(
  `^(${SUBJECT_PREFIX_TOKENS.join("|")})\\.?\\s*(?:\\[\\d+\\])?\\s*[:：]`, "i",
);
const FORWARD_TOKENS = new Set(SUBJECT_PREFIXES.filter((p) => p.kind === "forward").map((p) => p.token));

/**
 * Does the subject open with an UNAMBIGUOUS forward prefix, as the sender's client wrote it?
 * The leading token alone decides — "Fwd: Re: x" is a forward of a reply, "Re: Fwd: x" a reply
 * to one — and a token that is a reply in one language and a forward in another ("VS:") answers
 * false. DISPLAY ONLY: a conversation panel faces the account's own forward as "Forwarded to …"
 * off this, and the worst error is a forward wearing its sender's name; nothing here reaches
 * threading, naming or a merge.
 */
export function opensWithForwardPrefix(subject: string): boolean {
  const m = subject.trim().match(LEADING_PREFIX_RE);
  return m !== null && FORWARD_TOKENS.has(m[1]!.toLowerCase());
}

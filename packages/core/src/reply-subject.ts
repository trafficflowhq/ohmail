/**
 * The reply subject — `Re: ` exactly once, in ONE implementation for every surface that composes
 * a reply. It was the client engine's while a person pressing Reply was the only composer; the
 * away responder ends that — reply-only, running in `packages/services` on hosts that may not
 * import the browser engine. A second copy is how `Re: RE: Re:` ships on the one surface nobody
 * watches: the away reply is the only reply no human reads before it leaves. A LEAF on its own
 * source subpath, dependency-free, imported by two graphs that share nothing else.
 * `forwardSubject` stays in `mutations.ts`: nothing outside the compose window forwards, so
 * promoting it would cross a package boundary for no consumer.
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

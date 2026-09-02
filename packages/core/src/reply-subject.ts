/**
 * THE REPLY SUBJECT — `Re: ` exactly once, in ONE implementation for every surface that composes
 * a reply.
 *
 * ── WHY IT LIVES IN CORE AND NOT IN THE CLIENT ENGINE ─────────────────────────────────────────
 *
 * It was `packages/client-engine/src/mutations.ts`'s, and that was the right home while the only
 * thing in this system that composed a reply was a person pressing Reply in the window. The away
 * responder ends that: it is reply-only — it carries no subject of its own and derives one from
 * the message it answers — and it runs in `packages/services`, on three hosts, none of which may
 * import the browser engine. A second copy of this rule in the pass is how `Re: RE: Re:` ships on
 * the one surface nobody is watching, because the away reply is the only reply in the product
 * that no human reads before it leaves.
 *
 * So it is a LEAF on its own source subpath, the reason `./ics`, `./folder-name` and
 * `./drain-policy` have one and stated in the same words as `//drain-policy` in this package's
 * manifest: it is dependency-free — no store, no clock, no network, no node builtin, no DOM — and
 * it is imported by two graphs that share nothing else. The client engine (which cannot load
 * mailparser or `node:crypto`) reaches it at `@trafficflow/core/reply-subject`; the services pass
 * reaches the same function through the `mail` barrel, which re-exports this module.
 *
 * `forwardSubject` deliberately stays in `mutations.ts`. It is this function's twin in shape, but
 * nothing outside the compose window forwards a message, so promoting it would move code across a
 * package boundary for no consumer. The pair is split on purpose rather than by oversight, and the
 * twin's own note says so.
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

/**
 * ═══ "IS THE COMPUTER THIS WINDOW READS THROUGH ANSWERING?" — the shape, and the 60 s grace ══
 *
 * The shared shell cannot answer this and must not try. Only the desktop window knows it is
 * paired to another computer, what that computer is called, and how old its mirror is; the shell
 * knows how to draw a line in the rail. So the whole fact — the state, the age, and the sentences
 * in the reader's language — arrives as one object, and this module owns its shape and the one
 * piece of arithmetic that has to be shared with a test.
 */

/**
 * WHAT THE WINDOW HANDS THE SHELL. Absent means "nothing to say", which covers three genuinely
 * different situations and deliberately renders identically in all three: this is a browser tab,
 * this is a desktop on another door, or the other computer is answering normally. A line that
 * appeared to say "everything is fine" would be a line standing permanently in the rail, and the
 * one state it exists for would then be a change of wording rather than the arrival of a warning.
 */
export interface HostConnection {
  /** `stale` — a pull has completed before and the last one is old. `unknown` — none ever has. */
  state: "stale" | "unknown";
  words: {
    /** "Can't reach {host}." — the fact, in bold. */
    title: string;
    /** The age and what it means, or what to check. Never announced separately from the title. */
    detail: string;
    /** Settings → Desktop. There is deliberately no Retry; see below. */
    link: { href: string; label: string } | null;
  };
}

/**
 * How long an `unknown` verdict may stay silent — three mirror polls. `unknown` means no pull has
 * ever completed under this engine, which is TRUE for the first seconds of every successful
 * pairing; a sentence there would fire on every first run, announcing a failure about to not
 * happen — the fastest way to teach somebody the line means nothing. Three polls
 * (`DEFAULT_CLOUD_POLL_MS` is 20 s) gives a first pull three chances while not leaving somebody
 * who pasted a link from a switched-off machine staring at a blank window. NOT the stale bound:
 * `stale` has a completed pull behind it and its own five-minute rule.
 */
export const HOST_UNKNOWN_GRACE_MS = 60_000;

/**
 * Is an `unknown` verdict old enough to say so? — a pure function of two instants, separated from
 * every clock so a test can drive the one rule that would otherwise be a condition inside a
 * `useEffect` nobody can reach. `firstUnknownAt` is when the CURRENT engine first answered
 * `unknown` — it resets with the engine, so a door change or restart starts the grace again rather
 * than inheriting a bound measured against an engine that no longer exists. `null` means no
 * `unknown` has been recorded yet — nothing observed, nothing concluded, answer false. The
 * comparison is `>=` so the boundary is inside the speaking side: a `>` would leave one instant on
 * which the rule says nothing, the kind of edge a table test pins.
 */
export function unknownSpeaks(
  firstUnknownAt: number | null,
  now: number,
  graceMs: number = HOST_UNKNOWN_GRACE_MS,
): boolean {
  if (firstUnknownAt === null) return false;
  return now - firstUnknownAt >= graceMs;
}

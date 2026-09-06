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
 * HOW LONG AN `unknown` VERDICT IS ALLOWED TO STAY SILENT — three mirror polls.
 *
 * `unknown` means no pull has ever completed under this engine, which is TRUE for the first
 * seconds of every successful pairing. A sentence there would fire on every single first run,
 * announcing a failure that has not happened yet and is about to not happen — the fastest way to
 * teach somebody that this line does not mean anything.
 *
 * Three polls (`DEFAULT_CLOUD_POLL_MS` is 20 s) is long enough that a first pull has had three
 * chances and short enough that a person who pasted a link from a machine that is switched off is
 * not left looking at a blank window wondering. It is NOT the stale bound: `stale` has a
 * completed pull behind it and a real age to report, and its own five-minute rule already applies.
 */
export const HOST_UNKNOWN_GRACE_MS = 60_000;

/**
 * IS AN `unknown` VERDICT OLD ENOUGH TO SAY SO? — a pure function of two instants.
 *
 * Pure, and separated from every clock, because it is the one rule here that a test can drive
 * exhaustively and the one that would otherwise be a condition inside a `useEffect` nobody can
 * reach. `firstUnknownAt` is when the CURRENT engine first answered `unknown` — it resets with the
 * engine, so a door change or a restart starts the grace again rather than inheriting a bound
 * measured against an engine that no longer exists.
 *
 * `null` means no `unknown` verdict has been recorded yet, which is not the same as one recorded
 * a moment ago: nothing has been observed, so nothing may be concluded, and the answer is false.
 *
 * The comparison is `>=` so the boundary is INSIDE the speaking side: at exactly sixty seconds the
 * three polls have had their chance. A `>` would leave one instant on which the rule says nothing,
 * which is unobservable in the app and is the kind of edge a table test is written to pin.
 */
export function unknownSpeaks(
  firstUnknownAt: number | null,
  now: number,
  graceMs: number = HOST_UNKNOWN_GRACE_MS,
): boolean {
  if (firstUnknownAt === null) return false;
  return now - firstUnknownAt >= graceMs;
}

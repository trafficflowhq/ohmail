/**
 * THE SCREENER'S KEYS, declared: j k walk, the five decision letters (Shift on the three that let a sender in also
 * marks their letters read; the two demotions have no read verb), Enter accepts a real suggestion and nothing else,
 * a applies every suggestion, [ ] walk the sections without wrapping, s opens the sender's card, z takes back the
 * last decision, Escape closes what is open. A key that cannot act now stays listed and inert.
 */
import type { KeyBinding } from "../keys/binding.js";
import { DECISION_KEY, DECISION_ORDER, DECISION_QUIET, type DecisionDestination } from "./decision.js";

export type KeySegment = "waiting" | "screened" | "spam";
const SEGMENT_ORDER: readonly KeySegment[] = ["waiting", "screened", "spam"];

/** The keys' words, read by the mount from the `screener` namespace. */
export interface ScreenerKeyWords {
  readonly next: string;
  readonly prev: string;
  readonly accept: string;
  readonly applyAll: string;
  readonly card: string;
  readonly segPrev: string;
  readonly segNext: string;
  readonly undo: string;
  readonly close: string;
  readonly file: Readonly<Record<DecisionDestination, string>>;
  readonly fileRead: Readonly<Record<DecisionDestination, string>>;
}

export interface ScreenerKeysInput {
  readonly words: ScreenerKeyWords;
  readonly segment: KeySegment;
  readonly step: { readonly down: (() => void) | null; readonly up: (() => void) | null };
  /** A waiting sender is open and may be decided. */
  readonly decidable: boolean;
  readonly decide: (dest: DecisionDestination, read: boolean) => void;
  /** The open sender's real suggestion; null leaves Enter inert. */
  readonly suggested: DecisionDestination | null;
  readonly applyAll: (() => void) | null;
  readonly card: (() => void) | null;
  readonly go: (segment: KeySegment) => void;
  readonly undo: () => void;
  /** What Escape closes now (an ask, a menu, the open sender on one column); null when nothing is open. */
  readonly escape: (() => void) | null;
}

export function screenerKeys(input: ScreenerKeysInput): KeyBinding[] {
  const { words, segment } = input;
  const at = SEGMENT_ORDER.indexOf(segment);
  const inert = (run: (() => void) | null) => ({ disabled: run === null, run: () => run?.() });
  const decisions = DECISION_ORDER.flatMap((dest): KeyBinding[] => {
    const file: KeyBinding = {
      chord: DECISION_KEY[dest],
      group: "screener",
      label: words.file[dest],
      disabled: !input.decidable,
      run: () => input.decide(dest, false),
    };
    if (DECISION_QUIET.has(dest)) return [file];
    return [
      file,
      {
        chord: `shift+${DECISION_KEY[dest]}`,
        group: "screener",
        label: words.fileRead[dest],
        disabled: !input.decidable,
        run: () => input.decide(dest, true),
      },
    ];
  });
  const suggested = input.decidable ? input.suggested : null;
  return [
    { chord: "j", group: "navigate", label: words.next, ...inert(input.step.down) },
    { chord: "k", group: "navigate", label: words.prev, ...inert(input.step.up) },
    {
      chord: "Escape",
      group: "screener",
      label: words.close,
      ...inert(input.escape),
    },
    {
      chord: "Enter",
      group: "screener",
      label: words.accept,
      disabled: suggested === null,
      /* On a focused control Enter is the control's own press. */
      when: (e) => (e.target as HTMLElement | null)?.tagName !== "BUTTON",
      run: (e) => {
        if (suggested !== null) input.decide(suggested, e.shiftKey && !DECISION_QUIET.has(suggested));
      },
    },
    {
      chord: "a",
      group: "screener",
      label: words.applyAll,
      ...inert(segment === "waiting" ? input.applyAll : null),
    },
    { chord: "s", group: "screener", label: words.card, ...inert(input.decidable ? input.card : null) },
    {
      chord: "[",
      group: "screener",
      label: words.segPrev,
      disabled: at <= 0,
      run: () => at > 0 && input.go(SEGMENT_ORDER[at - 1]!),
    },
    {
      chord: "]",
      group: "screener",
      label: words.segNext,
      disabled: at >= SEGMENT_ORDER.length - 1,
      run: () => at < SEGMENT_ORDER.length - 1 && input.go(SEGMENT_ORDER[at + 1]!),
    },
    { chord: "z", group: "screener", label: words.undo, run: () => input.undo() },
    ...decisions,
  ];
}

import { useEffect, type ReactNode } from "react";
import { Icon } from "../icons.js";
import { InfoNote } from "../primitives/InfoNote.js";
import { SegmentedControl } from "../primitives/SegmentedControl.js";
import { SplitButton } from "../primitives/SplitButton.js";
import "./decision-bar.css";

export type DecisionDestination = "ohbox" | "reads" | "receipts" | "screened" | "spam";
export type DecisionScope = "sender" | "domain";

export const DECISION_KEY: Record<DecisionDestination, string> = {
  ohbox: "o",
  reads: "r",
  receipts: "c",
  screened: "n",
  spam: "x",
};
const DESTINATIONS: DecisionDestination[] = ["ohbox", "reads", "receipts", "screened", "spam"];
/**
 * The DEMOTING destinations — the two piles you triage mail OUT to, not admit it into.
 *
 * Exported so the one truth "a demoting destination has no read verb" lives beside `DECISION_KEY`
 * and is read rather than re-listed: the ✓ half is dropped here, the ⇧-twin key binding is dropped
 * in `ScreenerView`, and the mark-read is clamped at the decision funnel in `screener-state.ts`,
 * all from this same set. A consumer that hand-listed "screened, spam" in three places would grow
 * the ✓ back the day someone edited two of them.
 */
export const DECISION_QUIET = new Set<DecisionDestination>(["screened", "spam"]);

/** One capsule's words. The ✓ half is absent for a destination that has no read verb. */
export interface DecisionCapsuleCopy {
  /** The verb on the label half — "Screen out", not "Screened out". */
  label: string;
  /** That half's title, with its key: "Screened out (n)". */
  title: string;
  /** The ✓ half, when there is one. */
  check?: { label: string; title: string };
}

/**
 * Every word this bar says is brought by the host. The labels, scope
 * toggle and consequence line used to be literals here, so a German window
 * rendered an English decision bar — the one control on the surface that
 * writes a rule. A composite has no catalogue and must not grow one; the
 * host reads `messages/*.json` and hands the words down (the `Settings`
 * contract). Required, not defaulted: an optional copy prop with an
 * English default is the same defect with a longer fuse — missing copy
 * is a type error at every call site instead.
 */
export interface DecisionBarCopy {
  dest: Record<DecisionDestination, DecisionCapsuleCopy>;
  scopeAria: string;
  scopeSender: string;
  scopeDomain: string;
  /** The consequence line — the consent disclosure, with the rule target already placed. */
  rule: ReactNode;
  /** The disclosure's summary and its body. */
  halvesLabel: string;
  halves: ReactNode;
  /** The word on the narrow-width back affordance. */
  back: string;
}

export interface DecisionBarProps {
  /** The AI-preselected destination: ringed, warm, accepts on "y". */
  aiDest?: DecisionDestination;
  scope: DecisionScope;
  onScopeChange: (scope: DecisionScope) => void;
  /** Every word on the bar. See {@link DecisionBarCopy}. */
  copy: DecisionBarCopy;
  /** One click files; `markRead` is true from the ✓ segment / shifted key. */
  onDecide: (dest: DecisionDestination, opts: { markRead: boolean }) => void;
  /**
   * Bind the keyboard map on document: y accepts the AI suggestion,
   * o/r/c/n/x file, ⇧+key files + marks read — except for the demoting destinations
   * (Screen out, Spam), which have no read verb, so ⇧ there just files.
   */
  keyboard?: boolean;
  /** Mobile back affordance. */
  onBack?: () => void;
  /** Overrides the default consequence line. */
  note?: ReactNode;
  className?: string;
}

/**
 * Five split-buttons — Ohbox · Reads · Receipts · Screen out · Spam —
 * with the AI destination preselected, a sender/domain scope toggle and
 * the consequence line; one line at 1280px (container query). Each capsule
 * half wears its own keycap, from `DECISION_KEY` — the same constant
 * `ScreenerView` derives its registry bindings from, so a cap and its
 * binding cannot disagree without editing the one line both read. No
 * detached legend, and a cap appears only where its key is really live
 * (a strip once hinted `y` where `y` was not bound).
 */
export function DecisionBar({
  aiDest,
  scope,
  onScopeChange,
  copy,
  onDecide,
  keyboard,
  onBack,
  note,
  className,
}: DecisionBarProps) {
  useEffect(() => {
    if (!keyboard) return;
    const plain: Record<string, DecisionDestination> = {
      o: "ohbox",
      r: "reads",
      c: "receipts",
      n: "screened",
      x: "spam",
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const lower = e.key.toLowerCase();
      if (lower === "y") {
        if (aiDest) {
          e.preventDefault();
          // ⇧ marks read only where reading is meaningful — never for a demoting destination.
          onDecide(aiDest, { markRead: e.shiftKey && !DECISION_QUIET.has(aiDest) });
        }
        return;
      }
      const dest = plain[lower];
      if (dest) {
        e.preventDefault();
        onDecide(dest, { markRead: e.shiftKey && !DECISION_QUIET.has(dest) });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [keyboard, aiDest, onDecide]);

  return (
    <div className={className ? `decide ${className}` : "decide"}>
      {onBack ? (
        <button type="button" className="scn-back" onClick={onBack}>
          <Icon name="chev" className="chev" /> {copy.back}
        </button>
      ) : null}
      <div className="d-btns">
        {DESTINATIONS.map((d) => {
          const ai = aiDest === d;
          const k = DECISION_KEY[d];
          const quiet = DECISION_QUIET.has(d);
          const words = copy.dest[d];
          return (
            <SplitButton
              key={d}
              label={words.label}
              /* `y` only where `y` is bound — this component's own listener. Everywhere
                 else the capsule shows the letter that files it, which is live in both
                 modes: the registry declares o/r/c/n/x from this same `DECISION_KEY`. */
              kbdHint={keyboard && ai ? "y" : k}
              ai={ai}
              quiet={quiet}
              title={words.title}
              onPress={() => onDecide(d, { markRead: false })}
              /* No "& mark read" ✓ for the demoting destinations — you don't read what you
                 screen out or mark spam. The mail destinations keep both halves, and the host
                 leaves `check` off exactly the destinations `DECISION_QUIET` names, so the two
                 cannot drift: a `check` supplied for a quiet destination is dropped here. */
              {...(quiet || !words.check
                ? {}
                : {
                    check: {
                      onPress: () => onDecide(d, { markRead: true }),
                      label: words.check.label,
                      kbdHint: `⇧${k.toUpperCase()}`,
                      title: words.check.title,
                    },
                  })}
            />
          );
        })}
      </div>
      <div className="d-sub">
        <SegmentedControl
          variant="scope"
          className="d-scope"
          ariaLabel={copy.scopeAria}
          value={scope}
          onChange={(s) => onScopeChange(s)}
          options={[
            { id: "sender", label: copy.scopeSender },
            { id: "domain", label: copy.scopeDomain },
          ]}
        />
        {/*
            THE CONSEQUENCE LINE, WHICH IS THE CONSENT DISCLOSURE. "Becomes a rule — future mail from … files
            automatically" is the sentence that has to be readable BEFORE the click, because screening a sender out
            arms auto-unsubscribe. It is the LEAD, so it is on screen with the disclosure shut and no press can reveal
            less of it than it says now. WHICH HALF OF THE SPLIT BUTTON DOES WHAT is a different kind of sentence: it
            explains a control that is in front of the reader, it is as true on the hundredth decision as the first,
            and it was costing a second line of a bar that already holds a segmented control on the same row. That is
            what moved behind the (i). A `note` passed in is a caller's own whole sentence and is not split — the
            caller wrote one line and gets one line.
          */}
        {note ? (
          <span className="d-note">{note}</span>
        ) : (
          <InfoNote className="d-note" lead={copy.rule} moreLabel={copy.halvesLabel}>
            {copy.halves}
          </InfoNote>
        )}
      </div>
    </div>
  );
}

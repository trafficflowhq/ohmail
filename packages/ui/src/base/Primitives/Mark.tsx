import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Dot } from "./Dot.js";
import "./mark.css";

export interface MarkProps {
  /** The product's letters: "oh". The mark is said with its full stop: "oh.". */
  children: string;
  /** Its stop is hot: something waits, or it is the first screen's doorbell. Left out: the ink. */
  hot?: boolean;
  /**
   * Its stop is a doorbell: the bell's name ("Ring the doorbell"). A press rings it once, and `onRing` hears
   * it. Left out, the stop is drawn and says nothing.
   */
  bell?: { label: string; onRing?: () => void };
  /** It rings once without a press: the first screen, a moment after it arrived. */
  ringing?: boolean;
}

/** The product's mark: its letters and its full stop, as large as the face sets a mark. What holds it places it. */
export function Mark({ children, hot, bell, ringing }: MarkProps) {
  const own = useRef<HTMLParagraphElement>(null);
  /* Whether a press rang it; until the first press it rings as it is told. */
  const [rung, setRung] = useState<boolean | null>(null);
  const ring = () => {
    /* The ring that was playing is let go and seen gone, so that this press is played from its start. */
    flushSync(() => setRung(false));
    void own.current?.offsetWidth;
    setRung(true);
    bell?.onRing?.();
  };
  return (
    <p ref={own} className="oh-text oh-mark" aria-label={`${children}.`}>
      {children}
      <Dot
        kind={hot ? "hot" : "ink"}
        ringing={rung ?? ringing}
        press={bell ? { label: bell.label, onPress: ring } : undefined}
      />
    </p>
  );
}

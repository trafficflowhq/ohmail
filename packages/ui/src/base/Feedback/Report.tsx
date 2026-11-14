import { useLayoutEffect, useRef } from "react";
import { animate } from "../../motion/motion.js";
import { useSaidOnArrival } from "../said-on-arrival.js";
import { Button } from "../Primitives/Button.js";
import { EndDot } from "../Primitives/EndDot.js";
import "./report.css";

interface ReportCommon {
  /** What happened, in four words or fewer. It ends in the dot. */
  children: string;
  /**
   * It is on its way out: it fades, then says so once. The fade is for the eye alone: the way back takes a
   * press, by a pointer and by the keys, until what holds the report takes it away.
   */
  leaving?: boolean;
  onGone?: () => void;
  /**
   * It is being taken away with the keys on it, whatever takes it: its way back was pressed by them, its fade
   * ran out under them, a newer report took its place, a withdrawn way back took it, or what holds it is itself
   * leaving (the frame at sign-out). For this one call the keys are still on it, so what holds the report puts
   * them where the person goes on (a list's row), and looks first that the list is still there; left out, they
   * fall to the page with it.
   */
  onKeysGone?: () => void;
}

/** A report that it is done, with the one way back; or the answer to a press that was queued or refused. */
export type ReportProps = ReportCommon &
  (
    | {
        kind?: undefined;
        /** The way back. Left out where there is none. */
        undo?: { label: string; keyHint?: string; onPress: () => void };
      }
    | {
        /** `why`: nothing happened here, and one sentence says why and what to do. It never offers Undo. */
        kind: "why";
        why: string;
        /** Where the way out is one place, that one press. */
        act?: { label: string; onPress: () => void };
        undo?: never;
      }
  );

/* It goes as it was said, with no weight: its opacity alone runs out. */
const FADE: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];

/** It is done, and this is the one place to take it back. */
export function Report(props: ReportProps) {
  const { children, leaving, onGone, onKeysGone } = props;
  const el = useRef<HTMLDivElement | null>(null);
  const gone = useRef(onGone);
  const keysGone = useRef(onKeysGone);
  useLayoutEffect(() => {
    gone.current = onGone;
    keysGone.current = onKeysGone;
  });
  /* Taken away: while it still stands in the page, it says whether the keys go with it. */
  useLayoutEffect(() => {
    const node = el.current;
    return () => {
      if (node?.contains(node.ownerDocument.activeElement)) keysGone.current?.();
    };
  }, []);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    if (leaving) animate(node, "hush", { ease: "--e-hush", keyframes: FADE, onDone: () => gone.current?.() });
    else animate(node, "in", { ease: "--e-arrive" });
  }, [leaving]);
  const press = props.kind === "why" ? props.act : props.undo;
  /* Said when it appears: its words are given to a screen reader once the region stands; its way back at once. */
  const held = useSaidOnArrival(true) ? true : undefined;
  return (
    <div
      ref={el}
      className="oh-report"
      role="status"
      data-kind={props.kind}
      data-leaving={leaving ? "" : undefined}
    >
      {props.kind === "why" ? (
        <p className="oh-text oh-report-why" aria-hidden={held}>
          <b className="oh-report-verdict">
            <EndDot kind="ink">{children}</EndDot>
          </b>{" "}
          {props.why}
        </p>
      ) : (
        <span className="oh-report-said" aria-hidden={held}>
          <EndDot kind="ink">{children}</EndDot>
        </span>
      )}
      {press ? (
        <Button
          kind="quiet"
          size="s"
          keyHint={props.kind === "why" ? undefined : props.undo?.keyHint}
          onPress={press.onPress}
        >
          {press.label}
        </Button>
      ) : null}
    </div>
  );
}

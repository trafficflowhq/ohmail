import { useLayoutEffect, useRef } from "react";
import { animate } from "../../motion/motion.js";
import { Button } from "../Primitives/Button.js";
import { EndDot } from "../Primitives/EndDot.js";
import "./report.css";

interface ReportCommon {
  /** What happened, in four words or fewer. It ends in the dot. */
  children: string;
  /** It is on its way out: it fades, then says so once. */
  leaving?: boolean;
  onGone?: () => void;
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

/** It is done, and this is the one place to take it back. */
export function Report(props: ReportProps) {
  const { children, leaving, onGone } = props;
  const el = useRef<HTMLDivElement | null>(null);
  const gone = useRef(onGone);
  useLayoutEffect(() => {
    gone.current = onGone;
  });
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    if (leaving) animate(node, "hush", { ease: "--e-hush", onDone: () => gone.current?.() });
    else animate(node, "in", { ease: "--e-arrive" });
  }, [leaving]);
  const press = props.kind === "why" ? props.act : props.undo;
  return (
    <div
      ref={el}
      className="oh-report"
      role="status"
      data-kind={props.kind}
      data-leaving={leaving ? "" : undefined}
    >
      {props.kind === "why" ? (
        <p className="oh-text oh-report-why">
          <b className="oh-report-verdict">
            <EndDot kind="ink">{children}</EndDot>
          </b>{" "}
          {props.why}
        </p>
      ) : (
        <span className="oh-report-said">
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

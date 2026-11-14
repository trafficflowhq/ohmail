import { Button, EndDot } from "../../base/index.js";
import "./text-not-kept.css";
import { WarnRow, type WarnRowProps } from "./WarnRow.js";

/** A press on a line of the letter. `busy`: it is being done, and the label says so. */
interface Act {
  label: string;
  busy?: boolean;
  onPress?: () => void;
}

export type TextNotKeptProps =
  | {
      /** The text is elsewhere: where it is, why, the one act, and what the act does and does not do. */
      kind: "kept";
      label: string;
      line?: string;
      /** Why it could not be loaded, as one whole sentence. */
      warn?: string;
      act?: Act;
      /** A quiet way beside the act: to Storage. */
      more?: Act;
      fine?: string;
    }
  | {
      /** The letter did not load, the session ended: one refusal and the way on. */
      kind: "refused";
      warn: string;
      way?: WarnRowProps["way"];
    }
  | {
      /** Where the text shown came from, over the text. */
      kind: "loaded";
      line: string;
      more?: Act;
    }
  | {
      /** One fine line under what is shown. `live`: it says what is happening now. */
      kind: "fine";
      line: string;
      live?: boolean;
    };

/** A letter whose text is not kept here: what is shown instead, where the text is, and the way to it. */
export function TextNotKept(props: TextNotKeptProps) {
  if (props.kind === "refused") return <WarnRow way={props.way}>{props.warn}</WarnRow>;
  if (props.kind === "fine")
    return (
      <p className="oh-text oh-notkept-fine" role={props.live ? "status" : undefined}>
        {props.line}
      </p>
    );
  if (props.kind === "loaded")
    return (
      <p className="oh-text oh-notkept-source" role="status">
        <span>{props.line}</span>
        {props.more ? (
          <Button kind="quiet" size="s" onPress={props.more.onPress}>
            {props.more.label}
          </Button>
        ) : null}
      </p>
    );
  const { label, line, warn, act, more, fine } = props;
  return (
    <div className="oh-notkept" role="status" aria-busy={act?.busy || undefined}>
      <p className="oh-text oh-display oh-notkept-label">
        <EndDot kind="ink">{label}</EndDot>
      </p>
      {line ? <p className="oh-text oh-notkept-line">{line}</p> : null}
      {warn ? <WarnRow>{warn}</WarnRow> : null}
      {act || more ? (
        <div className="oh-notkept-acts">
          {act ? (
            <Button kind="two" size="s" disabled={act.busy} onPress={act.onPress}>
              {act.label}
            </Button>
          ) : null}
          {more ? (
            <Button kind="quiet" size="s" onPress={more.onPress}>
              {more.label}
            </Button>
          ) : null}
        </div>
      ) : null}
      {fine ? <p className="oh-text oh-notkept-fine">{fine}</p> : null}
    </div>
  );
}

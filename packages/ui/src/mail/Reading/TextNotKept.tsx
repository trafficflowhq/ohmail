import { Button, EndDot } from "../../base/index.js";
import { useSaidOnArrival } from "../../base/said-on-arrival.js";
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
      /** The letter's preview, where one is kept: it stands over the notice, muted, in the letter's face. */
      preview?: string;
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

/**
 * A letter whose text is not kept here: what is shown instead, where the text is, and the way to it. Each region
 * is a part of its own, so a change of kind draws a new region, and its words are said as it appears.
 */
export function TextNotKept(props: TextNotKeptProps) {
  if (props.kind === "refused") return <WarnRow way={props.way}>{props.warn}</WarnRow>;
  if (props.kind === "fine")
    return props.live ? (
      <LiveFine line={props.line} />
    ) : (
      <p className="oh-text oh-notkept-fine">{props.line}</p>
    );
  if (props.kind === "loaded") return <LoadedLine {...props} />;
  return <KeptNotice {...props} />;
}

/** The fine line that says what is happening now: a region, said when it appears. */
function LiveFine({ line }: { line: string }) {
  const held = useSaidOnArrival(true) ? true : undefined;
  return (
    <p className="oh-text oh-notkept-fine" role="status">
      <span aria-hidden={held}>{line}</span>
    </p>
  );
}

/** Where the text shown came from: a region, said when it appears. */
function LoadedLine({ line, more }: Extract<TextNotKeptProps, { kind: "loaded" }>) {
  const held = useSaidOnArrival(true) ? true : undefined;
  return (
    <p className="oh-text oh-notkept-source" role="status">
      <span aria-hidden={held}>{line}</span>
      {more ? (
        <Button kind="quiet" size="s" onPress={more.onPress}>
          {more.label}
        </Button>
      ) : null}
    </p>
  );
}

/** Where the text is and the way to it, under the letter's preview: a region, said when it appears. */
function KeptNotice({
  preview,
  label,
  line,
  warn,
  act,
  more,
  fine,
}: Extract<TextNotKeptProps, { kind: "kept" }>) {
  const held = useSaidOnArrival(true) ? true : undefined;
  const notice = (
    <div className="oh-notkept" role="status" aria-busy={act?.busy || undefined}>
      <p className="oh-text oh-display oh-notkept-label" aria-hidden={held}>
        <EndDot kind="ink">{label}</EndDot>
      </p>
      {line ? (
        <p className="oh-text oh-notkept-line" aria-hidden={held}>
          {line}
        </p>
      ) : null}
      {warn ? <WarnRow>{warn}</WarnRow> : null}
      {act || more ? (
        <div className="oh-notkept-acts">
          {act ? (
            <Button kind="two" size="s" busy={act.busy} onPress={act.onPress}>
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
      {fine ? (
        <p className="oh-text oh-notkept-fine" aria-hidden={held}>
          {fine}
        </p>
      ) : null}
    </div>
  );
  if (!preview) return notice;
  return (
    <>
      <div className="oh-text oh-notkept-preview">{preview}</div>
      {notice}
    </>
  );
}

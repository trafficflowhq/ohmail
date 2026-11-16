import { useId, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../Primitives/Button.js";
import { EndDot } from "../Primitives/EndDot.js";
import { Sentence } from "../Primitives/Sentence.js";
import "./dialog.css";
import { Overlay } from "./Overlay.js";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** The question, as a sentence. It ends in the dot. */
  title: string;
  /** Hot while the sentence holds something still to be decided. */
  hot?: boolean;
  /** The sentence is about one of the two apps: it ends in that app's own dot. */
  product?: "mail" | "cal";
  /** At most one line under it. */
  line?: string;
  /** `delete`: Enter confirms wherever the keys are. */
  kind?: "delete";
  /**
   * Where the keys land as it opens. `confirm` (left out): the answer that does it. `cancel`: the
   * answer that does nothing, for a question whose yes cannot be taken back by Enter (a link that
   * leaves for another site). A dialog without `confirm` starts on the way out either way.
   */
  keysOn?: "confirm" | "cancel";
  /** The answer that does it: the dialog's first button, where the keys land unless `keysOn` says otherwise. Left out: a dialog that only tells. */
  confirm?: { label: string; onPress: () => void; disabled?: boolean; keyHint?: string };
  /** The way out. It closes the dialog. */
  cancel: { label: string; keyHint?: string };
  /** Show the answers' keys whatever the face says. */
  keysShown?: boolean;
  /** What the answer needs: a field, the list of what waits. A long one scrolls; the sentence and the answers stay. */
  children?: ReactNode;
  /** The body is a list: of what waits. */
  list?: boolean;
  /** Other ways to the same answer, under the answers: small quiet buttons, one under the other ("Use a passkey instead"). */
  under?: ReactNode;
}

/* The way out is the last of the answers. */
const wayOut = (box: HTMLElement) => box.querySelector<HTMLElement>(".oh-dialog-acts > button:last-child");

/**
 * Only for a yes that cannot be undone. The keys land on its first button and stay inside; Esc
 * and a press on the scrim close it, and the keys go back to what opened it.
 */
export function Dialog(props: DialogProps) {
  const {
    open,
    onClose,
    title,
    hot,
    product,
    line,
    kind,
    keysOn,
    confirm,
    cancel,
    keysShown,
    children,
    list,
    under,
  } = props;
  const name = useId();
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || kind !== "delete" || !confirm || confirm.disabled) return false;
    e.preventDefault();
    confirm.onPress();
    return true;
  };
  return (
    <Overlay
      open={open}
      onClose={onClose}
      labelledBy={name}
      className={list ? "oh-dialog oh-dialog-listed" : "oh-dialog"}
      onKey={keys}
      first={keysOn === "cancel" ? wayOut : undefined}
    >
      <Sentence id={name} level={2}>
        <EndDot kind={hot ? "hot" : "ink"} product={product}>
          {title}
        </EndDot>
      </Sentence>
      {line ? <p className="oh-text oh-dialog-line">{line}</p> : null}
      {children ? (
        <div className="oh-dialog-body" role={list ? "list" : undefined}>
          {children}
        </div>
      ) : null}
      <div className="oh-dialog-acts">
        {confirm ? (
          <Button
            onPress={confirm.onPress}
            disabled={confirm.disabled}
            keyHint={confirm.keyHint}
            keyShown={keysShown}
          >
            {confirm.label}
          </Button>
        ) : null}
        <Button kind="quiet" onPress={onClose} keyHint={cancel.keyHint} keyShown={keysShown}>
          {cancel.label}
        </Button>
      </div>
      {under ? <div className="oh-dialog-under">{under}</div> : null}
    </Overlay>
  );
}

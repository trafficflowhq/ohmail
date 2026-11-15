import { Fragment, useId, type KeyboardEvent } from "react";
import { Button } from "../Primitives/Button.js";
import { Dot } from "../Primitives/Dot.js";
import { KeyHint } from "../Primitives/KeyHint.js";
import "./key-help.css";
import { Overlay } from "./Overlay.js";

export interface KeyHelpRow {
  /** What the key does. */
  label: string;
  /** Its spellings; each is the keys of one chord, as they are printed. */
  keys: readonly (readonly string[])[];
}

export interface KeyHelpGroup {
  title: string;
  rows: readonly KeyHelpRow[];
}

export interface KeyHelpProps {
  open: boolean;
  onClose: () => void;
  /** Its title; it ends in the dot. */
  title: string;
  /** The name of the control that closes it. */
  close: string;
  /** The groups, column by column, as the app's key registry lists them. */
  columns: readonly (readonly KeyHelpGroup[])[];
  /** A key the app answers while it stands open, as its own key that shuts it. True: taken. */
  onKey?: (e: KeyboardEvent<HTMLDivElement>) => boolean;
}

/* It is read, not answered: the keys land on the sheet itself, and Tab reaches the control that closes it. */
const itself = (box: HTMLElement) => box;

/** Every key that is live where you are, in the app's groups and order. It lists; it listens for none of them. */
export function KeyHelp({ open, onClose, title, close, columns, onKey }: KeyHelpProps) {
  const name = useId();
  return (
    <Overlay
      open={open}
      onClose={onClose}
      labelledBy={name}
      className="oh-keyhelp"
      first={itself}
      onKey={onKey}
    >
      <header className="oh-keyhelp-head">
        <h1 id={name} className="oh-text oh-display oh-keyhelp-title">
          {title}
          <Dot kind="ink" />
        </h1>
        <Button kind="quiet" icon="x" label={close} onPress={onClose} />
      </header>
      <div className="oh-keyhelp-grid">
        {columns.map((groups, c) => (
          <div key={c}>
            {groups.map((group) => (
              <Fragment key={group.title}>
                <h2 className="oh-text oh-display oh-keyhelp-group">
                  <span>
                    {group.title}
                    <Dot kind="ink" />
                  </span>
                </h2>
                {group.rows.map((row) => (
                  <p key={row.label} className="oh-text oh-keyhelp-row">
                    <span className="oh-keyhelp-label">{row.label}</span>
                    <span className="oh-keyhelp-keys">
                      {row.keys.map((chord, i) => (
                        <Fragment key={chord.join(" ")}>
                          {i ? <i className="oh-keyhelp-or">·</i> : null}
                          <span className="oh-keyhelp-chord">
                            {chord.map((k) => (
                              <KeyHint key={k} shown>
                                {k}
                              </KeyHint>
                            ))}
                          </span>
                        </Fragment>
                      ))}
                    </span>
                  </p>
                ))}
              </Fragment>
            ))}
          </div>
        ))}
      </div>
    </Overlay>
  );
}

import { Fragment, useId, type KeyboardEvent } from "react";
import { Button } from "../Primitives/Button.js";
import { EndDot } from "../Primitives/EndDot.js";
import { KeyHint } from "../Primitives/KeyHint.js";
import "./key-help.css";
import { Overlay } from "./Overlay.js";

export interface KeyHelpRow {
  /** What the key does. */
  label: string;
  /** Whether all spellings of this shortcut are unavailable here. */
  disabled?: boolean;
  /** Its spellings; each is the keys of one chord, as they are printed. */
  keys: readonly (readonly string[])[];
  /** For an inert row, the reason its shortcuts do nothing here. */
  disabledReason?: string;
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
  /** Where focus starts when the sheet opens. */
  initialFocus?: "dialog" | "close";
  /** The groups, column by column, as the app's key registry lists them. */
  columns: readonly (readonly KeyHelpGroup[])[];
  /** A key the app answers while it stands open, as its own key that shuts it. True: taken. */
  onKey?: (e: KeyboardEvent<HTMLDivElement>) => boolean;
}

const itself = (box: HTMLElement) => box;

/** The keys where you are, in the app's groups and order. It lists; it listens for none of them. */
export function KeyHelp({
  open,
  onClose,
  title,
  close,
  initialFocus = "dialog",
  columns,
  onKey,
}: KeyHelpProps) {
  const name = useId();
  return (
    <Overlay
      open={open}
      onClose={onClose}
      labelledBy={name}
      className="oh-keyhelp"
      scrimMotion="together"
      first={initialFocus === "dialog" ? itself : undefined}
      onKey={onKey}
    >
      <header className="oh-keyhelp-head">
        <h2 id={name} className="oh-text oh-display oh-keyhelp-title">
          <EndDot kind="ink">{title}</EndDot>
        </h2>
        <Button kind="quiet" icon="x" label={close} onPress={onClose} />
      </header>
      <div className="oh-keyhelp-grid" role="region" aria-labelledby={name} tabIndex={0}>
        {columns.map((groups, c) => (
          <div key={c}>
            {groups.map((group) => (
              <Fragment key={group.title}>
                <h3 className="oh-text oh-display oh-keyhelp-group">
                  <span>
                    <EndDot kind="ink">{group.title}</EndDot>
                  </span>
                </h3>
                {group.rows.map((row) => (
                  <p
                    key={row.label}
                    className="oh-text oh-keyhelp-row"
                    aria-disabled={row.disabled || row.disabledReason ? true : undefined}
                    aria-description={row.disabledReason}
                    title={row.disabledReason}
                  >
                    <span className="oh-keyhelp-label">{row.label}</span>
                    <span className="oh-keyhelp-keys">
                      {row.keys.map((chord, i) => (
                        <Fragment key={chord.join(" ")}>
                          {i ? <i className="oh-keyhelp-or">·</i> : null}
                          <span className="oh-keyhelp-chord">
                            {chord.map((k) => (
                              <KeyHint key={k} shown quiet>
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

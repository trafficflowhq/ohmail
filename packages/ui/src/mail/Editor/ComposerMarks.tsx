import { Fragment } from "react";
import { Icon, type ComposerIconName, type IconName } from "../../icons/Icon.js";
import "./composer.css";

/** One mark of the editor: Bold, a link, a list. It is drawn as a letter or as a sign. */
export interface ComposerMark {
  id: string;
  label: string;
  /** The pointer's hint, where it says more than the name: the name with its key, "Bold · ⌘B". */
  title?: string;
  /** The letter that stands for it, drawn the way the mark draws text. */
  glyph?: { letter: string; as: "bold" | "italic" | "underline" | "strike" };
  icon?: IconName | ComposerIconName;
  /** The mark holds where the caret is. */
  pressed?: boolean;
  /** This control opens a dialog and reports whether it is open. */
  dialogExpanded?: boolean;
  menuExpanded?: boolean;
  disabled?: boolean;
  /** A press hands the mark's own element: what the mark opens (a link's card) comes out of it. */
  onPress?: (anchor: HTMLElement) => void;
}

export interface ComposerMarksProps {
  /** The strip's name for a screen reader. */
  label: string;
  /** The marks in groups; a hair parts two groups. */
  groups: readonly (readonly ComposerMark[])[];
}

/** The editor's marks on a quiet strip at its top. A press never takes the caret out of the text. */
export function ComposerMarks({ label, groups }: ComposerMarksProps) {
  return (
    <div
      className="oh-composer-marks"
      role="toolbar"
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
    >
      {groups.map((group, g) => (
        <Fragment key={g}>
          {g ? <i className="oh-composer-hair" aria-hidden="true" /> : null}
          {group.map((mark) => (
            <button
              key={mark.id}
              type="button"
              className="oh-control oh-composer-mark"
              aria-label={mark.label}
              title={mark.title ?? mark.label}
              aria-pressed={mark.pressed}
              aria-haspopup={
                mark.menuExpanded !== undefined
                  ? "menu"
                  : mark.dialogExpanded !== undefined
                    ? "dialog"
                    : undefined
              }
              aria-expanded={mark.menuExpanded ?? mark.dialogExpanded}
              disabled={mark.disabled}
              onClick={(event) => mark.onPress?.(event.currentTarget)}
            >
              {mark.icon ? (
                <Icon name={mark.icon} size={18} />
              ) : (
                <span className="oh-composer-glyph" data-as={mark.glyph?.as}>
                  {mark.glyph?.letter}
                </span>
              )}
              {mark.menuExpanded !== undefined ? <Icon name="down" size={18} /> : null}
            </button>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

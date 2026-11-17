import { Icon } from "../../icons/Icon.js";
import "./setting-note.css";

/** A part of a note's sentence: words, or words the sentence leans on. */
export type SettingNotePart = string | { strong: string };

export interface SettingNoteProps {
  /**
   * What needs saying once under the line it is about: one or two short sentences. In parts where the sentence
   * leans on some of its words: the app hands the catalogue's sentence as it marks it.
   */
  children: string | readonly SettingNotePart[];
  /** It warns: the warning sign leads it, and it is said when it appears. */
  warn?: boolean;
  /** It says that something is being read: said when it appears, and gone when the lines it stands for arrive. */
  busy?: boolean;
}

/** A note on a sheet of settings: the second ink, under the line it is about, at a reading measure. */
export function SettingNote({ children, warn, busy }: SettingNoteProps) {
  const parts = typeof children === "string" ? [children] : children;
  return (
    <p
      className="oh-text oh-settingnote"
      data-warn={warn ? "" : undefined}
      role={warn || busy ? "status" : undefined}
      aria-busy={busy ? true : undefined}
    >
      {warn ? <Icon name="warn" size={18} /> : null}
      <span>
        {parts.map((part, at) =>
          typeof part === "string" ? (
            part
          ) : (
            <b key={at} className="oh-settingnote-strong">
              {part.strong}
            </b>
          ),
        )}
      </span>
    </p>
  );
}

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
  /**
   * A settled outcome that is no fault ("The mailbox is connected."): said when it appears, calmly, with no sign.
   * A note that only explains the line it stands under leaves it out: it is read, not announced.
   */
  said?: boolean;
}

/** A note on a sheet of settings: the second ink, under the line it is about, at a reading measure. */
export function SettingNote({ children, warn, busy, said }: SettingNoteProps) {
  const parts = typeof children === "string" ? [children] : children;
  return (
    <p
      className="oh-text oh-settingnote"
      data-warn={warn ? "" : undefined}
      /* Said when it appears. It never calls itself busy: that would ask a screen reader to wait with it. */
      role={warn || busy || said ? "status" : undefined}
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

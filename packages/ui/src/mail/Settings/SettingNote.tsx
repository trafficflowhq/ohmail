import { Icon } from "../../icons/Icon.js";
import "./setting-note.css";

export interface SettingNoteProps {
  /** What needs saying once under the line it is about: one or two short sentences. */
  children: string;
  /** It warns: the warning sign leads it. */
  warn?: boolean;
}

/** A note on a sheet of settings: the second ink, under the line it is about, at a reading measure. */
export function SettingNote({ children, warn }: SettingNoteProps) {
  return (
    <p className="oh-text oh-settingnote" data-warn={warn ? "" : undefined}>
      {warn ? <Icon name="warn" size={18} /> : null}
      <span>{children}</span>
    </p>
  );
}

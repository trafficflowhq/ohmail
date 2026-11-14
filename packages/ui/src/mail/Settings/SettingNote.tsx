import { useSaidOnArrival } from "../../base/said-on-arrival.js";
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
   * A note that only explains the line it stands under leaves it out: it is read, not announced. A note that is
   * said (this, `warn`, `busy`) is said by a change inside a region that already stands: on a running page its
   * words are drawn at once and given to a screen reader a moment later.
   */
  said?: boolean;
}

/** A note on a sheet of settings: the second ink, under the line it is about, at a reading measure. */
export function SettingNote({ children, warn, busy, said }: SettingNoteProps) {
  const parts = typeof children === "string" ? [children] : children;
  const live = Boolean(warn || busy || said);
  /* Said when it appears: by a change inside the region once it stands, never by arriving full. */
  const held = useSaidOnArrival(live);
  return (
    <p
      className="oh-text oh-settingnote"
      data-warn={warn ? "" : undefined}
      /* It never calls itself busy: that would ask a screen reader to wait with it. */
      role={live ? "status" : undefined}
    >
      {warn ? <Icon name="warn" size={18} /> : null}
      <span aria-hidden={held ? true : undefined}>
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

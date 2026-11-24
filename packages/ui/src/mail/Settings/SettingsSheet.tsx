import type { ReactNode, Ref } from "react";
import { Avatar, Dot, EndDot, Sign } from "../../base/index.js";
import type { IconName } from "../../icons/Icon.js";
import { Sheet } from "../Shell/Sheet.js";
import "./settings-sheet.css";

export interface SettingsSheetProps {
  /** What the sheet is about. Left out: the sheet has no head, its lines speak for it. */
  title?: string;
  /** Focus target for a link that leads directly to this sheet. */
  headRef?: Ref<HTMLHeadingElement>;
  /** A sheet about one person or mailbox: its circle leads the head. */
  person?: { name: string; address: string };
  /** A sheet about a thing: its sign leads the head. */
  sign?: IconName;
  /** Something on the sheet wants the person: the sheet is tinted, and a head with no circle or sign leads with the hot dot. */
  hot?: boolean;
  /** What stands at the head's end: a state as a word or a tag, a count, one word that acts. */
  aside?: ReactNode;
  /** What the sheet wants, said once: a word that ends in the dot, at most a line, at most two buttons. It tints the sheet. */
  wants?: { word: string; line?: string; acts?: ReactNode; alert?: boolean };
  /** A settled explanation with its own action, such as the way to delete the account. */
  note?: { line: string; acts: ReactNode };
  /** Its lines. */
  children?: ReactNode;
}

/** A sheet of settings: a head when it needs one, what it wants when it wants something, then its lines. */
export function SettingsSheet({
  title,
  headRef,
  person,
  sign,
  hot,
  aside,
  wants,
  note,
  children,
}: SettingsSheetProps) {
  const lead = person ? (
    <Avatar name={person.name} address={person.address} size="s" />
  ) : sign ? (
    <Sign icon={sign} size="s" />
  ) : hot ? (
    <Dot kind="hot" />
  ) : null;
  const message = wants ?? note;
  return (
    <Sheet kind="plain">
      <div className="oh-settingssheet" data-wants={hot || wants ? "" : undefined}>
        {title ? (
          <header className="oh-settingssheet-head">
            {lead}
            <h2 className="oh-text oh-settingssheet-title" ref={headRef} tabIndex={headRef ? -1 : undefined}>
              {title}
            </h2>
            {aside ? <span className="oh-settingssheet-aside">{aside}</span> : null}
          </header>
        ) : null}
        {/* It stands before the sheet wants anything, so what the sheet then wants is said when it appears. */}
        <div className="oh-settingssheet-said" aria-live="polite">
          {message ? (
            <div className="oh-settingssheet-say" role={wants?.alert ? "alert" : undefined}>
              <p className="oh-text oh-settingssheet-line">
                {wants ? (
                  <b className="oh-settingssheet-word">
                    <EndDot kind="hot">{wants.word}</EndDot>
                  </b>
                ) : null}
                {wants && message.line ? " " : null}
                {message.line}
              </p>
              {message.acts ? <span className="oh-settingssheet-acts">{message.acts}</span> : null}
            </div>
          ) : null}
        </div>
        {children}
      </div>
    </Sheet>
  );
}

import { EndDot } from "../../base/index.js";
import "./settings-head.css";

export interface SettingsHeadProps {
  /** The section's name: "Notifications". */
  title: string;
  /** Something in the section wants the person: the title ends in the hot dot. */
  hot?: boolean;
  /** How many the section holds, where it is a list of things: "2". */
  count?: string;
}

/** The head of a Settings section: its name on the line of the list's title, and how many it holds. It stays while the sheets scroll under it. */
export function SettingsHead({ title, hot, count }: SettingsHeadProps) {
  return (
    <header className="oh-settingshead">
      <div className="oh-settingshead-line">
        <span className="oh-settingshead-name">
          <h1 className="oh-text oh-display oh-settingshead-title">
            <EndDot kind={hot ? "hot" : "ink"}>{title}</EndDot>
          </h1>
          {count ? <span className="oh-settingshead-count">{count}</span> : null}
        </span>
      </div>
    </header>
  );
}

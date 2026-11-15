import { Dot } from "../../base/index.js";
import { Icon } from "../../icons/Icon.js";
import "./group-heading.css";

export interface GroupHeadingProps {
  /** The group's name. */
  children: string;
  /** How many stand under it, as it is printed. */
  count?: string;
  /** An unread row stands under it: the name ends in the hot dot. */
  hot?: boolean;
  /** A group that shuts: whether its rows stand. Left out: the heading is no button. */
  expanded?: boolean;
  /** The name opens a menu instead. */
  opensMenu?: boolean;
  onPress?: () => void;
}

/** A group's name, its full stop and its count. */
export function GroupHeading({ children, count, hot, expanded, opensMenu, onPress }: GroupHeadingProps) {
  const name = (
    <>
      <span>
        {children}
        <Dot kind={hot ? "hot" : "ink"} />
      </span>
      {count === undefined ? null : <span className="oh-groupheading-count">{count}</span>}
    </>
  );
  const pressed = expanded !== undefined || opensMenu;
  return (
    <h2 className="oh-text oh-display oh-groupheading">
      {pressed ? (
        <button
          type="button"
          className="oh-control oh-groupheading-fold"
          aria-expanded={opensMenu ? undefined : expanded}
          aria-haspopup={opensMenu ? "menu" : undefined}
          onClick={onPress}
        >
          {name}
          <Icon name="down" size={16} className="oh-groupheading-chevron" />
        </button>
      ) : (
        name
      )}
    </h2>
  );
}

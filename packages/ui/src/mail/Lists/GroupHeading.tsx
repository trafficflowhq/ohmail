import type { ReactNode } from "react";
import { Dot, Tag } from "../../base/index.js";
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
  /** One word about the whole group, as a label at the heading's end: "Read-only". */
  tag?: string;
  /** A control of the group's own at the line's end: how its rows are ordered. It is no part of the heading's name. */
  aside?: ReactNode;
  onPress?: () => void;
}

/** A group's name, its full stop and its count. */
export function GroupHeading(props: GroupHeadingProps) {
  const { children, count, hot, expanded, opensMenu, tag, aside, onPress } = props;
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
  const heading = (
    <h2 className="oh-text oh-display oh-groupheading" data-tag={tag ? "" : undefined}>
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
      {tag ? <Tag>{tag}</Tag> : null}
    </h2>
  );
  /* The same box with and without a control: a heading that gains one keeps its node, and the keys on it. */
  return (
    <div className="oh-groupheading-line" data-bare={aside ? undefined : ""}>
      {heading}
      {aside ? <span className="oh-groupheading-aside">{aside}</span> : null}
    </div>
  );
}

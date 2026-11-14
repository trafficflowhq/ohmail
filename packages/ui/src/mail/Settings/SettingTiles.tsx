import type { ReactNode } from "react";
import { EndDot, Tag } from "../../base/index.js";
import "./setting-tiles.css";

export interface SettingTilesProps {
  /** The setting the tiles choose: the group is named by it ("Look"). */
  label: string;
  /** The tiles, one a choice. */
  children: ReactNode;
}

/** A choice shown as tiles: two columns where two fit, one under a finger or in a narrower column. */
export function SettingTiles({ label, children }: SettingTilesProps) {
  return (
    <div className="oh-settingtiles" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export interface SettingTileProps {
  /** The choice's name, under its picture: "ohmarchy". */
  name: string;
  /** A word beside the name: "follows Omarchy". */
  tag?: string;
  /** It is the one chosen: pressed, its name bold with the end dot. */
  on: boolean;
  /** The press that chooses it. */
  onPress?: () => void;
  /** What the choice looks like (a LookPicture). It is not heard: the tile is named by its name and tag. */
  children: ReactNode;
}

/** One choice of SettingTiles: a button with its picture, its name and its tag. */
export function SettingTile({ name, tag, on, onPress, children }: SettingTileProps) {
  return (
    <button type="button" className="oh-control oh-settingtile" aria-pressed={on} onClick={onPress}>
      {children}
      <span className="oh-settingtile-name">
        <b className="oh-settingtile-word">{on ? <EndDot kind="ink">{name}</EndDot> : name}</b>
        {tag ? <Tag>{tag}</Tag> : null}
      </span>
    </button>
  );
}

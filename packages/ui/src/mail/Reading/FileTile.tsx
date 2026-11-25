import type { MouseEventHandler, ReactNode } from "react";
import { Button, mailContextTrigger, type Point } from "../../base/index.js";
import "./file-tile.css";

export interface FileTileProps {
  /** What it is, as a few letters: "PDF", "JPG". */
  kind: string;
  name: string;
  /** How much it weighs, as it is printed. */
  size?: string;
  /** A picture's small look at itself, in place of the letters: the image the app has of it. */
  look?: ReactNode;
  /**
   * The tile itself: a press looks at the file, or saves what cannot be looked at. The label says which.
   * Left out on a draft's file that cannot be looked at: the tile is no button.
   */
  main?: {
    label: string;
    onPress?: MouseEventHandler<HTMLButtonElement>;
    onMouseDown?: MouseEventHandler<HTMLButtonElement>;
  };
  /** The arrow that saves it. `saved`: it was. */
  save?: { label: string; saved?: boolean; busy?: boolean; onPress?: () => void };
  /** On a draft: the way off the letter, said with the file's name. */
  off?: { label: string; onPress?: () => void };
  onMenu?: (at: Point | Element, opener: HTMLElement) => void;
}

/** A file on a message, a draft or a waiting sender's letter. */
export function FileTile({ kind, name, size, look, main, save, off, onMenu }: FileTileProps) {
  const face = (
    <>
      {look ? <i className="oh-file-kind oh-file-look">{look}</i> : <i className="oh-file-kind">{kind}</i>}
      <span className="oh-file-name">
        <b className="oh-file-title">{name}</b>
        {size ? <span className="oh-file-size">{size}</span> : null}
      </span>
    </>
  );
  return (
    <span className="oh-file" {...mailContextTrigger(onMenu)}>
      {main ? (
        <button
          type="button"
          className="oh-control oh-file-main"
          aria-label={main.label}
          aria-busy={save?.busy || undefined}
          onMouseDown={main.onMouseDown}
          onClick={main.onPress}
        >
          {face}
        </button>
      ) : (
        <span className="oh-file-main">{face}</span>
      )}
      {save ? (
        <span className="oh-file-save" data-saved={save.saved ? "" : undefined}>
          <Button
            kind="quiet"
            size="s"
            icon="download"
            label={save.label}
            busy={save.busy}
            onPress={save.onPress}
          />
        </span>
      ) : null}
      {off ? (
        <span className="oh-file-save">
          <Button kind="quiet" size="s" icon="x" label={off.label} onPress={off.onPress} />
        </span>
      ) : null}
    </span>
  );
}

export interface FilesProps {
  /** Several files: how many they are and what they weigh. */
  summary?: string;
  /** All of them at once. `busy`: they are being fetched. */
  all?: { label: string; busy?: boolean; onPress?: () => void };
  /** The tiles. */
  children: ReactNode;
}

/** The files of one letter: a line that counts them, then a tile each. */
export function Files({ summary, all, children }: FilesProps) {
  return (
    <div className="oh-files" data-set={summary ? "" : undefined}>
      {summary ? (
        <p className="oh-text oh-files-head">
          <span className="oh-nowrap">{summary}</span>
          {all ? (
            <span className="oh-files-all" aria-busy={all.busy || undefined}>
              <Button kind="quiet" size="s" icon="download" onPress={all.onPress}>
                {all.label}
              </Button>
            </span>
          ) : null}
        </p>
      ) : null}
      {children}
    </div>
  );
}

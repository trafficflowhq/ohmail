import type { ReactNode, Ref } from "react";
import { Button } from "../../base/index.js";
import "./sheet.css";

interface PaperProps {
  /** `plain`: a sheet. `list`: a column that is one sheet and cuts what scrolls in it. `wide`: a pane over two columns. */
  kind: "plain" | "list" | "wide";
  /** The column's name, where it is a region of the window. */
  label?: string;
  /** The column has the keyboard: the face that rings such a column draws its ring. */
  focused?: boolean;
  children?: ReactNode;
}

interface ReadingProps {
  /** The reading column: every message a sheet of its own on the ground, under one head. */
  kind: "reading";
  /** The whole sheet, including its foot, for returning focus when it closes. */
  ref?: Ref<HTMLDivElement>;
  label?: string;
  focused?: boolean;
  /**
   * The way back on a phone, first in the bar over the column: the place it returns to, as its word. `label` names
   * it where the word is not its whole name; without a word it is the arrow alone, and `label` is its name.
   */
  back?: { onPress?: () => void } & ({ word: string; label?: string } | { label: string; word?: undefined });
  /** What else stands in the bar over the column on a phone: the squares along it. */
  top?: ReactNode;
  /** What stands beside the sheets: a conversation's squares. A single letter has nothing there and starts at the edge. */
  gutter?: ReactNode;
  /** What stays while the sheets scroll under it. */
  head?: ReactNode;
  /** What floats over the column's foot: the action panel. */
  foot?: ReactNode;
  /** The way back to the column's start (`JumpBack`): it stands at the column's right corner, over the foot. */
  jump?: ReactNode;
  /** The box the sheets scroll in, handed out: the read rule and the way back read it. */
  scroller?: Ref<HTMLDivElement>;
  /** The sheets, oldest first. */
  children?: ReactNode;
}

export type SheetProps = PaperProps | ReadingProps;

/**
 * The box a reading column's sheets scroll in, found under `root` (the column itself, or anything around it):
 * for a part that does not draw the column and still walks into the open letter or reads how far it is scrolled.
 * Whoever draws the column takes the same box by `scroller`. `root` holds ONE reading column: under a root that
 * holds two (a stream's column and a letter's beside it) this answers the first in the page's order, so hand the
 * section of the column that is meant.
 */
export function readingScroller(root: ParentNode | null | undefined): HTMLElement | null {
  return root?.querySelector<HTMLElement>("[data-reading-scroll]") ?? null;
}

/**
 * What belongs together lies on one sheet. A sheet never lies on a sheet.
 *
 * As a reading column the sheets stand on the ground, at a reading width in a wide window, and the
 * column ends in their corners while one runs under its foot.
 */
export function Sheet(props: SheetProps) {
  const region = props.label ? ({ role: "region", "aria-label": props.label } as const) : {};
  const focused = props.focused ? "" : undefined;
  if (props.kind !== "reading") {
    return (
      <div className="oh-sheet" data-kind={props.kind} data-focused={focused} {...region}>
        {props.children}
      </div>
    );
  }
  const { back, top, gutter, head, foot, jump, scroller, children } = props;
  return (
    <div
      ref={props.ref}
      className="oh-sheet"
      data-kind="reading"
      data-gutter={gutter ? "" : undefined}
      data-focused={focused}
      {...region}
    >
      {back || top ? (
        <div className="oh-sheet-top">
          {back ? (
            <span className="oh-sheet-back">
              {back.word === undefined ? (
                <Button kind="quiet" icon="back" label={back.label} onPress={back.onPress} />
              ) : (
                <Button kind="quiet" icon="back" label={back.label} onPress={back.onPress}>
                  {back.word}
                </Button>
              )}
            </span>
          ) : null}
          {top}
        </div>
      ) : null}
      <div className="oh-sheet-body">
        <div className="oh-sheet-gutter">{gutter}</div>
        <div ref={scroller} className="oh-sheet-scroll" data-reading-scroll="" tabIndex={-1}>
          {head}
          <div className="oh-sheet-run">{children}</div>
        </div>
      </div>
      {foot ? (
        <div className="oh-sheet-foot">
          {jump}
          {foot}
        </div>
      ) : (
        jump
      )}
    </div>
  );
}

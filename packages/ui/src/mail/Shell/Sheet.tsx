import type { ReactNode, Ref } from "react";
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
  label?: string;
  focused?: boolean;
  /** The bar over the column on a phone: the way back, and the squares along it. */
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
  const { top, gutter, head, foot, jump, scroller, children } = props;
  return (
    <div
      className="oh-sheet"
      data-kind="reading"
      data-gutter={gutter ? "" : undefined}
      data-focused={focused}
      {...region}
    >
      {top ? <div className="oh-sheet-top">{top}</div> : null}
      <div className="oh-sheet-body">
        <div className="oh-sheet-gutter">{gutter}</div>
        <div ref={scroller} className="oh-sheet-scroll" tabIndex={-1}>
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

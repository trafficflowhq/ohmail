/**
 * THE COLUMNS: the rail, then the list and the reading column, or one wide pane over both. On a phone's width
 * one column stands: the list, or the reading column over it. On the desktop a handle at each column's far
 * edge sets the person's own width; a double press gives the theme's back. Beside a rail or a dock standing upright
 * the list lies on one sheet, the frame's, and the list draws on it (a sheet never lies on a sheet); on a phone's
 * width the list is the ground and draws its own. The reading column and a wide pane draw their own.
 */
import { useRef } from "react";
import { ColumnHandle, Sheet } from "@ohmail/ui/mail";
import type { ColumnsProps } from "./contract.js";
import { useColumnWidths } from "./column-widths.js";

export function Columns({ plan, rail, list, listKeys, reading, wide, labels }: ColumnsProps) {
  const drawn = useRef<HTMLDivElement>(null);
  const widths = useColumnWidths(drawn);
  const handle = (column: "rail" | "list") =>
    plan.handles ? (
      <div className="fr-handle">
        <ColumnHandle
          column={column}
          label={column === "rail" ? labels.railWidth : labels.listWidth}
          value={widths[column]}
          min={widths.limits[column].min}
          max={widths.limits[column].max}
          onChange={(width) => widths.set(column, width)}
          onReset={() => widths.set(column, undefined)}
        />
      </div>
    ) : null;
  const over = plan.columns === 1 && reading !== null && reading !== undefined;
  const body =
    wide !== null ? (
      <div className="fr-wide">{wide}</div>
    ) : (
      <>
        <section className="fr-list" aria-label={labels.list}>
          {plan.device === "phone" ? (
            list
          ) : (
            <Sheet kind="list" focused={listKeys}>
              {list}
            </Sheet>
          )}
        </section>
        {handle("list")}
        {plan.columns === 2 || over ? (
          <section className="fr-reading" aria-label={labels.reading} data-over={over ? "" : undefined}>
            {reading}
          </section>
        ) : null}
      </>
    );
  return (
    <div
      ref={drawn}
      className="fr-columns"
      data-columns={plan.columns}
      data-wide={wide !== null ? "" : undefined}
      data-norail={rail ? undefined : ""}
    >
      {rail}
      {rail ? handle("rail") : null}
      <main className="fr-main">{body}</main>
    </div>
  );
}

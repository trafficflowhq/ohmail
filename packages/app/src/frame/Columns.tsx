/**
 * THE COLUMNS: the rail, then the list and the reading column, or one wide pane over both. On a phone's width
 * one column stands: the list, or the reading column over it. On the desktop a handle at each column's far
 * edge sets the person's own width; a double press gives the theme's back. Beside a rail or a dock standing upright
 * the list lies on one sheet, the frame's, and the list draws on it (a sheet never lies on a sheet); on a phone's
 * width the list is the ground and draws its own. The reading column and a wide pane draw their own.
 *
 * What a place stands above its two columns wraps them and nothing else: the rail is outside it.
 */
import { Fragment, useRef, type KeyboardEvent } from "react";
import { cycleTab, useOverlayFocus } from "@ohmail/ui/base";
import { ColumnHandle, Sheet } from "@ohmail/ui/mail";
import type { ColumnsProps } from "./contract.js";
import { useColumnWidths } from "./column-widths.js";

const focusReading = (reading: HTMLElement): HTMLElement => reading;

export function Columns({ plan, rail, list, listKeys, reading, wide, above, labels }: ColumnsProps) {
  const drawn = useRef<HTMLDivElement>(null);
  const listColumn = useRef<HTMLElement>(null);
  const widths = useColumnWidths(drawn);
  const handle = (column: "rail" | "list") =>
    plan.handles || (column === "list" && plan.ribbon === "split") ? (
      <div className="fr-handle">
        <ColumnHandle
          column={column}
          label={column === "rail" ? labels.railWidth : labels.listWidth}
          value={widths[column]}
          min={widths.limits[column].min}
          max={widths.limits[column].max}
          resizeTarget={column === "list" ? listColumn : undefined}
          onChange={(width) => widths.set(column, width)}
          onReset={() => widths.set(column, undefined)}
        />
      </div>
    ) : null;
  const over = plan.columns === 1 && reading !== null && reading !== undefined;
  const modal = over && plan.ribbon !== "push";
  const readingBox = useRef<HTMLElement>(null);
  useOverlayFocus(over, readingBox, focusReading);
  const columns = (
    <>
      <section ref={listColumn} className="fr-list" aria-label={labels.list} inert={over || undefined}>
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
        <section
          ref={readingBox}
          className="fr-reading"
          aria-label={labels.reading}
          data-over={over ? "" : undefined}
          /* Over the list on one column the letter covers it: a modal dialog, so a screen reader's walk stays in it, as
             today's narrow sheet claimed; beside the list it is the region it is. */
          role={modal ? "dialog" : undefined}
          aria-modal={modal || undefined}
          tabIndex={over ? -1 : undefined}
          onKeyDown={
            modal
              ? (event: KeyboardEvent<HTMLElement>) => {
                  if (!event.defaultPrevented) cycleTab(event, event.currentTarget);
                }
              : undefined
          }
        >
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
      data-ribbon={plan.ribbon}
      data-wide={wide !== null ? "" : undefined}
      data-norail={rail ? undefined : ""}
    >
      {rail}
      {rail ? handle("rail") : null}
      <main className="fr-main">
        {wide !== null ? (
          <div key="wide" className="fr-wide">
            {wide}
          </div>
        ) : above !== null ? (
          <above.Above key={`above ${above.body}`}>{columns}</above.Above>
        ) : (
          <Fragment key="columns">{columns}</Fragment>
        )}
      </main>
    </div>
  );
}

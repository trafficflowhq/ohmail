import { createContext, useLayoutEffect, useRef } from "react";
import { GroupHeading, ListHead, Row, Rows } from "@ohmail/ui/mail";

export interface SavedOhboxRow {
  id: string;
  who: string;
  subject: string;
  preview: string;
  when: string;
  unread?: boolean;
  offset?: number;
}

export interface SavedOhbox {
  groups: { label: string; heading?: boolean; rows: SavedOhboxRow[] }[];
  anchor: { id: string; offset: number };
  atTop?: true;
  top?: number;
  bottom?: number;
}

export interface OhboxStartup {
  launch: { saved: SavedOhbox | null; pressed: string | null };
  save(value: SavedOhbox | null): void;
  onLeave?(save: () => void): () => void;
}

export const OhboxStartupContext = createContext<OhboxStartup | null>(null);

/** A previous viewport speaks for itself. An open is just an intent until the current list names the row. */
export function SavedOhboxList({
  saved,
  title,
  startup,
}: {
  saved: SavedOhbox;
  title: string;
  startup: OhboxStartup;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (saved.atTop) return;
    const el = scroller.current;
    const anchor =
      el &&
      Array.from(el.querySelectorAll<HTMLElement>(".oh-row[data-id]")).find(
        (row) => row.dataset.id === saved.anchor.id,
      );
    if (el && anchor)
      el.scrollTop =
        anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.anchor.offset;
  }, [saved]);
  return (
    <div className="ob-list" data-saved-list="">
      <ListHead title={title} />
      <div
        className="ob-scroll"
        data-keep-row-date=""
        ref={scroller}
        onScroll={(event) => {
          const anchor = visibleAnchor(event.currentTarget);
          if (anchor) {
            saved.anchor = anchor;
            saved.atTop = event.currentTarget.scrollTop === 0 ? true : undefined;
          }
        }}
      >
        {saved.top ? <div aria-hidden style={{ height: saved.top }} /> : null}
        {saved.groups.map(({ label, heading, rows }, index) => (
          <div key={index}>
            {heading !== false ? (
              <div className="ob-heading">
                <GroupHeading>{label}</GroupHeading>
              </div>
            ) : null}
            <Rows label={label} many>
              {rows.map((row) => (
                <div key={row.id} data-saved-row="">
                  <Row
                    who={row.who}
                    subject={row.subject}
                    preview={row.preview}
                    when={row.when}
                    unread={row.unread}
                    people={[{ name: row.who, address: "" }]}
                    mark={{ id: row.id }}
                    listing={{ name: `${row.who}: ${row.subject}`, selected: false }}
                    onOpen={() => {
                      startup.launch.pressed = row.id;
                    }}
                  />
                </div>
              ))}
            </Rows>
          </div>
        ))}
        {saved.bottom ? <div aria-hidden style={{ height: saved.bottom }} /> : null}
      </div>
    </div>
  );
}

function visibleAnchor(scroller: HTMLDivElement): SavedOhbox["anchor"] | null {
  const top = scroller.getBoundingClientRect().top;
  const row = Array.from(scroller.querySelectorAll<HTMLElement>(".oh-row[data-id]")).find(
    (node) => node.getBoundingClientRect().bottom > top,
  );
  return row?.dataset.id ? { id: row.dataset.id, offset: row.getBoundingClientRect().top - top } : null;
}

/** Copy only the painted viewport and its overscan. This never runs in the browser or phone shell. */
export function takeSavedOhbox(scroller: HTMLDivElement): SavedOhbox | null {
  const anchor = visibleAnchor(scroller);
  if (!anchor) return null;
  const top = scroller.getBoundingClientRect().top;
  const groups: SavedOhbox["groups"] = [];
  let first: HTMLElement | undefined;
  let last: HTMLElement | undefined;
  for (const list of scroller.querySelectorAll<HTMLElement>(".oh-rows")) {
    const heading = list.previousElementSibling?.matches(".ob-heading") ? list.previousElementSibling : null;
    const nodes = Array.from(list.querySelectorAll<HTMLElement>(".oh-row[data-id]"))
      .filter((row) => {
        const rect = row.getBoundingClientRect();
        // Keep the visible rows and a row on either side for a small scroll while opening.
        return rect.bottom + rect.height > top && rect.top - rect.height < top + scroller.clientHeight;
      })
      .slice(0, 40);
    if (nodes.length === 0) continue;
    const showHeading = heading !== null && nodes[0] === list.querySelector(".oh-row");
    first ??= showHeading && heading instanceof HTMLElement ? heading : nodes[0];
    last = nodes.at(-1);
    const words = (row: HTMLElement, field: string) =>
      row.querySelector(`.oh-row-${field}`)?.textContent?.trim().slice(0, 320) ?? "";
    groups.push({
      label: (list.getAttribute("aria-label") ?? "").slice(0, 100),
      heading: showHeading,
      rows: nodes.map((row) => ({
        id: row.dataset.id!,
        who: words(row, "who"),
        subject: words(row, "subject"),
        preview: words(row, "preview"),
        when: words(row, "when"),
        unread: row.hasAttribute("data-unread"),
        offset: row.getBoundingClientRect().top - top,
      })),
    });
  }
  return first && last
    ? {
        groups,
        anchor,
        atTop: scroller.scrollTop === 0 ? true : undefined,
        top: Math.max(0, first.getBoundingClientRect().top - top),
        bottom: Math.max(0, top + scroller.clientHeight - last.getBoundingClientRect().bottom),
      }
    : null;
}

/**
 * THE ROWS OF A LIST PLACE beside the reader: one row a letter, who wrote it (or whom it went to), its subject, its
 * first words and its hour, the cursor's row marked, and what the place says beside it (where it is, a tag). Pure
 * drawing over the place's model: a press opens.
 */
import type { EngineMessage } from "@ohmail/wire";
import type { ReactNode } from "react";
import type { RowSelection } from "./use-row-selection.js";
import type { RowContact } from "./use-row-contact.js";
import { Row, Rows } from "@ohmail/ui/mail";
import { useRowPeople } from "./people.js";

export interface LetterRowsProps {
  readonly label: string;
  readonly selection?: RowSelection;
  readonly contact?: RowContact;
  readonly rows: readonly EngineMessage[];
  readonly windowed?: {
    readonly start: number;
    readonly total: number;
    readonly top: number;
    readonly bottom: number;
    readonly rowHeight: number;
    readonly slots: readonly (EngineMessage | "gone" | "folded" | null)[];
  };
  /** The cursor's row: the letter open beside the list, or where one column stands the row the keys are on. */
  readonly cursor: string | null;
  /** Slot index and the row's position in this group when only a slice is drawn. */
  readonly slice?: { index: number; first: number; total: number };
  readonly press: (id: string) => void;
  /** An instant as the row prints it. */
  readonly stamp: (iso: string) => string;
  /** What line one says: the sender, or for one's own letter whom it went to. */
  readonly who: (m: EngineMessage) => string;
  /** The place the letter is in, as a word. */
  readonly where?: (m: EngineMessage) => string | undefined;
  /** One tag, whole. */
  readonly tag?: (m: EngineMessage) => ReactNode;
  readonly squares?: (m: EngineMessage) => ReactNode;
  /** The paper-clip's name, on a letter that carries a file. */
  readonly file?: string;
  /** The words a screen reader hears after the name: unread or read. */
  readonly spoken: (m: EngineMessage) => string;
  /** A row's own menu (a right click, or the key that opens one), where the place has one: at the pointer. */
  readonly onMenu?: (m: EngineMessage, at: { x: number; y: number }) => void;
}

export function LetterRows({
  label,
  selection,
  contact,
  rows,
  windowed,
  cursor,
  slice,
  press,
  stamp,
  who,
  where,
  tag,
  squares,
  file,
  spoken,
  onMenu,
}: LetterRowsProps) {
  const rowPeople = useRowPeople();
  return (
    <Rows label={label} many={selection !== undefined}>
      {windowed ? <div data-window-top="" aria-hidden style={{ height: windowed.top }} /> : null}
      {(windowed?.slots ?? rows).map((m, offset) => {
        const index = windowed ? windowed.start + offset : slice && slice.index + offset;
        const place = windowed
          ? { at: windowed.start + offset + 1, of: windowed.total }
          : slice && { at: slice.first + offset + 1, of: slice.total };
        if (m === "folded")
          return <div key={`folded-${index}`} data-index={index} data-folded-row="" aria-hidden />;
        if (m === "gone") return <div key={`gone-${index}`} aria-hidden />;
        if (m === null)
          return (
            <div
              key={`pending-${index}`}
              data-index={index}
              aria-hidden
              style={{ height: windowed?.rowHeight }}
            />
          );
        const name = who(m);
        const open = m.id === cursor;
        const pick = selection?.rowProps(m.id);
        return (
          <Row
            key={m.id}
            {...pick}
            {...contact?.rowProps(m.from, m.id)}
            who={name}
            address={m.from.address}
            {...rowPeople(m, { name: m.from.name ?? m.from.address, address: m.from.address })}
            subject={m.subject}
            preview={m.snippet ?? undefined}
            when={m.date === null ? undefined : stamp(m.date)}
            where={where?.(m)}
            tag={tag?.(m)}
            squares={squares?.(m)}
            file={m.hasAttachments ? file : undefined}
            unread={m.unread}
            open={open}
            onOpen={() => press(m.id)}
            onMenu={onMenu ? (at) => onMenu(m, at) : undefined}
            listing={{
              name: `${name}: ${m.subject}`,
              spoken: spoken(m),
              selected: selection?.ids.length ? pick?.picked === true : open,
              stop: open,
              place,
            }}
            mark={{ id: m.id, unseen: m.unread, index }}
          />
        );
      })}
      {windowed ? <div aria-hidden style={{ height: windowed.bottom }} /> : null}
    </Rows>
  );
}

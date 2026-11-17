/**
 * THE ROWS OF A LIST PLACE beside the reader: one row a letter, who wrote it (or whom it went to), its subject, its
 * first words and its hour, the letter open marked, and what the place says beside it (where it is, a tag). Pure
 * drawing over the place's model: a press opens.
 */
import type { ReactNode } from "react";
import type { EngineMessage } from "@ohmail/client-engine";
import { Row, Rows } from "@ohmail/ui/mail";

export interface LetterRowsProps {
  readonly label: string;
  readonly rows: readonly EngineMessage[];
  readonly openId: string | null;
  readonly press: (id: string) => void;
  /** An instant as the row prints it. */
  readonly stamp: (iso: string) => string;
  /** What line one says: the sender, or for one's own letter whom it went to. */
  readonly who: (m: EngineMessage) => string;
  /** The place the letter is in, as a word. */
  readonly where?: (m: EngineMessage) => string | undefined;
  /** One tag, whole. */
  readonly tag?: (m: EngineMessage) => ReactNode;
  /** The paper-clip's name, on a letter that carries a file. */
  readonly file?: string;
  /** The words a screen reader hears after the name: unread or read. */
  readonly spoken: (m: EngineMessage) => string;
}

export function LetterRows({
  label,
  rows,
  openId,
  press,
  stamp,
  who,
  where,
  tag,
  file,
  spoken,
}: LetterRowsProps) {
  return (
    <Rows label={label}>
      {rows.map((m) => {
        const name = who(m);
        const open = m.id === openId;
        return (
          <Row
            key={m.id}
            who={name}
            address={m.from.address}
            people={[{ name: m.from.name ?? m.from.address, address: m.from.address }]}
            subject={m.subject}
            preview={m.snippet ?? undefined}
            when={m.date === null ? undefined : stamp(m.date)}
            where={where?.(m)}
            tag={tag?.(m)}
            file={m.hasAttachments ? file : undefined}
            unread={m.unread}
            open={open}
            onOpen={() => press(m.id)}
            listing={{ name: `${name}: ${m.subject}`, spoken: spoken(m), selected: open, stop: open }}
            mark={{ id: m.id, unseen: m.unread }}
          />
        );
      })}
    </Rows>
  );
}

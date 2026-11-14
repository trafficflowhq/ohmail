/**
 * WHO A LETTER GOES TO, AND ITS SUBJECT: the kit's recipients over the composition's three lines. A person is a
 * chip of the line's wire text; a person is moved within and between the lines by the shell's one move; what does
 * not parse is said in one line under the people before Send, the person marked where it stands.
 */
import { useState } from "react";
import { Recipients, type RecipientLine, type RecipientPerson, type RecipientsProps } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { useWriteBeside } from "../above.js";
import type { RecipientRow } from "../ports.js";

const ROWS: readonly RecipientRow[] = ["to", "cc", "bcc"];
const SEP = "\u0000";
const personId = (row: RecipientRow, at: number, entry: string): string => `${row}${SEP}${at}${SEP}${entry}`;
const personOf = (id: string): { row: RecipientRow; at: number; entry: string } => {
  const [row, at, ...rest] = id.split(SEP);
  return { row: row as RecipientRow, at: Number(at), entry: rest.join(SEP) };
};

/** The address in a wire entry ("Name <a@b>" or "a@b"), and the name it wears. */
function nameOf(entry: string): { name: string; address?: string } {
  const angled = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(entry);
  if (angled) return { name: angled[1]!.trim() || angled[2]!.trim(), address: angled[2]!.trim() };
  return { name: entry.trim() };
}

/** The three lines of people, each the wire text of its line. */
export type PeopleRows = { readonly to: string; readonly cc: string; readonly bcc: string };

export function People({
  rows,
  invalid,
  locked,
  onRows,
  from,
  subject,
  reply,
  allOpen,
  folded,
}: {
  /** A reply's people folded into names until they are changed; left out, the lines stand. */
  folded?: RecipientsProps["folded"];
  /** The From line (`useFromLine`), or undefined: none is drawn. */
  from?: RecipientsProps["from"];
  rows: PeopleRows;
  /** What does not parse in each line, as the send's plan reads it. */
  invalid: {
    readonly to: readonly string[];
    readonly cc: readonly string[];
    readonly bcc: readonly string[];
  };
  locked: boolean;
  onRows: (next: PeopleRows) => void;
  /** The subject line and its change; left out, none is drawn. */
  subject?: { value: string; onChange: (subject: string) => void };
  /** A reply's head: the subject is one more line. */
  reply?: boolean;
  /** All three lines stand from the first (a reply's people, opened to be changed). */
  allOpen?: boolean;
}) {
  const t = useText("write");
  const beside = useWriteBeside();
  const [opened, setOpened] = useState(false);
  const shown: readonly RecipientRow[] =
    allOpen === true || opened || rows.cc.trim() !== "" || rows.bcc.trim() !== "" ? ROWS : ["to"];
  const refusedOf = (row: RecipientRow): string[] => beside.lines.refused(rows[row], true, [...invalid[row]]);
  const refused = ROWS.flatMap(refusedOf);
  const label = { to: t("to"), cc: t("cc"), bcc: t("bcc") };
  const lines: RecipientLine[] = shown.map((row) => {
    const { chips, tail } = beside.lines.split(rows[row]);
    const bad = new Set(refusedOf(row));
    return {
      id: row,
      label: label[row],
      typed: tail,
      people: chips.map((entry, at): RecipientPerson => {
        const who = nameOf(entry);
        return {
          id: personId(row, at, entry),
          name: who.name,
          ...(who.address !== undefined ? { address: who.address } : {}),
          refused: bad.has(entry) || undefined,
          remove: t("remove", { name: who.name }),
        };
      }),
    };
  });
  const write = (row: RecipientRow, chips: readonly string[], tail: string): void =>
    onRows({ to: rows.to, cc: rows.cc, bcc: rows.bcc, [row]: beside.lines.join(chips, tail) });
  return (
    <Recipients
      from={from}
      lines={lines}
      locked={locked}
      more={shown.length === 1 ? { label: t("more"), onPress: () => setOpened(true) } : undefined}
      refusal={refused.length > 0 ? t("refused", { list: refused.join(", ") }) : undefined}
      reply={reply}
      folded={folded}
      subject={
        subject === undefined
          ? undefined
          : { label: t("subject"), placeholder: t("subjectPlaceholder"), ...subject }
      }
      onType={(line, value) => {
        const row = line as RecipientRow;
        write(row, beside.lines.split(rows[row]).chips, value);
      }}
      onCommit={(line, value) => {
        const row = line as RecipientRow;
        write(row, [...beside.lines.split(rows[row]).chips, value.trim()], "");
      }}
      onRemove={(id) => {
        const { row, at } = personOf(id);
        const { chips, tail } = beside.lines.split(rows[row]);
        write(
          row,
          chips.filter((_, i) => i !== at),
          tail,
        );
      }}
      onLift={() => setOpened(true)}
      onMove={(id, to) => {
        const { row, entry } = personOf(id);
        const moved = beside.lines.move({
          rows: { to: rows.to, cc: rows.cc, bcc: rows.bcc },
          move: { entry, from: row, to: to.line as RecipientRow, before: to.index },
        });
        if (moved !== null) onRows(moved);
      }}
    />
  );
}

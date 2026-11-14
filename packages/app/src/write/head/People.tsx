/**
 * WHO A LETTER GOES TO, AND ITS SUBJECT: the kit's recipients over the composition's three lines. A person is a
 * chip of the line's wire text; a person is moved within and between the lines by the shell's one move; what does
 * not parse is said in one line under the people before Send, the person marked where it stands.
 */
import { useState } from "react";
import { formatRecipientLine } from "@ohmail/app-logic/writing/compose-from";
import { parseRecipients } from "@ohmail/app-logic/writing/compose";
import {
  Recipients,
  type RecipientLine,
  type RecipientPerson,
  type RecipientsProps,
  type RecipientSuggest,
} from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import { useWriteBeside } from "../above.js";
import type { RecipientRow, WriteBeside } from "../ports.js";

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

/** The lines shown, each a person a chip of the line's wire text, marked where it does not parse. */
function linesOf(
  shown: readonly RecipientRow[],
  rows: PeopleRows,
  refusedOf: (row: RecipientRow) => string[],
  beside: WriteBeside,
  t: Text,
): RecipientLine[] {
  const label = { to: t("to"), cc: t("cc"), bcc: t("bcc") };
  return shown.map((row) => {
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
}

/**
 * The people the account knows, offered while a line is typed in: none already on a line. A person taken is written
 * as every stored address is (`formatRecipientLine`): a name the line's own splitter would tear is left off, the
 * address kept.
 */
function suggestOf(
  rows: PeopleRows,
  write: (row: RecipientRow, chips: readonly string[], tail: string) => void,
  beside: WriteBeside,
  t: Text,
): RecipientSuggest {
  const taken = ROWS.flatMap((row) =>
    beside.lines.split(rows[row]).chips.map((entry) => (nameOf(entry).address ?? entry).toLowerCase()),
  );
  return {
    label: t("suggestions"),
    people: (typed) =>
      beside.suggest(typed, taken).map((p) => ({
        id: p.address,
        name: p.name === "" ? p.address : p.name,
        address: p.address,
        ...(p.they ? { tag: t("wroteToYou") } : {}),
      })),
    onTake: (line, person) => {
      const row = line as RecipientRow;
      const name = person.name === person.address ? null : person.name;
      write(
        row,
        [...beside.lines.split(rows[row]).chips, formatRecipientLine([{ name, address: person.address }])],
        "",
      );
    },
  };
}

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
  subject?: {
    value: string;
    onChange: (subject: string) => void;
    /** Escape in the subject: a reply's way back to its text. */
    onEscape?: () => void;
  };
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
  const lines = linesOf(shown, rows, refusedOf, beside, t);
  const write = (row: RecipientRow, chips: readonly string[], tail: string): void =>
    onRows({ to: rows.to, cc: rows.cc, bcc: rows.bcc, [row]: beside.lines.join(chips, tail) });
  const suggest = suggestOf(rows, write, beside, t);
  return (
    <Recipients
      from={from}
      lines={lines}
      locked={locked}
      suggest={suggest}
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
      onPaste={(line, value) => {
        const row = line as RecipientRow;
        const { chips } = beside.lines.split(rows[row]);
        const entries = value
          .split(/[,;\r\n\t]/)
          .map((entry) => entry.trim())
          .filter(Boolean);
        const last = entries.at(-1);
        const tail = last && parseRecipients(last).invalid.length > 0 ? entries.pop()! : "";
        write(row, [...chips, ...entries], tail);
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
        const { row, at, entry } = personOf(id);
        const line = to.line as RecipientRow;
        /* The kit counts the landing among the people left once the person is lifted; the move counts it among
           the people as they stand, the person still among them: along its own line, a place after it is one more. */
        const before = line === row && to.index >= at ? to.index + 1 : to.index;
        const moved = beside.lines.move({
          rows: { to: rows.to, cc: rows.cc, bcc: rows.bcc },
          move: { entry, from: row, to: line, before },
        });
        if (moved !== null) onRows(moved);
      }}
    />
  );
}

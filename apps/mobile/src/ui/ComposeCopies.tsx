/**
 * The Cc and Bcc fields of a new mail, drawn as To is (`compose-copies.ts` holds the rules). Only
 * mounted where the letter carries copies.
 */
import { Copy } from "../copy";
import type { AddressBookEntry } from "../state/live";
import type { BackStep } from "./RecipientInput";
import type { TypedCopies } from "./compose-copies";
import { RecipientInput } from "./RecipientInput";

export function ComposeCopies({ value, editable, onChange, book, back }: {
  value: TypedCopies;
  editable: boolean;
  onChange: (next: TypedCopies) => void;
  book: () => readonly AddressBookEntry[];
  back: BackStep;
}) {
  return (
    <>
      <RecipientInput label={Copy.composeCc} value={value.cc} editable={editable} book={book} back={back} onChangeText={(cc) => onChange({ ...value, cc })} />
      <RecipientInput label={Copy.composeBcc} value={value.bcc} editable={editable} book={book} back={back} onChangeText={(bcc) => onChange({ ...value, bcc })} />
    </>
  );
}

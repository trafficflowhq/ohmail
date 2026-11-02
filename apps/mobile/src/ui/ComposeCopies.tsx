/**
 * The Cc and Bcc fields of a new mail, drawn as To is (`compose-copies.ts` holds the rules). Mounted
 * where the letter carries copies or the person asked for them.
 */
import type { RefObject } from "react";
import type { TextInput } from "react-native";
import { Copy } from "../copy";
import type { AddressBookEntry } from "../state/live";
import type { BackStep } from "./RecipientInput";
import type { TypedCopies } from "./compose-copies";
import { RecipientInput } from "./RecipientInput";

export function ComposeCopies({ value, editable, onChange, book, back, ccField }: {
  value: TypedCopies;
  editable: boolean;
  onChange: (next: TypedCopies) => void;
  book: () => readonly AddressBookEntry[];
  back: BackStep;
  /** The Cc input, for a caller that focuses it once the fields are asked for. */
  ccField?: RefObject<TextInput | null>;
}) {
  return (
    <>
      <RecipientInput label={Copy.composeCc} {...(ccField ? { ref: ccField } : {})} value={value.cc} editable={editable} book={book} back={back} onChangeText={(cc) => onChange({ ...value, cc })} />
      <RecipientInput label={Copy.composeBcc} value={value.bcc} editable={editable} book={book} back={back} onChangeText={(bcc) => onChange({ ...value, bcc })} />
    </>
  );
}

/** Signatures' registered states, as models (`screen=settings&sec=signatures`, `&state=edited`). */
import { createElement } from "react";
import { Field } from "@ohmail/ui/base";
import type { SignatureEditorProps, SignaturesModel } from "./model.js";

/** The states page's editor: the kit's field of several lines, where the shell's rich editor stands in the app. */
function plainEditor(props: SignatureEditorProps) {
  const writable = props.editable && !props.preview;
  return createElement(Field, {
    label: props.label,
    placeholder: props.placeholder,
    lines: props.preview ? 2 : 3,
    value: props.value.text,
    onChange: writable ? (text: string) => props.onChange({ text, html: "" }) : undefined,
  });
}

export function signaturesState(): SignaturesModel {
  return {
    mailboxes: [
      {
        id: "m1",
        address: "mila@brunner.example",
        stored: { text: "Mila Brunner\nStudio Brunner", html: "" },
        reading: false,
        takeoverAsked: false,
      },
      {
        id: "m2",
        address: "mila.brunner@work.example",
        stored: { text: "", html: "" },
        reading: false,
        takeoverAsked: false,
      },
    ],
    write: async (id, text, html) => ({
      signatures: { [id]: text ?? "" },
      signaturesHtml: { [id]: html ?? "" },
    }),
    refusal: () => null,
    holdLeave: () => () => undefined,
    editor: plainEditor,
    changeNote: () => null,
  };
}

/**
 * `edited` is a draft typed into the first editor, which a person reaches by typing: the states page opens it through
 * the pane's states-only `typed`.
 */
export const SIGNATURES_STATES: Readonly<Record<string, () => SignaturesModel>> = {
  "": signaturesState,
  edited: signaturesState,
};
export const SIGNATURES_TYPED: Readonly<Record<string, { readonly mailbox: string; readonly text: string }>> =
  {
    edited: { mailbox: "m1", text: "Mila Brunner\nStudio Brunner · Basel" },
  };

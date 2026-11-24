import { useState } from "react";
import { ComposerMarks } from "@ohmail/ui/mail";
import type { EditorHandle, WriteEditor } from "../../write/ports.js";
import { useMarks } from "../../write/text/Marks.js";
import type { SignatureEditorProps } from "./model.js";

/** Edit and preview the signature with the same rich text and formatting controls as Write. */
export function SignatureEditor({
  editor: Editor,
  preview,
  tools,
  ...props
}: SignatureEditorProps & { readonly editor: WriteEditor }) {
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const marks = useMarks(!preview && tools ? handle : null, props.editable);
  return (
    <div className={preview ? "sig-preview-text" : "sig-settings-editor"}>
      {marks.strip && <ComposerMarks {...marks.strip} />}
      <Editor {...props} focusAtMount={false} onHandle={setHandle} />
      {marks.card}
    </div>
  );
}

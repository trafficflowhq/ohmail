import { useState } from "react";
import { ComposerEditor } from "@ohmail/ui/mail";
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
  const text = <Editor {...props} focusAtMount={false} onHandle={setHandle} />;
  if (preview)
    return (
      <div className="oh-composer-signature" data-formatted="">
        <div className="oh-composer-signed">{text}</div>
      </div>
    );
  return (
    <>
      <ComposerEditor
        signature
        marks={marks.strip}
        placeholder={props.value.text || props.value.html ? undefined : props.placeholder}
      >
        {text}
      </ComposerEditor>
      {marks.card}
    </>
  );
}

/**
 * THE RICH EDITOR'S ENTRY: the only entry of `write` that loads the editor's engine. A shell that mounts the
 * letter's body hands its link reading (`linkHref` and `useRenderedLinks` of `@ohmail/letter-body/links`); this
 * folder imports nothing of the body. Called once per shell, at module scope, so the editor keeps its identity.
 */
import { createElement } from "react";
import type { EditorProps, WriteEditor } from "../ports.js";
import { RichEditor, type EditorLinks } from "./RichEditor.js";

export type { EditorLinks };
export { RICH_MARKS } from "./RichEditor.js";

export function richEditor(links: EditorLinks): WriteEditor {
  return function Rich(props: EditorProps) {
    return createElement(RichEditor, { ...props, links });
  };
}

import { getExtensionField, resolveExtensions } from "@tiptap/react";
import type { EditorMarks, MarkId } from "../editor-controls.js";
import { CODE_KEYS, LINK_KEY } from "../format-help.js";
import { EXTENSIONS } from "./schema.js";

const extensionMark: Readonly<Record<string, MarkId>> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strike",
  code: "code",
  codeBlock: "codeBlock",
  bulletList: "bullets",
  orderedList: "numbers",
  blockquote: "quote",
};

/** Use the editor’s own bindings for its built-in formats, plus the letter’s own format keys. */
function formatChords(): NonNullable<EditorMarks["shortcuts"]> {
  const keys: Partial<Record<MarkId, string[]>> = {
    link: [LINK_KEY],
    code: [CODE_KEYS.code],
    codeBlock: [CODE_KEYS.codeBlock],
  };
  for (const extension of resolveExtensions(EXTENSIONS)) {
    const mark = extensionMark[extension.name];
    if (!mark) continue;
    const bindings = getExtensionField<() => Record<string, unknown>>(extension, "addKeyboardShortcuts", {
      name: extension.name,
      options: extension.options,
    });
    const chords = Object.keys(bindings?.() ?? {})
      .filter((key) => key.startsWith("Mod-"))
      .map((key) => key.toLowerCase().replaceAll("-", "+"));
    keys[mark] = [...new Set([...(keys[mark] ?? []), ...chords])];
  }
  return keys;
}

export const editorShortcuts = formatChords();

export function historyChords() {
  const history = resolveExtensions(EXTENSIONS).find(({ name }) => name === "undoRedo");
  if (!history) return [];
  // The history extension publishes callbacks that only call one editor command.
  let label = "";
  const bindings = getExtensionField<() => Record<string, () => boolean>>(history, "addKeyboardShortcuts", {
    name: history.name,
    editor: {
      commands: {
        undo: () => {
          label = "keys.undoTyping";
          return true;
        },
        redo: () => {
          label = "keys.redoTyping";
          return true;
        },
      },
    },
  });
  return Object.entries(bindings?.() ?? {}).flatMap(([key, run]) => {
    label = "";
    run();
    const parts = key.toLowerCase().split("-");
    const letter = parts.pop();
    return label && letter ? [[[...parts.sort(), letter].join("+"), label] as const] : [];
  });
}

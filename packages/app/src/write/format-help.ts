import type { Text } from "../text/index.js";
import type { EditorMarks, ParagraphStyle } from "./editor-controls.js";
import { teachWritingKey } from "./keys.js";

export const LINK_KEY = "mod+k";
export const CODE_KEYS = { code: "mod+shift+c", codeBlock: "mod+alt+shift+c" } as const;
export const PARAGRAPH_STYLES = [0, 1, 2, 3] as const;
export const paragraphKey = (style: ParagraphStyle): string => `mod+alt+${style}`;

// Help is available before an editor opens. The editor tests compare these defaults with the
// actual extension bindings so a library upgrade cannot silently change the keys people see.
export const formatHelpShortcuts: NonNullable<EditorMarks["shortcuts"]> = {
  link: [LINK_KEY],
  code: [CODE_KEYS.code, "mod+e"],
  codeBlock: [CODE_KEYS.codeBlock, "mod+alt+c"],
  bold: ["mod+b"],
  quote: ["mod+shift+b"],
  bullets: ["mod+shift+8"],
  italic: ["mod+i"],
  numbers: ["mod+shift+7"],
  strike: ["mod+shift+s"],
  underline: ["mod+u"],
};

export const historyHelpShortcuts = [
  ["mod+z", "keys.undoTyping"],
  ["mod+shift+z", "keys.redoTyping"],
  ["mod+y", "keys.redoTyping"],
  ["mod+я", "keys.undoTyping"],
  ["mod+shift+я", "keys.redoTyping"],
] as const;

const paragraphNames = ["paragraph", "heading1", "heading2", "heading3"] as const;

export function paragraphChoices(t: Text) {
  return PARAGRAPH_STYLES.map((style) => [style, t(`marks.${paragraphNames[style]}`)] as const);
}

export function editorHelp(t: Text, marks = formatHelpShortcuts) {
  return [
    ...Object.entries(marks).flatMap(([id, chords]) =>
      t.has(`marks.${id}`) ? chords.map((chord) => teachWritingKey(chord, t(`marks.${id}`))) : [],
    ),
    ...paragraphChoices(t).map(([style, label]) => teachWritingKey(paragraphKey(style), label)),
    ...historyHelpShortcuts.flatMap(([chord, label]) =>
      t.has(label) ? [teachWritingKey(chord, t(label))] : [],
    ),
  ];
}

/**
 * WHAT THE PRESS SEAM SAYS ITS SENTENCES WITH, where no shell's catalogue reader stands: one root reader over the
 * namespaces the seam asks (`ohbox.toastQueued`, `trash.restored`, …), and a folder said as a place.
 */
import { VIEW_OF_FOLDER, folderLeaf } from "@ohmail/client-engine";
import type { TranslationValue, Translator } from "../text/translator.js";

/** One namespace's sentences: a key inside it and its values in, the sentence out. */
export type NamespaceText = (key: string, values?: Record<string, TranslationValue>) => string;

/** The namespaces the seam's sentences are in. */
export const PRESS_NAMESPACES = ["ohbox", "screener", "trash", "screening", "session", "shortcuts"] as const;
export type PressNamespace = (typeof PRESS_NAMESPACES)[number];

/** A root reader: `ns.key` goes to that namespace's reader; a namespace not handed answers nothing. */
export function pressWords(texts: Readonly<Record<PressNamespace, NamespaceText>>): Translator {
  const by = texts as Readonly<Record<string, NamespaceText | undefined>>;
  return (key, values) => {
    const dot = key.indexOf(".");
    const text = dot > 0 ? by[key.slice(0, dot)] : undefined;
    return text ? text(key.slice(dot + 1), values) : "";
  };
}

/**
 * A folder as the person reads it: its place's word where the folder is a place's, else its last part, never a
 * namespaced path. `viewWord` answers "" for a place it has no word for.
 */
export function placeLabelOver(viewWord: (view: string) => string): (folder: string) => string {
  return (folder) => {
    const view = VIEW_OF_FOLDER[folder as keyof typeof VIEW_OF_FOLDER];
    return (view ? viewWord(view) : "") || folderLeaf(folder);
  };
}

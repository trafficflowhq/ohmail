/**
 * THE PLAIN EDITOR'S ENTRY: a phone whose keyboard the rich editor fails keeps a plain composer. Same views,
 * same composition; it reports text alone and offers no marks.
 */
import type { WriteEditor } from "../ports.js";
import { PlainEditor } from "./PlainEditor.js";

export const plainEditor: WriteEditor = PlainEditor;

import type { RichValue } from "@ohmail/app-logic/writing/rich-text";

/** Nothing is written yet, not even a line or an empty list: the composer draws its placeholder on the first line. */
export const unwritten = (v: RichValue): boolean => v.text === "" && v.html === "";

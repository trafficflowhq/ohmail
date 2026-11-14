/**
 * The reader's body entry: the only file of this package that loads the letter's renderer. A shell that draws
 * letters imports it and hands it to `readerEntry`; one that does not, never downloads the renderer.
 */
import type { ReaderBody } from "../ports.js";
import { LetterBody } from "./LetterBody.js";

export const letterBody: ReaderBody = LetterBody;

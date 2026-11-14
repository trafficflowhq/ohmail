/**
 * The reader's door: the reading column a shell hands the frame, and what it takes. The letter's body is a second
 * entry (`@ohmail/app/reader/body`): this one never loads the renderer.
 */
export { readerEntry } from "./entry.js";
export type {
  LetterControl,
  LetterNotice,
  LetterProps,
  ReaderBody,
  ReaderFile,
  ReaderFileList,
  ReaderFiles,
  ReaderParts,
  ReaderReply,
} from "./ports.js";
export type { PictureSeam } from "@ohmail/app-logic/reader";

/**
 * The reader's door: the reading column a shell hands the frame, and what it takes. The letter's body is a second
 * entry (`@ohmail/app/reader/body`): this one never loads the renderer.
 */
export { PdfLookContext, type PdfLook, type PdfPage } from "./look/FilePreview.js";
export { readerEntry, readerEntryFrom } from "./entry.js";
/** The reading column's scrolling box under a root that holds the column: what a list's walk keeps in view. */
export { scrollerOf as readingScrollerIn } from "./read-dom.js";
export type {
  LetterControl,
  LetterNotice,
  LetterProps,
  ReaderBody,
  ReaderFile,
  ReaderFileList,
  ReaderFiles,
  ReaderInvitationProps,
  ReaderParts,
  ReaderReply,
} from "./ports.js";
export type { PictureSeam } from "@ohmail/app-logic/reader";
export { ContactDetails, useOpenCard, type ContactScreeningProps } from "./contact/Contact.js";

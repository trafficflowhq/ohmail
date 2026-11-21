/**
 * The door of `write`: the letter being written and the reply, for a shell to register. The editors are entries of
 * their own (`@ohmail/app/write/editor`, `@ohmail/app/write/plain`): this one never loads the rich editor.
 */
export { SupportDiagnostics } from "./text/LetterText.js";
export { writeEntry } from "./entry.js";
export { writePlace } from "./place.js";
export { WriteAbove, useWriteBeside, useWriting } from "./above.js";
export type {
  EditorHandle,
  EditorMarks,
  EditorProps,
  LetterWords,
  MarkId,
  ReaderReply,
  RecipientMoveInput,
  RecipientMoveOutput,
  RecipientRow,
  WriteBeside,
  WriteDiscardRefusal,
  WriteDraftChrome,
  WriteDraftControl,
  WriteEditor,
  WriteEntry,
  WriteEnvelope,
  WriteForwardFiles,
  WriteFrom,
  WriteParts,
  WritePerson,
  WriteReply,
  Writing,
} from "./ports.js";

/**
 * WHAT A SHELL HANDS THE READER, declared by what the reader calls of it and nothing more. The shell holds one
 * instance of each and hands the same object every mount: the letter's body (the only part that loads the renderer),
 * the files of its letters, and its pictures. `none` is a real answer: no tiles, no pictures, never a guess.
 */
import type { PdfLook } from "./look/FilePreview.js";
import type { EngineMessage } from "@ohmail/wire";
import type { ComponentType } from "react";
import type { SendPhase } from "@ohmail/app-logic/writing/mail-send";
import type { PanelVerb } from "@ohmail/ui/mail";
import type { EmbeddedPictureSeam, LetterPictureInputs, PictureSeam } from "@ohmail/app-logic/reader";

/** What a control of the body is, as the body hands it out to stand in the head. */
export interface LetterControl {
  readonly id: "pictures" | "adapt" | "design" | "history";
  readonly label: string;
  readonly title?: string;
  readonly pressed?: boolean;
  readonly expanded?: boolean;
  readonly controls?: string;
  readonly at?: "leading" | "trailing";
  readonly onPress: () => void;
}

/** What the body says it kept out of a letter: its two-word caption and its whole sentence. */
export interface LetterNotice {
  readonly caption: string;
  readonly text: string;
}

/** One letter's body as the reader mounts it. `html` and `text` are the engine's, never built or edited here. */
export interface LetterProps extends LetterPictureInputs {
  /** A closed card needs only the notice from its cached HTML. */
  readonly noticeOnly?: true;
  readonly messageId: string;
  readonly text: string;
  readonly html: string | null;
  readonly subject: string;
  /** The app's scheme: an adaptable letter is drawn to it. */
  readonly scheme: "light" | "dark";
  /** Whose stored choices these are (a letter kept original): the session's scope. */
  readonly owner: string | null;
  readonly onNotice: (notice: LetterNotice | null) => void;
  readonly onControls: (controls: readonly LetterControl[]) => void;
}

export type ReaderBody = ComponentType<LetterProps>;

/** The current letter's invitation facts. A snippet is never read as a full invitation. */
export interface ReaderInvitationProps {
  readonly messageId: string;
  readonly message?: EngineMessage;
  readonly invitationWithoutEvent: boolean;
  readonly text: string;
  readonly full: boolean;
}

/** A file of a letter as the shell's file door lists it. */
export interface ReaderFile {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly state: "idle" | "loading" | "ready" | "failed" | "too_large";
  readonly inline: boolean;
  readonly calendarBody?: boolean;
  readonly objectUrl?: string;
  readonly previewTooLarge?: boolean;
  readonly saving?: boolean;
  readonly code?: string | null;
  readonly status?: number | null;
  readonly retryable?: boolean;
  readonly reasking?: boolean;
}

export type ReaderFileList =
  | { readonly state: "unavailable" }
  | { readonly state: "loading"; readonly retrying?: boolean }
  | { readonly state: "ready"; readonly items: readonly ReaderFile[] }
  | {
      readonly state: "failed";
      readonly code: string | null;
      readonly retryable: boolean;
      readonly onRetry: () => void;
    };

/** The shell's one file door (structurally the web shell's `AttachmentsChrome`), and its pictures' half. */
export interface ReaderFiles extends EmbeddedPictureSeam {
  /**
   * Hold one letter's list while it is drawn: the door asks for a list somebody holds, and nothing else. The return
   * releases the hold.
   */
  hold(messageId: string): () => void;
  itemsOf(messageId: string, opts?: { includeInlineParts?: boolean }): ReaderFileList;
  /** Fetch if needed, and save. */
  open(messageId: string, attachmentId: string): void;
  /** Fetch and hold, no save; `retry` only on a person's press. */
  ensure(messageId: string, attachmentId: string, opts?: { retry?: boolean }): void;
  blobOf?(messageId: string, attachmentId: string): Blob | undefined;
  releasePreviews?(messageId: string): void;
  downloadAll(messageId: string, opts?: { includeInlineParts?: boolean; omit?: string }): void;
  downloadingAll(messageId: string): boolean;
}

/**
 * The reply a shell's `write` hands the reader: the sheet drawn after the conversation's last letter, and the open
 * that Reply, Reply all and Forward reach before anything else.
 */
export interface ReaderReply {
  /**
   * `keysHere`: the reading column has the keys, so the reply binds its own while it stands, as the letter does
   * (absent: it binds none, and its text's own keys still send and leave).
   */
  readonly Sheet: ComponentType<{ readonly letters: readonly string[]; readonly keysHere?: boolean }>;
  /** `from`: the press came from a letter's own menu: "answer THIS letter", which opens and never closes an editor. */
  readonly useOpen: () => (messageId: string, how: "reply" | "reply_all" | "forward", from?: "menu") => void;
  /** The letter the open reply answers, including while the person reads on to another letter. */
  readonly useTarget?: () => string | null;
  /** Read the send still finishing after its inline editor has closed. */
  readonly useSendPhase?: () => (lane: string) => SendPhase;
  /** The open reply's verbs, which the reading sheet's one panel shows in place of the letter's; null: none open. */
  readonly useVerbs: () => readonly PanelVerb[] | null;
  /**
   * DRAFT REPLY on a letter: the reply opened on it and the drafter asked, where the shell's composition has a
   * drafter (the host hands a draft wire). Null, or absent: no drafter stands, and the letter's More offers none.
   */
  readonly useDraft?: () => ((messageId: string) => void) | null;
}

export interface ReaderParts {
  readonly body: ReaderBody;
  readonly files: ReaderFiles | "none";
  readonly pictures: PictureSeam | "none";
  /** The shell's one look at a file's bytes; `none`: a press saves. */
  readonly look: ((messageId: string, attachmentId: string) => void) | { readonly usePdf: PdfLook } | "none";
  /**
   * What the shell says of the copy in Sent of a letter the account sent, where that copy is missing or still owed:
   * its sentence in `write`'s words, drawn as a note under the letter's recipients; null where there is nothing to
   * say. Read while the letter is drawn: a shell whose notes change hands a new one. `none`: nothing is said.
   */
  readonly sentCopy: ((messageId: string) => string | null) | "none";
  /** The reply's sheet and open (`write`'s); `none`: the reader hands a linked draft to the place `write`. */
  readonly reply: ReaderReply | "none";
  /**
   * What the shell says of a letter's invitation, drawn after the letter's text: the note where its
   * event cannot be shown, and the event once. `none`: nothing stands there.
   */
  readonly invitation: ComponentType<ReaderInvitationProps> | "none";
  readonly invitationFile?: (message: EngineMessage) => string | undefined;
  /**
   * The shell's clipboard, written inside the person's own press (a person's address, copied from their card): `true`
   * only once the clipboard took it. `none`, or left out: the shell has none, and a copy is not offered.
   */
  readonly copy?: ((text: string) => Promise<boolean>) | "none";
}

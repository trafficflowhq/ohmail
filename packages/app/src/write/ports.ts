/**
 * WHAT A SHELL HANDS `write`, declared by what the screen calls of it and nothing more.
 *
 * The letter being written lives in ONE composition (the shell's): its words, its people, its files, its send. The
 * screen reads that composition as `Writing` and presses its doors; it never holds the letter in its own state and
 * never sends by itself. `WriteBeside` is the shell's pure helpers beside it (the screen takes types alone of the
 * client engine). `none` is a real answer everywhere: a control for a wire that is `none` is not drawn.
 */
import type { ComposeAttachment, EngineDraft, EngineMessage } from "@ohmail/wire";
import type { ComponentType } from "react";
import type { FromOption, SignatureState } from "@ohmail/client-engine";
import type { ComposeFields, ComposePlan } from "@ohmail/app-logic/writing/compose";
import type { SupportSeed } from "@ohmail/app-logic/writing/composer-types";
import type { SendState, ShowSend } from "@ohmail/app-logic/writing/mail-send";
import type { ComposeElsewhere } from "@ohmail/app-logic/writing/compose-autosave";
import type { RichValue } from "@ohmail/app-logic/writing/rich-text";
import type { Pictures, SendSurface } from "@ohmail/app-logic/write/files";
import type { ComposedTime, ScheduleFiles } from "@ohmail/app-logic/write/later";
import type { PaneProps } from "../frame/contract.js";
import type { None } from "../host/contract.js";
import type { HostDevice } from "../host/device.js";
import type { QuotedHistoryControl } from "./text/history-ports.js";
import type { ReaderReply } from "../reader/ports.js";
import type { EditorMarks } from "./editor-controls.js";

export type { EditorLink, EditorMarks, MarkId, ParagraphStyle } from "./editor-controls.js";

export type { ReaderReply };

/* ---------------------------------------------------------------- the editor */

/** What an editor hands the screen once it stands: its marks, and the two moves the screen makes in the text. */
export interface EditorHandle {
  /** `none`: a plain editor; no strip and no "Aa" is drawn. */
  readonly marks: EditorMarks | "none";
  insert(text: RichValue, how: "replace" | "atCaret"): void;
  /**
   * The keys to the text. It never scrolls what the editor stands in (the reading column counts a scroll under a
   * resting pointer as the person's reading), and every call says so.
   */
  focus(how: { readonly preventScroll: true }): void;
}

export interface EditorProps {
  readonly value: RichValue;
  readonly onChange: (next: RichValue) => void;
  readonly label: string;
  readonly quotedHistory?: QuotedHistoryControl;
  readonly placeholder: string;
  /** False while a send is in flight: the words stay, input is refused. */
  readonly editable: boolean;
  readonly focusAtMount: boolean;
  /** Mod+Enter inside the text. Mod+Shift+Enter is left to the app's binding (Send + Done). */
  readonly onSendKey?: () => void;
  /** Escape the editor did not take, where the containing place handles it. */
  readonly onLeaveKey?: () => void;
  readonly onHandle: (handle: EditorHandle | null) => void;
}

export type WriteEditor = ComponentType<EditorProps>;

/** What a shell hands `writeEntry`: the editor (the rich one, or the phone's plain one). */
export interface WriteParts {
  readonly editor: WriteEditor;
}

/** The screen a shell registers: the new letter for the place `write`, and the reply for the reader's slot. */
export interface WriteEntry {
  readonly Letter: ComponentType<PaneProps>;
  readonly reply: ReaderReply;
}

/** Who a letter goes from, as the composition resolved it (the From line, the wire and the ceiling agree). */
export interface WriteFrom {
  readonly mailboxId: string | null;
  readonly address: string | null;
  readonly choices: readonly FromOption[];
  readonly substituted: boolean;
  readonly substitutedFrom: string | null;
  readonly maxMessageBytes: number | null;
  readonly domainMatched: boolean;
}

/** A reply's people as the person edited them; `null` in `Writing.replyEnvelope`: the computed audience. */
export interface WriteEnvelope {
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
}

/** One sentence key of a forward's files (the shell's `forwardFiles` words), with the byte counts it names. */
export interface ForwardLineKey {
  readonly key: string;
  readonly bytes?: Readonly<Record<string, number>>;
}

/** The files that came with a forward, as the composition plans them. */
export interface WriteForwardFiles {
  readonly plan: {
    readonly rows: readonly {
      readonly id: string;
      readonly filename: string;
      readonly sizeBytes: number;
      /** Drawn inside the original's text (a picture in its body). */
      readonly inline: boolean;
      readonly removable: boolean;
    }[];
    readonly line: ForwardLineKey | null;
    readonly refusal: ForwardLineKey | null;
  };
  readonly onRemove: (id: string) => void;
  readonly said: boolean;
}

/** A person a reply goes to, as the letter it answers names them. */
export interface WritePerson {
  readonly name: string | null;
  readonly address: string;
}

/**
 * THE REPLY BEING WRITTEN, as the composition plans it for the letter it answers: who it goes to while the people
 * are folded, the lines they open with, its subject, who it goes from, its send, and why Send rests. Planned by
 * the shell's own helpers, the ones its send builds the letter with: the view derives none of it.
 */
export interface WriteReply {
  readonly messageId: string;
  readonly mode: "reply" | "forward";
  /** Who it goes to while the people are folded; `forward`: nobody yet, the person names them. */
  readonly audience: { readonly to: readonly WritePerson[]; readonly cc: readonly WritePerson[] } | "forward";
  /** The three lines as they open when the person changes the people: what the fold named. */
  readonly seed: WriteEnvelope;
  /** What does not parse in the person's lines, by line, as the send's plan reads them. */
  readonly invalid: {
    readonly to: readonly string[];
    readonly cc: readonly string[];
    readonly bcc: readonly string[];
  };
  /** The subject it goes with; a forward's is the original's and is not written over. */
  readonly subject: { readonly value: string; readonly editable: boolean };
  readonly from: WriteFrom;
  readonly send: SendState;
  readonly saveRefused?: boolean;
  /** Why Send rests, as the send's own gate reads the reply as it would go now; null: it may go. */
  readonly refusal: "locked" | "too_long" | "needs_content" | "incomplete" | null;
  /** The row of this reply's send nobody confirmed (a reply only): its two answers are offered. */
  readonly held: string | null;
}

/** What a new letter's draft is made of: the person's words, the address it goes from and its subject. */
export interface LetterWords {
  readonly text: string;
  readonly mailboxId: string | null;
  readonly subject: string;
}

/** The one-press draft (today's `DraftReplyControl`). */
export interface WriteDraftControl {
  readonly preview?: string;
  /** The host has a draft wire; false: no draft control is drawn. */
  readonly offered: boolean;
  readonly phase: "closed" | "offered" | "running";
  readonly messageId: string | null;
  /** What one press costs, in credits: said before the press. */
  readonly cost: number;
  /** One sentence about the current state, already worded, or null. */
  readonly notice: string | null;
  readonly open: (messageId: string) => void;
  readonly cancel: () => void;
  readonly confirm: () => void;
  /** The offer and the purchase in one press (its cost is said on the control before it); `own`: the reply's words. */
  readonly press: (messageId: string, own: RichValue, fullConversation?: boolean) => void;
  /** A draft made of the person's own words, in one press as `press`. `none`: the host has no door for it; not offered. */
  readonly fromText:
    ((messageId: string, text: string, own: RichValue, fullConversation?: boolean) => void) | None;
  /** A new letter drafted from the person's words, as `fromText`; `none` exactly with it. */
  readonly letter: ((words: LetterWords, own: RichValue) => void) | None;
  /** The new letter's place among the drafts' letters: `messageId` while its draft is out, and its entry of `own`. */
  readonly letterId: string;
  /** The person's own text in each reply a draft landed over, by the letter's id: kept by the composition, not past a
   * reload; a draft on another letter never touches it. */
  readonly own: ReadonlyMap<string, WriteOwnText>;
  /** The two texts as they stand now, kept for their letter when the person changes tabs. */
  readonly keep: (own: WriteOwnText) => void;
}

/** The person's own text beside the draft that landed over it, and which of the two the reply shows. */
export interface WriteOwnText {
  readonly messageId: string;
  readonly yours: RichValue;
  readonly draft: RichValue;
  readonly shown: "yours" | "draft";
}

/** The one-press draft, and a draft that landed over typed words waiting to be placed (today's chrome). */
export interface WriteDraftChrome {
  readonly control: WriteDraftControl;
  readonly pending: { readonly draft: RichValue; readonly messageId: string } | null;
  /** `replace` drops what was typed; `append` puts the draft under it. */
  readonly resolve: (mode: "replace" | "append") => void;
  /** The account's last refusal was an empty balance: no price is said. */
  readonly noCredits?: boolean;
}

/** The refusal a discard came back with (today's `DiscardRefusal`). */
export interface WriteDiscardRefusal {
  readonly draftId: string;
  readonly why: "still-sending" | "unknown-jar" | "cancel-unknown";
  readonly at: number;
}

/**
 * THE COMPOSITION, AS THE SCREEN READS IT: a structural subset of the shell's composer record (`useShellCompose`),
 * member for member with the same names, plus the members the shell's adapter derives as today's shell does.
 */
export interface Writing {
  /* The letter. */
  readonly compose: ComposeFields;
  /** The live binding changes when another letter takes the same composer. */
  readonly composeEpochNow?: () => number;
  readonly onComposeFields: (next: ComposeFields) => void;
  readonly offeredDraft?: EngineDraft;
  readonly takeOfferedDraft?: (id: string) => Promise<void>;
  readonly plan: ComposePlan;
  readonly composeFrom: WriteFrom;
  /** The letter's row moved on another device (sent, deleted or changed there), or null. */
  readonly composeElsewhere: ComposeElsewhere | null;
  /** The account refused to keep the draft. */
  readonly composeSaveRefused: boolean;
  /** The letter came back from the last session. */
  readonly composeResumed: boolean;
  readonly restoreClosedCompose?: () => void;
  readonly composeWaitNote: string | null;
  readonly composeCloseRefusal: string | null;
  readonly composeHistoryTarget?: { readonly messageId: string; readonly forward: boolean } | null;
  readonly loadQuotedHistory?: (messageId: string, forward: boolean) => Promise<readonly string[]>;
  readonly composeForwardFiles: WriteForwardFiles | null;
  /** Send now, or at `sendAt` (an ISO instant). The composition's gate decides; a press is never "sent". */
  readonly sendCompose: (sendAt?: string) => void;
  readonly closeCompose: () => void;
  readonly discardKeepsCompose: () => "held" | "unknown" | null;

  /* The reply. */
  readonly replyTo: string | null;
  readonly replyMode: "reply" | "forward";
  readonly replyAll: boolean;
  readonly replyBody: RichValue;
  readonly onReplyBody: (next: RichValue) => void;
  readonly replyEnvelope: WriteEnvelope | null;
  readonly setReplyEnvelope: (next: WriteEnvelope | null) => void;
  readonly replyFromId: string | null;
  readonly setReplyFromId: (id: string | null) => void;
  readonly replySig: SignatureState;
  readonly onReplySig: (next: SignatureState) => void;
  readonly replySubjectEdit: string | null;
  readonly onReplySubject: (subject: string) => void;
  readonly replyAttachments: readonly ComposeAttachment[];
  readonly setReplyAttachments: (next: ComposeAttachment[]) => void;
  readonly replyForwardFiles: WriteForwardFiles | null;
  readonly replyBook: readonly { readonly name: string | null; readonly address: string }[];
  readonly replySendState: (lane: string) => SendState;
  /**
   * A letter that shows its send registers the send's lane while it stands (the send machine's `showing`): the one
   * machine then says the send's ending on that letter's line, and in the frame's report only where no letter shows it.
   */
  readonly showSend: ShowSend;
  readonly heldReplyRow: (messageId: string) => string | null;
  readonly sendReply: (messageId: string) => void;
  /**
   * SEND + DONE for the reply to a letter: the same send, and the letter filed once the send is confirmed. Asked at
   * every render, of the letters as the Ohbox shows them; `null`: it is not offered there (nothing to finish), and
   * neither its verb nor its key acts.
   */
  readonly sendReplyAndDone: (messageId: string) => (() => void) | null;
  readonly openReply: (messageId: string, all?: boolean) => void;
  readonly openForward: (messageId: string, seed?: EngineMessage) => void;
  readonly confirmForward: () => void;
  readonly forwardAsk: string | null;
  readonly closeReply: () => void;

  /* Shared. */
  readonly discardRefusal: WriteDiscardRefusal | null;
  readonly resolveHeldSend: (draftId: string, outcome: "arrived" | "not_arrived") => void;
  readonly draftReply: WriteDraftControl;
  readonly draftReplyChrome: WriteDraftChrome;
  readonly openDraft: (draft: EngineDraft, files?: ComposeAttachment[]) => void;
  readonly writeTo: (address: string, name?: string) => void;
  readonly writeSupport?: (seed: SupportSeed) => void;

  /* Derived by the shell's adapter, as today's shell derives them for its views. */
  /** The reply open on a letter, planned; null: none is open, or its letter is not known here. */
  readonly reply: WriteReply | null;
  readonly composeSend: SendState;
  /** The composer is back on the same message after its send moved to the sidebar. */
  readonly composeReopenedSending: boolean;
  /** Send is locked by a send this letter cannot see the end of: the sentence that says so. */
  readonly composeLocked: { readonly sentence: string } | null;
  /** The letter's row, while its send is not confirmed: the two answers resolve it. */
  readonly composeHeld: { readonly draftId: string } | null;
  /** Files the last session could not keep across the restart; null: none lost. */
  readonly composeFilesNotKept: number | null;
  /** The account's signatures by mailbox; `unknown` until the consent row is read. */
  readonly signatures:
    | {
        readonly text: Readonly<Record<string, string>>;
        readonly html: Readonly<Record<string, string>>;
      }
    | "unknown";

  /* The two doors that discard with Undo. */
  readonly discardCompose: () => void;
  readonly discardReply: () => void;
  /* Taking the signature off this letter, or off this reply: each with its Undo. */
  readonly removeComposeSig: () => void;
  readonly removeReplySig: () => void;
}

export type RecipientRow = "to" | "cc" | "bcc";
export interface RecipientMoveInput {
  readonly rows: { readonly to: string; readonly cc: string; readonly bcc: string };
  readonly move: {
    readonly entry: string;
    readonly from: RecipientRow;
    readonly to: RecipientRow;
    readonly before: number | null;
  };
}
export type RecipientMoveOutput = { readonly to: string; readonly cc: string; readonly bcc: string } | null;

export interface WriteBeside {
  /** The session's storage scope: whose letter this is. Required; never defaulted. */
  readonly scope: string;
  readonly online: () => boolean;
  /** The send line's sentence key for a send state, or null for none (today's `sendLine`). */
  readonly sendLine: (
    send: SendState,
    long: boolean,
  ) => { readonly tone: "pending" | "warn" | "error"; readonly key: string } | null;
  /** The values the send line's sentences name (today's `sendLineValues`): the ceiling as the too-long line says it. */
  readonly sendLineValues: () => { readonly size: string };
  readonly lines: {
    split(value: string): { chips: string[]; tail: string };
    join(chips: readonly string[], tail: string): string;
    move(move: RecipientMoveInput): RecipientMoveOutput;
    refused(raw: string, focused: boolean, invalid: string[]): string[];
  };
  readonly suggest: (
    typed: string,
    taken: readonly string[],
  ) => readonly { readonly name: string; readonly address: string; readonly they: boolean }[];
  readonly later: {
    options(now: number): readonly { readonly id: string; readonly at: string }[];
    /** The earliest instant a time may be picked at (now and a few minutes). */
    floor(now: number): number;
    label(at: string): string;
    /** The first whole minute at the floor, as a local "YYYY-MM-DDTHH:MM" that books past the floor. */
    seed(now: number): string;
    /** A typed local "YYYY-MM-DDTHH:MM" in the person's zone; null: not a clock. */
    compose(value: string, notBefore: number): ComposedTime | null;
    /** The person's zone, as it is named to them. */
    zone(): string;
    /** Whether a scheduled letter's files are kept, asked once `asking` is true; null: no answer. */
    useFiles(asking: boolean): ScheduleFiles | null;
  };
  readonly size: (bytes: number) => string;
  /**
   * The signature a letter carries under its text, as its send will seal it: the text, and the markup when the
   * mailbox's signature has formatting. Null: none (removed, written down to nothing, or none stored).
   */
  readonly signature: (
    state: SignatureState,
    mailboxId: string | null,
    stored: {
      readonly text: Readonly<Record<string, string>>;
      readonly html: Readonly<Record<string, string>>;
    },
  ) => { readonly text: string; readonly html: string | null } | null;
  /** How pictures are sent; `none`: as picked, and no quality control is drawn. */
  readonly pictures: Pictures;
  /** The desktop's own held-file pick, where its window supplies one. */
  readonly pickFile?: HostDevice["pickFile"];
  /** What this window can carry in one send, beside the sending mailbox's own ceiling. */
  readonly surface: SendSurface;
  /** The server meters drafting in credits: a draft's price is said before its press. False: none is charged. */
  readonly metered: boolean;
}

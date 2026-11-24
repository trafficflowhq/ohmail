import type { ThreadPanel } from "@ohmail/client-engine";

export interface StreamItemBox {
  /** The measured sender and preview text, in the same content coordinates as the card. */
  readonly lines?: Pick<ThreadPanel, "first" | "lead" | "end">;
  readonly id: string;
  /** From the top of the stream's content, in CSS px. */
  readonly top: number;
  readonly height: number;
  readonly unread: boolean;
  /** Its body is in: an item drawn as a placeholder is never read live. */
  readonly ready: boolean;
}
export interface StreamLook {
  readonly scrollTop: number;
  /** The part of the scroller where text can be read. */
  readonly viewHeight: number;
  /** The whole scrollport, for judging overflow and how far it moved. */
  readonly physicalHeight?: number;
  readonly scrollHeight: number;
  /** The mounted items, measured. */
  readonly items: readonly StreamItemBox[];
  /** The clock of the look, in ms (the caller's). */
  readonly at: number;
}
export type JudgedReadPhase = "moving" | "landing" | "settled";
export type StreamHand = "wheel" | "touch" | "key";

export interface StreamReadRule {
  /** A press in the stream or on a row, an arrow, `j` or `k`: the stream is driven, and the scroll that follows is not the hand's. */
  enter(at: number, letter?: string, viewport?: boolean): void;
  /** Withdrawing a Search result ends its read dwell, including when history later previews the same letter. */
  selectionChanged(openId: string | null): void;
  /** A passive address ends the permission to read and move the line from the previous screen. */
  preview(): void;
  /** The letter still eligible for a dwell started by choosing it. */
  holdsEntered(id: string): boolean;
  /** A scroll key that jumps to an end (End, Home, Ctrl or Cmd with an arrow): driven by a hand; its scroll is a flight. */
  scrollKey(at: number): void;
  /** The app moved the stream (a landing, the hold): the scroll that follows is not the hand's, and nothing is driven. */
  appMoved(at: number): void;
  /** A wheel step, a finger moving on the stream (`touching` while it is down), or Space, Page Up, Page Down. */
  hand(kind: StreamHand, at: number, touching?: boolean): void;
  /** A finger came down on the stream: driven, and what it scrolls is the hand's; no hand for the leave until it moves. */
  touchDown(at: number): void;
  /** The finger lifted: its momentum is the hand's a while; a tap that never moved is no hand for the leave. */
  touchUp(at: number): void;
  /** A scroll was seen: what it carried through, read now. `flight`: a jump of many screens. */
  look(l: StreamLook, attended: boolean, flight: boolean, receiptAttended?: boolean): readonly string[];
  /** A hand on a stream that fits whole: what stands in it, read now (nothing where the stream overflows). */
  still(l: StreamLook, by: StreamHand): readonly string[];
  /** Read cards shown through the top band, from a stable viewport. */
  band(l: StreamLook): readonly string[];
  /** The application finished a landing: record the displayed screen. */
  settled(l: StreamLook): void;
  /** Fired STREAM_REST_MS after the last scroll: the item the stream rests on, read now. */
  rest(l: StreamLook, restingId: string | null, openId?: string | null): readonly string[];
  /** Observe pending previews, or clear their dwell when attention leaves. */
  previewDwell(look: StreamLook | null, judged?: JudgedReadPhase | null): readonly string[];
  readonly previewDue: number | null;
  keepUnread(id: string): void;
  keptUnread(id: string): boolean;
  shown(id: string): boolean;
  /** This visit read it, live or by the rule while its body was not in, and it was not marked unread since: the leave flips it. */
  read(id: string): boolean;
  readonly driven: boolean;
  /** A wheel, a moving finger or a scroll key moved the stream this visit: what the leave answers to. */
  readonly handDrove: boolean;
}

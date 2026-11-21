"use client";

import type { EngineMessage, MessageBody, WaterlineMeta } from "@ohmail/wire";
import { type RefObject } from "react";
import { type EntityReader } from "@ohmail/client-engine";
import { type StreamLeaveCommit } from "./leave.js";
import { type StreamReadDom } from "./stream-read-dom.js";
import { type StreamScroll } from "./stream-scroll.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import type { ListVerbs } from "../press/list-verbs.js";

export type StreamPlace = "news" | "receipts";

/** What a host hands a stream place, under today's names (`ReadsView`'s and `ReceiptsView`'s props). */
export interface StreamInput {
  readonly place: StreamPlace;
  /** `MailState.settled` and `.owed`: nothing about the pile is stated before both allow it. */
  readonly settled: boolean;
  readonly owed: boolean;
  /** The engine's partition of the pile: above the line, at and below it, the line, the head's count. */
  readonly partition: {
    readonly fresh: readonly EngineMessage[];
    readonly seen: readonly EngineMessage[];
    readonly waterline: WaterlineMeta | null;
    readonly newCount: number;
  };
  /** The live write of the read rule: these ids read now (the shell batches them). */
  readonly markSeen: (ids: readonly string[]) => void;
  /** The leave's one anchored commit (`feed_mark_seen`). */
  readonly onLeaveSeen: (commit: StreamLeaveCommit) => void;
  /** Mark unread, through the press seam. */
  readonly markUnread: (id: string) => void;
  /** Mark all read: the unread ids, and the line to the top. */
  readonly markAllRead: (ids: readonly string[]) => void;
  /** An item's words while the reader's own letter is not handed: plain text, null while its body is not in. */
  readonly textOf: (id: string) => string | null;
  /** Current body availability, even when the folded preview keeps its earlier text. */
  readonly bodyReady?: (id: string) => boolean;
  readonly bodyStateOf?: (id: string) => MessageBody["state"] | undefined;
  /** Ask for the bodies of these items. */
  readonly hydrate: (ids: readonly string[]) => void;
  /** A lookahead request fills the cache without updating the folded preview. */
  readonly prefetch?: (ids: readonly string[]) => void;
  /** Recheck pending preview requests when the presented mirror changes. */
  readonly hasPreviewMarkup?: (id: string) => boolean;
  readonly prefetchSource?: EntityReader;
  readonly revealPrefetch?: (id: string) => void;
  /**
   * The tab going away is a leave too: the shell's page-hide, as a subscription (the web's and the desktop's
   * `pagehide`). Only a shell touches the window.
   */
  readonly onPageHide: (leave: () => void) => () => void;
  /** The item open (the route's), and the way to open one. */
  readonly openId: string | null;
  readonly open: (id: string | null) => void;
  /** The narrow stream keeps a keyboard step in the list pane. */
  readonly inlineKeys?: boolean;
  /** A Search hit the person chose, while its address stands. */
  readonly entered?: PlaceLiveArgs["entered"];
  /** A row's stamp in the list's own form (the shell's `displayTime`: the clock today, yesterday, the weekday, the date). */
  readonly stamp: (iso: string) => string;
}

export interface StreamModel {
  readonly verbs?: ListVerbs;
  /** The chosen hit whose card opens after its landing. A direct address previews the card. */
  readonly entered?: PlaceLiveArgs["entered"];
  readonly place: StreamPlace;
  /** Nothing about the pile is said while the mailbox is not settled or a sync is owed. */
  readonly mayState: boolean;
  readonly items: readonly EngineMessage[];
  /** Items above the line; the line stands after them where a visit committed one. */
  readonly freshCount: number;
  readonly lineShown: boolean;
  /** When the line was drawn (the last visit's leave), as the pile says it; null where it says none. */
  readonly lineAt: string | null;
  readonly newCount: number;
  readonly openId: string | null;
  /** The visible toolbar's letter, including a toolbar restored without selection. */
  readonly toolbar: RefObject<string | null>;
  /** The row where an unaddressed visit began. This does not open, scroll, or read. */
  readonly standingId: string | null;
  /** A letter was addressed, or the reader has returned to a stream that had a cursor. */
  readonly actionVisit: boolean;
  /** The shared panel's target. An explicit address stands while the scroll selection moves. */
  readonly actionId: string | null;
  /** Whether the immediate Delete shortcut can act on this selection at the keypress. */
  canDeleteKey(id: string): boolean;
  /** Whether an answer shortcut can act on the addressed card at the keypress. */
  canAnswerKey(id: string): boolean;
  /** The explicit address to land on. Reading farther by hand changes selection without making a history entry. */
  readonly addressedId: string | null;
  /** Did the mounted stream itself ask for this address? */
  openedLocally(id: string): boolean;
  /** A row's stamp in the list's own form, as the seat hands it. */
  readonly stamp: (iso: string) => string;
  /** The stream's scroller once mounted, and the ref that mounts it (the reading sheet's `scroller`). */
  readonly scroller: HTMLDivElement | null;
  readonly attach: (el: HTMLDivElement | null) => void;
  readonly read: StreamReadDom;
  /** The stream's own scroll: the landing, the anchor hold, the cursor and the leave's range. */
  readonly scroll: StreamScroll;
  /** The item under the reading line, as the scroll last found it (a step's origin). */
  readonly current: string | null;
  /** A press on a row: the item opens and the stream is driven. */
  open(id: string, byKeyboard?: boolean, viewport?: boolean): void;
  /** A keyboard step keeps a narrow stream in place and opens the address beside a wide stream. */
  stepTo(id: string): void;
  /** Leave the narrow stream's local selection. */
  closeInline(): void;
  readonly keyboardOpened: { readonly id: string } | null;
  markUnread(id: string): void;
  markAllRead(): void;
  hydrateOpened(id: string, ask?: boolean): void;
  readonly prefetch?: StreamInput["prefetch"];
  hasPreviewMarkup(id: string): boolean;
  textOf(id: string): string | null;
  bodyStateOf(id: string): MessageBody["state"] | undefined;
}

/**
 * WHAT A NOTICE SAYS in the frame's one slot (re-exported by `contract.ts`): its kind, its sentence, at most one line
 * and its answers, and where a notice has more to show than one line holds, its more: the rows a press on its last
 * answer opens over the app, in the kit's dialog, with the notice's sentence and line above them.
 */
import type { NoticeAct } from "@ohmail/ui/base";
import type { NoticeKind } from "./contract.js";

/** What a notice shows behind its last answer: that answer's word, and the rows, each a sentence whole. */
export interface NoticeMore {
  readonly label: string;
  /** A sentence shown only after opening these details. */
  readonly line?: string;
  readonly rows: readonly string[];
  /** A choice available once the full list is visible. */
  readonly confirm?: NoticeAct;
}

interface NoticeSaid {
  readonly kind: NoticeKind;
  /** Where one kind stands more than once (one per mailbox): what tells them apart. */
  readonly id?: string;
  /** Attempts in a failed-send notice. A newly failed attempt brings its details back into view. */
  readonly failedSendIds?: readonly string[];
  readonly title: string;
  readonly hot?: boolean;
  readonly line?: string;
}

/** A notice answers twice at most: where it hands `more`, that is its second answer, after the one act it hands. */
export type FrameNotice = NoticeSaid &
  (
    | { readonly acts?: readonly [NoticeAct] | readonly [NoticeAct, NoticeAct]; readonly more?: undefined }
    | { readonly acts?: readonly [NoticeAct]; readonly more: NoticeMore }
  );

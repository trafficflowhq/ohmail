/**
 * THE ONE NOTICE SLOT'S STORE. Every feed posts what is true for it now, under its own name, and a later post
 * of the same feed replaces its earlier one; the slot reads one list, ordered by `NOTICE_RANK` (the kit's
 * `slotOrder`). A feed that posts the same notices again with fresh callbacks changes nothing on screen: the
 * slot is told only when what it shows changed, and a press always reaches the feed's latest callback.
 */
import type { NoticeAct, SlotNotice } from "@ohmail/ui/base";
import { NOTICE_RANK, type FrameNotice } from "./contract.js";

interface FedNotice extends SlotNotice {
  readonly feed: string;
  readonly collapsible: boolean;
  readonly failedSendIds?: readonly string[];
}

export interface NoticeStore {
  post(feed: string, notices: readonly FrameNotice[]): void;
  read(): readonly FedNotice[];
  subscribe(changed: () => void): () => void;
  /** The more a notice's last answer opened, as that notice says it now; null when none is open or it has left. */
  readMore(): ShownMore | null;
  confirmMore(): void;
  /** Closes the more that stands. */
  closeMore(): void;
}

/** A notice's more as the dialog draws it: the notice's sentence and line, and its rows. */
export interface ShownMore {
  readonly title: string;
  readonly line?: string;
  readonly rows: readonly string[];
  readonly confirmLabel?: string;
}

/** A notice's name in the slot: its kind, and its own id where one kind stands more than once. */
export const noticeId = (notice: FrameNotice): string =>
  notice.id ? `${notice.kind}:${notice.id}` : notice.kind;

/** What the slot draws of a notice, without its callbacks: two equal faces draw the same. */
function face(notices: readonly FrameNotice[]): string {
  return JSON.stringify(
    notices.map((n) => [
      n.kind,
      n.id,
      n.failedSendIds,
      n.title,
      n.hot,
      n.line,
      n.acts?.map(({ label, busy, disabled, kind }) => [label, busy, disabled, kind]),
      n.more,
    ]),
  );
}

export function createNoticeStore(): NoticeStore {
  const latest = new Map<string, readonly FrameNotice[]>();
  const faces = new Map<string, string>();
  const told = new Set<() => void>();
  let snapshot: readonly FedNotice[] = [];
  /* The notice whose more is open, by its name in the slot, and what the dialog draws of it now. */
  let moreOf: string | null = null;
  let more: ShownMore | null = null;
  const tell = () => {
    for (const changed of [...told]) changed();
  };
  /* What the dialog draws: the open notice as it stands now; a notice that left closes it. */
  const opened = () => [...latest.values()].flat().find((n) => noticeId(n) === moreOf);
  const readOpen = (): ShownMore | null => {
    const notice = opened();
    if (!notice?.more) return null;
    const next = {
      title: notice.title,
      line: notice.more.line ?? notice.line,
      rows: notice.more.rows,
      confirmLabel: notice.more.confirm?.label,
    };
    return more !== null && JSON.stringify(more) === JSON.stringify(next) ? more : next;
  };
  const openMore = (id: string) => () => {
    moreOf = id;
    more = readOpen();
    tell();
  };

  const closeMore = () => {
    if (moreOf === null) return;
    moreOf = null;
    more = null;
    tell();
  };

  const press = (feed: string, at: number, act: number) => () =>
    latest.get(feed)?.[at]?.acts?.[act]?.onPress();
  const slotted = (feed: string, notice: FrameNotice, at: number): FedNotice => ({
    feed,
    collapsible: notice.kind === "notSent" || notice.kind === "unsaved",
    id: noticeId(notice),
    failedSendIds: notice.failedSendIds,
    rank: NOTICE_RANK[notice.kind],
    title: notice.title,
    progress: notice.kind === "firstSync",
    hot: notice.hot,
    line: notice.line,
    acts: answers(feed, notice, at),
  });
  /* Its answers as the slot presses them; its more, where it hands one, the last. */
  const answers = (feed: string, notice: FrameNotice, at: number): SlotNotice["acts"] => {
    const acts = (notice.acts ?? []).map((act, i): NoticeAct => ({
      ...act,
      onPress: press(feed, at, i),
    }));
    if (notice.more) acts.push({ label: notice.more.label, onPress: openMore(noticeId(notice)) });
    return acts.length ? (acts as unknown as SlotNotice["acts"]) : undefined;
  };

  return {
    post(feed, notices) {
      const now = face(notices);
      if (notices.length) latest.set(feed, notices);
      else latest.delete(feed);
      if (faces.get(feed) === now || (!notices.length && !faces.has(feed))) return;
      if (notices.length) faces.set(feed, now);
      else faces.delete(feed);
      snapshot = [...latest].flatMap(([name, list]) => list.map((notice, at) => slotted(name, notice, at)));
      more = readOpen();
      if (more === null) moreOf = null;
      tell();
    },
    read: () => snapshot,
    readMore: () => more,
    confirmMore() {
      const confirm = opened()?.more?.confirm;
      if (!confirm) return;
      closeMore();
      confirm.onPress();
    },
    closeMore,
    subscribe(changed) {
      told.add(changed);
      return () => told.delete(changed);
    },
  };
}

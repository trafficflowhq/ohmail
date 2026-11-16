/**
 * THE ONE NOTICE SLOT'S STORE. Every feed posts what is true for it now, under its own name, and a later post
 * of the same feed replaces its earlier one; the slot reads one list, ordered by `NOTICE_RANK` (the kit's
 * `slotOrder`). A feed that posts the same notices again with fresh callbacks changes nothing on screen: the
 * slot is told only when what it shows changed, and a press always reaches the feed's latest callback.
 */
import type { NoticeAct, SlotNotice } from "@ohmail/ui/base";
import { NOTICE_RANK, type FrameNotice } from "./contract.js";

export interface NoticeStore {
  post(feed: string, notices: readonly FrameNotice[]): void;
  read(): readonly SlotNotice[];
  subscribe(changed: () => void): () => void;
}

/** A notice's name in the slot: its kind, and its own id where one kind stands more than once. */
export const noticeId = (notice: FrameNotice): string =>
  notice.id ? `${notice.kind}:${notice.id}` : notice.kind;

/** What the slot draws of a notice, without its callbacks: two equal faces draw the same. */
function face(notices: readonly FrameNotice[]): string {
  return JSON.stringify(
    notices.map((n) => [n.kind, n.id, n.title, n.hot, n.line, n.acts?.map((act) => act.label)]),
  );
}

export function createNoticeStore(): NoticeStore {
  const latest = new Map<string, readonly FrameNotice[]>();
  const faces = new Map<string, string>();
  const told = new Set<() => void>();
  let snapshot: readonly SlotNotice[] = [];

  const press = (feed: string, at: number, act: number) => () =>
    latest.get(feed)?.[at]?.acts?.[act]?.onPress();
  const slotted = (feed: string, notice: FrameNotice, at: number): SlotNotice => ({
    id: noticeId(notice),
    rank: NOTICE_RANK[notice.kind],
    title: notice.title,
    hot: notice.hot,
    line: notice.line,
    acts: notice.acts?.map((act, i): NoticeAct => ({
      label: act.label,
      onPress: press(feed, at, i),
    })) as SlotNotice["acts"],
  });

  return {
    post(feed, notices) {
      const now = face(notices);
      if (notices.length) latest.set(feed, notices);
      else latest.delete(feed);
      if (faces.get(feed) === now || (!notices.length && !faces.has(feed))) return;
      if (notices.length) faces.set(feed, now);
      else faces.delete(feed);
      snapshot = [...latest].flatMap(([name, list]) => list.map((notice, at) => slotted(name, notice, at)));
      for (const tell of [...told]) tell();
    },
    read: () => snapshot,
    subscribe(changed) {
      told.add(changed);
      return () => told.delete(changed);
    },
  };
}

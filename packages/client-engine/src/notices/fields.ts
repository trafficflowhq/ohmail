/**
 * WHERE AN EVENT'S WORDS STAND IN A DRAWN NOTICE: in the title, and nowhere else. Common
 * notification centres draw a body with markup and a title without, so the body is the app's own
 * words over numbers. A surface brings its words; it is never handed the label, and the title's
 * text is cleaned once more here whatever made the notice.
 */
import { cleanNoticeText } from "./label.js";
import type { EventLabel, Notice } from "./kinds.js";

type WithoutLabel<N> = N extends unknown ? Omit<N, "label"> : never;

/** A notice's numbers and closed words: everything but its label. */
export type NoticeFacts = WithoutLabel<Notice>;

/** A surface's words, in the person's language. */
export interface NoticeWording {
  /** The app's own title, for a notice that names no event. */
  title(facts: NoticeFacts): string;
  /** The app's own words and numbers. */
  body(facts: NoticeFacts): string;
  /** The app's word for an event whose title is not shown. */
  label(as: "busy" | "event"): string;
}

/** The two fields a platform draws. */
export interface NoticeFields {
  readonly title: string;
  readonly body: string;
}

function split(notice: Notice): { label: EventLabel | null; facts: NoticeFacts } {
  if (!("label" in notice)) return { label: null, facts: notice };
  const { label, ...facts } = notice;
  return { label, facts };
}

/** `notice` as its two fields, in `wording`'s words. */
export function noticeFields(notice: Notice, wording: NoticeWording): NoticeFields {
  const { label, facts } = split(notice);
  const body = wording.body(facts);
  if (label === null) return { title: wording.title(facts), body };
  const text = label.as === "title" ? cleanNoticeText(label.text) : null;
  return { title: text ?? wording.label(label.as === "busy" ? "busy" : "event"), body };
}

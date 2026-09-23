"use client";

import { Extension, getMarkRange } from "@tiptap/react";
import Link from "@tiptap/extension-link";
import Code from "@tiptap/extension-code";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import type { Mark, MarkType } from "@tiptap/pm/model";

/**
 * THE MARK-BOUNDARY RULES — Slack's, stated once. Each row is a claim the editor-feel rig
 * (`test/editor-feel/rules.pw.ts`, a real keyboard on chromium and webkit) drives, and the jsdom
 * suite (`test/rich-editor-marks.test.tsx`) pins at the mechanism; `test/rich-editor-rules-census`
 * refuses a row without a test naming its id. The mechanism behind the rows: the link mark is
 * NON-INCLUSIVE in the schema and re-enters only for a non-space character typed at its end
 * (`nextMarks`); code EXITS on a space typed at its end; `keepOnSplit: false` on code and link is
 * what ends them at a line break; `exitable: false` is what stops ArrowRight from typing a space.
 */
export const EDITOR_RULES = [
  ["link-end-letter", "A letter or punctuation typed at the end of a link extends the link."],
  ["link-end-space", "A space or a line break typed at the end of a link is plain: the link ends where you stopped typing it."],
  ["link-start", "Typing before a link never joins it, even when the link opens the line."],
  ["link-reenter", "Backspace back to a link's last character re-enters it: the next letter continues the link."],
  ["link-self-href", "A link whose address is its own text keeps the address equal to the text as you type onto it."],
  ["autolink-punct", "A web address typed before a full stop, comma, colon or closing bracket is linked without that punctuation once a space follows."],
  ["mark-end-sticky", "Bold, italic, strikethrough and code continue while you type at their end."],
  ["mark-start", "Typing before bold, italic, strikethrough or code text in a line never takes the format; only at a line's first position is the line's opening format taken, as in Slack."],
  ["code-end-space", "A space typed at the end of inline code leaves the code."],
  ["enter-keeps", "A line break keeps bold, italic and strikethrough for the next line; code and links end with the line."],
  ["toggle-sticky", "A format toggled on with nothing selected carries into what you type until you toggle it off or move the caret."],
  ["list-empty-enter", "Enter on an empty list item, anywhere in the list, takes the item out of the list."],
  ["toolbar-next", "Bold, italic, strikethrough and code light up exactly when the next letter typed would carry them."],
  ["link-not-toggle", "The link button is never a toggle: it opens the address dialog and lights up only while that dialog is open."],
  ["one-caret", "Arrow keys move one caret, the editor is the one focus owner, and no key that moves the caret writes a character."],
] as const;

export type EditorRuleId = (typeof EDITOR_RULES)[number][0];

/** Marks a space typed at their END leaves. Bold, italic and strike stay sticky across a space. */
const EXITS_ON_SPACE: ReadonlySet<string> = new Set(["code", "link"]);

const isWhitespace = (s: string): boolean => /^\s+$/.test(s);

/**
 * Is the caret at the END of `mark`: the character before carries it, the one after does not (or
 * there is none)? Inside a mark both neighbours carry it, and a space typed there stays marked.
 */
function atEndOf($from: EditorState["selection"]["$from"], mark: Mark): boolean {
  const before = $from.nodeBefore;
  const after = $from.nodeAfter;
  return !!before && mark.isInSet(before.marks) && !(after && mark.isInSet(after.marks));
}

/**
 * The marks the next typed text carries — ONE answer for the toolbar and for the text-input
 * plugin, so the row of buttons cannot say one thing while the keystroke does another. `typed`
 * is the text about to be inserted; absent, the answer is for a letter. ProseMirror's own rule
 * (`storedMarks ?? $from.marks()`, which honours each mark's `inclusive`) is the base; the two
 * amendments are the link re-entering for a non-space at its end, and code/link leaving on a
 * space at theirs. A range selection keeps ProseMirror's answer untouched.
 */
export function nextMarks(state: EditorState, typed?: string): readonly Mark[] {
  const { $from, $to, empty } = state.selection;
  const base: readonly Mark[] = state.storedMarks ?? (empty ? $from.marks() : ($from.marksAcross($to) ?? []));
  if (!empty) return base;
  const ws = typed !== undefined && isWhitespace(typed);
  let marks = base;
  if (ws) {
    marks = marks.filter((m) => !(EXITS_ON_SPACE.has(m.type.name) && atEndOf($from, m)));
    return marks;
  }
  const link = $from.nodeBefore?.marks.find((m) => m.type.name === "link");
  if (link && !link.isInSet(marks) && atEndOf($from, link)) marks = link.addToSet(marks);
  return marks;
}

/** The link the caret stands in or at the end of — what ⌘K edits and what Remove removes. */
export function linkAtCaret(state: EditorState): Mark | null {
  return nextMarks(state).find((m) => m.type.name === "link") ?? null;
}

const sameMarks = (a: readonly Mark[], b: readonly Mark[]): boolean =>
  a.length === b.length && a.every((m) => m.isInSet(b));

/**
 * A link whose address IS its text — an autolinked URL, a bare address — with the scheme Tiptap's
 * autolink prefixes when the text has none. Returns the prefix, or null when the address is its own.
 */
function selfAddressedPrefix(href: string, text: string): string | null {
  for (const prefix of ["", "http://", "https://", "mailto:"]) {
    if (href === prefix + text) return prefix;
  }
  return null;
}

/**
 * Typing `text` onto the END of `link` extends its text; when the address was the text, the
 * address follows, so a URL typed further stays the URL it reads as. Runs on the transaction
 * that already inserted the text with the link mark.
 */
function syncSelfAddressedHref(tr: Transaction, from: number, text: string, link: Mark): void {
  const range = getMarkRange(tr.doc.resolve(from), link.type, link.attrs);
  if (!range) return;
  const before = tr.doc.textBetween(range.from, range.to - text.length, "￼");
  const prefix = selfAddressedPrefix(String(link.attrs.href ?? ""), before);
  if (prefix === null) return;
  const next = link.type.create({ ...link.attrs, href: prefix + before + text });
  tr.removeMark(range.from, range.to, link.type).addMark(range.from, range.to, next);
}

/**
 * THE TEXT-INPUT SEAM. ProseMirror lets the browser insert the character and then reads the DOM
 * change; `handleTextInput` is where a plugin may decide the marks instead. Whenever `nextMarks`
 * differs from ProseMirror's own answer, the text is inserted here with the marks the rules say,
 * and the browser's rendering is redrawn from the document — the same path the input rules take.
 * Low priority, so those rules (`**bold**`, `- `) get first refusal.
 */
export const MarkBoundaries = Extension.create({
  name: "markBoundaries",
  priority: 50,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("markBoundaries"),
        props: {
          handleTextInput: (view, from, to, text) => {
            const { state } = view;
            if (!state.selection.empty || from !== to || from !== state.selection.from) return false;
            const want = nextMarks(state, text);
            const have = state.storedMarks ?? state.selection.$from.marks();
            if (sameMarks(want, have)) return false;
            const tr = state.tr.setStoredMarks([...want]).insertText(text, from, to);
            const link = want.find((m) => m.type.name === "link");
            if (link && !link.isInSet(have)) syncSelfAddressedHref(tr, from, text, link);
            view.dispatch(tr);
            return true;
          },
        },
      }),
    ];
  },
});

/** Trailing punctuation a sentence puts after an address: linked without it (`autolink-punct`). */
const TRAILING = /^(\S+?)([.,;:!?]+|[)\]]+)$/;
const SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/** The address `stem` links to under Tiptap's own autolink conventions, or null when it is not one. */
export function autolinkHref(stem: string): string | null {
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(stem)) return `mailto:${stem}`;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(stem) ? stem : /^www\.[^\s.]+\.[^\s]+$/i.test(stem) ? `http://${stem}` : null;
  if (!candidate) return null;
  let url: URL;
  try { url = new URL(candidate); } catch { return null; }
  if (!SCHEMES.has(url.protocol)) return null;
  if (url.protocol !== "mailto:" && !url.hostname.includes(".")) return null;
  return candidate;
}

/**
 * Tiptap's autolink refuses a word that tokenizes to `[address, punctuation]` (`isValidLinkStructure`),
 * so `see https://example.com.` followed by a space linked NOTHING — measured on both engines. This
 * takes exactly that case: a space just typed, the word before it an address plus trailing
 * punctuation, no link or code on it yet — and links the address alone.
 */
export const AutolinkPunctuation = Extension.create({
  name: "autolinkPunctuation",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("autolinkPunctuation"),
        appendTransaction: (transactions, _old, state) => {
          const linkType: MarkType | undefined = state.schema.marks.link;
          if (!linkType || !state.selection.empty) return null;
          const { $from } = state.selection;
          let typed = 0;
          for (const tr of transactions) {
            for (const step of tr.steps) {
              if (!(step instanceof ReplaceStep) || step.from !== step.to) continue;
              const text = step.slice.content.textBetween(0, step.slice.content.size, "￼");
              if (isWhitespace(text) && step.from + text.length === $from.pos) typed = text.length;
            }
          }
          if (!typed || !$from.parent.isTextblock) return null;
          const upTo = $from.parentOffset - typed;
          const text = $from.parent.textBetween(0, upTo, "￼");
          const word = text.slice(text.search(/\S+$/) >= 0 ? text.search(/\S+$/) : text.length);
          const m = TRAILING.exec(word);
          if (!m) return null;
          const href = autolinkHref(m[1]);
          if (!href) return null;
          const from = $from.start() + upTo - word.length;
          const to = from + m[1].length;
          const code = state.schema.marks.code;
          if (state.doc.rangeHasMark(from, to, linkType) || (code && state.doc.rangeHasMark(from, to, code))) return null;
          return state.tr.addMark(from, to, linkType.create({ href }));
        },
      }),
    ];
  },
});

/**
 * The link mark, non-inclusive: nothing typed at its end joins it unless `nextMarks` says so.
 * `exitable: false` and `keepOnSplit: false` (the latter already Tiptap's own for a link) keep
 * ArrowRight from writing a space and a line break from carrying the link.
 */
export const LinkMark = Link.extend({
  inclusive: false,
  exitable: false,
  keepOnSplit: false,
});

/**
 * Inline code: sticky while typing (inclusive, Tiptap's default), ended by a space at its end
 * (`nextMarks`), by a line break (`keepOnSplit: false`), and never by an arrow key writing a space.
 */
export const CodeMark = Code.extend({
  keepOnSplit: false,
  exitable: false,
});

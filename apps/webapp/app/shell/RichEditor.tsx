"use client";

import { useCallback, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import {
  EMPTY_RICH, escapeAsParagraphs, isRichEmpty, richToHtml, type RichValue,
} from "./rich-text";

/**
 * THE COMPOSE AND REPLY EDITOR — eight things it can do, and a list of what it refuses.
 *
 * ── THE GRAMMAR IS THE PRODUCT DECISION ──────────────────────────────────────────────────
 *
 * Bold, italic, strike, link, bullet list, numbered list, block quote, inline code. No fonts,
 * no colours, no sizes, no alignment, no tables, no images. That is not a first cut waiting to
 * be extended — it is the same list the server's outbound-HTML sanitiser will accept, and the
 * two are one decision written in two places because they are enforced at two different trust
 * boundaries. A control offered here that the server strips would be a button that silently
 * does nothing, which is worse than no button.
 *
 * The refusals are stated as configuration rather than left to the defaults. `StarterKit`
 * ships headings, horizontal rules and code BLOCKS, and every one of them would round-trip
 * through the editor, look right on screen, and then be discarded by the sanitizer on the way
 * out. Switching them off here is what makes the editor's own behaviour honest.
 *
 * ── MARKDOWN INPUT RULES COME FREE, AND THAT IS WHY THEY ARE HERE ────────────────────────
 *
 * `**bold**`, `- `, `1. `, `> ` and `` `code` `` are TipTap's own input rules, shipped with
 * the extensions above. They are the reason this editor needs almost no toolbar: somebody who
 * writes mail in Markdown never has to look at one, and somebody who does not can press the
 * buttons. Cmd/Ctrl+B and +I are likewise the extensions'; Cmd/Ctrl+K is ours, below, because
 * a link needs a destination and TipTap has no opinion about where that comes from.
 *
 * ── HOW IT TALKS TO THE SCRATCH BUFFERS ──────────────────────────────────────────────────
 *
 * `onChange` fires with BOTH halves on every keystroke — `{text, html}` — and the caller
 * stores that verbatim. `text` is `editor.getText()`, the editor's own plain rendering; it is
 * what the send path's local checks read and what the optimistic draft row shows. It is NOT
 * what the recipient's plaintext client will see: the server derives that from the sanitized
 * markup, so the two parts of the multipart cannot be made to disagree by a client. Having
 * both here is what lets Send stay disabled on an empty editor without asking the server.
 *
 * ── WHY `value` IS NOT A CONTROLLED PROP IN THE REACT SENSE ──────────────────────────────
 *
 * ProseMirror owns a document and a selection; re-setting its content from a prop on every
 * render would move the caret to the end on every keystroke. So the incoming `value.html` is
 * applied ONLY when it differs from what the editor currently holds, which is exactly the
 * cases that must work — restoring a scratch buffer, and an AI draft landing in an open reply
 * — and never the case that must not, a re-render caused by the user's own typing.
 */

/** The marks and nodes this editor offers, and the ones it explicitly refuses. */
const EXTENSIONS = [
  StarterKit.configure({
    // Offered.
    bold: {},
    italic: {},
    strike: {},
    code: {},
    bulletList: {},
    orderedList: {},
    listItem: {},
    blockquote: {},
    // REFUSED, each because the sanitizer drops it on the way out and a control that
    // silently does nothing is worse than an absent one.
    heading: false,
    horizontalRule: false,
    codeBlock: false,
    // `Link` is configured separately below; StarterKit's copy would win otherwise.
    link: false,
    // Underline has no plain-text rendering and no place in mail — it reads as a dead link.
    underline: false,
  }),
  Link.configure({
    openOnClick: false,
    // The editor writes markup that a MAIL client renders, so a link may only be a thing a
    // mail client can open. This mirrors the scheme allow-list the server's sanitiser applies;
    // the server is the enforcement and this is the courtesy of not offering what it will refuse.
    protocols: ["http", "https", "mailto"],
    autolink: true,
    HTMLAttributes: {},
  }),
];

export interface RichEditorProps {
  id?: string;
  value: RichValue;
  onChange: (v: RichValue) => void;
  /** The accessible name. Required — an unlabelled editor is unusable with a screen reader. */
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  /**
   * False while a send is in flight. It is the textarea's `readOnly` and not its `disabled`:
   * the text is never taken away from the author — a failed send whose draft had been cleared
   * would be a message they have to write twice — but the document must not take input either,
   * because what is on screen is no longer what was handed to the send.
   *
   * The toolbar goes with it. A formatting button that still fired would edit a document the
   * caret cannot reach, which is the inert-affordance class this app keeps closing.
   */
  editable?: boolean;
  /** Wired by the reply surface for ⌘↵ — the editor swallows keys the shell would not see. */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /**
   * The editor instance, handed to the parent when it is ready and `null` when it goes away.
   *
   * This exists for the one thing `value`/`onChange` cannot express: putting content INTO an
   * open editor at a caret the user chose. A generated draft is appended at the cursor or
   * replaces the selection — both are document operations, and expressing them by rewriting
   * `value` would throw away the caret and the undo history along with it.
   */
  editorRef?: (editor: Editor | null) => void;
}

export function RichEditor({
  id, value, onChange, ariaLabel, placeholder, className, autoFocus, editable = true,
  onKeyDown, editorRef,
}: RichEditorProps) {
  const t = useTranslations("compose");

  /**
   * The last value this component EMITTED, so the sync effect below can tell the caller
   * echoing our own change back (do nothing) from the caller genuinely replacing the content
   * (re-set the document). Without it, every keystroke would be indistinguishable from an
   * external replace and the caret would jump to the end of the message.
   */
  const emitted = useRef<string>(richToHtml(value));

  /**
   * ── A MESSAGE WITH NO FORMATTING IN IT REPORTS NO MARKUP, AND THAT IS LOAD-BEARING ──────
   *
   * `getHTML()` answers `<p>hi</p>` for a document nobody formatted, so emitting it verbatim
   * would make `html` non-empty for EVERY non-empty editor. Three things downstream read
   * "there is markup" as a decision rather than as a detail, and all three would be wrong:
   * `compose.ts` would put `html` on the wire instead of `body`, so a plain note would leave
   * as a `multipart/alternative` and the recipient's plain part would be the server's
   * re-rendering of markup nobody wrote; `serializeRichValue` would store an envelope for
   * every reply, and its bare-string branch — the one that keeps a plain draft readable by
   * the bundle that predates this editor — would become unreachable code that no test could
   * distinguish from working; and a plain send would stop being byte-identical to the one
   * this slice replaced, which is the difference between adding a feature and changing
   * everybody's mail.
   *
   * THE TEST IS THE ROUND TRIP, not a hand-written "does it contain a tag". `richToHtml` is
   * how a value becomes a document, so a document that serialises to exactly what that helper
   * would have produced from the text alone carries nothing the text does not already say —
   * hard breaks and paragraph splits included, which is why this is not `getText()`-only
   * comparison of the visible characters. A second predicate could disagree with the loader,
   * and the disagreement would surface as somebody's line breaks vanishing on reload; asking
   * the loader is the only check that cannot drift from it. Same discipline, and the same
   * sentence, as `serializeRichValue`.
   */
  /**
   * WHAT THE CALLER ALREADY KNOWS — updated on render AND inside `emit`, and the second half
   * is not redundant.
   *
   * The no-op guard below compares against this. Tracking only the `value` PROP looks
   * equivalent and is not: a prop refreshes on render, so two transactions inside one tick are
   * both measured against the state before the first of them. Measured in production, on the
   * live build, before this line existed: `setContent` → `toggleBold` → `clearContent` in one
   * block wrote the text, wrote the formatted envelope, and then SILENTLY DROPPED the clear,
   * because emptying the editor produced the same `{"",""}` the stale prop still held. The
   * scratch buffer kept a reply that was no longer on screen.
   *
   * A person cannot do that — React flushes between discrete events, so each keystroke gets its
   * own render — but a program can, and several already do: a generated draft landing at a
   * caret, a paste handler, a future clear button. Recording what we told the caller, at the
   * moment we tell them, is exact in both cases and costs one assignment.
   */
  const told = useRef<RichValue>(value);
  told.current = value;

  const emit = useCallback((editor: Editor) => {
    const text = editor.getText();
    const markup = editor.isEmpty ? "" : editor.getHTML();
    const html = markup === escapeAsParagraphs(text) ? "" : markup;
    // The document's OWN serialisation, so the sync effect below can recognise this change
    // coming back and leave the caret alone. `richToHtml` of what we emit is the same string
    // in both branches, which is what makes one ref serve both.
    emitted.current = markup;
    /**
     * A TRANSACTION THAT PRODUCED THE VALUE THE CALLER ALREADY HAS IS NOT A CHANGE.
     *
     * TipTap emits `update` for things that are not edits — `setEditable` does it by default,
     * and that one cost a real draft (see the effect below). The caller cannot tell such an
     * emission from a keystroke, and it must not have to: what it does with a change is
     * WRITE THE SCRATCH BUFFER, whose rule is that an empty value removes the key. So one
     * spurious empty emission on mount is somebody's unsent message, deleted by the editor
     * that was opening to show it to them.
     *
     * Compared against what the caller KNOWS (`told`) rather than against `emitted.current`:
     * that ref holds the document's serialisation, which is a different question — it answers
     * "would re-setting the content be a no-op", not "would the caller's state change". They
     * disagree for a plain document, where `emitted.current` is `<p>hi</p>` and the caller was
     * told `html: ""`.
     */
    if (text === told.current.text && html === told.current.html) return;
    told.current = { text, html };
    onChange({ text, html });
  }, [onChange]);

  const editor = useEditor({
    extensions: EXTENSIONS,
    /**
     * ESCAPED HERE TOO, and this is not belt-and-braces — it is the same hole in the other
     * entry point. `setContent` in the sync effect below escapes a plain starting value for a
     * stated reason (somebody who typed `<b>` into the old textarea must not have it become
     * formatting), and the INITIAL content is parsed as HTML by exactly the same parser. A
     * legacy plain buffer restored on first mount never reached that effect, so it went in
     * raw. One helper, both doors.
     */
    content: richToHtml(value),
    // Next renders this shell on the server; ProseMirror needs a DOM. Rendering the editor
    // immediately during SSR produces a hydration mismatch, and TipTap's own answer is this
    // flag rather than a `typeof window` guard.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": ariaLabel,
        ...(id ? { id } : {}),
        ...(placeholder ? { "data-placeholder": placeholder } : {}),
        class: "rte-surface",
      },
    },
    onUpdate: ({ editor: e }) => emit(e),
  }, []);

  /**
   * Content replaced from OUTSIDE — a scratch buffer restored, or a generated draft landing.
   *
   * Guarded on the value differing from what we last emitted, for the caret reason in the
   * header. `emitOnUpdate: false` keeps the replacement from bouncing straight back out as a
   * change the caller would store as if the user had typed it.
   */
  useEffect(() => {
    if (!editor) return;
    const incoming = richToHtml(value);
    if (incoming === emitted.current) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (incoming === current) return;
    emitted.current = incoming;
    editor.commands.setContent(incoming, { emitUpdate: false });
  }, [editor, value.html, value.text]);

  useEffect(() => {
    if (editor && autoFocus) editor.commands.focus("end");
  }, [editor, autoFocus]);

  /**
   * Mid-send. `setEditable` rather than a fresh editor, so the document, the caret and the
   * undo history all survive being locked and unlocked — a failed send must hand the message
   * back exactly as it was.
   */
  useEffect(() => {
    /**
     * `emitUpdate: false` — THE SECOND ARGUMENT IS LOAD-BEARING AND ITS DEFAULT IS WRONG HERE.
     *
     * `setEditable(editable)` defaults to emitting an `update` (`@tiptap/core`, `setEditable`:
     * `if (emitUpdate) this.emit("update", …)`), and this effect runs on mount. So a freshly
     * mounted editor announced a change it had not had, carrying the empty document it starts
     * with — and Compose's `onChange` writes the scratch buffer, whose rule is that an empty
     * form removes the key. Opening Compose therefore DELETED the half-written message it was
     * about to restore. Measured, not reasoned about: the buffer held
     * `{"body":"Halb fertig."…}` before the remount and nothing after it, and the stack ran
     * `setEditable → emit(update) → onChange → writeComposeDraft → removeItem`.
     *
     * Editability changes no content, so it has no business reporting one. The guard in `emit`
     * closes the same hole from the other side, and both are kept: this one states the local
     * fact, that one refuses to believe any emission that says nothing changed.
     */
    editor?.setEditable(editable, false);
  }, [editor, editable]);

  useEffect(() => {
    if (!editorRef) return;
    editorRef(editor ?? null);
    return () => editorRef(null);
  }, [editor, editorRef]);

  /**
   * ⌘K / Ctrl+K — the one shortcut TipTap cannot ship, because a link needs a destination.
   *
   * `window.prompt` and not a custom popover, deliberately: it is one line of code, it is
   * keyboard-native, it is announced by screen readers, and Escape cancels it. A bespoke
   * floating input is a second focus trap to get right in a surface that already has Escape
   * precedence rules the shell owns. When the design system grows a real prompt, this is one
   * call site.
   */
  const onEditorKeyDown = (e: React.KeyboardEvent): void => {
    if (editor && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      promptForLink(editor, t("linkPrompt"));
      return;
    }
    onKeyDown?.(e);
  };

  /**
   * THE PLACEHOLDER IS A CLASS ON THE WRAPPER, not TipTap's `Placeholder` extension.
   *
   * That extension lives in `@tiptap/extensions`, which is a transitive dependency here rather
   * than a declared one — reaching into it would make the editor's behaviour depend on a
   * package this app does not name. `.rte-surface::before` reads the `data-placeholder`
   * attribute already on the surface and is shown only while this class is on, which needs no
   * new dependency and no plugin in the transaction pipeline.
   *
   * Emptiness is decided on the TEXT, by the same predicate that decides whether there is
   * anything to send or to keep: an empty ProseMirror document serialises to `<p></p>`, so a
   * markup test would hide the placeholder the moment the editor mounted.
   */
  const cls = [
    "rte",
    isRichEmpty(value) ? "is-empty" : "",
    editable ? "" : "is-locked",
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <div className={cls}>
      <Toolbar editor={editor} editable={editable} />
      <EditorContent editor={editor} onKeyDown={onEditorKeyDown} />
    </div>
  );
}

/**
 * The toolbar, and why it is fixed rather than a bubble menu.
 *
 * A bubble menu appears on selection, which means the controls are invisible until you already
 * know they exist — fine for a document editor somebody lives in, wrong for a reply box a
 * person opens twice a day. Eight buttons in a row, always in the same place, is the smaller
 * thing to learn. It is also the accessible one: a menu that materialises near a selection is
 * a focus-order problem, and this is a plain row of buttons in the tab order.
 *
 * Each button reports its own pressed state from the editor, so the row says what the cursor
 * is standing in rather than what was last clicked.
 */
function Toolbar({ editor, editable }: { editor: Editor | null; editable: boolean }) {
  const t = useTranslations("compose");

  /**
   * The pressed states, SUBSCRIBED rather than read during render.
   *
   * `useEditor` does not re-render its owner on every transaction — that is a deliberate
   * performance decision in TipTap 3, and it means a toolbar that called `editor.isActive()`
   * straight in its render body would paint the state as of the last React render and then sit
   * there while the caret moved. Measured, not assumed: the first version of this component did
   * exactly that, and its test read `aria-pressed="false"` immediately after a successful
   * `toggleBold` — the editor was right and the toolbar was stale.
   *
   * `useEditorState` subscribes to the transactions and re-renders only when one of these eight
   * booleans actually changes, which is the whole reason to select them rather than the editor.
   */
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      strike: e?.isActive("strike") ?? false,
      code: e?.isActive("code") ?? false,
      link: e?.isActive("link") ?? false,
      bullet: e?.isActive("bulletList") ?? false,
      ordered: e?.isActive("orderedList") ?? false,
      quote: e?.isActive("blockquote") ?? false,
    }),
  });

  if (!editor || !active) return null;

  const btn = (
    key: string,
    isActive: boolean,
    run: () => void,
  ) => (
    <button
      key={key}
      type="button"
      className="rte-b"
      // The glyph is a letter, so the letter has to carry the mark it stands for — a "B" that
      // is not bold and an "S" that is not struck are eight buttons that all look the same.
      // An attribute rather than a per-button class so the stylesheet names the mark, and so
      // adding a control cannot silently inherit another one's look through nth-child.
      data-mark={key}
      // `aria-pressed` and not a class alone: "is this text already bold" is the question the
      // control answers, and a sighted user reads it from the highlight.
      aria-pressed={isActive}
      aria-label={t(`rte.${key}`)}
      title={t(`rte.${key}`)}
      // Mid-send. Not merely styled: a live button here would edit a document the caret cannot
      // reach, and the text on screen would stop being the text handed to the send.
      disabled={!editable}
      // The editor loses focus to a click, and a formatting command applied with no selection
      // does nothing visible. Preventing the default keeps the caret where it was.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {TOOLBAR_GLYPHS[key]}
    </button>
  );

  return (
    <div className="rte-bar" role="toolbar" aria-label={t("rte.bar")}>
      {btn("bold", active.bold, () => editor.chain().focus().toggleBold().run())}
      {btn("italic", active.italic, () => editor.chain().focus().toggleItalic().run())}
      {btn("strike", active.strike, () => editor.chain().focus().toggleStrike().run())}
      {btn("code", active.code, () => editor.chain().focus().toggleCode().run())}
      {btn("link", active.link, () => promptForLink(editor, t("linkPrompt")))}
      {btn("bullet", active.bullet, () => editor.chain().focus().toggleBulletList().run())}
      {btn("ordered", active.ordered, () => editor.chain().focus().toggleOrderedList().run())}
      {btn("quote", active.quote, () => editor.chain().focus().toggleBlockquote().run())}
    </div>
  );
}

/** Text glyphs, not an icon set: eight marks that read the same in every theme and at 390px. */
const TOOLBAR_GLYPHS: Record<string, string> = {
  bold: "B", italic: "I", strike: "S", code: "‹›",
  link: "↗", bullet: "•", ordered: "1.", quote: "❝",
};

/**
 * Ask for a link target and set it, or clear the link when the answer is empty.
 *
 * An empty answer UNSETS rather than doing nothing, because "remove this link" has no other
 * control and inventing a ninth button for it would cost more than it is worth. `prompt`
 * returning null is a cancel and leaves everything alone; that distinction is the reason the
 * two are not collapsed.
 */
function promptForLink(editor: Editor, message: string): void {
  const previous = (editor.getAttributes("link").href as string | undefined) ?? "";
  const answer = window.prompt(message, previous);
  if (answer === null) return;
  const href = answer.trim();
  if (href === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
}

export { EMPTY_RICH };

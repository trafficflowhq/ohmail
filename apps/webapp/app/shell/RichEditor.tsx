"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  EditorContent, Extension, useEditor, useEditorState,
  type ChainedCommands, type Editor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { ResolvedPos } from "@tiptap/pm/model";
import { LinkPopover } from "./LinkPopover";
import {
  EMPTY_RICH, escapeAsParagraphs, isRichEmpty, richToHtml, type RichValue,
} from "./rich-text";

/**
 * THE COMPOSE AND REPLY EDITOR — eight controls, and a list of what they refuse.
 *
 * ── THE GRAMMAR IS THE PRODUCT DECISION ──────────────────────────────────────────────────
 *
 * Bold, italic, strike, link, bullet list, numbered list, block quote, and code — an inline
 * mark for a selection inside ONE line, a code BLOCK for one that spans lines (see
 * {@link applyCode}). No fonts, no colours, no sizes, no alignment, no tables, no images. That
 * is not a first cut waiting to be extended — it is the same list the server's outbound-HTML
 * sanitiser will accept, and the two are one decision written in two places because they are
 * enforced at two different trust boundaries. A control offered here that the server strips
 * would be a button that silently does nothing, which is worse than no button.
 *
 * THE INVARIANT RUNS BOTH WAYS, AND THAT IS WHAT ADMITTED THE CODE BLOCK. `StarterKit`'s
 * `codeBlock` was switched off here *because* `outbound-html.ts` had `code` in its allowlist
 * and no `pre` — so the only honest way to offer it was to move both ends together: the node
 * here, `pre` there, and the `<pre>` rendering in `htmlToPlainText` that keeps the two parts of
 * a `multipart/alternative` saying the same thing. Either half alone is a defect: the node
 * without the tag is a control whose output the server flattens into a run-on line, and the tag
 * without the node is an allowlist entry nothing can produce.
 *
 * The remaining refusals are stated as configuration rather than left to the defaults.
 * `StarterKit` ships headings and horizontal rules, and both would round-trip through the
 * editor, look right on screen, and then be discarded by the sanitizer on the way out.
 * Switching them off here is what makes the editor's own behaviour honest.
 *
 * ── MARKDOWN INPUT RULES COME FREE, AND THAT IS WHY THEY ARE HERE ────────────────────────
 *
 * `**bold**`, `- `, `1. `, `> `, `` `code` `` and ```` ``` ```` are TipTap's own input rules,
 * shipped with the extensions above. They are the reason this editor needs almost no toolbar:
 * somebody who writes mail in Markdown never has to look at one, and somebody who does not can
 * press the buttons. Cmd/Ctrl+B and +I are likewise the extensions'; Cmd/Ctrl+K is ours, below,
 * because a link needs a destination and TipTap has no opinion about where that comes from.
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

/**
 * ENTER IS A SINGLE LINE BREAK, NOT A NEW PARAGRAPH.
 *
 * ── THE BUG THIS CLOSES ──────────────────────────────────────────────────────────────────
 *
 * StarterKit binds Enter to "split the paragraph", so a message someone types line by line
 * leaves as one `<p>` per line. The outbound sanitiser keeps `<p>`, and a `<p>` renders with a
 * top/bottom margin in every mail client — so a note that looked single-spaced on screen arrives
 * at the recipient double-spaced, a gap between every line. There is no way to close that from
 * the html side: the one thing that would (an inline `margin:0` style) is exactly what the
 * outbound allow-list strips, and rightly. The break has to be a `<br>` at the source.
 *
 * So Enter inserts a hard break — one `<br>`, single-spaced, inside the paragraph — which is
 * what a plain-text-minded mail composer has always meant by Enter. A blank line is two of them
 * in a row (`<br><br>`), which renders as the gap the author actually asked for. `outbound-html.ts`
 * mirrors this into the text/plain half: one break is one newline, a doubled break is a blank
 * line, so both parts of the alternative show the same spacing.
 *
 * ── WHY IT DEFERS INSIDE LISTS AND QUOTES ─────────────────────────────────────────────────
 *
 * Enter already has a job in a list item (start the next item) and a block quote (the built-in
 * exit behaviour), and stealing it would break both. The handler returns `false` there, which
 * lets the default keymap run — `ListItem.splitListItem` and the rest. The high priority is so
 * this binding is consulted before those and can decline, rather than never being reached.
 */
const EnterAsHardBreak = Extension.create({
  name: "enterAsHardBreak",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        // Defer wherever Enter already means something: a list item (next item), a block quote
        // (its exit behaviour) and the code block, where Enter is a newline in the source and
        // three of them in a row is how you leave. `false` falls through to the default keymap
        // so `splitListItem`, `CodeBlock`'s own `exitOnTripleEnter` and the rest all run.
        if (
          this.editor.isActive("listItem") ||
          this.editor.isActive("blockquote") ||
          this.editor.isActive("codeBlock")
        ) {
          return false;
        }
        return this.editor.commands.setHardBreak();
      },
    };
  },
});

/** The marks and nodes this editor offers, and the ones it explicitly refuses. */
const EXTENSIONS = [
  EnterAsHardBreak,
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
    // The block half of the Code control. Admitted in the same commit that put `pre` into
    // `outbound-html.ts`'s allowlist and taught `htmlToPlainText` to render one — see the
    // header. Its options are the shipped defaults: `exitOnTripleEnter` is how you leave a
    // block from the keyboard, and `EnterAsHardBreak` defers to it.
    codeBlock: {},
    // REFUSED, each because the sanitizer drops it on the way out and a control that
    // silently does nothing is worse than an absent one.
    heading: false,
    horizontalRule: false,
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
   * this change replaced, which is the difference between adding a feature and changing
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
    // A hard break renders as ONE newline. TipTap's `getText` has no serializer for `hardBreak`
    // and would drop it, which since Enter now inserts a hard break (see `EnterAsHardBreak`)
    // would erase every line break from the plain half — so `richToHtml(getText())` would no
    // longer reproduce the document and a plain note with a single line break would report markup
    // it does not have, sending as `multipart/alternative` when it should be text/plain. Rendering
    // the break as `\n` keeps the round trip exact: `escapeAsParagraphs("a\nb")` is `<p>a<br>b</p>`,
    // which is exactly what the editor holds, so `html` stays `""`.
    const text = editor.getText({ textSerializers: { hardBreak: () => "\n" } });
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
   * THE LINK POPOVER'S ONE PIECE OF STATE, held here because two doors open it: the toolbar's
   * Link button and ⌘K below. The popover itself (`LinkPopover.tsx`) reads the caret's link
   * when it mounts and owns everything else — destination, normalisation, refusal, removal.
   *
   * This used to be `window.prompt`, chosen deliberately for being keyboard-native, announced,
   * and Escape-cancellable for free. The popover pays those costs explicitly (see its header)
   * to buy what the prompt could not offer: a visible Remove, a stated refusal for a scheme
   * the server would strip, and a control that belongs to the app rather than to the browser.
   */
  const [linkOpen, setLinkOpen] = useState(false);

  /**
   * Mid-send, the popover goes WITH the toolbar. A destination applied through a popover that
   * outlived the lock would edit a document whose bytes were already handed to the send —
   * the exact inert-affordance/live-affordance split the `editable` prop exists to enforce.
   */
  useEffect(() => {
    if (!editable) setLinkOpen(false);
  }, [editable]);

  const closeLink = useCallback((focusEditor: boolean) => {
    setLinkOpen(false);
    // Escape hands focus back to the message; a click elsewhere took it somewhere on purpose.
    if (focusEditor) editor?.commands.focus();
  }, [editor]);

  /**
   * ⌘K / Ctrl+K — the one shortcut TipTap cannot ship, because a link needs a destination.
   * The same toggle as the toolbar's Link button, so the keyboard and the mouse open one
   * affordance rather than two that could drift. Gated on `editable` exactly as the button is
   * disabled by it.
   */
  const onEditorKeyDown = (e: React.KeyboardEvent): void => {
    if (editor && editable && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setLinkOpen((open) => !open);
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

  /**
   * `rte-body` — THE MIDDLE LINK OF THE CHAIN, AND THE REASON THE BOX HAD A DEAD ZONE.
   *
   * `EditorContent` renders a plain `<div>` of its own and appends ProseMirror's
   * `contenteditable` INSIDE it (`@tiptap/react`, `PureEditorContent.render`). So the flex
   * child of `.rte` is that div — not the surface — and it was unclassed: `.compose-editor
   * .rte-surface{flex:1}` in `app.css` therefore named an element whose parent was not a flex
   * container, which is a declaration that computes and does nothing. The surface stayed at its
   * content height, the panel kept the rest, and a click below the first line landed on the
   * wrapper rather than on anything editable — a 220px box that only took a click on the line
   * of text in it. Reported as "the textbox can't be clicked fully, only the first text line".
   *
   * The fix is the chain, not a handler: `.rte` → `.rte-body` → `.rte-surface` are all flex
   * columns that pass the height down, so the contenteditable genuinely fills its box. Once it
   * does, nothing else is needed — a click inside a `contenteditable` is the browser's own
   * caret placement, and ProseMirror maps it to the nearest document position, which for a
   * click in the padding under the last line is the end of that line. A click-to-focus handler
   * would have been the other option and it is the wrong one: it fights the browser for
   * selection, breaks click-and-drag, and would have left the real defect — a one-line-tall
   * surface inside a frame at least 220px tall — in place underneath it.
   */
  return (
    <div className={cls}>
      <Toolbar
        editor={editor}
        editable={editable}
        linkOpen={linkOpen}
        onLinkToggle={() => setLinkOpen((open) => !open)}
        onLinkClose={closeLink}
      />
      <EditorContent editor={editor} className="rte-body" onKeyDown={onEditorKeyDown} />
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
function Toolbar({ editor, editable, linkOpen, onLinkToggle, onLinkClose }: {
  editor: Editor | null;
  editable: boolean;
  linkOpen: boolean;
  onLinkToggle: () => void;
  onLinkClose: (focusEditor: boolean) => void;
}) {
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
      // ONE button, two constructs, so its pressed state has to answer for both — a caret
      // sitting in a code block with an unlit Code button is a control that says the text is
      // not code while the text is code, and pressing it would then be the only way to find
      // out that it toggles the block off.
      code: (e?.isActive("code") ?? false) || (e?.isActive("codeBlock") ?? false),
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
    extra?: React.ButtonHTMLAttributes<HTMLButtonElement>,
  ) => (
    <button
      key={key}
      type="button"
      className="rte-b"
      {...extra}
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
      {btn("code", active.code, () => applyCode(editor))}
      {btn("link", active.link, onLinkToggle, { "aria-haspopup": "dialog", "aria-expanded": linkOpen })}
      {btn("bullet", active.bullet, () => applyList(editor, "bulletList"))}
      {btn("ordered", active.ordered, () => applyList(editor, "orderedList"))}
      {btn("quote", active.quote, () => applyQuote(editor))}
      {/* Inside the bar so `position: absolute` anchors to the bar's own box, whatever height
          the row wraps to at 390px. Out of flow, so the buttons never move when it opens. */}
      {linkOpen && <LinkPopover editor={editor} onClose={onLinkClose} />}
    </div>
  );
}

/**
 * Text glyphs where a LETTER is the mark — seven that read the same in every theme and at
 * 390px
 * — and one drawing where no letter says it. The link is the conventional CHAIN-LINK, two
 * interlocking halves, because that is the one shape every mail client and editor has taught
 * people to read as "link"; the arrow it replaced read as "open in new window", which is a
 * promise about navigation this button never made. Drawn in `currentColor` so it takes the
 * button's own ink in light, dark, hover and pressed alike — the same property the letters
 * get for free.
 */
const TOOLBAR_GLYPHS: Record<string, ReactNode> = {
  bold: "B", italic: "I", strike: "S", code: "‹›",
  link: (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  bullet: "•", ordered: "1.", quote: "❝",
};

/**
 * ═══ BLOCK COMMANDS TAKE LINES, NOT TEXTBLOCKS ═══════════════════════════════════════════
 *
 * ── THE DEFECT THIS LAYER CLOSES ──────────────────────────────────────────────────────────
 *
 * Enter here is a hard break (`EnterAsHardBreak`), so a message typed line by line is ONE
 * paragraph with `<br>`s in it. Every block command TipTap ships — `toggleBulletList`,
 * `toggleOrderedList`, `toggleBlockquote`, `setBlockType` — resolves its target as "the
 * textblocks the selection touches", which in an ordinary document is the current line and in
 * this editor is the WHOLE MESSAGE. Reported exactly so: "list or code formats always mark the
 * full text and not the current line". The multi-paragraph case was already right (measured:
 * three `<p>`s, caret in the middle one, list takes only that one), which is what pins the
 * defect on the hard-break line structure rather than on the toggles.
 *
 * ── THE RULE, WHICH IS EVERY OTHER EDITOR'S ───────────────────────────────────────────────
 *
 * A block command applies to LINES — the hard-break-delimited runs a person sees. No selection:
 * the line the caret stands in. A selection: exactly the lines it touches, expanded outward to
 * their boundaries (nobody selects a line to its exact ends before pressing Quote). A full
 * select is all lines, which is the one case the old behaviour got right — but as one item per
 * line, not the whole message inside a single bullet.
 *
 * ── HOW: THE BREAKS AT THE TARGET'S EDGES BECOME REAL SPLITS, THEN THE STOCK TOGGLE RUNS ──
 *
 * {@link splitTargetLines} rewrites the hard break on each side of the target lines into a
 * paragraph split (and, for lists, every break inside the target too — three selected lines
 * are three `<li>`s, not one item with breaks in it), then narrows the transaction's selection
 * to the isolated lines. The stock toggle chained after it therefore wraps exactly what the
 * user meant. Everything runs in ONE chain, hence one transaction and one undo step.
 *
 * The neighbouring lines necessarily become paragraphs of their own — a `<p>` cannot contain a
 * `<ul>`, so no editor keeps "the line above a list" in the same block as the list. Marks are
 * untouched: splitting moves nodes, it does not rebuild them, so bold inside a bulleted line
 * survives (the code block is the one command that drops marks, and that is the node's own
 * declared rule).
 */

/** The hard-break-delimited line edge on one side of `pos`, inside `$pos`'s textblock. */
function lineEdge($pos: ResolvedPos, pos: number, dir: -1 | 1): number {
  const blockStart = $pos.start();
  let edge = dir === -1 ? blockStart : blockStart + $pos.parent.content.size;
  $pos.parent.forEach((child, offset) => {
    if (child.type.name !== "hardBreak") return;
    const at = blockStart + offset;
    // Looking left: the latest break that ends at or before `pos`. Looking right: the earliest
    // break that starts at or after it. A caret sitting exactly on a break therefore belongs to
    // the line that ENDS there, which is where the eye says it is.
    if (dir === -1 && at + 1 <= pos && at + 1 > edge) edge = at + 1;
    if (dir === 1 && at >= pos && at < edge) edge = at;
  });
  return edge;
}

/**
 * Expand the selection to whole lines and turn the hard breaks at (and optionally inside) the
 * target into paragraph splits, leaving the transaction's selection on the isolated lines.
 *
 * Always answers `true`: a selection this cannot resolve (no textblock to stand in) is left
 * for the chained toggle's own semantics, never a refused button press.
 */
function splitTargetLines(
  state: EditorState,
  tr: Transaction,
  splitInner: boolean,
  quotationAsLines = false,
): boolean {
  const sel = state.selection;
  // A NODE selection — a whole list or block picked as a node — is not a run of lines, and
  // narrowing it to the text inside (what `between` does) would change which node the chained
  // toggle acts on: unquoting a selected `<ul>` must lift THE LIST, not the first line in it
  // (review-caught). Left exactly as the user made it; the stock toggles know node selections.
  //
  // The one exception is OPT-IN, because each button means something different by a selected
  // QUOTATION (all three review-caught, one round each): the LIST buttons mean "list the
  // quoted lines" — they pass `quotationAsLines` and the normalisation narrows to the
  // contents; the QUOTE button never brings one here, answering the wrapper's own node
  // selection structurally before isolation is asked; and the CODE button keeps the bail, so
  // the whole quotation becomes one block rather than the exemption descending into a nested
  // list's items and leaving its shell behind.
  if (
    sel instanceof NodeSelection &&
    !(quotationAsLines && sel.node.type.name === "blockquote")
  ) return true;
  // A select-all is an AllSelection whose ends resolve to the DOCUMENT; `between` snaps both
  // ends into the outermost textblocks, which is what makes ⌘A + list one item per line.
  const textSel = sel instanceof TextSelection ? sel : TextSelection.between(sel.$from, sel.$to);
  const { $from, $to, from, to, empty } = textSel;
  if (!$from.parent.isTextblock || !$to.parent.isTextblock) return true;

  const lineStart = lineEdge($from, from, -1);
  const lineEnd = lineEdge($to, to, 1);

  /**
   * A ZERO-WIDTH LINE — the caret on an empty line, `<p>intro<br>│</p>` or `<p>a<br>│<br>b</p>`.
   * Review-caught, then measured twice: an empty line has no interior for a mapping bias to
   * hold on to, so mapping its one position inward from both sides lands on OPPOSITE sides of
   * the surrounding splits — an inverted range whose clamp put the caret on the line ABOVE,
   * and the button formatted a line the caret was not on. And no single bias serves both
   * surrounding splits: +1 pushes the caret past the break AFTER the line (onto the next
   * line), −1 keeps it before the break BEFORE it (onto the previous). So the empty line is
   * isolated explicitly — the break after it first (the caret stays at the end of the first
   * half), then the break before it (the caret moves into the split's second half, the empty
   * paragraph itself) — with the caret TRACKED through each step rather than mapped.
   */
  if (lineStart === lineEnd && empty) {
    let caret = lineStart;
    if (lineEnd < $to.end()) {
      tr.delete(caret, caret + 1);
      tr.split(caret);
    }
    if (lineStart > $from.start()) {
      tr.delete(caret - 1, caret);
      tr.split(caret - 1);
      caret += 1;
    }
    tr.setSelection(TextSelection.create(tr.doc, caret));
    return true;
  }

  const splits = new Set<number>();
  if (lineStart > $from.start()) splits.add(lineStart - 1);
  if (lineEnd < $to.end()) splits.add(lineEnd);
  if (splitInner) {
    // `nodesBetween` visits a break only while it overlaps [lineStart, lineEnd), so the two
    // boundary breaks — one ending at lineStart, one starting at lineEnd — are not re-added.
    state.doc.nodesBetween(lineStart, lineEnd, (node, pos) => {
      if (node.type.name === "hardBreak") splits.add(pos);
    });
  }

  // Descending, so each delete+split leaves every EARLIER collected position untouched.
  for (const pos of [...splits].sort((a, b) => b - a)) {
    tr.delete(pos, pos + 1);
    tr.split(pos);
  }

  // The mapped line range: bias inward on both ends, so a split exactly at an edge leaves the
  // position inside the lines rather than in the neighbour it just created. (The zero-width
  // line, where a bias has nothing to hold on to, returned above.)
  const start = tr.mapping.map(lineStart, 1);
  const end = tr.mapping.map(lineEnd, -1);
  if (empty) {
    // A caret stays a caret — the command's TARGET is the line, but nothing was selected and
    // nothing should read as selected afterwards. Clamped, because a split exactly at the
    // caret can map it just outside the isolated line.
    const caret = Math.min(Math.max(tr.mapping.map(from, -1), start), end);
    tr.setSelection(TextSelection.create(tr.doc, caret));
  } else {
    // A range takes the whole lines, INCLUDING when no split was needed: a mid-line selection
    // across two clean paragraphs still means both lines, and the toggle reads the selection.
    tr.setSelection(TextSelection.create(tr.doc, start, end));
  }
  return true;
}

/**
 * The list buttons. Inside a list already, TipTap's own toggle is right as shipped: same type
 * lifts the touched item(s) back out, the other type converts — items ARE lines, so there is
 * nothing to isolate. Outside one, the target lines are isolated first (every break becomes an
 * item boundary), and then the stock toggle wraps exactly those.
 */
function applyList(editor: Editor, list: "bulletList" | "orderedList"): void {
  const toggle = (c: ChainedCommands) =>
    list === "bulletList" ? c.toggleBulletList() : c.toggleOrderedList();
  if (editor.isActive("bulletList") || editor.isActive("orderedList")) {
    toggle(editor.chain().focus()).run();
    return;
  }
  toggle(
    editor.chain().focus().command(({ state, tr }) => splitTargetLines(state, tr, true, true)),
  ).run();
}

/**
 * The quote button. One quote for the target lines, with the breaks INSIDE it kept as breaks —
 * quoting three lines of prose is one quotation, not three (the difference from a list, where
 * every line is its own item; `splitInner` is that difference, spelled as an argument).
 *
 * The OFF direction is line-scoped too, and that is not free the way it is for lists. A list's
 * items are lines, so TipTap's own lift already takes the item the caret stands in — but this
 * command deliberately quotes several lines as ONE paragraph, so a bare `toggleBlockquote`
 * would lift all of them together and pressing Quote on one line of a three-line quotation
 * would unquote all three (review-caught). Isolating the caret's line first makes the lift
 * take exactly that line out, splitting the quotation around it, which is what unquoting one
 * line of a quotation has always meant.
 */
function applyQuote(editor: Editor): void {
  /**
   * A node-selected QUOTATION unwraps structurally, before line isolation is even asked.
   * Review-caught twice, once per wrong answer: bailing on the node selection left the press
   * INERT (TipTap's toggle cannot lift a wrapper from its own node selection), and narrowing
   * to the text inside lifted the WRONG DEPTH when the quotation's sole child was a list —
   * `between` descends into the item paragraphs, so the toggle either refused or took the
   * list apart and left the quotation standing. Unwrapping is one exact operation with no
   * range to derive: the node is replaced by its own children, whatever they are.
   */
  const sel = editor.state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === "blockquote") {
    editor.chain().focus()
      .command(({ tr }) => {
        tr.replaceWith(sel.from, sel.to, sel.node.content);
        return true;
      })
      .run();
    return;
  }
  editor.chain().focus()
    .command(({ state, tr }) => splitTargetLines(state, tr, false))
    .toggleBlockquote()
    .run();
}

/**
 * DOES THE SELECTION COVER MORE THAN ONE LINE?
 *
 * TWO WAYS IT CAN, and reading only the first is the bug this predicate exists to close. The
 * obvious one is a selection touching more than one block — two paragraphs, two list items. The
 * one that actually bit is a selection inside a SINGLE paragraph that contains hard breaks,
 * which is what almost every multi-line message here is: `EnterAsHardBreak` makes Enter a `<br>`
 * rather than a paragraph split, so "five lines pasted into a reply" is one `<p>` with four
 * `<br>`s in it. A predicate that only compared the two ends' blocks would call that one line
 * and hand it to the inline mark, which is the reported defect exactly.
 *
 * COUNTED BY WALKING, not by comparing `$from.sameParent($to)`, and the difference is not
 * academic: under an AllSelection both ends resolve to the DOCUMENT, so `sameParent` is true
 * across a whole three-paragraph message and Select-All + Code would have kept the bug in the
 * one case people reach for first.
 *
 * `nodesBetween` visits a node at `p` only while it overlaps `[from, to)`, so a break sitting
 * immediately after the selection is not counted — selecting exactly one line of a multi-line
 * paragraph is a one-line selection, which is the answer a person expects.
 */
function selectionCoversLines(editor: Editor): boolean {
  const { doc, selection } = editor.state;
  if (selection.empty) return false;
  let blocks = 0;
  let broken = false;
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.isTextblock) blocks += 1;
    if (node.type.name === "hardBreak") broken = true;
  });
  return blocks > 1 || broken;
}

/**
 * THE CODE BUTTON — one control, and which of the two code constructs it means.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────────────────
 *
 * It used to run `toggleCode()` unconditionally, and `code` is an INLINE MARK. A mark applies
 * to text runs, and a multi-line selection is several text runs with structure between them —
 * so marking it produced a separate shaded box per line, nothing at all on the blank ones (a
 * blank line has no text to mark), and the paragraph margins or line breaks showing through
 * between them as gaps. Reported as "adding a code format applies it… with spaces in between,
 * only for lines that have text", which is an exact description of what an inline mark does to
 * a block of code. There was no way to ask for the thing that was actually wanted, because
 * `codeBlock` was switched off.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────────
 *
 * A selection inside one line is inline code — `filename.txt` in a sentence, which is what the
 * mark is for. A selection covering more than one line is ONE code block. Nothing else changes
 * meaning with the selection, so this is the only command that has to ask.
 *
 * ── WHY THE BLOCK IS BUILT FROM TEXT RATHER THAN BY `setCodeBlock()` ─────────────────────
 *
 * `setCodeBlock` is `setBlockType`, which retypes each textblock it finds — so a selection over
 * three paragraphs gives THREE `<pre>` elements, one per paragraph, and the gaps the user
 * complained about come back in a different costume. Replacing the range with a single node
 * built from `textBetween(from, to, "\n", "\n")` gives one block for any selection, and it is
 * also the only form that is exact about the hard-break case: the same `"\n"` stands for a
 * block boundary and for a `<br>`, which is precisely the equivalence the rest of this file
 * (and `htmlToPlainText`) already keeps. Marks inside the selection are dropped, which is not a
 * loss but the node's own rule — `codeBlock` declares `marks: ""`, and bold inside a code block
 * is not a thing a mail client would render anyway.
 */
function applyCode(editor: Editor): void {
  // Already in a block: the button is a toggle. `toggleCodeBlock` lifts it back to a paragraph
  // and turns the block's newlines back into hard breaks (`HardBreak` is the schema's
  // `linebreakReplacement`), so the round trip loses no line the author typed.
  if (editor.isActive("codeBlock")) {
    editor.chain().focus().toggleCodeBlock().run();
    return;
  }
  const { from, to } = editor.state.selection;
  const text = selectionCoversLines(editor)
    ? editor.state.doc.textBetween(from, to, "\n", "\n")
    : "";
  // Whitespace-only, or one line, or no selection at all — the inline mark, including the
  // empty-selection case where it sets a stored mark the next characters typed will carry.
  // Guarded on the text and not only on the line count because ProseMirror refuses an empty
  // text node, so a selection of two blank lines must not become a code block of nothing.
  if (text.trim() === "") {
    editor.chain().focus().toggleCode().run();
    return;
  }
  /**
   * The block, over WHOLE LINES. The selection is expanded and isolated first
   * ({@link splitTargetLines}), for the two defects the exact-range replacement had:
   *
   *  · a mid-line selection put the block boundary mid-line, so half a sentence became code;
   *  · the boundary break stayed behind in the neighbour — `<p>one<br></p>` before the block,
   *    a dangling break that rendered (and SENT) as a stray blank line under "one". Measured,
   *    not reasoned: that exact markup came out of the pre-fix command.
   *
   * After isolation the target lines are whole textblocks, so the replacement covers the
   * NODES (`$pos.before()`/`after()`), which is what leaves no empty `<p>` where their content
   * used to be. A selection that never resolved to textblocks (nothing to isolate) keeps the
   * old exact-range behaviour, which is the select-all case the suite pins.
   */
  editor.chain().focus()
    .command(({ state, tr }) => splitTargetLines(state, tr, false))
    .command(({ state, commands }) => {
      const sel = state.selection;
      const lineText = state.doc.textBetween(sel.from, sel.to, "\n", "\n");
      const $f = state.doc.resolve(sel.from);
      const $t = state.doc.resolve(sel.to);
      const range = $f.parent.isTextblock && $t.parent.isTextblock
        ? { from: $f.before(), to: $t.after() }
        : { from: sel.from, to: sel.to };
      return commands.insertContentAt(range, {
        type: "codeBlock",
        content: [{ type: "text", text: lineText }],
      });
    })
    .run();
}

export { EMPTY_RICH };

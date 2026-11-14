"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { nextMarks } from "@ohmail/app/write/editor/marks";
import { EXTENSIONS, escapeUnlessTaken, linksIn } from "@ohmail/app/write/editor/schema";
import { applyCode, applyList, applyQuote } from "@ohmail/app/write/editor/commands";
import { PasteAsLines, readParagraphsAsLines } from "./rich-editor-paste";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { dropCarriesFiles } from "./dropped-files";
import { LinkPopover } from "./LinkPopover";
import { linkHref, useRenderedLinks } from "@ohmail/letter-body/links";
import {
  EMPTY_RICH, escapeAsParagraphs, isRichEmpty, richToHtml, type RichValue,
} from "@ohmail/app-logic/writing/rich-text";

/**
 * The compose and reply editor — eight controls: bold, italic, strike, link, bullet list, numbered list,
 * block quote, code. No fonts, colours, sizes, alignment, tables, images: the same list the server's
 * outbound-HTML sanitiser accepts — one decision at two trust boundaries, both ways (the code block was
 * admitted by moving both ends together; headings are switched off because the sanitizer discards them).
 * Markdown input rules come free from TipTap — why there is almost no toolbar. `onChange` fires `{text,
 * html}` per keystroke; `text` is the editor's own plain rendering, never what the recipient's plaintext
 * client sees (the server derives that). `value` is not React-controlled: incoming html is applied only
 * when it differs, or every keystroke would move the caret.
 */

/** The shared schema's marks and nodes, then the paste rule (`rich-editor-paste.ts`): pasted text keeps its lines. */
const EDITOR_EXTENSIONS = [...EXTENSIONS, PasteAsLines];

const NO_LINKS: readonly string[] = [];

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
  /**
   * False for a READ-ONLY VIEW of a document — no toolbar at all, rather than a disabled one.
   *
   * `editable: false` already refuses input and greys the controls, and for a send in flight
   * that is exactly right: the buttons are coming back. A view that will NEVER take input is a
   * different thing, and eight permanently dead buttons above it is the inert affordance this
   * app keeps removing. Used by the signature block and the Settings preview, which render what
   * a message will carry and are never typed into.
   */
  toolbar?: boolean;
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
  toolbar = true, onKeyDown, editorRef,
}: RichEditorProps) {
  /**
   * The last value this component EMITTED, so the sync effect below can tell the caller
   * echoing our own change back (do nothing) from the caller genuinely replacing the content
   * (re-set the document). Without it, every keystroke would be indistinguishable from an
   * external replace and the caret would jump to the end of the message.
   */
  const emitted = useRef<string>(richToHtml(value));

  /**
   * A message with no formatting reports no markup, and that is load-bearing: `getHTML()` answers
   * `<p>hi</p>` for an unformatted document, and three consumers read "there is markup" as a
   * decision — `compose.ts` would send a plain note as `multipart/alternative`,
   * `serializeRichValue`'s bare-string branch would become unreachable, and a plain send would stop
   * being byte-identical to before. The test is the ROUND TRIP, not a hand-written "contains a
   * tag": a document serialising to exactly what `richToHtml` would produce from the text alone
   * carries nothing the text does not say — asking the loader is the only check that cannot drift
   * from it (drift would surface as line breaks vanishing on reload).
   */
  /**
   * What the caller already knows — updated on render AND inside `emit`, and the second half is not
   * redundant: the no-op guard compares against this, and a prop refreshes only on render, so two
   * transactions inside one tick are both measured against the state before the first. Measured in
   * production: `setContent → toggleBold → clearContent` in one block silently dropped the clear
   * (emptying produced the same `{"",""}` the stale prop held), and the scratch buffer kept a reply
   * no longer on screen. A person cannot do that — React flushes between events — but a program
   * can: a generated draft, a paste handler, a future clear button.
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
     * A transaction that produced the value the caller already has is not a change. TipTap emits
     * `update` for things that are not edits (`setEditable` by default), the caller cannot tell
     * such an emission from a keystroke, and what it does with a change is WRITE THE SCRATCH
     * BUFFER, whose rule is that an empty value removes the key — one spurious empty emission on
     * mount is somebody's unsent message, deleted by the editor opening to show it. Compared
     * against what the caller KNOWS (`told`), not `emitted.current`, which answers a different
     * question and disagrees for a plain document (`<p>hi</p>` vs `html: ""`).
     */
    if (text === told.current.text && html === told.current.html) return;
    told.current = { text, html };
    onChange({ text, html });
  }, [onChange]);

  const editor = useEditor({
    extensions: EDITOR_EXTENSIONS,
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
      /* ⌘↵ AND ⌘⇧↵ ARE SEND'S. TipTap's HardBreak binds Mod-Enter and ProseMirror prevents a key
         a binding takes, so the keymap, which leaves a handled key alone, never heard Send.
         Answering `true` here skips ProseMirror's handling without claiming the key. */
      handleDOMEvents: {
        keydown: (view, e) => (e.key === "Enter" && (e.metaKey || e.ctrlKey)) || escapeUnlessTaken(view, e),
      },
      /* A FILE DROP IS NEVER TEXT. ProseMirror would parse the drop's html and insert the file's
         URL (WebKitGTK's file-manager drop); `true` prevents it, and the compose around the editor
         attaches the files. The editor's own moves stay ProseMirror's. */
      handleDrop: (_view, event, _slice, moved) => !moved && dropCarriesFiles(event.dataTransfer),
      attributes: {
        /**
         * The body is a multi-line text box, and it has to say so. ProseMirror's surface is a
         * `contenteditable` `<div>`, which maps to no implicit role: a reader landing on it was
         * told its name and not that it can be typed into, nor that Return inserts a line.
         * `role="textbox"` with `aria-multiline="true"` is the pair the platforms read — UIA
         * reports an Edit control with the multiline pattern, AT-SPI an editable text object — and
         * it makes the body findable by role. The name is `ariaLabel`, which every caller passes.
         * Order before `aria-label` is reading order only.
         */
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
        ...(id ? { id } : {}),
        ...(placeholder ? { "data-placeholder": placeholder } : {}),
        class: "rte-surface",
      },
    },
    onUpdate: ({ editor: e }) => emit(e),
  }, []);

  /**
   * THE LINKS THIS DOCUMENT DRAWS, ON THE SHELL'S LIST WHILE IT IS MOUNTED — a signature's, a
   * draft's (`rendered-links.ts`). Read when the editor arrives and after every transaction that
   * changed the document: `transaction` and not `update`, because content replaced from outside
   * (`setContent` with `emitUpdate: false`, below) emits no update. A change that keeps the same
   * links keeps the same array, so a keystroke reports nothing.
   */
  const [links, setLinks] = useState<readonly string[]>(NO_LINKS);
  useEffect(() => {
    if (!editor) return undefined;
    let read: ProseMirrorNode | null = null;
    const look = (): void => {
      if (editor.state.doc === read) return;
      read = editor.state.doc;
      const next = linksIn(read, linkHref);
      setLinks((prev) => (prev.length === next.length && prev.every((l, i) => l === next[i]) ? prev : next));
    };
    look();
    editor.on("transaction", look);
    return () => {
      editor.off("transaction", look);
    };
  }, [editor]);
  useRenderedLinks(links);

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
    editor.chain().setContent(incoming, { emitUpdate: false }).command(readParagraphsAsLines).run();
  }, [editor, value.html, value.text]);

  useEffect(() => {
    if (editor && autoFocus) editor.commands.focus("end", { scrollIntoView: false });
  }, [editor, autoFocus]);

  /**
   * Mid-send. `setEditable` rather than a fresh editor, so the document, the caret and the
   * undo history all survive being locked and unlocked — a failed send must hand the message
   * back exactly as it was.
   */
  useEffect(() => {
    /**
     * `emitUpdate: false` — the second argument is load-bearing and its default is wrong here.
     * `setEditable(editable)` defaults to emitting an `update`, and this effect runs on mount: a
     * freshly mounted editor announced a change it had not had, carrying its empty starting
     * document — and Compose's `onChange` writes the scratch buffer, whose rule removes the key for
     * an empty form. Opening Compose therefore DELETED the half-written message it was about to
     * restore (measured: the buffer held text before the remount and nothing after). The guard in
     * `emit` closes the same hole from the other side; both are kept.
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
    if (focusEditor) editor?.commands.focus(null, { scrollIntoView: false });
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
   * The placeholder is a class on the wrapper, not TipTap's `Placeholder` extension: that lives in
   * `@tiptap/extensions`, a transitive dependency this app does not name, and reaching into it
   * would tie the editor's behaviour to a package outside the manifest. `.rte-surface::before`
   * reads the `data-placeholder` attribute already on the surface — no new dependency, no plugin in
   * the transaction pipeline. Emptiness is decided on the TEXT, by the same predicate that decides
   * whether there is anything to send: an empty document serialises to `<p></p>`, so a markup test
   * would hide the placeholder on mount.
   */
  const cls = [
    "rte",
    isRichEmpty(value) ? "is-empty" : "",
    editable ? "" : "is-locked",
    className ?? "",
  ].filter(Boolean).join(" ");

  /**
   * `rte-body` — the middle link of the chain, and the reason the box had a dead zone. `EditorContent`
   * renders a `<div>` of its own and appends the `contenteditable` INSIDE it, so the flex child of `.rte`
   * is that div — and it was unclassed: `.compose-editor .rte-surface{flex:1}` named an element whose
   * parent was not a flex container, the surface stayed at content height, and a click below the first
   * line landed on the wrapper ("the textbox can't be clicked fully"). The fix is the chain, not a
   * handler: `.rte` → `.rte-body` → `.rte-surface` all pass the height down; a click inside a
   * `contenteditable` is then the browser's own caret placement. A click-to-focus handler would fight the
   * browser for selection and leave the real defect underneath.
   */
  return (
    <div className={cls}>
      {toolbar ? (
        <Toolbar
          editor={editor}
          editable={editable}
          linkOpen={linkOpen}
          onLinkToggle={() => setLinkOpen((open) => !open)}
          onLinkClose={closeLink}
        />
      ) : null}
      <EditorContent editor={editor} className="rte-body" onKeyDown={onEditorKeyDown} />
    </div>
  );
}

/**
 * The toolbar, and why it is fixed rather than a bubble menu. A bubble menu
 * appears on selection, so the controls are invisible until you already
 * know they exist — fine for a document editor somebody lives in, wrong for
 * a reply box opened twice a day. Eight buttons in a row, always in the
 * same place, is the smaller thing to learn, and the accessible one: a menu
 * that materialises near a selection is a focus-order problem; this is a
 * plain row in the tab order. Each button reports its pressed state from
 * the editor, so the row says what the cursor is standing in.
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
   * The pressed states, subscribed rather than read during render. `useEditor` does not re-render
   * its owner on every transaction (a deliberate TipTap 3 decision), so a toolbar calling
   * `editor.isActive()` in its render body paints the state as of the last React render and sits
   * there while the caret moves — measured: the first version's test read `aria-pressed="false"`
   * immediately after a successful `toggleBold`. `useEditorState` subscribes to the transactions
   * and re-renders only when one of these eight booleans changes, which is the whole reason to
   * select them rather than the editor.
   */
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      // With nothing selected a mark button answers "does the next letter carry this" through
      // the SAME function the text-input plugin decides by (`toolbar-next`); over a selection it
      // answers "is the whole selection marked", Tiptap's own reading.
      const carried = e && e.state.selection.empty
        ? new Set(nextMarks(e.state).map((m) => m.type.name))
        : null;
      const mark = (name: string): boolean =>
        carried ? carried.has(name) : (e?.isActive(name) ?? false);
      return {
        bold: mark("bold"),
        italic: mark("italic"),
        strike: mark("strike"),
        // ONE button, two constructs, so its pressed state has to answer for both — a caret
        // sitting in a code block with an unlit Code button is a control that says the text is
        // not code while the text is code, and pressing it would then be the only way to find
        // out that it toggles the block off.
        code: mark("code") || (e?.isActive("codeBlock") ?? false),
        bullet: e?.isActive("bulletList") ?? false,
        ordered: e?.isActive("orderedList") ?? false,
        quote: e?.isActive("blockquote") ?? false,
      };
    },
  });

  if (!editor || !active) return null;

  const btn = (
    key: string,
    isActive: boolean | null,
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
      // control answers, and a sighted user reads it from the highlight. `null` is the link
      // button, which is not a toggle and claims no pressed state (`link-not-toggle`).
      aria-pressed={isActive ?? undefined}
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
      {btn("link", null, onLinkToggle, { "aria-haspopup": "dialog", "aria-expanded": linkOpen })}
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

export { EMPTY_RICH };

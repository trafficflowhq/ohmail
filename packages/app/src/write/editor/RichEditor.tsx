/**
 * THE RICH EDITOR: the letter's text over the one schema every editor of a letter shares (`schema.ts`), reporting
 * `{ text, html }` exactly as the web shell's editor does, so a plain note stays plain on the wire. It hands the
 * screen a handle (its marks, an insert at the caret, focus) and keeps nothing of the letter beyond what Tiptap
 * holds while it is mounted.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, type Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { dropCarriesFiles } from "@ohmail/app-logic/write/dropped-files";
import { richToHtml, type RichValue } from "@ohmail/app-logic/writing/rich-text";
import type { EditorHandle, EditorMarks, EditorProps, MarkId, ParagraphStyle } from "../ports.js";
import { applyCodeBlock, applyDivider, applyList, applyParagraphStyle, applyQuote } from "./commands.js";
import { linkAtCaret, nextMarks } from "./marks.js";
import { EXTENSIONS, escapeUnlessTaken, linksIn } from "./schema.js";
import { LETTER_TEXT, LetterNames } from "./letter-names.js";
import { QuotedHistory, appendHistory, historyIn, historyValue } from "./quoted-history.js";
import { HistorySelection } from "./history-selection.js";
import { HistoryEditorContent } from "./HistoryEditorContent.js";
import { UnlinkedText } from "./unlinked-text.js";
import { openEditorLink } from "./edit-link.js";
import { revealWritingSelection } from "./scroll-selection.js";
import { FormatExtensions } from "./formats.js";
import { editorShortcuts, LINK_KEY } from "./shortcuts.js";
import { chordMatches } from "@ohmail/app-logic/keys";
import { isSendKey } from "../keys.js";
import { PasteAsLines, readParagraphsAsLines } from "./paste.js";

/** The links a body reads, handed by the shell that mounts the body (the folder imports nothing of it). */
export interface EditorLinks {
  /** The address a link in the text reads as, or null when it is none the body would draw. */
  href(raw: string): string | null;
  /** The links this text draws, on the shell's list while it is mounted. */
  useRendered(hrefs: readonly string[]): void;
}

/** The marks this editor offers, in the strip's order. */
export const RICH_MARKS: readonly MarkId[] = [
  "bold",
  "italic",
  "underline",
  "strike",
  "link",
  "numbers",
  "bullets",
  "quote",
  "code",
  "codeBlock",
  "divider",
];

const NO_LINKS: readonly string[] = [];
/**
 * The schema, the names the kit's sheet reads stamped on the view alone, and the paste rule (`paste.ts`): pasted
 * text keeps its lines, and a draft's paragraphs are read as lines when it is put back.
 */
const DRAWN = [...EXTENSIONS, QuotedHistory, ...FormatExtensions, LetterNames, PasteAsLines, UnlinkedText];

/** The marks that hold where the caret is: the next letter's marks with nothing selected, the selection's otherwise. */
function activeIn(editor: Editor): ReadonlySet<MarkId> {
  const carried = editor.state.selection.empty
    ? new Set(nextMarks(editor.state).map((m) => m.type.name))
    : null;
  const mark = (name: string): boolean => (carried ? carried.has(name) : editor.isActive(name));
  const on = new Set<MarkId>();
  if (mark("bold")) on.add("bold");
  if (mark("italic")) on.add("italic");
  if (mark("underline")) on.add("underline");
  if (mark("strike")) on.add("strike");
  if (mark("code")) on.add("code");
  if (editor.isActive("codeBlock")) on.add("codeBlock");
  if (editor.isActive("bulletList")) on.add("bullets");
  if (editor.isActive("orderedList")) on.add("numbers");
  if (editor.isActive("blockquote")) on.add("quote");
  if (linkAtCaret(editor.state) !== null) on.add("link");
  return on;
}

function marksOf(editor: Editor, asks: Set<() => void>): EditorMarks {
  return {
    ids: RICH_MARKS,
    shortcuts: editorShortcuts,
    active: () => activeIn(editor),
    subscribe(changed) {
      editor.on("transaction", changed);
      return () => {
        editor.off("transaction", changed);
      };
    },
    run(id) {
      keepNativeSelection(editor.view);
      if (id === "bold") editor.chain().focus().toggleBold().run();
      else if (id === "italic") editor.chain().focus().toggleItalic().run();
      else if (id === "underline") editor.chain().focus().toggleUnderline().run();
      else if (id === "strike") editor.chain().focus().toggleStrike().run();
      else if (id === "code") editor.chain().focus().toggleCode().run();
      else if (id === "codeBlock") applyCodeBlock(editor);
      else if (id === "divider") applyDivider(editor);
      else if (id === "bullets") applyList(editor, "bulletList");
      else if (id === "numbers") applyList(editor, "orderedList");
      else if (id === "quote") applyQuote(editor);
    },
    paragraph: {
      active() {
        for (const level of [1, 2, 3] as const) {
          if (editor.isActive("heading", { level })) return level;
        }
        return editor.isActive("paragraph") ? 0 : null;
      },
      set(style: ParagraphStyle) {
        keepNativeSelection(editor.view);
        applyParagraphStyle(editor, style);
      },
    },
    link: {
      open() {
        keepNativeSelection(editor.view);
        return openEditorLink(editor);
      },
      onKey(ask) {
        asks.add(ask);
        return () => {
          asks.delete(ask);
        };
      },
    },
  };
}

/** Mod+K asks for the link, as the strip's Link does: the app's own Mod+K gets no key from the text. */
function askedLink(editable: boolean, e: KeyboardEvent, asks: ReadonlySet<() => void>): boolean {
  if (!chordMatches(LINK_KEY, e)) return false;
  if (!editable || asks.size === 0) return false;
  e.preventDefault();
  for (const ask of asks) ask();
  return true;
}

/** Keep the native range before a pending editor update restores the previous selection. */
function syncArrowSelection(view: EditorView, event: KeyboardEvent): boolean {
  if (!event.shiftKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return false;
  keepNativeSelection(view);
  return false;
}

function keepNativeSelection(view: EditorView): void {
  if (!view.hasFocus()) return;
  const selection = view.dom.ownerDocument.getSelection();
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !view.dom.contains(selection.anchorNode) ||
    !view.dom.contains(selection.focusNode)
  )
    return;
  const { state } = view;
  const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
  const head = view.posAtDOM(selection.focusNode, selection.focusOffset);
  const next = TextSelection.between(state.doc.resolve(anchor), state.doc.resolve(head));
  if (!next.eq(state.selection)) view.dispatch(state.tr.setSelection(next));
}

/** Plain words at the caret: one run per line with a break between, so a one-line insert takes the caret's marks. */
function inlineOf(text: string): { type: string; text?: string }[] {
  return text
    .split("\n")
    .flatMap((line, at) => [
      ...(at > 0 ? [{ type: "hardBreak" }] : []),
      ...(line === "" ? [] : [{ type: "text", text: line }]),
    ]);
}

export function RichEditor({
  links,
  value,
  onChange,
  label,
  quotedHistory,
  placeholder,
  editable,
  focusAtMount,
  onSendKey,
  onLeaveKey,
  onHandle,
}: EditorProps & { readonly links: EditorLinks }) {
  /** What this editor last emitted, so the caller echoing it back is not taken for a replacement. */
  const emitted = useRef<string>(richToHtml(value));
  /** What the caller knows: a transaction that lands on it is no change (an empty emission would delete a draft). */
  const told = useRef<RichValue>(value);
  told.current = value;
  const keys = useRef({ onChange, onSendKey, onLeaveKey });
  keys.current = { onChange, onSendKey, onLeaveKey };
  const asks = useRef(new Set<() => void>()).current;

  const original = useRef<ProseMirrorNode | null>(null);
  const historyVisible = useRef(false);

  const editor = useEditor(
    {
      extensions: [...DRAWN, HistorySelection.configure({ visible: () => historyVisible.current })],
      content: richToHtml(value),
      editable,
      immediatelyRender: false,
      editorProps: {
        handleScrollToSelection: revealWritingSelection,
        handleDOMEvents: {
          keyup: syncArrowSelection,
          keydown: (view, event) => editorKeyDown(view, event, keys.current, asks),
        },
        handleDrop: (_view, event, _slice, moved) => !moved && dropCarriesFiles(event.dataTransfer),
        attributes: {
          class: LETTER_TEXT,
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": label,
          "aria-placeholder": placeholder,
        },
      },
      onUpdate: ({ editor: e, transaction }) => {
        const { text, html } = readEditorValue(
          e,
          original.current,
          historyVisible.current,
          transaction.before,
        );
        emitted.current = richToHtml({ text, html });
        if (text === told.current.text && html === told.current.html) return;
        told.current = { text, html };
        keys.current.onChange({ text, html });
      },
    },
    [],
  );

  /* Content replaced from outside (a draft restored, a draft landing): applied only when it differs. */
  const { text, html } = value;
  useEffect(() => {
    if (!editor) return;
    const incoming = richToHtml({ text, html });
    if (incoming === emitted.current) return;
    if (incoming === (editor.isEmpty ? "" : editor.getHTML())) return;
    emitted.current = incoming;
    editor.chain().setContent(incoming, { emitUpdate: false }).command(readParagraphsAsLines).run();
    if (original.current !== null && historyIn(editor.state.doc) === undefined) {
      appendHistory(editor, original.current);
    }
  }, [editor, html, text]);

  /* Locked while a send is in flight: the document, the caret and the history stay; no update is emitted. */
  useEffect(() => {
    editor?.setEditable(editable, false);
  }, [editor, editable]);

  useEffect(() => {
    if (editor && focusAtMount) {
      const history = historyIn(editor.state.doc);
      editor.commands.focus(history === undefined ? "end" : Math.max(1, history.pos - 1), {
        scrollIntoView: false,
      });
    }
  }, [editor, focusAtMount]);

  const handle = useEditorHandle(editor, asks);
  useEffect(() => {
    onHandle(handle);
    return () => onHandle(null);
  }, [handle, onHandle]);

  links.useRendered(useDrawnLinks(editor, links));

  return (
    <HistoryEditorContent
      editor={editor}
      quotedHistory={quotedHistory}
      editable={editable}
      original={original}
      historyVisible={historyVisible}
    />
  );
}

function useEditorHandle(editor: Editor | null, asks: Set<() => void>) {
  return useMemo<EditorHandle | null>(
    () =>
      editor
        ? {
            marks: marksOf(editor, asks),
            focus: () => editor.commands.focus(null, { scrollIntoView: false }),
            insert: (text, how) => {
              if (how === "replace") {
                const history = historyIn(editor.state.doc);
                editor
                  .chain()
                  .setContent(richToHtml(text), { emitUpdate: true })
                  .command(({ tr }) => {
                    if (history !== undefined) tr.insert(tr.doc.content.size, history.node);
                    return true;
                  })
                  .run();
              } else
                editor
                  .chain()
                  .focus(null, { scrollIntoView: false })
                  .insertContent(text.html !== "" ? text.html : inlineOf(text.text))
                  .run();
            },
          }
        : null,
    [editor, asks],
  );
}

function readEditorValue(
  editor: Editor,
  original: ProseMirrorNode | null,
  visible: boolean,
  before: ProseMirrorNode,
): RichValue {
  // Selecting all while the history is folded selects the written note.
  if (!visible && historyIn(editor.state.doc) === undefined) {
    const folded = historyIn(before);
    if (folded !== undefined) appendHistory(editor, folded.node);
  }
  return historyValue(editor.state.doc, original);
}

/** The links the text draws, on the shell's list while it is mounted; a keystroke that keeps them reports none. */
function useDrawnLinks(editor: Editor | null, links: EditorLinks): readonly string[] {
  const [hrefs, setHrefs] = useState<readonly string[]>(NO_LINKS);
  useEffect(() => {
    if (!editor) return undefined;
    let read: ProseMirrorNode | null = null;
    const look = (): void => {
      if (editor.state.doc === read) return;
      read = editor.state.doc;
      const next = linksIn(read, (raw) => links.href(raw));
      setHrefs((prev) => (prev.length === next.length && prev.every((l, i) => l === next[i]) ? prev : next));
    };
    look();
    editor.on("transaction", look);
    return () => {
      editor.off("transaction", look);
    };
  }, [editor, links]);
  return hrefs;
}

function editorKeyDown(
  view: EditorView,
  e: KeyboardEvent,
  keys: Pick<EditorProps, "onSendKey" | "onLeaveKey">,
  asks: ReadonlySet<() => void>,
): boolean {
  /* Mod+Shift+Enter is Send + Done, the app's key (bound where the reply's composer is): answered here only
     so that the editor's own Mod-Enter (a line break) does not take it, and left to reach the binding. */
  if (isSendKey(e)) {
    const send = keys.onSendKey;
    if (!e.shiftKey && send) {
      e.preventDefault();
      send();
    }
    return true;
  }
  if (askedLink(view.editable, e, asks)) return true;
  // The browser can move the caret before its selectionchange reaches ProseMirror.
  // Use the visible caret so Enter cannot replace the text that was previously selected.
  const selection = view.state.selection;
  if (
    e.key === "Enter" &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.isComposing &&
    e.keyCode !== 229 &&
    !view.composing &&
    view.editable &&
    selection instanceof TextSelection &&
    !selection.empty &&
    view.dom.ownerDocument.getSelection()?.isCollapsed
  ) {
    keepNativeSelection(view);
  }
  if (!escapeUnlessTaken(view, e)) return false;
  /* An Escape none of the editor's own bindings took is the screen's, and claimed for it. */
  const leave = keys.onLeaveKey;
  if (!e.defaultPrevented && leave) {
    e.preventDefault();
    leave();
  }
  return true;
}

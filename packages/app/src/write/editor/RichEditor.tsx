/**
 * THE RICH EDITOR: the letter's text over the one schema every editor of a letter shares (`schema.ts`), reporting
 * `{ text, html }` exactly as the web shell's editor does, so a plain note stays plain on the wire. It hands the
 * screen a handle (its marks, an insert at the caret, focus) and keeps nothing of the letter beyond what Tiptap
 * holds while it is mounted.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { escapeAsParagraphs, richToHtml, type RichValue } from "@ohmail/app-logic/writing/rich-text";
import type { EditorHandle, EditorMarks, EditorProps, MarkId } from "../ports.js";
import { applyCode, applyList, applyQuote } from "./commands.js";
import { linkAtCaret, nextMarks, normalizeHref } from "./marks.js";
import { EXTENSIONS, escapeUnlessTaken, linksIn } from "./schema.js";
import { LETTER_TEXT, LetterNames } from "./letter-names.js";
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
  "code",
  "link",
  "bullets",
  "numbers",
  "quote",
];

const NO_LINKS: readonly string[] = [];
/**
 * The schema, the names the kit's sheet reads stamped on the view alone, and the paste rule (`paste.ts`): pasted
 * text keeps its lines, and a draft's paragraphs are read as lines when it is put back.
 */
const DRAWN = [...EXTENSIONS, LetterNames, PasteAsLines];

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
  if (mark("code") || editor.isActive("codeBlock")) on.add("code");
  if (editor.isActive("bulletList")) on.add("bullets");
  if (editor.isActive("orderedList")) on.add("numbers");
  if (editor.isActive("blockquote")) on.add("quote");
  if (linkAtCaret(editor.state) !== null) on.add("link");
  return on;
}

function marksOf(editor: Editor, asks: Set<() => void>): EditorMarks {
  return {
    ids: RICH_MARKS,
    active: () => activeIn(editor),
    subscribe(changed) {
      editor.on("transaction", changed);
      return () => {
        editor.off("transaction", changed);
      };
    },
    run(id) {
      if (id === "bold") editor.chain().focus().toggleBold().run();
      else if (id === "italic") editor.chain().focus().toggleItalic().run();
      else if (id === "underline") editor.chain().focus().toggleUnderline().run();
      else if (id === "strike") editor.chain().focus().toggleStrike().run();
      else if (id === "code") applyCode(editor);
      else if (id === "bullets") applyList(editor, "bulletList");
      else if (id === "numbers") applyList(editor, "orderedList");
      else if (id === "quote") applyQuote(editor);
    },
    link: {
      open() {
        const { view } = editor;
        keepNativeSelection(view);
        const { doc, selection, storedMarks } = editor.state;
        let editedDoc = doc;
        return {
          href: (linkAtCaret(editor.state)?.attrs.href as string | undefined) ?? null,
          set(raw) {
            const href = raw === null ? "" : normalizeHref(raw);
            if (href === null || editor.isDestroyed || editor.state.doc !== doc) return "refused";
            const chain = editor
              .chain()
              .command(({ tr }) => {
                tr.setSelection(selection).setStoredMarks(storedMarks);
                return true;
              })
              .extendMarkRange("link");
            const changed = href === "" ? chain.unsetLink().run() : chain.setLink({ href }).run();
            editedDoc = editor.state.doc;
            return changed ? "ok" : "refused";
          },
          restore() {
            if (editor.isDestroyed) return;
            if (editor.state.doc === editedDoc && !selection.eq(editor.state.selection)) {
              const tr = editor.state.tr;
              view.dispatch(tr.setSelection(selection.getBookmark().resolve(tr.doc)));
            }
            editor.commands.focus(null, { scrollIntoView: false });
          },
        };
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
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return false;
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

/**
 * A drop of files is never text: the composer around the editor takes the files. Three shapes: File objects, the
 * `Files` type, and a drop whose files are withheld (a Linux file manager's: no File, `text/uri-list` listed, its
 * data unreadable or every entry `file:`), whose URL the editor would otherwise insert.
 */
function carriesFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = [...(dt.types ?? [])];
  if ((dt.files?.length ?? 0) > 0 || types.includes("Files")) return true;
  if (!types.includes("text/uri-list")) return false;
  let data = "";
  try {
    data = dt.getData("text/uri-list");
  } catch {
    data = "";
  }
  const entries = data
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  return entries.every((entry) => /^file:/i.test(entry));
}

export function RichEditor({
  links,
  value,
  onChange,
  label,
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
  /** Who asks for a link on Mod+K: the strip's card, while it stands. */
  const asks = useRef(new Set<() => void>()).current;

  const editor = useEditor(
    {
      extensions: DRAWN,
      content: richToHtml(value),
      editable,
      immediatelyRender: false,
      editorProps: {
        handleDOMEvents: {
          keyup: syncArrowSelection,
          keydown: (view, event) => editorKeyDown(view, event, keys.current, asks),
        },
        handleDrop: (_view, event, _slice, moved) => !moved && carriesFiles(event.dataTransfer),
        attributes: {
          class: LETTER_TEXT,
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": label,
          "aria-placeholder": placeholder,
        },
      },
      onUpdate: ({ editor: e }) => {
        const text = e.getText({ textSerializers: { hardBreak: () => "\n" } });
        const markup = e.isEmpty ? "" : e.getHTML();
        const html = markup === escapeAsParagraphs(text) ? "" : markup;
        emitted.current = markup;
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
  }, [editor, html, text]);

  /* Locked while a send is in flight: the document, the caret and the history stay; no update is emitted. */
  useEffect(() => {
    editor?.setEditable(editable, false);
  }, [editor, editable]);

  useEffect(() => {
    if (editor && focusAtMount) editor.commands.focus("end", { scrollIntoView: false });
  }, [editor, focusAtMount]);

  const handle = useMemo<EditorHandle | null>(
    () =>
      editor
        ? {
            marks: marksOf(editor, asks),
            focus: () => editor.commands.focus(null, { scrollIntoView: false }),
            insert: (text, how) => {
              if (how === "replace") editor.commands.setContent(richToHtml(text), { emitUpdate: true });
              else
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
  useEffect(() => {
    onHandle(handle);
    return () => onHandle(null);
  }, [handle, onHandle]);

  links.useRendered(useDrawnLinks(editor, links));

  return <EditorContent editor={editor} />;
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
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    const send = keys.onSendKey;
    if (!e.shiftKey && send) {
      e.preventDefault();
      send();
    }
    return true;
  }
  if (askedLink(view.editable, e, asks)) return true;
  if (!escapeUnlessTaken(view, e)) return false;
  /* An Escape none of the editor's own bindings took is the screen's, and claimed for it. */
  const leave = keys.onLeaveKey;
  if (!e.defaultPrevented && leave) {
    e.preventDefault();
    leave();
  }
  return true;
}

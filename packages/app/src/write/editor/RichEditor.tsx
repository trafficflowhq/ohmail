/**
 * THE RICH EDITOR: the letter's text over the one schema every editor of a letter shares (`schema.ts`), reporting
 * `{ text, html }` exactly as the web shell's editor does, so a plain note stays plain on the wire. It hands the
 * screen a handle (its marks, an insert at the caret, focus) and keeps nothing of the letter beyond what Tiptap
 * holds while it is mounted.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { escapeAsParagraphs, richToHtml, type RichValue } from "@ohmail/app-logic/writing/rich-text";
import type { EditorHandle, EditorMarks, EditorProps, MarkId } from "../ports.js";
import { applyCode, applyList, applyQuote } from "./commands.js";
import { linkAtCaret, nextMarks, normalizeHref } from "./marks.js";
import { EXTENSIONS, escapeUnlessTaken, linksIn } from "./schema.js";
import { LETTER_TEXT, LetterNames } from "./letter-names.js";

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
/** The schema, and the names the kit's sheet reads stamped on the view alone. */
const DRAWN = [...EXTENSIONS, LetterNames];

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
      read: () => (linkAtCaret(editor.state)?.attrs.href as string | undefined) ?? null,
      set(raw) {
        const href = raw === null ? "" : normalizeHref(raw);
        if (href === null) return "refused";
        const chain = editor.chain().focus().extendMarkRange("link");
        if (href === "") {
          chain.unsetLink().run();
          return "ok";
        }
        return chain.setLink({ href }).run() ? "ok" : "refused";
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

/** Plain words at the caret: one run per line with a break between, so a one-line insert takes the caret's marks. */
function inlineOf(text: string): { type: string; text?: string }[] {
  return text
    .split("\n")
    .flatMap((line, at) => [
      ...(at > 0 ? [{ type: "hardBreak" }] : []),
      ...(line === "" ? [] : [{ type: "text", text: line }]),
    ]);
}

/** A drop of files is never text: the composer around the editor takes the files. */
const carriesFiles = (dt: DataTransfer | null): boolean =>
  (dt?.files?.length ?? 0) > 0 || [...(dt?.types ?? [])].includes("Files");

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
      immediatelyRender: false,
      editorProps: {
        handleDOMEvents: {
          keydown: (view, e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              keys.current.onSendKey();
              return true;
            }
            if (askedLink(view.editable, e, asks)) return true;
            if (!escapeUnlessTaken(view, e)) return false;
            /* An Escape none of the editor's own bindings took is the screen's, and claimed for it. */
            if (!e.defaultPrevented) {
              e.preventDefault();
              keys.current.onLeaveKey();
            }
            return true;
          },
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
    editor.commands.setContent(incoming, { emitUpdate: false });
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
                  .focus()
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

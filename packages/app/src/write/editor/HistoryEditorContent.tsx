import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { EditorContent, type Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { Selection } from "@tiptap/pm/state";
import { useAfterComposerTextTarget } from "@ohmail/ui/mail";
import { Button } from "@ohmail/ui/base";
import type { QuotedHistoryControl } from "../text/history-ports.js";
import { appendHistory, historyIn, originalHistory } from "./quoted-history.js";
import "./history-style.css";

function AfterComposerText({ children }: { children: ReactNode }) {
  const target = useAfterComposerTextTarget();
  return target === undefined ? children : target ? createPortal(children, target) : null;
}

export function HistoryEditorContent({
  editor,
  quotedHistory,
  editable,
  original,
  historyVisible,
}: {
  readonly editor: Editor | null;
  readonly quotedHistory: QuotedHistoryControl | undefined;
  readonly editable: boolean;
  readonly original: RefObject<ProseMirrorNode | null>;
  readonly historyVisible: RefObject<boolean>;
}) {
  useVisibleCaret(editor);
  const [mode, setMode] = useState<"collapsed" | "preview" | "edit">("collapsed");
  const historyOpen = mode !== "collapsed";
  const [historyPending, setHistoryPending] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);

  const owner = useRef<object | null>(null);
  useLayoutEffect(() => {
    owner.current = {};
    return () => {
      owner.current = null;
    };
  }, [editor]);

  async function loadOriginal() {
    if (!quotedHistory || !editor || editor.isDestroyed) return null;
    if (original.current !== null) return original.current;
    setHistoryPending(true);
    setHistoryFailed(false);
    const started = owner.current;
    try {
      const messages = await quotedHistory.load();
      if (!started || owner.current !== started || editor.isDestroyed) return null;
      if (messages.length === 0) {
        setHistoryFailed(true);
        return null;
      }
      return (original.current = originalHistory(editor.schema, messages));
    } catch {
      if (owner.current === started && !editor.isDestroyed) setHistoryFailed(true);
      return null;
    } finally {
      if (owner.current === started && !editor.isDestroyed) setHistoryPending(false);
    }
  }

  async function openHistory(edit: boolean) {
    if (!editor) return;
    if (historyOpen && !edit) {
      historyVisible.current = false;
      setMode("collapsed");
      editor.view.dispatch(editor.state.tr);
      return;
    }
    if (historyIn(editor.state.doc) === undefined) {
      const started = owner.current;
      const node = await loadOriginal();
      if (owner.current !== started || node === null || editor.isDestroyed || !editor.isEditable) return;
      appendHistory(editor, node);
    }
    historyVisible.current = edit;
    setMode(edit ? "edit" : "preview");
    if (!edit) return;
    const { state, view } = editor;
    const history = historyIn(state.doc);
    if (history) {
      view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(history.pos + 1))));
      editor.commands.focus(null, { scrollIntoView: false });
    }
  }

  async function restoreHistory() {
    const started = owner.current;
    const node = await loadOriginal();
    if (owner.current !== started || !editor || node === null || editor.isDestroyed || !editor.isEditable)
      return;
    const { state, view } = editor;
    const history = historyIn(state.doc);
    if (history?.node.eq(node)) return;
    const pos = history?.pos ?? state.doc.content.size;
    const tr = closeHistory(state.tr.replaceWith(pos, pos + (history?.node.nodeSize ?? 0), node));
    view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(pos + 1))));
    editor.commands.focus(null, { scrollIntoView: false });
  }

  return (
    <>
      <EditorContent editor={editor} className={historyOpen ? undefined : "write-history-folded"} />
      {quotedHistory && (
        <AfterComposerText>
          <div className="write-history-controls">
            <Button
              kind="quiet"
              size="s"
              label={historyOpen ? quotedHistory.hide : quotedHistory.show}
              expanded={historyOpen}
              disabled={!editable || historyPending}
              onPress={() => void openHistory(false)}
            >
              …
            </Button>
            <Button
              kind="quiet"
              size="s"
              disabled={!editable || historyPending}
              onPress={mode === "edit" ? () => void restoreHistory() : () => void openHistory(true)}
            >
              {mode === "edit" ? quotedHistory.restore : quotedHistory.edit}
            </Button>
            {historyFailed && <span role="status">{quotedHistory.unavailable}</span>}
          </div>
        </AfterComposerText>
      )}
    </>
  );
}

/** A paste can wrap the draft action onto another row after the editor first reveals the caret. */
function useVisibleCaret(editor: Editor | null) {
  useEffect(() => {
    if (!editor || typeof ResizeObserver !== "function") return;
    const port = editor.view.dom.closest(".oh-composer-scroll");
    if (!port) return;
    const watch = new ResizeObserver(() => {
      if (editor.isFocused && editor.state.selection.empty) editor.commands.scrollIntoView();
    });
    watch.observe(port);
    return () => watch.disconnect();
  }, [editor]);
}

import { Node, getHTMLFromFragment, getTextBetween, type Editor } from "@tiptap/react";
import { Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import {
  escapeAsParagraphs,
  QUOTED_HISTORY_ATTRIBUTE,
  type RichValue,
} from "@ohmail/app-logic/writing/rich-text";

const NAME = "quotedHistory";

export const QuotedHistory = Node.create({
  name: NAME,
  group: "block",
  content: "block*",
  isolating: true,
  parseHTML: () => [{ tag: `blockquote[${QUOTED_HISTORY_ATTRIBUTE}="edited"]`, priority: 60 }],
  renderHTML: () => ["blockquote", { [QUOTED_HISTORY_ATTRIBUTE]: "edited" }, 0],
});

/** Loading a quote opens it in the editor without changing the draft or its Undo history. */
export function appendHistory(editor: Editor, node: ProseMirrorNode): void {
  const tr = editor.state.tr;
  editor.view.dispatch(
    tr.insert(tr.doc.content.size, node).setMeta("addToHistory", false).setMeta("preventUpdate", true),
  );
}

export function originalHistory(schema: Schema, messages: readonly string[]): ProseMirrorNode {
  const quotes = messages.map((message) => {
    const lines = message
      .split("\n")
      .flatMap((line, index) => [
        ...(index > 0 ? [schema.nodes.hardBreak!.create()] : []),
        ...(line.length > 0 ? [schema.text(line)] : []),
      ]);
    return schema.nodes.blockquote!.create(null, schema.nodes.paragraph!.create(null, lines));
  });
  return schema.nodes[NAME]!.create(null, quotes);
}

export function historyIn(doc: ProseMirrorNode) {
  let found: { node: ProseMirrorNode; pos: number } | undefined;
  doc.forEach((node, pos) => {
    if (node.type.name === NAME) found = { node, pos };
  });
  return found;
}

/** Only an edit takes the history into the saved and sent body. */
export function historyValue(doc: ProseMirrorNode, original: ProseMirrorNode | null): RichValue {
  const history = historyIn(doc);
  let body = doc;
  if (history !== undefined && original !== null && history.node.eq(original)) {
    body = doc.copy(
      doc.content.cut(0, history.pos).append(doc.content.cut(history.pos + history.node.nodeSize)),
    );
  } else if (history === undefined && original !== null) {
    body = doc.copy(doc.content.append(Fragment.from(doc.type.schema.nodes[NAME]!.create())));
  }
  const dividerOnly =
    body.childCount === 2 &&
    body.firstChild?.type.name === "horizontalRule" &&
    body.lastChild?.type.name === "paragraph" &&
    body.lastChild.content.size === 0;
  const text = dividerOnly
    ? "--------"
    : getTextBetween(
        body,
        { from: 0, to: body.content.size },
        {
          blockSeparator: "\n\n",
          textSerializers: { hardBreak: () => "\n", horizontalRule: () => "--------" },
        },
      );
  const markup =
    body.childCount === 0 ||
    (body.childCount === 1 &&
      body.firstChild?.type.name === "paragraph" &&
      body.firstChild.content.size === 0)
      ? ""
      : getHTMLFromFragment(body.content, doc.type.schema);
  return { text, html: markup === escapeAsParagraphs(text) ? "" : markup };
}

import { Extension, InputRule } from "@tiptap/react";
import Heading from "@tiptap/extension-heading";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import { Mapping } from "@tiptap/pm/transform";
import { Plugin } from "@tiptap/pm/state";
import { AUTHORED_CODE_STYLE } from "@ohmail/app-logic/writing/rich-text";
import type { ParagraphStyle } from "../ports.js";
import { applyCodeBlock, applyParagraphStyle, splitTargetLines } from "./commands.js";

export const CODE_KEYS = { code: "mod+shift+c", codeBlock: "mod+alt+shift+c" } as const;
export const PARAGRAPH_STYLES = [0, 1, 2, 3] as const;
export const paragraphKey = (style: ParagraphStyle): string => `mod+alt+${style}`;

const FormatKeys = Extension.create({
  name: "letterFormatKeys",
  priority: 101,

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handleKeyDown(_view, event) {
            if (!(event.metaKey || event.ctrlKey) || event.isComposing || event.getModifierState("AltGraph"))
              return false;
            const codeKey = event.altKey ? CODE_KEYS.codeBlock : CODE_KEYS.code;
            const codeLetter = codeKey.at(-1)!;
            if (
              event.shiftKey &&
              (event.code === `Key${codeLetter.toUpperCase()}` || event.key.toLowerCase() === codeLetter)
            ) {
              return event.altKey ? applyCodeBlock(editor) : editor.commands.toggleCode();
            }
            if (!event.altKey || event.shiftKey) return false;
            const digit = /^Digit([0-3])$/.exec(event.code)?.[1] ?? event.key;
            const style = PARAGRAPH_STYLES.find((value) => paragraphKey(value) === `mod+alt+${digit}`);
            return style !== undefined && applyParagraphStyle(editor, style);
          },
        },
      }),
    ];
  },

  addInputRules() {
    return [
      new InputRule({
        find: /```$/,
        handler({ state, range, chain }) {
          const start = state.doc.resolve(range.from);
          if (start.parentOffset !== 0 && start.nodeBefore?.type.name !== "hardBreak") return null;
          if (
            !chain()
              .deleteRange(range)
              .command(({ state, tr }) => splitTargetLines(state, tr, false))
              .setCodeBlock()
              .updateAttributes("codeBlock", { authored: true })
              .run()
          )
            return null;
        },
      }),
    ];
  },
});

const AuthoredCode = Extension.create({
  name: "authoredLetterCode",

  addGlobalAttributes() {
    return [
      {
        types: ["codeBlock"],
        attributes: {
          authored: {
            default: false,
            parseHTML: (el: HTMLElement) =>
              el.getAttribute("data-ohmail-code") === "1" || el.getAttribute("style") === AUTHORED_CODE_STYLE,
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.authored ? { "data-ohmail-code": "1" } : {},
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, previous, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const map = new Mapping();
          for (const tr of transactions) map.appendMapping(tr.mapping);
          const change = state.tr;
          previous.doc.descendants((node, pos) => {
            if (node.type.name !== "codeBlock" || node.attrs.authored) return;
            const next = map.mapResult(pos, 1);
            if (next.deleted) return;
            const edited = state.doc.nodeAt(next.pos);
            if (edited?.type === node.type && !edited.attrs.authored && !edited.content.eq(node.content)) {
              change.setNodeAttribute(next.pos, "authored", true);
            }
          });
          return change.docChanged ? change : null;
        },
      }),
    ];
  },
});

export const FormatExtensions = [
  Heading.extend({ addInputRules: () => [] }).configure({ levels: [1, 2, 3] }),
  HorizontalRule.extend({ addInputRules: () => [] }),
  FormatKeys,
  AuthoredCode,
];

import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { AddMarkStep, RemoveMarkStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** Remember explicit removals while editing. Completing a word with a space or Enter must not relink it. */
const unlinked = new PluginKey<DecorationSet>("unlinkedText");
export const UnlinkedText = Extension.create({
  name: "unlinkedText",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: unlinked,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, previous: DecorationSet) {
            let ranges = previous.map(tr.mapping, tr.doc);
            // The link commands mark their transactions so the autolinker leaves them alone.
            if (!tr.getMeta("preventAutolink")) return ranges;
            for (const step of tr.steps) {
              if (
                !(step instanceof RemoveMarkStep || step instanceof AddMarkStep) ||
                step.mark.type.name !== "link"
              )
                continue;
              ranges = ranges.remove(ranges.find(step.from, step.to));
              if (step instanceof RemoveMarkStep) {
                const text = tr.doc.textBetween(step.from, step.to);
                ranges = ranges.add(tr.doc, [Decoration.inline(step.from, step.to, {}, { text })]);
              }
            }
            return ranges;
          },
        },
        appendTransaction(transactions, _old, state) {
          const ranges = unlinked.getState(state);
          if (!ranges || ranges === DecorationSet.empty) return null;
          const tr = state.tr;
          for (const change of transactions) {
            if (!change.getMeta("appendedTransaction") || change.getMeta("preventAutolink")) continue;
            for (const step of change.steps) {
              if (!(step instanceof AddMarkStep) || step.mark.type.name !== "link") continue;
              const text = state.doc.textBetween(step.from, step.to);
              const removed = ranges
                .find(step.from, step.to)
                .some((r) => r.from === step.from && r.to === step.to && r.spec.text === text);
              if (removed) tr.removeMark(step.from, step.to, step.mark);
            }
          }
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});

import type { ChainedCommands, Editor } from "@tiptap/react";
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { ParagraphStyle } from "../ports.js";
import type { ResolvedPos } from "@tiptap/pm/model";

/**
 * Block commands take LINES, not textblocks. Enter here is a hard break (`EnterAsHardBreak`), so a message typed line
 * by line is ONE paragraph with `<br>`s — and every block command TipTap ships (`toggleBulletList`,
 * `toggleOrderedList`, `toggleBlockquote`, `setBlockType`) resolves its target as "the textblocks the selection
 * touches", which here is the WHOLE MESSAGE. Reported exactly so: "list or code formats always mark the full text and
 * not the current line". The multi-paragraph case was already right (measured: three `<p>`s, caret in the middle one,
 * list takes only that one), which pins the defect on the hard-break line structure rather than the toggles. The rule
 * is every other editor's: no selection — the caret's line; a selection — exactly the lines it touches, expanded to
 * their boundaries; a full select — all lines, as one item per line, not the whole message inside one bullet.
 */

/**
 * How: the breaks at the target's edges become real splits, then the stock toggle runs. {@link splitTargetLines}
 * rewrites the hard break on each side of the target lines into a paragraph split (and, for lists, every break inside
 * the target too — three selected lines are three `<li>`s), then narrows the transaction's selection to the isolated
 * lines; the stock toggle chained after it wraps exactly what the user meant. One chain, one transaction, one undo
 * step. The neighbouring lines necessarily become paragraphs of their own — a `<p>` cannot contain a `<ul>`. Marks
 * are untouched: splitting moves nodes, it does not rebuild them, so bold inside a bulleted line survives (the code
 * block is the one command that drops marks, by the node's own declared rule).
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
export function splitTargetLines(
  state: EditorState,
  tr: Transaction,
  splitInner: boolean | "heading",
  quotationAsLines = false,
): boolean {
  const mapFrom = tr.mapping.maps.length;
  const sel = state.selection;
  // A NODE selection — a whole list or block picked as a node — is not a run of lines, and narrowing it to the text
  // inside (what `between` does) would change which node the chained toggle acts on: unquoting a selected `<ul>` must
  // lift THE LIST, not the first line in it (review-caught). Left exactly as the user made it; the stock toggles know
  // node selections.

  // The one exception is OPT-IN, because each button means something different by a selected QUOTATION (all three
  // review-caught, one round each): the LIST buttons mean "list the quoted lines" — they pass `quotationAsLines` and
  // the normalisation narrows to the contents; the QUOTE button never brings one here, answering the wrapper's own
  // node selection structurally before isolation is asked; and the CODE button keeps the bail, so the whole quotation
  // becomes one block rather than the exemption descending into a nested list's items and leaving its shell behind.
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
   * A ZERO-WIDTH LINE — the caret on an empty line, `<p>intro<br>│</p>` or `<p>a<br>│<br>b</p>`. Review-caught, then
   * measured twice: an empty line has no interior for a mapping bias to hold on to, so mapping its one position
   * inward from both sides lands on OPPOSITE sides of the surrounding splits — an inverted range whose clamp put the
   * caret on the line ABOVE, and the button formatted a line the caret was not on. And no single bias serves both
   * surrounding splits: +1 pushes the caret past the break AFTER the line (onto the next line), −1 keeps it before
   * the break BEFORE it (onto the previous). So the empty line is isolated explicitly — the break after it first (the
   * caret stays at the end of the first half), then the break before it (the caret moves into the split's second
   * half, the empty paragraph itself) — with the caret TRACKED through each step rather than mapped.
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

  // Keep the last paragraph's authored blank lines as hard breaks when making a heading.
  // Turning the final break into an empty paragraph would make it look like StarterKit's
  // generated caret paragraph when the heading is converted back.
  if (splitInner === "heading" && $to.depth === 1 && $to.after() === tr.doc.content.size) {
    let trailing = $to.end();
    for (let i = $to.parent.childCount - 1; i >= 0; i -= 1) {
      const child = $to.parent.child(i);
      if (child.type.name !== "hardBreak") break;
      trailing -= child.nodeSize;
      splits.delete(trailing);
    }
  }

  // Descending, so each delete+split leaves every EARLIER collected position untouched.
  for (const pos of [...splits].sort((a, b) => b - a)) {
    tr.delete(pos, pos + 1);
    tr.split(pos);
  }

  // The mapped line range: bias inward on both ends, so a split exactly at an edge leaves the
  // position inside the lines rather than in the neighbour it just created. (The zero-width
  // line, where a bias has nothing to hold on to, returned above.)
  const mapping = tr.mapping.slice(mapFrom);
  const start = mapping.map(lineStart, 1);
  const end = mapping.map(lineEnd, -1);
  if (empty) {
    // A caret stays a caret — the command's TARGET is the line, but nothing was selected and
    // nothing should read as selected afterwards. Clamped, because a split exactly at the
    // caret can map it just outside the isolated line.
    const caret = Math.min(Math.max(mapping.map(from, -1), start), end);
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
export function applyList(editor: Editor, list: "bulletList" | "orderedList"): void {
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
 * The quote button. One quote for the target lines, with the breaks INSIDE it kept as breaks — quoting three lines of
 * prose is one quotation, not three (the difference from a list, where every line is its own item; `splitInner` is
 * that difference, spelled as an argument). The OFF direction is line-scoped too, and that is not free the way it is
 * for lists. A list's items are lines, so TipTap's own lift already takes the item the caret stands in — but this
 * command deliberately quotes several lines as ONE paragraph, so a bare `toggleBlockquote` would lift all of them
 * together and pressing Quote on one line of a three-line quotation would unquote all three (review-caught).
 * Isolating the caret's line first makes the lift take exactly that line out, splitting the quotation around it,
 * which is what unquoting one line of a quotation has always meant.
 */
export function applyQuote(editor: Editor): void {
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
 * DOES THE SELECTION COVER MORE THAN ONE LINE? TWO WAYS IT CAN, and reading only the first is the bug this predicate
 * exists to close. The obvious one is a selection touching more than one block — two paragraphs, two list items. The
 * one that actually bit is a selection inside a SINGLE paragraph that contains hard breaks, which is what almost
 * every multi-line message here is: `EnterAsHardBreak` makes Enter a `<br>` rather than a paragraph split, so "five
 * lines pasted into a reply" is one `<p>` with four `<br>`s in it. A predicate that only compared the two ends'
 * blocks would call that one line and hand it to the inline mark, which is the reported defect exactly.
 */

/**
 * COUNTED BY WALKING, not by comparing `$from.sameParent($to)`, and the difference is not academic: under an
 * AllSelection both ends resolve to the DOCUMENT, so `sameParent` is true across a whole three-paragraph message and
 * Select-All + Code would have kept the bug in the one case people reach for first. `nodesBetween` visits a node at
 * `p` only while it overlaps `[from, to)`, so a break sitting immediately after the selection is not counted —
 * selecting exactly one line of a multi-line paragraph is a one-line selection, which is the answer a person expects.
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
 * The code button — one control, and which of the two code constructs it means. It used to run `toggleCode()`
 * unconditionally, and `code` is an INLINE MARK: a multi-line selection is several text runs with structure between
 * them, so marking it produced a shaded box per line, nothing on the blank ones, and the margins showing through as
 * gaps ("adding a code format applies it… with spaces in between, only for lines that have text" — an exact
 * description of an inline mark over a block). There was no way to ask for what was wanted, because `codeBlock` was
 * switched off. The rule: a selection inside one line is inline code (`filename.txt` in a sentence); a selection
 * covering more than one line is ONE code block. Nothing else changes meaning with the selection, so this is the only
 * command that must ask.
 */

/**
 * Why the block is built from text rather than by `setCodeBlock()`: that is `setBlockType`,
 * which retypes each textblock it finds — three paragraphs give THREE `<pre>` elements and the
 * gaps come back in a different costume. Replacing the range with a single node built from
 * `textBetween(from, to, "\n", "\n")` gives one block for any selection, and is exact about
 * the hard-break case: the same `"\n"` stands for a block boundary and a `<br>`, the
 * equivalence the rest of this file (and `htmlToPlainText`) already keeps. Marks inside the
 * selection are dropped — the node's own rule (`codeBlock` declares `marks: ""`), and bold
 * inside a code block is not a thing a mail client would render anyway.
 */
export function applyCode(editor: Editor): void {
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
  applyCodeBlock(editor);
}

export function applyParagraphStyle(editor: Editor, style: ParagraphStyle): boolean {
  const chain = editor.chain().focus(null, { scrollIntoView: false });
  if (style === 0) return chain.command(restoreParagraphLines).run();
  return chain.command(({ state, tr }) => splitTargetLines(state, tr, "heading"))
    .setHeading({ level: style }).run();
}

function restoreParagraphLines({ tr }: { tr: Transaction }): boolean {
  const { from, to } = tr.selection;
  const headings: number[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "heading") headings.push(pos);
  });
  const { paragraph, hardBreak } = tr.doc.type.schema.nodes;
  const boundaries = new Set<number>();
  for (const pos of headings) {
    const heading = tr.doc.nodeAt(pos)!;
    tr.setNodeMarkup(pos, paragraph);
    boundaries.add(pos);
    boundaries.add(pos + heading.nodeSize);
  }
  for (const pos of [...boundaries].sort((a, b) => b - a)) {
    const { nodeBefore, nodeAfter } = tr.doc.resolve(pos);
    if (nodeBefore?.type !== paragraph || nodeAfter?.type !== paragraph) continue;
    // Authored terminal breaks are still inline. Drop only the generated caret paragraph.
    const trailingPlaceholder = !nodeAfter.content.size && pos + nodeAfter.nodeSize === tr.doc.content.size;
    tr.join(pos);
    if (!trailingPlaceholder) tr.insert(pos - 1, hardBreak.create());
  }
  return true;
}

export function applyDivider(editor: Editor): void {
  editor.chain().focus(null, { scrollIntoView: false })
    .command(({ state, tr }) => splitTargetLines(state, tr, false))
    .command(({ tr }) => {
      const { $to } = tr.selection;
      if ($to.parent.isTextblock) tr.setSelection(TextSelection.create(tr.doc, $to.end()));
      return true;
    })
    .setHorizontalRule()
    .run();
}

export function applyCodeBlock(editor: Editor): boolean {
  if (editor.isActive("codeBlock")) return editor.chain().focus().toggleCodeBlock().run();
  if (editor.state.selection.empty) {
    return editor.chain().focus()
      .command(({ state, tr }) => splitTargetLines(state, tr, false))
      .setCodeBlock().updateAttributes("codeBlock", { authored: true }).run();
  }
  /**
   * The block, over WHOLE LINES. The selection is expanded and isolated first ({@link splitTargetLines}), for the two
   * defects the exact-range replacement had:
   * · a mid-line selection put the block boundary mid-line, so half a sentence became code;
   * · the boundary break stayed behind in the neighbour — `<p>one<br></p>` before the block, a dangling break that
   *   rendered (and SENT) as a stray blank line under "one". Measured, not reasoned: that exact markup came out of
   *   the pre-fix command.
   * After isolation the target lines are whole textblocks, so the replacement covers the NODES
   * (`$pos.before()`/`after()`), which is what leaves no empty `<p>` where their content used to be.
   */

  /**
   * A selection that never resolved to textblocks (nothing to isolate) keeps the old exact-range behaviour, which is
   * the select-all case the suite pins.
   */
  return editor.chain().focus()
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
        attrs: { authored: true },
        content: lineText ? [{ type: "text", text: lineText }] : [],
      });
    })
    .run();
}

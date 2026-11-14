import "./letter-text.css";

/**
 * The names a letter being written wears, block by block: the one sheet that draws what is written reads them.
 * The app's editor stamps them on what it draws, in its view alone: the markup a letter is sent as carries none
 * of them, and nothing a received letter is drawn with names them.
 */
export const letterText = {
  /** The box the blocks stand in: the editor's own root, or what holds a formatted signature. */
  text: "oh-lettertext",
  paragraph: "oh-lettertext-p",
  /** A list with marks, a list with numbers, and an item of either. */
  bullets: "oh-lettertext-bullets",
  numbers: "oh-lettertext-numbers",
  item: "oh-lettertext-item",
  quote: "oh-lettertext-quote",
  /** A block of code, and code inside a line. */
  codeBlock: "oh-lettertext-codeblock",
  code: "oh-lettertext-code",
  link: "oh-lettertext-link",
  /** A plain text box that is the whole text: no line and no ground of its own, as tall as its words. */
  plain: "oh-lettertext-plain",
} as const;

export type LetterTextName = keyof typeof letterText;

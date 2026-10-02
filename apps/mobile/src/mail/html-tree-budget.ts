import {
  Parser,
  Tokenizer,
  defaultTreeAdapter,
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  type ParserOptions,
  type Token,
  type TokenHandler,
  type TokenizerOptions,
  type TreeAdapter,
} from "parse5";

/**
 * HOW MANY ELEMENTS A STRING BUILDS IS A QUESTION ONLY THE TREE BUILDER CAN ANSWER. The html parser
 * re-opens every unclosed formatting element in each later paragraph, so 2,000 raw tags build 600,000
 * elements and any count over the string reads a different number. This runs the spec's tree builder
 * (parse5) over a DOCUMENT, as `DOMParser` and the frame do, with scripting off as they have it (on,
 * a `<noscript>` wrap reads as text), and stops at the first element past the budget.
 */

/**
 * THE PARSE ITSELF IS BOUNDED TOO. Measured over 512 KiB parts building few elements: one tag of
 * 95,377 attributes took parse5 8.7-18.7 s (each new name is compared with the tag's earlier ones;
 * Chromium and WebKit 133-138 ms), and 87,000 stray end tags over 4,000 open spans 1.5-2.6 s of
 * scope walks. So every step the parser takes over its own stack and lists, and every attribute-name
 * comparison, is charged to one budget; a 511 KiB newsletter reads 17,199 of it.
 */
export const MAX_PARSE_WORK = 4_000_000;

/** Why a document did not fit: its elements, its text outside `<style>`, or the parse's own work. */
export type TreeReading =
  | { fits: true; elements: number; textChars: number; work: number }
  | { fits: false; past: "elements" | "text" | "work" };

type Map = DefaultTreeAdapterMap;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/** The private sentinel a count throws to stop the parse. Nothing outside this file can raise it. */
class Past {
  constructor(readonly past: "elements" | "text" | "work") {}
}

class Meter {
  elements = 0;
  textChars = 0;
  work = 0;
  private scanned = 0;

  constructor(private readonly budget: { elements: number; textChars?: number }) {}

  element(): void {
    if (++this.elements > this.budget.elements) throw new Past("elements");
  }

  text(parent: ParentNode, chars: string): void {
    if ("tagName" in parent && parent.tagName === "style") return;
    this.textChars += chars.length;
    if (this.budget.textChars !== undefined && this.textChars > this.budget.textChars) throw new Past("text");
  }

  charge(units: number): void {
    if ((this.work += units) > MAX_PARSE_WORK) throw new Past("work");
  }

  /** The stack's `contains` is a native scan, measured at a fifth of a read's cost: an eighth of a unit a step. */
  scan(steps: number): void {
    this.scanned += steps;
    if (this.scanned >= 8) {
      this.charge(this.scanned >>> 3);
      this.scanned &= 7;
    }
  }
}

/**
 * The tokenizer, charged for each comparison of a new attribute name with the tag's earlier ones.
 * `_createAttr` is protected, so parse5 is pinned exactly in both manifests: a release that renames
 * it leaves the override uncalled, and the 40,000-attribute case in the unit suite goes red.
 */
class BudgetTokenizer extends Tokenizer {
  constructor(options: TokenizerOptions, handler: TokenHandler, private readonly meter: Meter) {
    super(options, handler);
  }

  protected override _createAttr(attrNameFirstCh: string): void {
    this.meter.charge((this.currentToken as Token.TagToken).attrs.length);
    super._createAttr(attrNameFirstCh);
  }
}

/** parse5's own parser with the charged tokenizer, and the stack's `contains` charged per step. */
class BudgetParser extends Parser<Map> {
  constructor(options: ParserOptions<Map>, meter: Meter) {
    super(options);
    this.tokenizer = new BudgetTokenizer(this.options, this, meter);
    const stack = this.openElements;
    stack.contains = (element: Element): boolean => {
      const at = stack.items.lastIndexOf(element, stack.stackTop);
      meter.scan(stack.stackTop - at);
      return at > -1;
    };
  }
}

/**
 * The counting tree: elements only. Text and comments never steer tree construction, and stored,
 * parse5's own adapter scans a parent's children on every foster-parented or adopted insertion.
 */
function countingAdapter(meter: Meter): TreeAdapter<Map> {
  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      meter.element();
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    appendChild(parentNode, newNode) {
      if (!defaultTreeAdapter.isCommentNode(newNode)) defaultTreeAdapter.appendChild(parentNode, newNode);
    },
    insertText(parentNode, text) {
      meter.text(parentNode, text);
    },
    insertTextBefore(parentNode, text) {
      meter.text(parentNode, text);
    },
    getNamespaceURI(element) {
      meter.charge(1);
      return defaultTreeAdapter.getNamespaceURI(element);
    },
    getTagName(element) {
      meter.charge(1);
      return defaultTreeAdapter.getTagName(element);
    },
    getAttrList(element) {
      meter.charge(1);
      return defaultTreeAdapter.getAttrList(element);
    },
  };
}

/**
 * Does `html`, parsed as a document, build at most `budget.elements` elements and `budget.textChars`
 * characters of text outside `<style>`, within {@link MAX_PARSE_WORK}? Synchronous, and bounded by
 * its input's length and the budgets, so it can stand in front of every other parse of the string.
 */
export function treeWithin(html: string, budget: { elements: number; textChars?: number }): TreeReading {
  const meter = new Meter(budget);
  const parser = new BudgetParser({ scriptingEnabled: false, treeAdapter: countingAdapter(meter) }, meter);
  try {
    parser.tokenizer.write(html, true);
  } catch (e) {
    if (e instanceof Past) return { fits: false, past: e.past };
    throw e;
  }
  return { fits: true, elements: meter.elements, textChars: meter.textChars, work: meter.work };
}

/**
 * The same reading, a step at a time, for a caller that must not hold its thread for the whole parse.
 * Each call reads at most `charsPerStep` more characters and does at most about `workPerStep` more of
 * the parse's work (parse5's tokenizer pauses there and resumes on the next call, as it stops at a
 * slice's end), and answers null until the reading is known, then that reading again. One meter keeps
 * the counts, so the reading equals {@link treeWithin}'s at every step size.
 */
export function treeStepper(
  html: string,
  budget: { elements: number; textChars?: number },
  charsPerStep: number,
  workPerStep = Infinity,
): () => TreeReading | null {
  const meter = new StepMeter(budget);
  const parser = new BudgetParser({ scriptingEnabled: false, treeAdapter: countingAdapter(meter) }, meter);
  const tokenizer = parser.tokenizer;
  meter.onLimit = () => tokenizer.pause();
  const size = Math.max(1, Math.floor(charsPerStep));
  const share = Math.max(1, workPerStep);
  let at = 0;
  let ended = false;
  let reading: TreeReading | null = null;
  return () => {
    if (reading !== null) return reading;
    meter.allow(share);
    try {
      if (tokenizer.paused) tokenizer.resume();
      else if (at < html.length) {
        const end = Math.min(html.length, at + size);
        tokenizer.write(html.slice(at, end), false);
        at = end;
      }
      if (!tokenizer.paused && at >= html.length && !ended) {
        ended = true;
        tokenizer.write("", true);
      }
      if (tokenizer.paused || !ended) return null;
    } catch (e) {
      if (!(e instanceof Past)) throw e;
      reading = { fits: false, past: e.past };
      return reading;
    }
    reading = { fits: true, elements: meter.elements, textChars: meter.textChars, work: meter.work };
    return reading;
  };
}

/** The stepper's meter: past a step's share of work it asks the tokenizer to pause at the next character. */
class StepMeter extends Meter {
  onLimit: () => void = () => {};
  private limit = Infinity;

  allow(units: number): void {
    this.limit = this.work + units;
  }

  override charge(units: number): void {
    super.charge(units);
    if (this.work >= this.limit) this.onLimit();
  }
}

// A source file read as text, never run: its comments and literals told apart from its code, a bracket's
// partner, and the entries of an object literal. Every text this module hands back has the length of the file,
// so an index into it is an index into the file.

const REGEX_BEFORE = new Set([..."(,=:[!&|?;+-*%~^", "=>"]);
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);
const OPEN = { "(": ")", "[": "]", "{": "}" };

/** The last word before `at` in `out`, for a slash that follows a keyword. */
function wordBefore(out, at) {
  let end = at;
  while (end > 0 && /\s/.test(out[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && /[\w$]/.test(out[start - 1])) start -= 1;
  return out.slice(start, end).join("");
}

/** Where a regular expression that starts at `i` ends (past its flags), or -1 when the line ends first. */
function regexEnd(text, i) {
  let j = i + 1;
  let inClass = false;
  for (; j < text.length; j += 1) {
    const c = text[j];
    if (c === "\n") return -1;
    if (c === "\\") j += 1;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) break;
  }
  if (j >= text.length) return -1;
  j += 1;
  while (j < text.length && /[a-z]/.test(text[j])) j += 1;
  return j;
}

/**
 * Two readings of `text`, each as long as it: `code`, where every comment and the inside of every string, template
 * and regular expression is blanked (the quotes stay); and `bare`, where only the comments are blanked. A quote
 * that a line ends before it closes ends there (a stray apostrophe costs one line, never the file).
 * @param {string} text
 */
export function readSource(text) {
  const code = [...text];
  const bare = [...text];
  const blankAt = (j, both) => {
    if (text[j] === "\n") return;
    code[j] = " ";
    if (both) bare[j] = " ";
  };
  const stack = []; // the brace depth of each template expression we stand in
  let i = 0;
  /** The last character of code before `i`, and an arrow's `=>` as one. */
  const significant = () => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(code[k])) k -= 1;
    if (k < 0) return "";
    return code[k] === ">" && code[k - 1] === "=" ? "=>" : code[k];
  };
  const template = () => {
    // i stands just past a backtick or a closing brace of `${`; read to the template's end or its next `${`.
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (c === "\\") {
        blankAt(i, false);
        blankAt(i + 1, false);
        i += 1;
      } else if (c === "`") {
        i += 1;
        return;
      } else if (c === "$" && text[i + 1] === "{") {
        stack.push(0);
        i += 2;
        return;
      } else blankAt(i, false);
    }
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") blankAt(i++, true);
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      while (i < stop) blankAt(i++, true);
    } else if (c === '"' || c === "'") {
      i += 1;
      while (i < text.length && text[i] !== c && text[i] !== "\n") {
        if (text[i] === "\\" && text[i + 1] !== "\n") blankAt(i++, false);
        blankAt(i++, false);
      }
      i += 1;
    } else if (c === "`") {
      i += 1;
      template();
    } else if (c === "}" && stack.length && stack[stack.length - 1] === 0) {
      stack.pop();
      i += 1;
      template();
    } else if (
      c === "/" &&
      (REGEX_BEFORE.has(significant()) || significant() === "" || REGEX_AFTER_WORD.has(wordBefore(code, i)))
    ) {
      const end = regexEnd(text, i);
      if (end < 0) i += 1;
      else {
        for (let j = i + 1; j < end; j += 1) blankAt(j, false);
        i = end;
      }
    } else {
      if (stack.length && c === "{") stack[stack.length - 1] += 1;
      if (stack.length && c === "}") stack[stack.length - 1] -= 1;
      i += 1;
    }
  }
  return { code: code.join(""), bare: bare.join("") };
}

/** The index of the bracket that closes the one at `open` in `code` (a reading's `code`), or -1. */
export function closeOf(code, open) {
  const want = [OPEN[code[open]]];
  for (let i = open + 1; i < code.length; i += 1) {
    const c = code[i];
    if (OPEN[c]) want.push(OPEN[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (c !== want.pop()) return -1;
      if (want.length === 0) return i;
    }
  }
  return -1;
}

/** Splits `code` between `from` and `to` at its commas that stand at depth 0: [start, end) of each part. */
export function topLevelParts(code, from, to) {
  const parts = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const c = code[i];
    if (OPEN[c]) depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, to]);
  return parts.filter(([a, b]) => code.slice(a, b).trim() !== "");
}

/**
 * The entries of the object literal whose `{` stands at `brace`: `{ key, value }` as written, comments aside,
 * `value` null for a shorthand; a spread is `{ spread: "...x" }`. Null when the brace does not close.
 * @param {{ code: string, bare?: string }} reading `bare`, the text with its comments blanked (`readSource`)
 * @param {string} text
 * @param {number} brace
 */
export function entriesAt(reading, text, brace) {
  const close = closeOf(reading.code, brace);
  if (close < 0) return null;
  const said = reading.bare ?? text;
  return topLevelParts(reading.code, brace + 1, close).map(([a, b]) => {
    const raw = said.slice(a, b).trim();
    if (raw.startsWith("...")) return { spread: raw };
    const colon = topColon(reading.code, a, b);
    if (colon < 0) return { key: raw.replace(/\(.*$/s, "").trim(), value: null };
    return {
      key: said
        .slice(a, colon)
        .trim()
        .replace(/^["']|["']$/g, ""),
      value: said.slice(colon + 1, b).trim(),
    };
  });
}

function topColon(code, from, to) {
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const c = code[i];
    if (OPEN[c]) depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === ":" && depth === 0) return i;
  }
  return -1;
}

/**
 * The literal's inside as written, when the part is one string or template literal and nothing more; else null.
 * `code` and `raw` are the same part, read as code and as text.
 */
export function literalInside(code, raw) {
  const q = code[0];
  if (!(q === '"' || q === "'" || q === "`")) return null;
  let depth = 0;
  let end = -1;
  for (let i = 1; i < code.length; i += 1) {
    const c = code[i];
    if (q === "`" && c === "$" && code[i + 1] === "{") {
      depth += 1;
      i += 1;
    } else if (q === "`" && depth > 0 && c === "}") depth -= 1;
    else if (c === q && depth === 0) {
      end = i;
      break;
    }
  }
  return end === code.length - 1 && end > 0 ? raw.slice(1, end) : null;
}

const MARKS = ["strong", "em", "u"] as const;
export type Mark = (typeof MARKS)[number];
export interface Run { text: string; marks: readonly Mark[] }

const sameMarks = (a: readonly Mark[], b: readonly Mark[]) => a.length === b.length && a.every((mark) => b.includes(mark));

function append(to: Run[], text: string, marks: readonly Mark[]) {
  if (text === "") return;
  const previous = to.at(-1);
  if (previous && sameMarks(previous.marks, marks)) previous.text += text;
  else to.push({ text, marks });
}

function slice(runs: readonly Run[], start: number, end = Infinity): Run[] {
  const kept: Run[] = [];
  let offset = 0;
  for (const run of runs) {
    const left = Math.max(0, start - offset);
    const right = Math.max(0, end - offset);
    append(kept, run.text.slice(left, right), run.marks);
    offset += run.text.length;
  }
  return kept;
}

export function toggleMark(runs: readonly Run[], start: number, end: number, mark: Mark): Run[] {
  const selection = slice(runs, start, end);
  const remove = selection.every((run) => run.marks.includes(mark));
  const updated = slice(runs, 0, start);
  for (const run of selection) {
    const marks = MARKS.filter((m) => m === mark ? !remove : run.marks.includes(m));
    append(updated, run.text, marks);
  }
  for (const run of slice(runs, end)) append(updated, run.text, run.marks);
  return updated;
}

/** A TextInput edit replaces the span between its common prefix and suffix with the previous typing style. */
export function editRuns(runs: readonly Run[], text: string): Run[] {
  const old = runs.map((run) => run.text).join("");
  let left = 0;
  const common = Math.min(old.length, text.length);
  while (left < common && old[left] === text[left]) left++;
  let right = 0;
  while (right < common - left && old[old.length - right - 1] === text[text.length - right - 1]) right++;
  const next = slice(runs, 0, left);
  append(next, text.slice(left, text.length - right), next.at(-1)?.marks ?? []);
  for (const run of slice(runs, old.length - right)) append(next, run.text, run.marks);
  return next;
}

export function markupOf(runs: readonly Run[]): string | undefined {
  if (!runs.some((run) => run.marks.length > 0 && /\S/.test(run.text))) return undefined;
  let lineStart = true;
  let literalSpace = false;
  const body = runs.map((run) => {
    const escaped = run.text.replace(/[ &<>\n]|[^ &<>\n]+/g, (part) => {
      const keep = part === " " && (lineStart || literalSpace);
      literalSpace = part === " " && !keep;
      lineStart = part === "\n";
      if (keep) return "&nbsp;";
      switch (part) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case "\n": return "<br>";
        default: return part;
      }
    });
    return run.marks.reduceRight((text, mark) => "<" + mark + ">" + text + "</" + mark + ">", escaped);
  }).join("");
  return "<p>" + body + "</p>";
}

/** Only open markup the phone can put back whole. Other drafts stay readable through the existing draft view. */
export function runsOf(body: string, html: string): Run[] | null {
  if (!html.startsWith("<p>") || !html.endsWith("</p>")) return null;
  const inner = html.slice(3, -4);
  const parts = inner.match(/<\/?(?:strong|em|u)>|<br\s*\/?>|[^<]+/g) ?? [];
  if (parts.join("") !== inner) return null;
  const stack: Mark[] = [];
  const runs: Run[] = [];
  for (const part of parts) {
    const tag = MARKS.find((mark) => part === "<" + mark + ">" || part === "</" + mark + ">");
    if (tag) {
      if (!part.startsWith("</")) stack.push(tag);
      else if (stack.pop() !== tag) return null;
    } else {
      const text = part.startsWith("<br") ? "\n"
        : part.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, "\u00a0").replace(/&amp;/g, "&");
      append(runs, text, MARKS.filter((mark) => stack.includes(mark)));
    }
  }
  if (stack.length !== 0) return null;
  const restored = runs.map((run) => run.text).join("");
  if (restored === body) return runs;
  // The server can store &nbsp; as a literal character. Keep the plain draft's spacing.
  const spaces = (text: string) => text.replaceAll("\u00a0", " ");
  if (spaces(restored) !== spaces(body)) return null;
  let at = 0;
  for (const run of runs) {
    run.text = body.slice(at, at + run.text.length);
    at += run.text.length;
  }
  return runs;
}

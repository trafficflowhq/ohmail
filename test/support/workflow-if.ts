/**
 * A workflow expression evaluated the way the runner reads it, for the expressions the published workflows write:
 * contexts, string and boolean literals, `null`, `==`, `!=`, `!`, `&&`, `||`, parentheses, `cancelled()`,
 * `startsWith()`, `endsWith()`, `contains()` and `fromJSON()` over a string literal (`startsWith`, `endsWith` and
 * `contains` ignore case, as GitHub's do; `contains` over a list asks for an element, over a string for a part of it,
 * and reads null as the empty string, as GitHub's does). `evalValue` returns the expression's value — `&&` and `||`
 * return an operand, as GitHub's do, so a `runs-on:` reads as the label or the list of labels it names — and `evalIf`
 * reads that value for truth (a caller reads a job with no `if:` as `true`).
 * Anything else in the expression refuses, and so does a context the caller did not give: a reader that guessed a
 * value it was not handed would answer for a run nobody described. A context may be given as `null` (a pull request
 * whose head repository was deleted reads `github.event.pull_request.head.repo.full_name` as null).
 *
 * String comparison is case-insensitive there and exact here, which no expression in this repository depends on.
 */
export type IfContext = Record<string, string | null>;

const TOKEN = /\s*(?:('(?:[^']|'')*')|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)|(==|!=|&&|\|\||!|\(|\)|,))/y;

export function evalValue(raw: string, ctx: IfContext, opts: { cancelled?: boolean } = {}): unknown {
  const expr = raw.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
  const tokens: Array<{ s?: string; id?: string; op?: string; at: number }> = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expr.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(expr);
    if (!m) throw new Error(`not an expression this reads, at ${at}: ${expr}`);
    if (m[1] !== undefined) tokens.push({ s: m[1].slice(1, -1).replace(/''/g, "'"), at });
    else if (m[2] !== undefined) tokens.push({ id: m[2], at });
    else tokens.push({ op: m[3], at });
  }
  let js = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.s !== undefined) js += JSON.stringify(t.s);
    else if (t.id !== undefined) {
      const id = t.id;
      if (id === "true" || id === "false" || id === "null") js += id;
      else if (id === "cancelled" || id === "startsWith" || id === "endsWith" || id === "contains") js += `__${id}`;
      else if (id === "fromJSON") {
        /* fromJSON over a string literal only: a context or an expression inside would be a value nobody wrote here. */
        const [open, arg, close] = tokens.slice(i + 1, i + 4);
        if (open?.op !== "(" || arg?.s === undefined || close?.op !== ")") throw new Error(`fromJSON reads a string literal only, at ${t.at}: ${expr}`);
        js += `(${JSON.stringify(JSON.parse(arg.s))})`;
        i += 3;
      } else if (id in ctx) js += JSON.stringify(ctx[id]);
      else throw new Error(`no value given for the context ${id}`);
    } else js += { "==": "===", "!=": "!==" }[t.op!] ?? t.op;
    js += " ";
  }
  const fn = new Function("__cancelled", "__startsWith", "__endsWith", "__contains", `return (${js});`);
  return fn(
    () => opts.cancelled === true,
    (s: unknown, p: unknown) => text(s).startsWith(text(p)),
    (s: unknown, p: unknown) => text(s).endsWith(text(p)),
    (within: unknown, item: unknown) => (Array.isArray(within) ? within.some((x) => text(x) === text(item)) : text(within).includes(text(item))),
  );
}

/** A value as GitHub's string functions read it: null as the empty string, compared without case. */
function text(v: unknown): string {
  return (v === null || v === undefined ? "" : String(v)).toLowerCase();
}

export function evalIf(raw: string, ctx: IfContext, opts: { cancelled?: boolean } = {}): boolean {
  return Boolean(evalValue(raw, ctx, opts));
}

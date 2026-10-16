/**
 * A job's `if:` evaluated the way the runner reads it, for the expressions the published workflows write:
 * contexts, string and boolean literals, `==`, `!=`, `!`, `&&`, `||`, parentheses, `cancelled()` and
 * `startsWith()`; a caller reads a job with no `if:` as `true`.
 * Anything else in the expression refuses, and so does a context the caller did not give: a reader that
 * guessed a value it was not handed would answer for a run nobody described.
 *
 * `&&` and `||` return an operand, as GitHub's do; the result is read for truth. String comparison is
 * case-insensitive there and exact here, which no expression in this repository depends on.
 */
export type IfContext = Record<string, string>;

const TOKEN = /\s*(?:('(?:[^']|'')*')|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)|(==|!=|&&|\|\||!|\(|\)|,))/y;

export function evalIf(raw: string, ctx: IfContext, opts: { cancelled?: boolean } = {}): boolean {
  const expr = raw.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
  let js = "";
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expr.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(expr);
    if (!m) throw new Error(`not an expression this reads, at ${at}: ${expr}`);
    if (m[1] !== undefined) js += JSON.stringify(m[1].slice(1, -1).replace(/''/g, "'"));
    else if (m[2] !== undefined) {
      const id = m[2];
      if (id === "true" || id === "false" || id === "null") js += id;
      else if (id === "cancelled" || id === "startsWith") js += `__${id}`;
      else if (id in ctx) js += JSON.stringify(ctx[id]);
      else throw new Error(`no value given for the context ${id}`);
    } else js += { "==": "===", "!=": "!==" }[m[3]!] ?? m[3];
    js += " ";
  }
  const fn = new Function("__cancelled", "__startsWith", `return (${js});`);
  return Boolean(fn(() => opts.cancelled === true, (s: string, p: string) => String(s).toLowerCase().startsWith(String(p).toLowerCase())));
}

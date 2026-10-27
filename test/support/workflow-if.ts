/**
 * A workflow expression evaluated the way the runner reads it, for the expressions the published workflows write:
 * contexts, string, integer and boolean literals, `null`, `==`, `!=`, `!`, `&&`, `||`, parentheses, `cancelled()`,
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
 *
 * A job's `if:` read alone is not whether the job starts: `runJobs` reads a workflow's jobs as GitHub starts them.
 */
export type IfContext = Record<string, string | null>;

const TOKEN = /\s*(?:('(?:[^']|'')*')|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)|(==|!=|&&|\|\||!|\(|\)|,)|(\d+)(?![\w.]))/y;
type Token = { s?: string; id?: string; op?: string; n?: number; at: number };

/** An expression's tokens, its `${{ }}` dropped; a character this does not read refuses. */
function tokenize(raw: string): { expr: string; tokens: Token[] } {
  const expr = raw.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expr.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(expr);
    if (!m) throw new Error(`not an expression this reads, at ${at}: ${expr}`);
    if (m[1] !== undefined) tokens.push({ s: m[1].slice(1, -1).replace(/''/g, "'"), at });
    else if (m[2] !== undefined) tokens.push({ id: m[2], at });
    else if (m[4] !== undefined) tokens.push({ n: Number(m[4]), at });
    else tokens.push({ op: m[3], at });
  }
  return { expr, tokens };
}

export function evalValue(raw: string, ctx: IfContext, opts: { cancelled?: boolean } = {}): unknown {
  const { expr, tokens } = tokenize(raw);
  let js = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.s !== undefined) js += JSON.stringify(t.s);
    else if (t.n !== undefined) js += String(t.n);
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

const STATUS_CHECKS = new Set(["success", "failure", "always", "cancelled"]);

/** Whether an expression calls a status-check function; the name inside a string literal is no call. */
export function namesStatusCheck(raw: string): boolean {
  const { tokens } = tokenize(raw);
  return tokens.some((t, i) => t.id !== undefined && STATUS_CHECKS.has(t.id) && tokens[i + 1]?.op === "(");
}

export type JobResult = "success" | "failure" | "cancelled" | "skipped";
export type JobShape = { if?: unknown; needs?: unknown };

/** The jobs a job names in `needs:`. */
export const needsOf = (job: JobShape | undefined): string[] => (job?.needs === undefined ? [] : [job.needs].flat().map(String));

/**
 * How each job of one run ends, as GitHub decides which jobs start. A job starts when its `if:` reads true, and an
 * `if:` that names no status-check function, or a job with none, is read as `success() && (…)`. A job's `success()`
 * asks every job up its needs chain, not only the ones it names: "a failure or skip applies to all jobs in the
 * dependency chain from the point of failure or skip onwards" (GitHub's docs on `jobs.<job_id>.needs`;
 * actions/runner#2205). So a job two steps below a skipped one is skipped too, even when the job between them ran
 * because its own `if:` named `!cancelled()`.
 *
 * `ctx` holds what no job of the run decides: the event's contexts, and the outputs of the jobs the caller describes
 * (`needs.changes.outputs.desktop`), each handed only to the jobs that need that job. How a job ended is worked out
 * here and never taken from the caller: a job that starts ends `ended[id]`, by default `success`, and one that does not
 * reads `skipped`. `success()`, `failure()` and `always()` refuse, as evalIf does: no job here names them.
 */
export function runJobs(
  jobs: Record<string, JobShape>,
  ctx: IfContext,
  opts: { cancelled?: boolean; ended?: Record<string, JobResult> } = {},
): Record<string, JobResult> {
  for (const k of Object.keys(ctx)) {
    if (/^needs\.[^.]+\.result$/.test(k)) throw new Error(`${k} is how a job of this run ended: the reader works it out, it never takes it`);
  }
  const out: Record<string, JobResult> = {};
  const open = new Set<string>();
  const chainOf = (id: string, seen = new Set<string>()): Set<string> => {
    for (const n of needsOf(jobs[id])) if (!seen.has(n)) { seen.add(n); chainOf(n, seen); }
    return seen;
  };
  const resultOf = (id: string): JobResult => {
    const known = out[id];
    if (known !== undefined) return known;
    const job = jobs[id];
    if (!job) throw new Error(`no job ${id}`);
    if (open.has(id)) throw new Error(`a needs cycle through ${id}`);
    open.add(id);
    const needs = needsOf(job);
    const own: IfContext = {};
    for (const [k, v] of Object.entries(ctx)) {
      const n = /^needs\.([^.]+)\./.exec(k)?.[1];
      if (n === undefined || needs.includes(n)) own[k] = v;
    }
    for (const n of needs) own[`needs.${n}.result`] = resultOf(n);
    const raw = job.if === undefined ? "" : String(job.if);
    let reads: boolean;
    try {
      reads = raw === "" || evalIf(raw, own, opts);
    } catch (e) {
      throw new Error(`${id}: ${(e as Error).message}`);
    }
    const implicit = raw === "" || !namesStatusCheck(raw);
    const succeeded = !opts.cancelled && [...chainOf(id)].every((a) => resultOf(a) === "success");
    out[id] = reads && (!implicit || succeeded) ? (opts.ended?.[id] ?? "success") : "skipped";
    open.delete(id);
    return out[id];
  };
  for (const id of Object.keys(jobs)) resultOf(id);
  return out;
}

/** One event as `hostedJobs` reads it: the trigger, its ref, a schedule's cadence, and every context the files read. */
export type RunEvent = { event: string; action?: string; ref: string; cron?: "daily" | "weekly"; ctx: IfContext };

/** The filters each trigger may carry here; any other (a path filter included) refuses. */
const FILTERS: Record<string, string[]> = {
  push: ["branches", "tags"], pull_request: ["types"], pull_request_target: ["types"], release: ["types"],
  merge_group: ["types"], workflow_dispatch: ["inputs"],
};

/** A branch or tag filter: `*` within one path segment, `**` across them, anything else as written. */
function globMatch(patterns: unknown, name: string): boolean {
  return [patterns].flat().some((p) => {
    if (/[?+[\]!]/.test(String(p))) throw new Error(`a filter pattern this does not read: ${String(p)}`);
    const re = String(p).replace(/[.^${}()|\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
    return new RegExp(`^${re}$`).test(name);
  });
}

/** A cron's cadence: daily, weekly (a day of week), or other. */
const cadence = (cron: string) => {
  const f = cron.trim().split(/\s+/);
  return f[2] !== "*" || f[3] !== "*" ? "other" : f[4] === "*" ? "daily" : "weekly";
};

/**
 * Whether a workflow's `on:` starts a run for the event: a push by its branch and tag globs (a push filtered on
 * one kind of ref starts nothing for the other), a pull request or a release by its `types` (a pull request's
 * default three when none), a schedule by its cadence.
 */
export function startsOn(on: unknown, ev: RunEvent): boolean {
  const triggers = (typeof on === "string" ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((k) => [String(k), null])) : on ?? {}) as Record<string, unknown>;
  if (!(ev.event in triggers)) return false;
  if (ev.event === "schedule") return [triggers.schedule].flat().some((c) => cadence(String((c as { cron?: unknown } | null)?.cron ?? "")) === ev.cron);
  const f = (triggers[ev.event] ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(f)) if (!(FILTERS[ev.event] ?? []).includes(k)) throw new Error(`${ev.event}: a filter this does not read (${k})`);
  if (ev.event === "push") {
    const kind = ev.ref.startsWith("refs/tags/") ? "tags" : "branches";
    if (f.branches === undefined && f.tags === undefined) return true;
    return f[kind] !== undefined && globMatch(f[kind], ev.ref.replace(/^refs\/(heads|tags)\//, ""));
  }
  const types = f.types as string[] | undefined;
  if (ev.event.startsWith("pull_request")) return (types ?? ["opened", "synchronize", "reopened"]).includes(ev.action ?? "synchronize");
  return types === undefined || types.includes(ev.action ?? "");
}

/** A matrix value written `${{ fromJSON(needs.<job>.outputs.<name>) }}`, read from ctx; any other as written. */
function fromNeeds(v: unknown, ctx: IfContext): unknown {
  if (typeof v !== "string" || !v.includes("${{")) return v;
  const m = /^\$\{\{\s*fromJSON\((needs\.[\w-]+\.outputs\.[\w-]+)\)\s*\}\}$/.exec(v.trim());
  if (!m) throw new Error(`a matrix value this does not read: ${v}`);
  if (!(m[1] in ctx)) throw new Error(`no value given for the context ${m[1]}`);
  return JSON.parse(String(ctx[m[1]]));
}

/**
 * A job's matrix combinations as GitHub expands them: the axes crossed, then each `include` entry added to every
 * crossed combination whose axis values it keeps, or appended as one of its own when it fits none.
 */
export function matrixOf(strategy: unknown, ctx: IfContext): Array<Record<string, unknown>> {
  const raw = (strategy as { matrix?: unknown } | undefined)?.matrix;
  if (raw === undefined) return [{}];
  const { include, exclude, ...axes } = fromNeeds(raw, ctx) as Record<string, unknown>;
  if (exclude !== undefined) throw new Error("a matrix exclude this does not read");
  let out: Array<Record<string, unknown>> = Object.keys(axes).length ? [{}] : [];
  for (const [k, vs] of Object.entries(axes)) out = out.flatMap((c) => (fromNeeds(vs, ctx) as unknown[]).map((v) => ({ ...c, [k]: v })));
  const crossed = out.length;
  for (const e of (fromNeeds(include, ctx) as Array<Record<string, unknown>> | undefined) ?? []) {
    const fit = out.slice(0, crossed).filter((c) => Object.entries(e).every(([k, v]) => !(k in axes) || c[k] === v));
    if (fit.length) for (const c of fit) Object.assign(c, e);
    else out.push({ ...e });
  }
  return out;
}

/** A job's runner labels: a label or a list as written, or the value of the one expression it is. */
function labelsOf(runsOn: unknown, ctx: IfContext): string[] {
  const v = typeof runsOn === "string" && /^\s*\$\{\{[\s\S]*\}\}\s*$/.test(runsOn) ? evalValue(runsOn, ctx) : runsOn;
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new Error(`a runs-on this does not read: ${JSON.stringify(runsOn)}`);
}

/**
 * Every job one event starts on GitHub's hosted runners, one line per job and matrix combination:
 * `<file>: <job>[ (<matrix values>)] @<labels>`. A workflow starts as `startsOn` reads its `on:`, its jobs as
 * `runJobs` reads them, and a job is hosted when its `runs-on:`, read with the combination's `matrix.*`, names no
 * `self-hosted` label. `workflows` maps each file name to its parsed YAML.
 */
export function hostedJobs(workflows: Record<string, unknown>, ev: RunEvent): string[] {
  const out: string[] = [];
  for (const [file, parsed] of Object.entries(workflows)) {
    const wf = parsed as { on?: unknown; jobs?: Record<string, JobShape & { "runs-on"?: unknown; strategy?: unknown }> };
    if (!startsOn(wf.on, ev)) continue;
    const jobs = wf.jobs ?? {};
    const ended = runJobs(jobs, ev.ctx);
    for (const [id, job] of Object.entries(jobs)) {
      if (ended[id] !== "success") continue;
      for (const combo of matrixOf(job.strategy, ev.ctx)) {
        const ctx: IfContext = { ...ev.ctx };
        for (const [k, v] of Object.entries(combo)) ctx[`matrix.${k}`] = String(v);
        const labels = labelsOf(job["runs-on"], ctx);
        if (labels.some((l) => l.toLowerCase() === "self-hosted")) continue;
        const values = Object.values(combo);
        out.push(`${file}: ${id}${values.length ? ` (${values.join(", ")})` : ""} @${labels.join(",")}`);
      }
    }
  }
  return out;
}

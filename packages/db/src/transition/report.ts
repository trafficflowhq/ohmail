/**
 * WHAT THE TRANSITION MAY SAY, AND THE ONE PATH BY WHICH IT SAYS IT.
 *
 * It runs on stores that hold mail, addresses and secrets, and on a self-hosted server also on
 * names its owner chose. So nothing it emits is free text: an event is one of a closed set of
 * shapes carrying the program's own words, counts, and names out of its own map. A name read from
 * the STORE (an owner's table, something that depends on a dropped column) travels in a field of
 * its own and reaches a line only through {@link safeName}. A driver's error is never passed on:
 * its DETAIL quotes rows ("Key (account_id, key)=(…)", "Failing row contains (…)").
 */

/** A name read from the store, fit to print: quoted when it is an ordinary identifier, else only its size. */
export function safeName(name: string): string {
  return /^[A-Za-z0-9_]{1,63}$/.test(name) ? `"${name}"` : `<name of ${Buffer.byteLength(name, "utf8")} bytes, not printed>`;
}

/** At most twenty names, then how many more. */
export function safeNames(names: readonly string[]): string {
  const shown = names.slice(0, 20).map(safeName).join(", ");
  return names.length > 20 ? `${shown} and ${names.length - 20} more` : shown;
}

/** One line of the record: the program's own sentence and a count. */
export interface CountLine { readonly what: string; readonly n: number }

/** One verdict of a check. `subject` is a name of the map or a fixed word, never a row. */
export interface Verdict {
  readonly check: string;
  readonly subject: string;
  readonly expected: string;
  readonly found: string;
  readonly ok: boolean;
}

export type TransitionEvent =
  | { readonly type: "reported"; readonly what: string; readonly n: number }
  | { readonly type: "owner-table"; readonly name: string; readonly outcome: "left" | "refused" }
  | { readonly type: "refused"; readonly lines: readonly CountLine[] }
  | { readonly type: "entry"; readonly journal: string; readonly name: string; readonly ms: number }
  | { readonly type: "check"; readonly name: string; readonly subject: string; readonly expected: string; readonly found: string; readonly ok: boolean }
  | { readonly type: "sealed"; readonly site: string; readonly rows: number; readonly opened: number; readonly failed: number }
  | { readonly type: "committed"; readonly heads: Readonly<Record<string, number>> };

export type TransitionLog = (event: TransitionEvent) => void;

/** One event as a line for a plain log. A store's own name passes through {@link safeName} here and nowhere else. */
export function describeEvent(e: TransitionEvent): string {
  switch (e.type) {
    case "reported": return `transition: ${e.what}: ${e.n}`;
    case "owner-table": return `transition: a table that is not the product's, ${safeName(e.name)}, ${e.outcome === "left" ? "left alone" : "refuses the transition"}`;
    case "refused": return `transition: REFUSED before the first entry, nothing was changed: ${e.lines.map((l) => `${l.what} = ${l.n}`).join("; ")}`;
    case "entry": return `transition: ${e.journal} ${e.name} applied in ${e.ms} ms`;
    case "check": return `transition: ${e.ok ? "ok" : "RED"} ${e.name} / ${e.subject}: expected ${e.expected}, found ${e.found}`;
    case "sealed": return `transition: sealed values of ${e.site}: ${e.rows} rows, ${e.opened} opened, ${e.failed} failed`;
    case "committed": return `transition: committed; the heads read ${Object.entries(e.heads).map(([j, w]) => `${j} ${w}`).join(", ")}`;
  }
}

/** The transition did not begin: the store is not one it was written for. Nothing was changed. */
export class TransitionRefused extends Error {
  readonly code = "transition_refused";
  constructor(readonly lines: readonly CountLine[]) {
    super(`the 2.0 transition is refused before its first entry and nothing was changed: ${
      lines.slice(0, 12).map((l) => `${l.what} = ${l.n}`).join("; ")}${lines.length > 12 ? `; and ${lines.length - 12} more` : ""}`);
    this.name = "TransitionRefused";
  }
}

/** Where it stopped: reading the record of before, in an entry, at a check, opening a sealed value, or the connection went. */
export type FailureStage = "before" | "entry" | "check" | "sealed" | "lost";

/**
 * The transition began and was rolled back whole: the store is the 1.0.11 store it was, its
 * ledgers included. Composed from the fields below and nothing else; the driver's error is not
 * kept, in `cause` or anywhere.
 */
export class TransitionFailed extends Error {
  readonly code = "transition_failed";
  constructor(readonly at: {
    readonly stage: FailureStage;
    /** The entry that was running, as `mail 0201_account_on_borrowers`. */
    readonly entry?: string;
    /** The entry's own name for the step (`-- @step`), when the statement carries one. */
    readonly step?: string;
    /** The SQLSTATE. */
    readonly sqlState?: string;
    readonly relation?: string;
    readonly column?: string;
    readonly constraint?: string;
    readonly lines?: readonly CountLine[];
  }) {
    super([
      `the 2.0 transition was rolled back whole at ${at.stage}`,
      at.entry ? `in ${at.entry}` : "",
      at.step ? `step ${at.step}` : "",
      at.sqlState ? `SQLSTATE ${at.sqlState}` : "",
      at.relation ? `table ${safeName(at.relation)}` : "",
      at.column ? `column ${safeName(at.column)}` : "",
      at.constraint ? `constraint ${safeName(at.constraint)}` : "",
      at.lines && at.lines.length > 0
        ? `${at.lines.slice(0, 12).map((l) => `${l.what} = ${l.n}`).join("; ")}${at.lines.length > 12 ? `; and ${at.lines.length - 12} more` : ""}` : "",
      "the store is as it was",
    ].filter((s) => s !== "").join(": "));
    this.name = "TransitionFailed";
  }
}

/** The fields of a driver's error the transition keeps: which statement class failed, on what. Never its text. */
export function fieldsOf(err: unknown): { sqlState?: string; relation?: string; column?: string; constraint?: string } {
  const pick = (o: unknown, ...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = (o as Record<string, unknown> | null)?.[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };
  // drizzle wraps a driver's error as its cause on some paths; the fields are the driver's.
  const e = [err, (err as { cause?: unknown } | null)?.cause].find((x) => /^[0-9A-Z]{5}$/.test(pick(x, "code") ?? "")) ?? null;
  if (e === null) return {};
  const out: { sqlState?: string; relation?: string; column?: string; constraint?: string } = { sqlState: pick(e, "code")! };
  const relation = pick(e, "table_name", "table");
  const column = pick(e, "column_name", "column");
  const constraint = pick(e, "constraint_name", "constraint");
  if (relation) out.relation = relation;
  if (column) out.column = column;
  if (constraint) out.constraint = constraint;
  return out;
}

/**
 * The ONE place a Postgres notice is allowed to go. postgres.js defaults `onnotice` to console:
 * omit it and the driver's raw notice OBJECT lands on stdout (observed live). The log drain is a
 * CONTROLLED surface, and a notice is an uncontrolled path into it. Only `severity` and `code`
 * cross — closed vocabularies defined by Postgres, facts ABOUT the notice rather than content
 * FROM it; `message`/`detail`/`hint` can carry ROW VALUES. This DISCARDS diagnostics,
 * deliberately: the alternative on offer was the raw object on stdout. A SINK, not a logger
 * import: core → db, so importing core's logger would be a cycle; the host injects one at boot,
 * and until then notices are dropped — strictly better than the default.
 */

/** The closed set of facts about a notice that may leave this module. */
export interface PgNoticeFacts {
  severity: string | null;
  code: string | null;
}

export type NoticeSink = (facts: PgNoticeFacts) => void;

let sink: NoticeSink | null = null;

/**
 * Install the process's notice sink. Called once at boot by a host that owns a structured logger;
 * pass `null` to go back to dropping. Not per-client: a notice carries nothing that identifies which
 * pool produced it, so a per-client sink would imply an attribution this data cannot support.
 */
export function setNoticeSink(next: NoticeSink | null): void {
  sink = next;
}

/** Test seam only — asserts the default really is "drop", which is the whole point of the module. */
export function noticeSinkInstalled(): boolean {
  return sink !== null;
}

/**
 * The shape of a hardened logger, described STRUCTURALLY so this package never imports one.
 * `packages/core`'s `Logger` satisfies it without a nominal dependency, which is what keeps the
 * core → db direction intact.
 */
export interface NoticeLogger {
  warn(event: string, fields: Record<string, unknown>): void;
  info(event: string, fields: Record<string, unknown>): void;
}

/**
 * Build the sink a host installs at boot: `setNoticeSink(noticeSinkFor(log))`. ONE mapping in one
 * place rather than each host writing its own closure — N call sites each remembering the grammar
 * is the drift this prevents, and the field list is a privacy boundary, not formatting;
 * `severity` and `code` are already on the logger's `ALLOWED_FIELDS`. `info`, not `debug`, for
 * the non-warning case: a dropped-by-default channel that logs at debug is indistinguishable from
 * a broken one, and the live check for this path is "a structured `pg_notice` appears", which
 * needs the line to ship.
 */
export function noticeSinkFor(log: NoticeLogger): NoticeSink {
  return (facts) => {
    const fields = { severity: facts.severity, code: facts.code };
    if (facts.severity === "WARNING") log.warn("pg_notice", fields);
    else log.info("pg_notice", fields);
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Pass as postgres.js `onnotice` at EVERY construction site. Never writes to console, and never
 * throws: a notice handler that throws would surface inside the driver's message loop, turning a
 * diagnostic into a connection fault.
 */
export function onNotice(notice: unknown): void {
  if (sink === null) return;
  const o = (notice ?? {}) as Record<string, unknown>;
  try {
    sink({ severity: str(o.severity) ?? str(o.severity_local), code: str(o.code) });
  } catch {
    /* a broken sink must not become a database error */
  }
}

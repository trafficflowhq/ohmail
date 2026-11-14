/*
 * No imports, on purpose: the first-run stage reads this, and the stage takes a refusal through
 * its host (`FirstRunHost.probeReason`) so that no door's error class reaches it.
 */

/** The sentences a connect form with no port field says in place of the reason's own. */
export type NoPortProbeKey = "probe_connect_noport" | "probe_timeout_noport" | "probe_tls_noport";

/**
 * THE NO-PORT SENTENCE FOR A REASON, or null where the reason's own sentence names no port. The
 * `connect`, `timeout` and certificate-refused sentences tell the person to check a port; a form
 * with no port field gives them none to check (the generic entry sends none and the probe walks
 * 993, then 143; a preset sends its own). A TLS refusal with a named kind keeps its own sentence.
 */
export function noPortProbeKey(reason: string | null, namedTlsKind: boolean): NoPortProbeKey | null {
  if (reason === "connect") return "probe_connect_noport";
  if (reason === "timeout") return "probe_timeout_noport";
  if (reason === "tls" && !namedTlsKind) return "probe_tls_noport";
  return null;
}

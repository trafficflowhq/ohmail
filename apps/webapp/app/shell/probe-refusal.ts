import { ApiError } from "../api-client";
import { noPortProbeKey, type NoPortProbeKey } from "./no-port-sentence";

/*
 * THE PROBE REFUSAL, READ ONCE for every connect form: the Settings pane, the first-run stage
 * and the /join mailbox step all take the same `mailbox_probe_failed` answer from the server.
 */

/**
 * WHICH OF THE FOUR THINGS FAILED, IN THIS PANE'S OWN WORDS. `POST /mailboxes` now tries the credentials before
 * storing them and refuses with `mailbox_probe_failed` plus `details.reason`, a member of the SAME seven-value
 * taxonomy the worker's classifier emits. That is the whole reason this reads `reason` and not the sentence: one
 * vocabulary for one set of failures, so a mistyped host and a wrong password cannot drift back into sharing a
 * sentence. IT IS `probe_*`, NOT `err_*`, AND THAT IS NOT DUPLICATION. The `err_*` lines all begin "Sync failed",
 * which is a claim about a mailbox that exists and has a worker attached to it. Nothing has been stored when this
 * fires — there is no mailbox and there was no sync — so reusing them would ship a false sentence in the deploy that
 * removes one.
 */

/**
 * UNKNOWN REASONS FALL BACK TO THE SERVER'S OWN SENTENCE rather than to a generic apology: a newer API that adds a
 * taxonomy member must degrade to something true, and the server's message is always exactly that. It is also what
 * `JoinScreen` shows, since it renders `messageOf` directly except where the sentence names a port
 * ({@link noPortProbeSentence}) — so the connect surfaces never disagree about a failure.
 */
const PROBE_REASONS = new Set([
  "auth", "connect", "tls", "timeout", "storage", "sync", "unknown",
]);

export function probeReasonOf(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== "mailbox_probe_failed") return null;
  const reason = (err.details as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === "string" && PROBE_REASONS.has(reason) ? reason : null;
}

/**
 * THE TLS REFUSAL, IN DETAIL — `details.tls` on a `tls` reason, when the server could say more
 * than "certificate refused". Two kinds change what the form OFFERS rather than just what it
 * says: `hostname_mismatch` may carry `suggestedHost` (the vanity-CNAME shape — the certificate
 * is valid and names the provider's real host, so one press moves the field to a name the server
 * can prove), and `tls_unavailable` unlocks the explicit plaintext opt-in for a server that has
 * no TLS at all. `transport` says WHICH field is to blame; everything here degrades to the plain
 * `probe_tls` sentence when a newer server sends a kind this build has no copy for.
 */
const PROBE_TLS_KINDS = new Set([
  "hostname_mismatch", "expired", "not_yet_valid", "self_signed", "untrusted", "tls_unavailable", "generic",
]);

export interface ProbeTlsInfo {
  kind: string;
  transport: "imap" | "smtp";
  certHost?: string;
  expectedHost?: string;
  suggestedHost?: string;
}

export function probeTlsOf(err: unknown): ProbeTlsInfo | null {
  if (!(err instanceof ApiError) || err.code !== "mailbox_probe_failed") return null;
  const details = err.details as { tls?: unknown; transport?: unknown } | null | undefined;
  const tls = details?.tls;
  if (!tls || typeof tls !== "object") return null;
  const record = tls as Record<string, unknown>;
  if (typeof record.kind !== "string" || !PROBE_TLS_KINDS.has(record.kind)) return null;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  return {
    kind: record.kind,
    transport: details?.transport === "smtp" ? "smtp" : "imap",
    certHost: str(record.certHost),
    expectedHost: str(record.expectedHost),
    suggestedHost: str(record.suggestedHost),
  };
}

/**
 * {@link noPortProbeKey} read off the server's refusal, with the field the sentence may name: the
 * refused transport's host field where the form shows one, else `none`. `tlsKinds` says whether a
 * named TLS kind keeps its own sentence (`own`) or the form renders no kinds (`generic`).
 */
export function noPortProbeSentence(
  err: unknown, hostFields: boolean, tlsKinds: "own" | "generic" = "own",
): { key: NoPortProbeKey; field: "imap" | "smtp" | "none" } | null {
  const details = err instanceof ApiError
    ? err.details as { transport?: unknown; tls?: unknown } | null | undefined
    : undefined;
  const tls = details?.tls;
  const kind = tls && typeof tls === "object" ? (tls as { kind?: unknown }).kind : undefined;
  const key = noPortProbeKey(probeReasonOf(err), tlsKinds === "own" && kind !== undefined && kind !== "generic");
  if (key === null) return null;
  return { key, field: !hostFields ? "none" : details?.transport === "smtp" ? "smtp" : "imap" };
}

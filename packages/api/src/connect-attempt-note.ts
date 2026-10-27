import type { ApiDeps, ConnectAttemptFacts } from "./deps.js";

/**
 * Hand one door's ending to the host's recorder, when it composed one and the request has a session.
 * Awaited, and it never throws: a missing, failing or capped record changes no answer. Shared by the
 * local engine's route table, so it names no hosted module.
 */
export async function noteConnectAttempt(deps: ApiDeps, facts: ConnectAttemptFacts): Promise<void> {
  const record = deps.connectAttempts;
  const accountId = deps.session?.accountId;
  if (record === undefined || !accountId) return;
  try {
    await record(accountId, facts);
  } catch {
    // The recorder logs its own failures; this only keeps the answer whole.
  }
}

/** The IMAP host a request body names, for the record's preset only; total over any JSON value. */
export function imapHostOf(body: unknown): string | undefined {
  const host = (body as { imap?: { host?: unknown } | null } | null)?.imap?.host;
  return typeof host === "string" ? host : undefined;
}

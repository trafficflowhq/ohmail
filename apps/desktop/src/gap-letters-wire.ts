/**
 * ANSWERING THE GAP OFFER (mail 0151, 0158) — both counts the person was shown, so the door refuses a
 * pair that moved; the answer's shape is `GapLettersTransport`'s. Over an injected transport, with no door in this module, on
 * `junk-wire.ts`'s rule: the desktop window hands in its bridge (`local-gap-letters.ts`) and the
 * served host client its bearer socket (`host-client/transports.ts`), which has no bridge — a file
 * shared with the bridge binding would put the shell command into the bundle a phone is handed.
 */

import type { GapLettersTransport } from "../../webapp/app/shell/GapLettersNotice";

/** MUST REJECT on failure, with the status and code: a 409 is a pair of counts that moved since it was shown. */
export function gapLettersVia(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
): GapLettersTransport {
  return async (mailboxId, answer) => {
    const res = await fetchImpl(`/mailboxes/${encodeURIComponent(mailboxId)}/gap-letters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answer),
    });
    if (!res.ok) {
      const code = await res.json().then((b: { error?: { code?: unknown } }) => b?.error?.code, () => undefined);
      throw Object.assign(new Error(`${res.status}`), { status: res.status, code });
    }
    return undefined;
  };
}

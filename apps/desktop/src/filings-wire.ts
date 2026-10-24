/**
 * SETTINGS → MAILBOXES → THE FILINGS THAT WAIT, over an injected transport (`self-check-wire.ts`'s
 * rule: no door in this module, so the served host client may carry it too). The read hands the
 * engine's answer back raw for the block to narrow; the two presses answer their counts. A refusal
 * throws with its status; a 409 (another install organizes the mailbox now) is the block's own
 * `ApiError`, so it says that rather than "did not go through".
 */
import { ApiError } from "../../webapp/app/api-client";
import type { MailboxFilingsApi } from "../../webapp/app/shell/MailboxFilings";

type FetchImpl = (path: string, init?: RequestInit) => Promise<Response>;

/** A refusal as the block reads it. Never through the constructor: this build's client is a refusing stub. */
function refusal(status: number): Error {
  if (status !== 409) return Object.assign(new Error(`the mail engine answered ${status}`), { status });
  return Object.assign(Object.create(ApiError.prototype) as ApiError, {
    status, code: "conflict", message: "another install organizes this mailbox", name: "ApiError",
  });
}

export function filingsVia(fetchImpl: FetchImpl): MailboxFilingsApi {
  const at = (id: string, tail = ""): string => `/mailboxes/${encodeURIComponent(id)}/filings${tail}`;
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const res = await fetchImpl(path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw refusal(res.status);
    return res.json();
  };
  return {
    read: async (id) => {
      const res = await fetchImpl(at(id));
      if (!res.ok) throw refusal(res.status);
      return res.json();
    },
    retry: async (id, folder) => {
      const b = (await post(at(id, "/retry"), { folder })) as { reset?: unknown; skipped?: unknown };
      return { reset: typeof b?.reset === "number" ? b.reset : 0, ...(typeof b?.skipped === "number" ? { skipped: b.skipped } : {}) };
    },
    leave: async (id, folder, through) => {
      const b = (await post(at(id, "/leave"), { folder, through })) as { settled?: unknown; remaining?: unknown };
      return { settled: typeof b?.settled === "number" ? b.settled : 0, ...(typeof b?.remaining === "number" ? { remaining: b.remaining } : {}) };
    },
  };
}

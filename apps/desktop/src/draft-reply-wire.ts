/**
 * DRAFTING A REPLY OVER AN ENGINE DOOR — the two calls and the refusal contract, over an injected
 * transport and with no door in this module. The shared draft control decides when to spend, mints
 * the press's key and lands the text in the editor; this file only carries its two calls. The
 * desktop window hands in its bridge (`local-draft-reply.ts`), the served host client its bearer
 * socket (`host-client/transports.ts`): no transport is imported here, for `junk-wire.ts`'s reason
 * (`scan:host` refuses the bridge in the bundle a phone is handed).
 */

import type { DraftReplyRead, DraftReplyWire } from "../../webapp/app/shell/draft-reply.js";

/**
 * A REFUSAL THAT CARRIES THE ENGINE'S OWN ENVELOPE — status, code, sentence and details, out of
 * the body untouched. The shared control reads them by shape: the code picks a catalogue sentence
 * (`ai-refusal-copy.ts`), `details.credits` says what happened to a charge, and otherwise the
 * engine's sentence is shown as written. A body that is no envelope leaves the code empty, and the
 * control then says its own failure sentence.
 */
export class DraftReplyRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DraftReplyRefused";
  }
}

async function refusalOf(response: Response): Promise<DraftReplyRefused> {
  let code = "";
  let message = `the mail engine answered ${response.status}`;
  let details: unknown;
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
    details = body.error?.details;
  } catch {
    // A non-JSON refusal has no sentence beyond its status.
  }
  return new DraftReplyRefused(response.status, code, message, details);
}

/** The answer as the JSON the caller expects, or the refusal, thrown. */
async function answerOf<T>(response: Response): Promise<T> {
  if (!response.ok) throw await refusalOf(response);
  return (await response.json()) as T;
}

/**
 * The shared draft flow over ANY fetch-shaped transport. `noModel` is the door's sentence for an
 * engine with no model (see {@link DraftReplyWire}); absent, the engine's own sentence stands.
 */
export function draftReplyVia(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
  configured: () => boolean,
  noModel?: DraftReplyWire["noModel"],
): DraftReplyWire {
  return {
    configured,
    create: async (messageId, idempotencyKey) => answerOf<{ draftId: string }>(
      await fetchImpl(`/messages/${encodeURIComponent(messageId)}/draft`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
      }),
    ),
    read: async (draftId) => answerOf<DraftReplyRead>(
      await fetchImpl(`/drafts/${encodeURIComponent(draftId)}`),
    ),
    ...(noModel !== undefined ? { noModel } : {}),
  };
}

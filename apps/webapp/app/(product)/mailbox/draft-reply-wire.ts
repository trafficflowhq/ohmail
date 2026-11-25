/**
 * THE WEB'S DRAFT WIRE: the two calls a drafted reply makes, over the server client. It is the web host's own answer
 * to the host contract's `draftReply` (`web-supplies.tsx` hands it); the drafted reply's hook names no server client.
 * Moved out of the drafted reply's hook (`draft-reply.ts`, in app-logic's writing folder since) as it stood.
 */
import { api, apiConfigured } from "../../api-client";
import type { AnswerOf } from "@ohmail/wire";
import type { DraftReplyRead, DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";

/**
 * The hosted transport, and the default, so the web is unchanged. Each member reaches `api` only
 * when called: a module that merely imports this one (every test that mocks `api-client` without
 * `api`) touches nothing at load, as before the wire existed.
 */
export const CLOUD_WIRE: DraftReplyWire = {
  configured: () => apiConfigured(),
  create: (id, idempotencyKey, onDraftPreview, fullConversation) => api<AnswerOf<"POST /messages/:id/draft">>(`/messages/${id}/draft`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    onDraftPreview,
    ...(fullConversation ? { body: { fullConversation: true } } : {}),
  }),
  read: (draftId) => api<DraftReplyRead>(`/drafts/${draftId}`),
  fromText: (body, idempotencyKey, onDraftPreview) => api<AnswerOf<"POST /drafts/from-text">>("/drafts/from-text", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    onDraftPreview,
    body,
  }),
};

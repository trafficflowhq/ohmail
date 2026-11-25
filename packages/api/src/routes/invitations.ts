import { answerInvitation } from "@trafficflow/services/invitation-answer";
import type { InvitationAnswerResult, RequestOf, UntrustedBody } from "@ohmail/wire";
import { serviceContext } from "../context.js";
import { answer } from "../responses.js";
import type { Route } from "../router.js";
import { sendDepsOf, sendKeyOf } from "../send-deps.js";
import { readBody } from "./shared.js";

/** What each outcome that is no plain delivery tells a client that reads only the words. */
const SAID: Partial<Record<InvitationAnswerResult["status"], string>> = {
  unverified: "We couldn't confirm this answer was sent. Check your Sent folder before answering again.",
  queued: "This answer was accepted and is still being handed to your mail server.",
  failed: "A prior answer under this key failed and was not delivered.",
  in_flight: "This answer is already being sent.",
};

/** The send route's codes: a delivery or a settled state 200, a hand-off still running 202, a refusal 409. */
const STATUS: Readonly<Record<InvitationAnswerResult["status"], number>> = {
  sent: 200, already: 200, unverified: 200, queued: 202, failed: 409, in_flight: 409,
};

/**
 * `POST /messages/:id/invitation/answer` — Yes, Maybe or No on an invitation, sent by mail
 * (`@trafficflow/services/invitation-answer`). Session and CSRF, as every route; `Idempotency-Key`
 * required and bounded as the send's, because it IS the send's key: a replay of the press is
 * answered from its reservation, never sent again. `connection`: it opens SMTP on the person's own
 * server, so an unverified account is refused. Not behind the calendar's capability: an invitation
 * and its answer are mail.
 */
export const invitationRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/messages/:id/invitation/answer",
    wire: true,
    relay: true,
    cost: "connection",
    // The reservation answers every replay of a key.
    options: { replaySafe: true },
    handler: async (req, deps, params) => {
      const key = sendKeyOf(req);
      const body = (await readBody<UntrustedBody<RequestOf<"POST /messages/:id/invitation/answer">> | null>(req)) ?? {};
      const recordCalendarMailAnswer = deps.services?.calendar?.recordMailAnswer;
      const { result, seq } = await answerInvitation(
        serviceContext(deps, req), { messageId: params.id!, answer: body.answer, basis: body.basis, key },
        { send: sendDepsOf(deps), ...(recordCalendarMailAnswer && { recordCalendarMailAnswer }) },
      );
      const message = SAID[result.status];
      return answer<"POST /messages/:id/invitation/answer">()(
        { ...result, ...(message !== undefined && result.message === undefined ? { message } : {}) },
        { status: STATUS[result.status], seq: seq ?? undefined },
      );
    },
  },
];

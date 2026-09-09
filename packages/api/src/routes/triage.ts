import type { TriageSetBody, TriageState } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { triage, readBody } from "./shared.js";

/** The wire body for a triage set. The resurface time is accepted under either the
 * contract's `bubbleUpAt` or the plan's `untilTs` alias (bubbled_up requires it). */
interface TriageWireBody {
  state: TriageState;
  bubbleUpAt?: string;
  untilTs?: string;
}

/**
 * §5.5 — triage states & views. `POST /messages/:id/triage` upserts the bottom-pile
 * state (user-wins, no If-Match) and emits a `message_state` change; it is
 * idempotent (Idempotency-Key), the service writing the idempotency row IN its tx.
 * `GET /triage?state=` lists a pile; `/views/focus-reply` and
 * `/views/power-through` are pure read views over those states + the Imbox.
 */
export const triageRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/messages/:id/triage",
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const body = await readBody<TriageWireBody>(req);
      const setBody: TriageSetBody = { state: body.state, bubbleUpAt: body.bubbleUpAt ?? body.untilTs };
      const dto = await triage(deps).setState(serviceContext(deps, req), params.id!, setBody, {
        idempotency: deps.idempotency ?? null,
      });
      return jsonResponse(dto);
    },
  },
  {
    method: "GET",
    pattern: "/triage",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const state = (url.searchParams.get("state") ?? "") as TriageState;
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null ? Number(limitRaw) : undefined;
      const page = await triage(deps).listByState(serviceContext(deps, req), state, { cursor, limit });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "GET",
    pattern: "/views/focus-reply",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const view = await triage(deps).focusReply(serviceContext(deps, req));
      return jsonResponse(view);
    },
  },
  {
    method: "GET",
    pattern: "/views/power-through",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const view = await triage(deps).powerThrough(serviceContext(deps, req), { cursor });
      return jsonResponse(view);
    },
  },
];

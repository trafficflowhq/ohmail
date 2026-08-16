import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "./shared.js";
import { waitlistSvc } from "./shared-cloud.js";

/**
 * `POST /waitlist` (1). The landing form's only server call.
 *
 * ## Why the options are exactly `{ public: true }` and nothing else
 *
 *  · **`public`** — the caller has no account by definition; that is the entire premise
 *    of a waitlist. `withSession` still runs, so an ambient enrollment cookie is DROPPED
 *    rather than 403-ing a form submission on the landing page.
 *  · **NOT `raw`** — the request guard, the error envelope and JSON coercion all apply.
 *    `withRequestGuard` is what makes this endpoint uninteresting to a cross-site form
 *    post: a body demands `Content-Type: application/json` (killing the one shape a
 *    browser can POST cross-origin without a preflight), and an `Origin` header, when
 *    present, must be one of the deployment's own.
 *  · **NOT `idempotent`** — there is no `Idempotency-Key` to honour and no need for one:
 *    the write is an UPSERT on `email`, so re-submission is naturally idempotent, and the
 *    mail is deduplicated twice over by the mail service (a provider idempotency key derived
 *    from `to|tier`, and the per-recipient limiter under it).
 *
 * ## Rate limiting: two keys, because there are two victims
 *
 * The harm this endpoint can do to a THIRD PARTY is "mail lands in a stranger's inbox
 * because someone typed their address into our form", and the key for that harm is the
 * RECIPIENT. The mail service owns exactly that limiter (`MailService.guarded` → `auth_throttle` under
 * `mail:<quota>:<sha256(recipient)>`, five per rolling hour), so this route adds nothing
 * and reuses it by construction: it can only reach the mailer through `MailService`. The
 * `unsolicited` quota namespace is what stops those five submissions also consuming the
 * budget the same person's INVITE needs — see `MailQuota`.
 *
 * The harm it can do to US is unbounded rows, and the key for that is the CALLER:
 * `WaitlistService.join` claims one of {@link MAX_JOINS_PER_IP_WINDOW} per-IP slots before
 * it writes, and answers 429 when they are gone. That refusal is about the connection, not
 * about any address, so it is safe to make it visible.
 *
 * **The residual, stated rather than discovered later:** a DISTRIBUTED submitter still
 * writes one row per address it can invent, and each distinct address receives its one
 * confirmation. Closing that needs a challenge (Turnstile) and an edge limit — infra this
 * deployment does not have.
 *
 * ## The response is constant, and carries no counter
 *
 * `202 {status:"ok"}` for a first-time signup, a re-submission and a tier change alike.
 *
 * It used to carry `mailed`, and that was a mistake worth naming: the field is a readout of
 * the per-recipient mail limiter, so an unauthenticated caller could submit any address
 * five or six times, watch `true` flip to `false` early, and learn that we had recently
 * sent that person other mail — i.e. that they had been invited. A response field that
 * varies with data the caller has no right to is an oracle no matter how small it looks,
 * and the whole point of this endpoint's design is that the answer never varies.
 * `WaitlistService.join` still RETURNS `mailed`; the operator smoke path and the suite read
 * it from inside the trust boundary, where it is a fact rather than a leak.
 *
 * 202 rather than 201, deliberately: the durable effect (the row) is done, the visible
 * one (the mail) is best-effort and may legitimately not happen.
 */
export const waitlistRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/waitlist",
    cost: "unauthenticated",
    options: { public: true },
    handler: async (req, deps) => {
      // `unknown`, not `string` — this body is a JSON document a stranger wrote, and
      // `{"tier": 42}` used to reach `.trim()` and answer 500. `WaitlistService` does the
      // coercion (`asWireString`); the type here is what stops a future edit from
      // "helpfully" re-declaring these as strings.
      const body = await readBody<{ email?: unknown; tier?: unknown; source?: unknown }>(req);
      await waitlistSvc(deps).join(serviceContext(deps, req), {
        email: typeof body.email === "string" ? body.email : "",
        tier: body.tier,
        source: body.source,
      });
      // CONSTANT. Not `out` — see the header: `mailed` is a limiter readout and this is a
      // public endpoint. The service's return value stays inside the process.
      return jsonResponse({ status: "ok" }, { status: 202 });
    },
  },
];
